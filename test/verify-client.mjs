/**
 * dsh-task-reminder 浏览器半侧的 Node 自检。
 *
 * 为什么需要它：这个插件的关键行为都不在渲染里，而在 apply 的接线与
 * 「running → 非 running」边沿判据上 —— 事件订阅、做种、弹窗时机两种模式
 * （任何情况都弹 / 仅非前台窗口）、五个配置的默认值/读写/恢复默认、切换音效
 * 即时发声、音量整档 +20 的换算、系统弹窗的权限路径与点击回会话、挂起
 * AudioContext 的手势拉活，以及回调与监听的回收。页面里没有浏览器控制能力
 * 时，这些也必须被真机（Node）跑过，而不是只靠肉眼审阅。
 *
 * 做法：给 client.js 一个极简的 `window.__ModuleLoader__` 桩以取得工厂，
 * 再用桩服务（locale / slots / sessions / remote / uiWorkspace / timer）跑
 * apply，直接驱动停止事件（边沿 + turn/end 分类）、调用设置页组件。断言
 * 失败时以非零码退出。
 *
 * 用法：node test/verify-client.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');
/** 包元数据：用来比对 client.js 里那份版本号，发布前防漂。 */
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

/** 让出微任务/宏任务队列，供 requestPermission 这类 Promise 落地。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 桩：模块表（react / client-store / ui-primitives）
// ---------------------------------------------------------------------------

/**
 * 极简 React 桩：函数组件当场递归渲染成普通元素树
 * （否则 SettingRow / Stepper / Switch 这些组件节点不会展开，断言摸不到它们）。
 * 组件返回的节点不再二次包装：Switch 这类“函数即控件”的返回值直接当作终态。
 */
const reactStub = {
	createElement(type, props, ...children) {
		if (typeof type !== 'function') return { type, props: props ?? {}, children };
		return type({ ...(props ?? {}), children: children.length <= 1 ? children[0] : children });
	},
	useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
	// 隐藏文件选择框的 ref：桩里没人会真的把 DOM 节点塞进 current，所以组件
	// 里的用法必须是「取到才点」；用例可以自己往 current 里放一个假的 input。
	useRef: (initial) => ({ current: initial }),
};

/** 记录每个持久化 store 的创建参数，供断言 persist 键。 */
const persistedStores = [];
function createSnapshotStore(initial, options) {
	let value = initial;
	const listeners = new Set();
	const store = {
		options,
		getSnapshot: () => value,
		set(next) {
			value = next;
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	persistedStores.push(store);
	return store;
}

/** Switch 桩：渲染成可识别元素，props 原样带上。 */
const switchRenders = [];
const Switch = (props) => {
	switchRenders.push(props);
	return { type: 'Switch', props, children: [] };
};

const requireStub = (spec) => {
	if (spec === 'react') return reactStub;
	if (spec === '@deepseek-ai/dsh-client-store') return { createSnapshotStore };
	if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Switch };
	throw new Error(`verify-client: unexpected require(${JSON.stringify(spec)})`);
};

// ---------------------------------------------------------------------------
// 桩：window / document
// ---------------------------------------------------------------------------

/** 窗口焦点 / 标签页可见性状态，与 document/window 事件桩联动。 */
const focusState = { hidden: false, focused: true };
const domListeners = { document: new Map(), window: new Map() };
const listenOn = (target) => (type, fn) => {
	const set = domListeners[target].get(type) ?? new Set();
	set.add(fn);
	domListeners[target].set(type, set);
};
const unlistenFrom = (target) => (type, fn) => {
	domListeners[target].get(type)?.delete(fn);
};
const fireDom = (type) => {
	for (const target of ['document', 'window']) {
		for (const fn of [...(domListeners[target].get(type) ?? [])]) fn();
	}
};
/** 只派发 window 上的某类事件（如 pointerdown / keydown）。 */
const fireWindow = (type) => {
	for (const fn of [...(domListeners.window.get(type) ?? [])]) fn();
};
/** 改焦点/可见性状态并派发事件（插件的 sync 每次事件都重算）。 */
const setFocus = ({ hidden, focused }) => {
	focusState.hidden = hidden === true;
	focusState.focused = focused !== false;
	fireDom('visibilitychange');
	fireDom('focus');
	fireDom('blur');
};

/**
 * 「点弹窗落到你这次提问的位置」的 DOM 桩。真实环境里插件做的是：
 *   document.querySelector('[data-chat-flow]')                       → 会话流列
 *   column.querySelectorAll('[data-chat-flow-kind="user"], …="steering"]')
 *   column.closest('[data-conversation-scroll]') ?? column.parentElement → 滚动容器
 *   行 / 容器各量一次 getBoundingClientRect().top
 * 这里给出同样的形状；几何按「行的视口坐标 = 内容坐标 − scrollTop」算 ——
 * 写完 scrollTop 再量一次就能看出对齐有没有生效（真浏览器就是这个语义）。
 * 选择器/属性名在这里写成字面量，另有断言校验它们与插件导出的常量一致。
 */
const QUESTION_COLUMN_SELECTOR = '[data-chat-flow]';
const QUESTION_ROW_SELECTOR_STUB = '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]';
const QUESTION_OUTER_SELECTOR = '[data-conversation-scroll]';
const QUESTION_SESSION_SELECTOR = '[data-conversation-session]';
/** 当前装上的「会话画面」：列 / 滚动容器 / 行。没装时 document.querySelector 给 null。 */
const questionStage = { column: null, scroller: null, rows: [], outer: null, sessionHost: null, columns: [] };
/** 一条消息行的桩：只有插件真会用到的那几个成员。 */
const makeQuestionRow = (kind, contentTop, scroller, options = {}) => ({
	kind,
	hasAttribute: (name) => name === 'hidden' && options.hidden === true,
	// 桩里不做 hidden 祖先：需要时 options.hiddenAncestor 直接把最近 hidden 祖先指成容器。
	closest: (selector) => (selector === '[hidden]' && options.hiddenAncestor === true ? scroller : null),
	getBoundingClientRect: () => {
		const top = contentTop - scroller.scrollTop;
		return { top, height: 60, bottom: top + 60, left: 0, right: 800 };
	},
});
/**
 * 造一个会话流列（与真实 DOM 同形：列 → closest('[data-conversation-session]') 拿到会话号）。
 * @param options.mountedSession - 挂载点上的会话号（null = 没有这层属性）。
 * @param options.hidden - true 时列自带 hidden（real DOM 里被藏起来的列）。
 * @param options.rows - `{ kind, contentTop }` 列表。
 * @param options.scroller - 这个列自己那条滚动容器。
 */
const makeColumn = ({ mountedSession = null, hidden = false, rows = [], scroller }) => {
	const sessionHost = mountedSession === null ? null : {
		getAttribute: (name) => (name === QUESTION_SESSION_SELECTOR.slice(1, -1) ? mountedSession : null),
	};
	const column = {
		parentElement: scroller,
		rows: [],
		hidden,
		hasAttribute: (name) => name === 'hidden' && hidden === true,
		closest: (selector) => {
			if (selector === QUESTION_OUTER_SELECTOR) return null;
			if (selector === QUESTION_SESSION_SELECTOR) return sessionHost;
			if (selector === '[hidden]') return hidden ? scroller : null;
			return null;
		},
		// 与真实选择器同义：只给出 user / steering 两种行。
		querySelectorAll: (selector) => (selector === QUESTION_ROW_SELECTOR_STUB
			? column.rows.filter((row) => row.kind === 'user' || row.kind === 'steering')
			: []),
	};
	column.rows = rows.map((row) => makeQuestionRow(row.kind, row.contentTop, scroller, row));
	return { column, rows: column.rows, sessionHost };
};
/**
 * 装一套会话画面。
 * @param options.withOuter - true 时滚动口是列祖先上的 `[data-conversation-scroll]`，
 *   否则退回列的父节点（聊天自己的 `_scroll`）—— 两条真实路径都覆盖。
 * @param options.rows - `{ kind, contentTop }` 列表，DOM 顺序即数组顺序。
 * @param options.extraColumns - 额外挂着的会话流列（真实 DOM 里同时挂着好几个），
 *   每项 `{ mountedSession, hidden, rows }`；用来验「对着正确那一列对齐」。
 * @returns 这套画面的各个部件（列 / 实际滚动容器 / 行）。
 */
const installQuestionStage = (options = {}) => {
	const { withOuter = false, scrollTop = 0, scrollHeight = 4000, rows = [], mountedSession = null, extraColumns = [] } = options;
	const makeScroller = () => ({
		scrollTop,
		clientHeight: 600,
		scrollHeight,
		getBoundingClientRect: () => ({ top: 0, height: 600, bottom: 600, left: 0, right: 800 }),
	});
	const inner = makeScroller();
	const outer = withOuter ? makeScroller() : null;
	const scroller = outer ?? inner;
	// 挂载点：真实结构里它是列的更外层祖先，属性值就是当前挂着的会话号。
	const sessionHost = {
		getAttribute: (name) => (name === QUESTION_SESSION_SELECTOR.slice(1, -1) ? mountedSession : null),
	};
	const column = {
		parentElement: inner,
		rows: [],
		hidden: false,
		hasAttribute: () => false,
		closest: (selector) => {
			if (selector === QUESTION_OUTER_SELECTOR) return outer;
			if (selector === QUESTION_SESSION_SELECTOR) return mountedSession === null ? null : sessionHost;
			if (selector === '[hidden]') return null;
			return null;
		},
		// 与真实选择器同义：只给出 user / steering 两种行。
		querySelectorAll: (selector) => (selector === QUESTION_ROW_SELECTOR_STUB
			? column.rows.filter((row) => row.kind === 'user' || row.kind === 'steering')
			: []),
	};
	column.rows = rows.map((row) => makeQuestionRow(row.kind, row.contentTop, scroller, row));
	// 额外列各有自己的滚动容器（各自独立滚动，才能验「滚的是哪一列」）。
	const extras = extraColumns.map((entry) => makeColumn({
		mountedSession: entry.mountedSession ?? null,
		hidden: entry.hidden === true,
		rows: entry.rows ?? [],
		scroller: makeScroller(),
	}));
	questionStage.column = column;
	questionStage.scroller = scroller;
	questionStage.rows = column.rows;
	questionStage.outer = outer;
	questionStage.sessionHost = mountedSession === null ? null : sessionHost;
	questionStage.columns = [column, ...extras.map((entry) => entry.column)];
	return { column, scroller, inner, outer, sessionHost, rows: column.rows, extras };
};
/** 拆掉会话画面（等价于「当前打开的会话没有这根轴」）。 */
const clearQuestionStage = () => {
	questionStage.column = null;
	questionStage.scroller = null;
	questionStage.rows = [];
	questionStage.outer = null;
	questionStage.sessionHost = null;
	questionStage.columns = [];
};

const documentStub = {
	head: { appendChild: () => {} },
	createElement: (tag) => ({
		tag,
		dataset: {},
		textContent: '',
		removed: false,
		remove() {
			this.removed = true;
		},
	}),
	querySelector: (selector) => (selector === QUESTION_COLUMN_SELECTOR ? questionStage.column : null),
	// 排障一行报告要按选择器数命中数：这里按装上的会话画面如实回答。
	querySelectorAll: (selector) => {
		if (selector === QUESTION_COLUMN_SELECTOR) {
			// 真实 DOM 里可能同时挂着多个会话流列；装了几列就报几列。
			if (questionStage.columns.length > 0) return questionStage.columns;
			return questionStage.column === null ? [] : [questionStage.column];
		}
		if (selector === QUESTION_ROW_SELECTOR_STUB) {
			const extraRows = questionStage.columns.slice(1).flatMap((entry) => entry.querySelectorAll(QUESTION_ROW_SELECTOR_STUB));
			return [...questionStage.rows, ...extraRows].filter((row) => row.kind === 'user' || row.kind === 'steering');
		}
		if (selector === QUESTION_OUTER_SELECTOR) return questionStage.outer === null ? [] : [questionStage.outer];
		if (selector === QUESTION_SESSION_SELECTOR) return questionStage.sessionHost === null ? [] : [questionStage.sessionHost];
		return [];
	},
	get hidden() {
		return focusState.hidden;
	},
	hasFocus: () => focusState.focused && !focusState.hidden,
	addEventListener: listenOn('document'),
	removeEventListener: unlistenFrom('document'),
};

/** Web Notification 桩：记录构造、权限申请、关闭与 focus 回调。 */
const notificationLog = { created: [], requested: 0, closed: 0, focused: 0 };
class FakeNotification {
	constructor(title, options) {
		this.title = title;
		this.options = options ?? {};
		this.onclick = null;
		notificationLog.created.push(this);
	}
	close() {
		notificationLog.closed += 1;
	}
}
FakeNotification.permission = 'default';
FakeNotification.requestPermission = () => {
	notificationLog.requested += 1;
	return Promise.resolve(FakeNotification.permission);
};

/** Web Audio 录音桩：记录振荡器与增益节点，验证「提示音真的排了音、参数正确」。 */
const audioLog = { contexts: 0, instances: [], oscillators: [], gains: [], bufferSources: [], decodes: [], decodeFails: false, resumed: 0, closed: 0 };
class FakeAudioContext {
	constructor() {
		audioLog.contexts += 1;
		audioLog.instances.push(this);
		this.currentTime = 0;
		this.state = 'running';
		this.destination = {};
	}
	resume() {
		audioLog.resumed += 1;
		this.state = 'running';
		return Promise.resolve();
	}
	close() {
		audioLog.closed += 1;
		return Promise.resolve();
	}
	createOscillator() {
		const oscillator = {
			type: '',
			freq: null,
			startAt: null,
			stopAt: null,
			frequency: { setValueAtTime: (value) => { oscillator.freq = value; } },
			connect: (node) => node,
			start: (at) => { oscillator.startAt = at; },
			stop: (at) => { oscillator.stopAt = at; },
		};
		audioLog.oscillators.push(oscillator);
		return oscillator;
	}
	createGain() {
		const gain = {
			peak: null,
			ramps: [],
			gain: {
				setValueAtTime: () => {},
				// 每个包络 ramp 两次（起振峰值 → 衰减尾），peak 只记第一条。
				exponentialRampToValueAtTime: (value) => {
					gain.ramps.push(value);
					if (gain.peak === null) gain.peak = value;
				},
			},
			connect: (node) => node,
		};
		audioLog.gains.push(gain);
		return gain;
	}
	createBufferSource() {
		const source = {
			buffer: null,
			startAt: null,
			connect: (node) => node,
			start: (at) => { source.startAt = at; },
		};
		audioLog.bufferSources.push(source);
		return source;
	}
	decodeAudioData(data, onSuccess, onError) {
		audioLog.decodes.push(data);
		if (audioLog.decodeFails === true) {
			if (typeof onError === 'function') onError(new Error('decode-failed'));
			return;
		}
		// 解码结果只需要 duration（播放时要算淡出尾巴）。
		if (typeof onSuccess === 'function') onSuccess({ duration: 0.5, sampleRate: 48000, length: 24000 });
	}
}

/**
 * IndexedDB 桩：只实现插件用到的那条路径（open → 一个对象仓库 → get / put / delete），
 * 全部在微任务里落地。failOpen / failPut 用来演练「打不开」「写不进去」两条失败分支。
 */
const idbBacking = { records: new Map(), openCount: 0, failOpen: false, failPut: false };
const idbRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });
const settleIdb = (request, result) => {
	Promise.resolve().then(() => {
		request.result = result;
		if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
	});
};
const failIdb = (request, error) => {
	Promise.resolve().then(() => {
		request.error = error;
		if (typeof request.onerror === 'function') request.onerror({ target: request });
	});
};
const fakeObjectStore = () => ({
	get(key) {
		const request = idbRequest();
		settleIdb(request, idbBacking.records.get(key));
		return request;
	},
	put(value, key) {
		const request = idbRequest();
		if (idbBacking.failPut) {
			failIdb(request, new Error('quota exceeded'));
			return request;
		}
		idbBacking.records.set(key, value);
		settleIdb(request, key);
		return request;
	},
	delete(key) {
		const request = idbRequest();
		idbBacking.records.delete(key);
		settleIdb(request, undefined);
		return request;
	},
});
const fakeDatabase = {
	objectStoreNames: { contains: () => true },
	createObjectStore: () => {},
	transaction: () => ({ objectStore: () => fakeObjectStore() }),
};
const FakeIndexedDB = {
	open() {
		idbBacking.openCount += 1;
		const request = idbRequest();
		if (idbBacking.failOpen) {
			failIdb(request, new Error('blocked'));
			return request;
		}
		request.result = fakeDatabase;
		Promise.resolve().then(() => {
			if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded({ target: request });
			if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
		});
		return request;
	},
};

/** localStorage 桩：记账「已经申请过通知权限」。 */
const localStorageBacking = {};
/** Service Worker 桥的桩：注册、带按钮的通知、getNotifications 清理都记账。 */
const swShown = [];
const swClosed = [];
/** 快捷裁决记下的 answer() 结果（按顺序）。 */
const answeredOutcomes = [];
const swRegisterUrls = [];
let swRegisterCalls = 0;
const swContainers = new Map();
const fakeRegistration = {
	active: {}, // 直接 active：跳过 installing 状态机，桥立刻可用
	showNotification: (title, options) => { swShown.push({ title, options }); return Promise.resolve(); },
	getNotifications: (filter) => {
		swClosed.push(filter?.tag ?? null);
		return Promise.resolve([]);
	},
};
const fakeServiceWorkerContainer = {
	register: (url) => {
		swRegisterCalls += 1;
		swRegisterUrls.push(url);
		return Promise.resolve(fakeRegistration);
	},
	addEventListener: (name, fn) => { swContainers.set(name, fn); },
};
/** BroadcastChannel 桩：同名频道互投，页面侧用它收 worker 转回的点击。 */
const broadcastChannels = [];
class FakeBroadcastChannel {
	constructor(name) {
		this.name = name;
		this.onmessage = null;
		broadcastChannels.push(this);
	}
	postMessage(message) {
		for (const channel of broadcastChannels) {
			if (channel !== this && typeof channel.onmessage === 'function') channel.onmessage({ data: message });
		}
	}
	close() {}
}
const windowStub = {
	__ModuleLoader__: { load: (loaded) => { definition = loaded; } },
	// 启动图：桥从这里认自己那一行的 bundle URL。
	__DSH_BOOT__: { entries: [
		{ id: 'some-other-plugin', url: '/plugins/some-other-plugin/client.js' },
		{ id: '@hawkongz/dsh-task-reminder', url: '/plugins/@hawkongz/dsh-task-reminder/??/client.js&rev=abc123' },
	] },
	navigator: { serviceWorker: fakeServiceWorkerContainer },
	BroadcastChannel: FakeBroadcastChannel,
	isSecureContext: true,
	localStorage: {
		getItem: (key) => (Object.prototype.hasOwnProperty.call(localStorageBacking, key) ? localStorageBacking[key] : null),
		setItem: (key, value) => { localStorageBacking[key] = String(value); },
	},
	Notification: FakeNotification,
	AudioContext: FakeAudioContext,
	indexedDB: FakeIndexedDB,
	focus: () => { notificationLog.focused += 1; },
	addEventListener: listenOn('window'),
	removeEventListener: unlistenFrom('window'),
};
let definition;

// 在函数作用域里执行源码：那里有 `window` 与工厂参数 `require`。
new Function('window', 'document', source)(windowStub, documentStub);
if (definition === undefined) throw new Error('verify-client: client.js did not call window.__ModuleLoader__.load');

const plugin = definition.factory(requireStub);
const { diagnostics } = plugin;
const {
	APPROVAL_GRANT,
	APPROVAL_REJECT,
	BRIDGE_CHANNEL,
	BRIDGE_MESSAGE_TYPE,
	BRIDGE_SOURCE,
	CUSTOM_SOUND_CHOICE,
	CUSTOM_SOUND_MAX_BYTES,
	CUSTOM_SOUND_PERSIST_KEY,
	DEFAULTS,
	DEFAULT_NOTIFY_MODE,
	DESKTOP_ACTIVATION_ROUTE,
	NOTIFY_MODE_ALWAYS,
	NOTIFY_MODE_PERSIST_KEY,
	NOTIFY_MODE_UNFOCUSED,
	NOTIFY_MODES,
	NOTIFY_PERSIST_KEY,
	NOTIFICATION_TAG,
	NOTIFY_KIND_COMPLETED,
	NOTIFY_KIND_WAITING,
	NOTIFY_LANGUAGE_AUTO,
	NOTIFY_LANGUAGE_EN,
	NOTIFY_LANGUAGE_PERSIST_KEY,
	NOTIFY_LANGUAGE_ZH,
	NOTIFY_LANGUAGES,
	NS,
	PLUGIN_BUILD,
	PLUGIN_PACKAGE_NAME,
	PLUGIN_VERSION,
	QUESTION_GRACE_MS,
	QUESTION_ALIGN_MARGIN,
	QUESTION_ALIGN_TOLERANCE,
	QUESTION_FLOW_ATTR,
	QUESTION_MAX_ATTEMPTS,
	QUESTION_POLL_MS,
	QUESTION_ROW_ATTR,
	QUESTION_ROW_KINDS,
	QUESTION_ROW_SELECTOR,
	QUESTION_SCROLL_ATTR,
	QUESTION_SESSION_ATTR,
	QUESTION_STABLE_ATTEMPTS,
	REPORT_GRACE_MS,
	SOUND_CHOICES,
	SOUND_CHOICE_PERSIST_KEY,
	SOUND_PERSIST_KEY,
	SUBAGENT_PERSIST_KEY,
	STICKY_PERSIST_KEY,
	TEST_APPROVAL_KEY,
	UPDATE_APPLY_ROUTE,
	UPDATE_CHECK_ROUTE,
	UPDATE_IDLE,
	VOLUME_BOOST,
	VOLUME_MAX,
	VOLUME_MIN,
	VOLUME_PERSIST_KEY,
	VOLUME_STEP,
	WAIT_TITLE_KEYS,
	alignQuestionRow,
	clampVolume,
	compareVersions,
	conversationColumnInfo,
	createActionBridge,
	createNotifier,
	en,
	findLatestQuestionRow,
	findSelfBundleUrl,
	isHiddenElement,
	isNewerVersion,
	isServiceWorkerScope,
	isSubagentSession,
	mountedSessionId,
	normalizeCustomMeta,
	newerRecord,
	notifyLanguageFromLocale,
	pickConversationColumn,
	questionScroller,
	resolveDoNotifySubagent,
	resolveStickyNotifications,
	resolveNotifyLanguage,
	resolveNotifyMode,
	resolveSoundChoice,
	titleOf,
	updatePresentation,
	updateReducer,
	updateRouteUrl,
	zh,
} = diagnostics;

const failures = [];
const check = (name, ok, detail) => {
	if (ok) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures.push(name);
	console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};
const closeTo = (actual, expected, epsilon = 1e-3) => typeof actual === 'number' && Math.abs(actual - expected) <= epsilon;

// ---------------------------------------------------------------------------
// 静态面：模块身份、文案、音效表、归一化函数
// ---------------------------------------------------------------------------

console.log('模块与文案');
check('浏览器半侧模块 id 与包名一致（@hawkongz/dsh-task-reminder）', definition.id === '@hawkongz/dsh-task-reminder', definition.id);
check('插件形状正确（name / inject / apply）', plugin.name === 'dsh-task-reminder' && typeof plugin.apply === 'function'
	&& JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale', 'sessions', 'remote', 'uiSession', 'uiWorkspace', 'timer']), JSON.stringify(plugin.inject));
// 顶层一个声明都不许有：这份脚本可能被重新求值（HMR / 再次装载），顶层 `const`
// 会进全局词法环境，第二次求值直接抛「已声明」而让整个插件失效。这里用间接
// eval 在全局作用域连跑两次 —— 还有顶层声明就会在这里炸。
check('源码可重复求值（顶层无声明，重新装载不会因重复声明整条失效）', (() => {
	try {
		(0, eval)(source); // eslint-disable-line no-eval
		(0, eval)(source); // eslint-disable-line no-eval
		return true;
	} catch {
		return false;
	}
})(), '第二次求值抛错：说明顶层还有声明');

const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
check('中英文案键集合一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), JSON.stringify({ zhKeys, enKeys }));
check('全部文案非空', zhKeys.every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('应用内卡片相关文案已全部移除（卡片通道删除）', !('toast.title' in zh) && !('toast.open' in zh) && !('toast.close' in zh)
	&& !zhKeys.some((key) => key.startsWith('width.') || key.startsWith('height.') || key.startsWith('preview.')), JSON.stringify(zhKeys));
check('三种停止各有弹窗标题文案', ['toast.completed.title', 'toast.question.title', 'toast.error.title'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('「等你操作」按挂起类型分三个标题（审批请求 / 提问 / 方案待确认）+ 通用兜底', (() => {
	const keys = ['toast.approval.title', 'toast.question.title', 'toast.plan.title', 'toast.waiting.title'];
	if (!keys.every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== '')) return false;
	if (new Set(keys.map((key) => zh[key])).size !== keys.length) return false; // 四个标题互不相同
	return WAIT_TITLE_KEYS.approval === 'toast.approval.title' && WAIT_TITLE_KEYS['plan-review'] === 'toast.plan.title'
		&& WAIT_TITLE_KEYS.question === 'toast.question.title' && WAIT_TITLE_KEYS.other === undefined;
})(), JSON.stringify({ approval: zh['toast.approval.title'], question: zh['toast.question.title'], plan: zh['toast.plan.title'] }));
check('审批弹窗有「同意 / 拒绝」两个按钮的文案', typeof zh['toast.approve'] === 'string' && zh['toast.approve'] !== '' && typeof zh['toast.reject'] === 'string' && zh['toast.reject'] !== ''
	&& typeof en['toast.approve'] === 'string' && en['toast.approve'] !== '' && typeof en['toast.reject'] === 'string' && en['toast.reject'] !== '');
check('通知语言设置：只有两档（简体中文 / English，没有「跟随界面」）+ 持久化键', NOTIFY_LANGUAGES.length === 2
	&& NOTIFY_LANGUAGES.map((item) => item.id).join(',') === 'zh,en'
	&& NOTIFY_LANGUAGES.every((item) => typeof zh[item.nameKey] === 'string' && zh[item.nameKey] !== '')
	&& !('notify.language.auto' in zh) && !('notify.language.auto' in en)
	&& typeof zh['notify.language.title'] === 'string' && typeof NOTIFY_LANGUAGE_PERSIST_KEY === 'string' && NOTIFY_LANGUAGE_PERSIST_KEY.startsWith('dsh.task-reminder.'),
	JSON.stringify(NOTIFY_LANGUAGES.map((item) => item.id)));
check('通知语言默认仍是 auto（跟随界面），它只是不再作为选项出现', DEFAULTS.notifyLanguage === NOTIFY_LANGUAGE_AUTO);
check('通知语言归一化：坏值退回 auto，钉住时认 zh / en', resolveNotifyLanguage(NOTIFY_LANGUAGE_ZH) === 'zh' && resolveNotifyLanguage(NOTIFY_LANGUAGE_EN) === 'en'
	&& resolveNotifyLanguage(NOTIFY_LANGUAGE_AUTO) === 'auto' && resolveNotifyLanguage('zh-CN') === 'auto' && resolveNotifyLanguage(undefined) === 'auto' && resolveNotifyLanguage(null) === 'auto');
check('界面语言折算通知语言：区域码取主语言，认不出按中文', notifyLanguageFromLocale('en') === 'en' && notifyLanguageFromLocale('en-US') === 'en'
	&& notifyLanguageFromLocale('zh-CN') === 'zh' && notifyLanguageFromLocale('ja') === 'zh' && notifyLanguageFromLocale(undefined) === 'zh');
check('没有「试听」按钮文案（切换音效即发声）', !Object.keys(zh).some((key) => zh[key] === '试听'));
check('设置页有导航标题与导语', typeof zh['nav'] === 'string' && zh['nav'] !== '' && typeof zh['intro'] === 'string' && zh['intro'] !== '');
check('弹窗/提示音两个开关只有标题（自解释的行不再带说明）', ['settings.notify.title', 'settings.sound.title'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('自解释的行不再有说明文案（系统弹窗 / 通知语言 / 子智能体 / 完成提示音）', ['settings.notify.description', 'notify.mode.description', 'notify.language.description', 'subagent.description', 'settings.sound.description'].every((key) => !(key in zh) && !(key in en)));
check('留下的说明文案都很短（≤ 60 字，给用户看的短句）', ['sound.choice.description', 'sound.custom.empty', 'volume.description', 'reset.description', 'reset.descriptionDefault', 'notify.mode.always.description', 'notify.mode.unfocused.description'].every((key) => typeof zh[key] === 'string' && zh[key].length > 0 && zh[key].length <= 60), JSON.stringify(['sound.choice.description', 'sound.custom.empty', 'volume.description', 'reset.description', 'notify.mode.always.description', 'notify.mode.unfocused.description'].map((key) => [key, zh[key]?.length])));
check('按用户要求删掉的解释不再出现（音效生成的实现细节 / 自定义音频的存储细节）', !zh['sound.choice.description'].includes('Web Audio') && !zh['sound.choice.description'].includes('只存本地')
	&& !zh['sound.custom.empty'].includes('IndexedDB') && !zh['sound.custom.empty'].includes('不会上传')
	&& !en['sound.choice.description'].includes('Web Audio') && !en['sound.custom.empty'].includes('IndexedDB'), JSON.stringify({ choice: zh['sound.choice.description'], custom: zh['sound.custom.empty'] }));
check('弹窗时机有标题、两个选项与两档各自的说明', ['notify.mode.title', 'notify.mode.always', 'notify.mode.unfocused', 'notify.mode.always.description', 'notify.mode.unfocused.description'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('两档说明就是用户指定的文案', zh['notify.mode.always.description'] === '「任何情况都弹」：任务一完成就弹，不管浏览器窗口是否在前台'
	&& zh['notify.mode.unfocused.description'] === '「仅非前台窗口」：切走标签页或浏览器窗口失焦（人在别的应用）时才弹',
	JSON.stringify([zh['notify.mode.always.description'], zh['notify.mode.unfocused.description']]));
check('弹窗时机文案注明两种语义', zh['notify.mode.always'] === '任何情况都弹' && zh['notify.mode.unfocused'] === '仅非前台窗口'
	&& en['notify.mode.always'] === 'Always' && en['notify.mode.unfocused'] === 'Only when unfocused');
check('音效/音量/恢复默认各有文案', ['sound.choice.title', 'sound.choice.description', 'volume.title', 'volume.description', 'reset.title', 'reset.description', 'reset.descriptionDefault'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('四种音效各有名字文案', SOUND_CHOICES.every((choice) => typeof zh[choice.nameKey] === 'string' && zh[choice.nameKey] !== '' && typeof en[choice.nameKey] === 'string' && en[choice.nameKey] !== ''));
check('自定义音效有档位名与全部状态文案', ['sound.choice.custom', 'sound.custom.title', 'sound.custom.empty', 'sound.custom.ready', 'sound.custom.loading', 'sound.custom.missing', 'sound.custom.decodeFailed', 'sound.custom.storeFailed', 'sound.custom.tooLarge', 'sound.custom.unsupported', 'sound.custom.pick', 'sound.custom.clear'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('自定义档下标排在四种合成音效之后', CUSTOM_SOUND_CHOICE === SOUND_CHOICES.length && CUSTOM_SOUND_CHOICE === 4, String(CUSTOM_SOUND_CHOICE));
check('自定义音效的元数据持久化键符合约定', CUSTOM_SOUND_PERSIST_KEY === 'dsh.task-reminder.custom-sound');
check('自定义音频有字节上限（正整数，防误选大文件）', Number.isInteger(CUSTOM_SOUND_MAX_BYTES) && CUSTOM_SOUND_MAX_BYTES > 0, String(CUSTOM_SOUND_MAX_BYTES));
check('通知权限有三条提示文案', ['notify.unsupported', 'notify.denied', 'notify.pending'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('步进器有增减无障碍标签', typeof zh['decrease'] === 'string' && typeof zh['increase'] === 'string' && typeof en['decrease'] === 'string' && typeof en['increase'] === 'string');
check('导语说明唯一视觉通道是 Windows 系统弹窗', zh['intro'].includes('Windows 系统弹窗') && !zh['intro'].includes('卡片'), zh['intro'].slice(0, 40));
check('系统通知 tag 固定', typeof NOTIFICATION_TAG === 'string' && NOTIFICATION_TAG === 'dsh-task-reminder');

console.log('弹窗时机、音效表、音量换算与归一化');
check('两种弹窗时机（任何情况都弹 / 仅非前台窗口）', NOTIFY_MODES.length === 2
	&& NOTIFY_MODES[0].id === 'always' && NOTIFY_MODES[1].id === 'unfocused'
	&& NOTIFY_MODE_ALWAYS === 'always' && NOTIFY_MODE_UNFOCUSED === 'unfocused', JSON.stringify(NOTIFY_MODES));
check('默认时机是「任何情况都弹」', DEFAULT_NOTIFY_MODE === 'always' && DEFAULTS.notifyMode === 'always', String(DEFAULTS.notifyMode));
check('弹窗时机持久化键符合约定', NOTIFY_MODE_PERSIST_KEY === 'dsh.task-reminder.notify-mode');
check('resolveNotifyMode 接受合法值', resolveNotifyMode('always') === 'always' && resolveNotifyMode('unfocused') === 'unfocused');
check('resolveNotifyMode 坏值退回默认时机', resolveNotifyMode('nonsense') === 'always' && resolveNotifyMode(undefined) === 'always' && resolveNotifyMode(null) === 'always' && resolveNotifyMode(42) === 'always');

check('四种音效', Array.isArray(SOUND_CHOICES) && SOUND_CHOICES.length === 4, String(SOUND_CHOICES.length));
check('音效 id 互不重复', new Set(SOUND_CHOICES.map((choice) => choice.id)).size === SOUND_CHOICES.length, SOUND_CHOICES.map((choice) => choice.id).join());
check('每种音效至少两个音、参数都为正', SOUND_CHOICES.every((choice) => choice.notes.length >= 2
	&& choice.notes.every((noteSpec) => noteSpec.frequency > 0 && noteSpec.duration > 0 && noteSpec.peak > 0 && noteSpec.peak <= 1 && noteSpec.at >= 0)));
check('音效波形只有正弦与三角', SOUND_CHOICES.every((choice) => choice.type === 'sine' || choice.type === 'triangle'));
check('四种音效的节奏/频率表两两不同（听得出区别）', (() => {
	const shapes = SOUND_CHOICES.map((choice) => choice.notes.map((noteSpec) => `${noteSpec.frequency}@${noteSpec.at}`).join(','));
	return new Set(shapes).size === SOUND_CHOICES.length;
})());
check('默认值符合验收（弹窗开且任何情况都弹 / 声音开 / 第一种音效 / 音量 80）', DEFAULTS.notify === true && DEFAULTS.notifyMode === 'always' && DEFAULTS.sound === true && DEFAULTS.soundChoice === 0 && DEFAULTS.volume === 80, JSON.stringify(DEFAULTS));
check('音量整档上调 20（VOLUME_BOOST=20）', VOLUME_BOOST === 20, String(VOLUME_BOOST));
check('显示 80 = 原 100 的响度（master 1.0，峰值 0.4375/0.3625）', closeTo(SOUND_CHOICES[0].notes[0].peak * (DEFAULTS.volume + VOLUME_BOOST) / 100, 0.4375) && closeTo(SOUND_CHOICES[0].notes[1].peak * (DEFAULTS.volume + VOLUME_BOOST) / 100, 0.3625), JSON.stringify(SOUND_CHOICES[0].notes));
check('显示 100 = 原 120 的响度（上限不削波，峰值仍 < 1）', SOUND_CHOICES.every((choice) => choice.notes.every((noteSpec) => noteSpec.peak * (VOLUME_MAX + VOLUME_BOOST) / 100 < 1)));
check('音量说明只保留增益与插值，不带上调解释（按用户要求去掉）', zh['volume.description'] === '提示音的整体增益，当前 {value}%；0 为静音'
	&& en['volume.description'] === 'Overall gain of the chime, currently {value}%; 0 mutes it'
	&& !zh['volume.description'].includes('整档') && !en['volume.description'].includes('shifted up by 20'), JSON.stringify({ zh: zh['volume.description'], en: en['volume.description'] }));

check('resolveSoundChoice 接受合法下标（含 0 与自定义档）', [0, 1, 2, 3, CUSTOM_SOUND_CHOICE].every((index) => resolveSoundChoice(index) === index));
check('resolveSoundChoice 夹住越界与坏值', resolveSoundChoice(9) === CUSTOM_SOUND_CHOICE && resolveSoundChoice(-2) === 0 && resolveSoundChoice(Number.NaN) === 0 && resolveSoundChoice('x') === 0 && resolveSoundChoice(null) === 0);
check('resolveSoundChoice 四舍五入到整数档', resolveSoundChoice(1.4) === 1 && resolveSoundChoice(2.6) === 3);
check('normalizeCustomMeta 保留合法元数据', JSON.stringify(normalizeCustomMeta({ name: 'ding.mp3', size: 1234.6, type: 'audio/mpeg', at: 7 })) === JSON.stringify({ name: 'ding.mp3', size: 1235, type: 'audio/mpeg', at: 7 }), JSON.stringify(normalizeCustomMeta({ name: 'ding.mp3', size: 1234.6, type: 'audio/mpeg', at: 7 })));
check('normalizeCustomMeta 坏值一律视为没有自定义音效', normalizeCustomMeta(null) === null && normalizeCustomMeta('ding.mp3') === null && normalizeCustomMeta({}) === null && normalizeCustomMeta({ name: '' }) === null && normalizeCustomMeta({ name: '   ' }) === null && normalizeCustomMeta({ name: 'a.mp3', size: -5, type: 7, at: 'x' }).size === 0);
check('clampVolume 夹住 0~100', clampVolume(0) === 0 && clampVolume(100) === 100 && clampVolume(140) === 100 && clampVolume(-5) === 0);
check('clampVolume 坏值退回默认音量', clampVolume(Number.NaN) === DEFAULTS.volume && clampVolume('loud') === DEFAULTS.volume && clampVolume(null) === DEFAULTS.volume);
check('音量区间覆盖 0~100 且步进为正', VOLUME_MIN === 0 && VOLUME_MAX === 100 && VOLUME_STEP > 0);

console.log('titleOf');
const listSnapshot = { ids: ['s1', 's2', 's3'], byId: {
	s1: { title: '给接口加缓存', displayTitle: '给接口加缓存' },
	s2: { displayTitle: 'my-project' },
} };
const ctxForTitle = { sessions: { list: { getSnapshot: () => listSnapshot } } };
check('优先取 durable 标题', titleOf(ctxForTitle, 's1') === '给接口加缓存', titleOf(ctxForTitle, 's1'));
check('没有 durable 标题时取展示名', titleOf(ctxForTitle, 's2') === 'my-project', titleOf(ctxForTitle, 's2'));
check('列表里没有时退回会话 id', titleOf(ctxForTitle, 's3') === 's3', titleOf(ctxForTitle, 's3'));
check('列表整体读不到也不抛', titleOf({ sessions: { list: { getSnapshot: () => { throw new Error('boom'); } } } }, 's1') === 's1');

// ---------------------------------------------------------------------------
// apply：桩服务驱动真实装载路径
// ---------------------------------------------------------------------------

const dictionaries = [];
const injections = [];
const listeners = [];
const opened = [];
/** 跨工作区跳转时被 openWorkspace 切过的工作区（见 uiWorkspace 桩）。 */
const openedWorkspaces = [];
/** 模拟「openSession 对这些会话静默无效」（跨工作区时 DSH 的真实行为）。 */
const silentOpenSessions = new Set();
/** 工作区快照桩：默认空，用例要验跨工作区时临时塞 items。 */
let workspaceSnapshot = { items: [], pinnedSessionIds: [], archivedSessionIds: [] };
const timerEntries = [];
const effects = [];
/** DSH 界面语言（locale 快照 active）：用例可改它验证「跟随界面」。 */
let activeLocale = 'zh-CN';
/** locale 订阅者（插件的「生效语言」跟着界面语言走时用）。 */
const localeSubscribers = new Set();
/** 模拟一次界面语言切换通知。 */
const notifyLocaleChange = () => {
	for (const fn of [...localeSubscribers]) fn();
};

const t = (key, params) => {
	const dict = dictionaries.at(-1)?.dicts?.zh ?? {};
	let text = dict[key] ?? key;
	if (params !== null && typeof params === 'object') {
		for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
	}
	return text;
};

/** 宿主列表快照：s1 页面加载前就在跑，s2 / s3 空闲。 */
let hostList = { ids: ['s1', 's2', 's3'], byId: {
	s1: { title: '旧任务', displayTitle: '旧任务', running: true },
	s2: { title: '另一个会话', displayTitle: '另一个会话', running: false },
	s3: { title: '第三个会话', displayTitle: '第三个会话', running: false },
} };

/** 会话列表订阅者（通道二）与会话运行位改写助手。 */
const listListeners = new Set();
const fireList = () => {
	for (const listener of [...listListeners]) listener();
};
const setRunning = (id, running) => {
	if (running === true) nextTurn(); // running=true 的观测 = 新回合开始（见 fakeTurn 注释）
	hostList.byId = { ...hostList.byId, [id]: { ...hostList.byId[id], running } };
	fireList();
};

/**
 * 停止分类读取的假事件窗口：改 fakeTurnEndReason 即改变「最后一条 turn/end
 * 的原因」；fakeEventEntries 非空时整窗替换（供注入「旧 turn/end + 未闭合
 * turn/start」这类窗口）；fakeUsingThrows 模拟 retain/open 失败（插件应走
 * 兜底）；fakeUsingGate 非空时 using 等这个 Promise 落地再返回（可控闸门，
 * 用于把分类摁在途再放重复边沿）。
 */
let fakeTurnEndReason = { kind: 'completed' };
let fakeUsingThrows = false;
let fakeEventEntries = null;
let fakeUsingGate = null;
/**
 * 合成持久日志里「最新回合」的回合号（1.5.4 起停止去重按回合号判「同一次停止」）。
 * 凡是代表「会话开始了一个新回合」的测试动作，这里就 +1：
 *   - 任一通道观测到 running=true（转发事件 / 列表 / sessionStatus 快照）；
 *   - 用户回答了问题（pendingInteraction 消失 = Agent 接着干活的新回合）。
 * 要演练「同一次停止的重复边沿」时不要把号往前推：直接调 rawStatusListener 制造
 * 假的 true→false，或用 fakeEventEntries 把这个窗口钉在固定的回合号上。
 */
let fakeTurn = 1;
const nextTurn = () => { fakeTurn += 1; };
const fakeEventWindow = () => ({
	entries: fakeEventEntries ?? [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: fakeTurn, reason: fakeTurnEndReason } } }],
});

const sessionsStub = {
	list: {
		getSnapshot: () => hostList,
		subscribe(listener) {
			listListeners.add(listener);
			return () => listListeners.delete(listener);
		},
	},
	using(sessionId, options, operation) {
		if (fakeUsingThrows) return Promise.reject(new Error('stub: retain failed'));
		const reference = { ready: Promise.resolve({ eventSource: { getSnapshot: fakeEventWindow } }) };
		if (fakeUsingGate !== null) return fakeUsingGate.then(() => Promise.resolve(operation(reference)));
		return Promise.resolve(operation(reference));
	},
};

/** uiSession.sessionStatus 桩：可改的快照 + 订阅者（等你回答检测读它）。 */
let sessionStatusMap = new Map();
const statusSubscribers = new Set();
const uiSessionStub = {
	sessionStatus: {
		getSnapshot: () => sessionStatusMap,
		subscribe(listener) {
			statusSubscribers.add(listener);
			return () => statusSubscribers.delete(listener);
		},
	},
};
/** 改某个会话的 pendingInteraction 并通知订阅者（null = 已回答，条目仍在、值为空）。 */
const setPendingInteraction = (sessionId, interaction) => {
	const previous = sessionStatusMap.get(sessionId);
	const next = new Map(sessionStatusMap);
	if (interaction === null || interaction === undefined) {
		// 回答 / 交互关闭 = 用户放行，Agent 接着干活的那个新回合开始（回合号 +1）。
		nextTurn();
		next.set(sessionId, { running: previous?.running ?? false, pendingInteraction: undefined, completionUnread: false });
	} else next.set(sessionId, { running: true, pendingInteraction: interaction, completionUnread: false });
	sessionStatusMap = next;
	for (const listener of [...statusSubscribers]) listener();
};
/** 只改某个会话的 running 位并通知订阅者（第三完成通道专用，不动 pendingInteraction）。 */
const setStatusRunning = (sessionId, running) => {
	if (running === true) nextTurn(); // running=true 的观测 = 新回合开始（见 fakeTurn 注释）
	const next = new Map(sessionStatusMap);
	next.set(sessionId, { running: running === true, pendingInteraction: next.get(sessionId)?.pendingInteraction, completionUnread: false });
	sessionStatusMap = next;
	for (const listener of [...statusSubscribers]) listener();
};
/**
 * 只改某个会话的「完成未读」电平并通知订阅者（补漏通道专用）：
 * 宿主在后台会话跑完且用户还没打开时点亮它，打开 / 再跑 / 会话消失即清零。
 */
const setCompletionUnread = (sessionId, unread) => {
	const next = new Map(sessionStatusMap);
	next.set(sessionId, {
		running: false,
		pendingInteraction: next.get(sessionId)?.pendingInteraction,
		completionUnread: unread === true,
	});
	sessionStatusMap = next;
	for (const listener of [...statusSubscribers]) listener();
};

/** 整个会话从快照里消失（被删除 / 归档）。 */const dropSessionFromStatus = (sessionId) => {
	const next = new Map(sessionStatusMap);
	next.delete(sessionId);
	sessionStatusMap = next;
	for (const listener of [...statusSubscribers]) listener();
};

const ctxStub = {
	effect(fn, label) {
		const disposer = fn();
		effects.push({ label, disposer });
		return disposer;
	},
	locale: {
		// DSH 当前界面语言（真实宿主是 locale 快照的 active）：通知语言 auto 档读它。
		getSnapshot: () => ({ active: activeLocale }),
		// 界面语言变化通知（真实宿主在切语言时推给订阅者）。
		subscribe(fn) {
			localeSubscribers.add(fn);
			return () => localeSubscribers.delete(fn);
		},
		register(ns, dicts) {
			dictionaries.push({ ns, dicts });
			return () => {};
		},
		// 命名空间感知：插件自己的文案走 task-reminder 字典。现在不再借用
		// ui-chat 的 chat 命名空间（「回到底部」按钮那条路已经删掉）。
		bind: (ns) => (key, params) => (ns === 'chat' ? key : t(key, params)),
	},
	slots: {
		inject(name, callback) {
			injections.push({ name, entry: callback() });
		},
		register(options, component) {
			return { options, component };
		},
	},
	sessions: sessionsStub,
	uiSession: uiSessionStub,
	remote: {
		$on(name, fn) {
			const entry = { name, fn, disposed: false };
			listeners.push(entry);
			return () => {
				entry.disposed = true;
			};
		},
	},
	uiWorkspace: {
		// 真实 `openSession(target)` 走 `replaceMain`，**同步**把 mainReference 指到
		// 目标会话（DSH 自己的「当前会话」判据）；桩照做，否则就测不出
		// 「openSession 到底有没有吃下这个会话」。
		// `silentOpenSessions` 里的会话模拟「openSession 静默无效」——DSH 在目标会话
		// 属于别的工作区时就是这个行为（不抛错、也不切界面）。
		openSession: (id) => {
			opened.push(id);
			if (silentOpenSessions.has(id)) return;
			ctxStub.uiWorkspace.mainReference = { sessionId: id };
		},
		// 跨工作区跳转用：当前主视图会话 + 工作区快照（默认空 = 认不出工作区，
		// 走原来的「直接开会话」路径，不影响其它用例）。
		mainReference: { sessionId: 's1' },
		workspaces: { list: { getSnapshot: () => workspaceSnapshot } },
		openWorkspace: (workspaceId) => {
			openedWorkspaces.push(workspaceId);
			return Promise.resolve();
		},
	},
	timer: {
		timeout(fn, ms) {
			const entry = { fn, ms, cancelled: false, fired: false };
			timerEntries.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
	},
};

console.log('');
console.log('apply（桩服务）');
plugin.apply(ctxStub);

check('注册了 task-reminder 字典（zh/en）', dictionaries.length === 1 && dictionaries[0].ns === NS && typeof dictionaries[0].dicts?.zh?.['settings.notify.title'] === 'string' && typeof dictionaries[0].dicts?.en?.['settings.notify.title'] === 'string');
check('订阅了 api-session/status 完成事件', listeners.some((entry) => entry.name === 'api-session/status' && typeof entry.fn === 'function'));
check('订阅了 api-session/error 出错事件', listeners.some((entry) => entry.name === 'api-session/error' && typeof entry.fn === 'function'));
check('订阅了官方会话列表（第二通道）', listListeners.size === 1, String(listListeners.size));
check('effects 全部登记（字典 / 事件 / 列表 / 焦点 / 拉活 / 权限 / 提示音 / 排障）', effects.length >= 8, String(effects.length));
check('只注册了 settings.section 一个 slot（也就没有 shell.overlay 浮层：卡片通道已删除）', injections.length === 1 && injections[0].name === 'settings.section', JSON.stringify(injections.map((item) => item.name)));

// 「设置 → 通用」里不再有开关：上面那条「只注册一个 slot」已经蕴含（没有 settings.general.item）。

const section = injections.find((item) => item.name === 'settings.section');
check('独立设置页注册在 settings.section', section !== undefined && section.entry.options.id === 'task-reminder' && section.entry.options.locale === NS, JSON.stringify(section?.entry.options));
check('设置页 order 避开 chat-locator(41)', section.entry.options.order === 44, String(section.entry.options.order));
check('设置页导航标题走本地化', section.entry.options.label() === '任务提醒', section.entry.options.label());
const sectionFace = () => section.entry.options.inject();
const face = sectionFace();
check('设置页 face 带八个配置 store 与写回函数', ['notifyStore', 'notifyModeStore', 'notifyLanguageStore', 'soundStore', 'soundChoiceStore', 'volumeStore', 'subagentStore', 'stickyStore', 'permissionStore'].every((name) => typeof face[name]?.getSnapshot === 'function')
	&& ['setNotify', 'setNotifyMode', 'setNotifyLanguage', 'setSound', 'setSoundChoice', 'setVolume', 'setSubagent', 'setSticky'].every((name) => typeof face[name] === 'function'));
check('设置页 face 带自定义音效的 store、写回函数与支持标志', typeof face.customMetaStore?.getSnapshot === 'function' && typeof face.customStatusStore?.getSnapshot === 'function'
	&& typeof face.setCustomSound === 'function' && typeof face.clearCustomSound === 'function' && face.customSupported === true, JSON.stringify({ customSupported: face.customSupported }));
check('设置页 face 带审批快捷裁决桥的状态 store', typeof face.bridgeStateStore?.getSnapshot === 'function', typeof face.bridgeStateStore?.getSnapshot);
check('设置页 face 不带卡片相关（宽度/高度/预览/弹窗开关）', !('widthStore' in face) && !('heightStore' in face) && !('setWidth' in face) && !('setHeight' in face) && !('popupStore' in face) && !('preview' in face));
check('设置页 face 带恢复默认、通知支持标志与本地化函数', typeof face.reset === 'function' && typeof face.notifySupported === 'boolean' && typeof face.t === 'function');
check('浏览器桩支持 Notification 时 notifySupported 为真', face.notifySupported === true);

check('十四个 store：九个持久化 + 权限 / 桥状态 / 生效语言 / 自定义音效状态 / 更新状态不持久化', persistedStores.length === 14
	&& persistedStores[0].options?.persist?.name === NOTIFY_PERSIST_KEY
	&& persistedStores[1].options?.persist?.name === NOTIFY_MODE_PERSIST_KEY
	&& persistedStores[2].options?.persist?.name === SOUND_PERSIST_KEY
	&& persistedStores[3].options?.persist?.name === SOUND_CHOICE_PERSIST_KEY
	&& persistedStores[4].options?.persist?.name === VOLUME_PERSIST_KEY
	&& persistedStores[5].options?.persist?.name === SUBAGENT_PERSIST_KEY
	&& persistedStores[6].options?.persist?.name === STICKY_PERSIST_KEY
	&& persistedStores[7].options?.persist?.name === NOTIFY_LANGUAGE_PERSIST_KEY
	&& persistedStores[8].options === undefined
	&& persistedStores[9].options?.persist?.name === CUSTOM_SOUND_PERSIST_KEY
	&& persistedStores[10].options === undefined && persistedStores[11].options === undefined && persistedStores[12].options === undefined
	&& persistedStores[13].options === undefined, JSON.stringify(persistedStores.map((store) => store.options?.persist?.name)));
check('自定义音效的元数据默认空（没上传过就是 null）', face.customMetaStore.getSnapshot() === null && DEFAULTS.customSound === null && face.customStatusStore.getSnapshot() === 'idle', JSON.stringify({ meta: face.customMetaStore.getSnapshot(), status: face.customStatusStore.getSnapshot() }));
check('八个配置默认值符合出厂表', face.notifyStore.getSnapshot() === DEFAULTS.notify
	&& face.notifyModeStore.getSnapshot() === DEFAULTS.notifyMode
	&& face.notifyLanguageStore.getSnapshot() === DEFAULTS.notifyLanguage
	&& face.soundStore.getSnapshot() === DEFAULTS.sound
	&& face.soundChoiceStore.getSnapshot() === DEFAULTS.soundChoice
	&& face.volumeStore.getSnapshot() === DEFAULTS.volume
	&& face.subagentStore.getSnapshot() === DEFAULTS.subagent
	&& face.stickyStore.getSnapshot() === DEFAULTS.sticky);
check('通知语言默认跟随界面', DEFAULTS.notifyLanguage === NOTIFY_LANGUAGE_AUTO && face.notifyLanguageStore.getSnapshot() === 'auto', String(face.notifyLanguageStore.getSnapshot()));
check('系统弹窗默认开启且时机为「任何情况都弹」', face.notifyStore.getSnapshot() === true && face.notifyModeStore.getSnapshot() === 'always');
check('子智能体提醒默认关闭（默认不提示子智能体）', DEFAULTS.subagent === false && face.subagentStore.getSnapshot() === false, String(face.subagentStore.getSnapshot()));
check('子智能体开关只认布尔真值（坏值退回关）', resolveDoNotifySubagent(true) === true && resolveDoNotifySubagent(false) === false
	&& resolveDoNotifySubagent('true') === false && resolveDoNotifySubagent(1) === false && resolveDoNotifySubagent(undefined) === false && resolveDoNotifySubagent(null) === false);
check('「弹窗一直挂着」默认关闭（横幅照旧自动收）', DEFAULTS.sticky === false && face.stickyStore.getSnapshot() === false, String(face.stickyStore.getSnapshot()));
check('「弹窗一直挂着」开关只认布尔真值（坏值退回关）', resolveStickyNotifications(true) === true && resolveStickyNotifications(false) === false
	&& resolveStickyNotifications('true') === false && resolveStickyNotifications(1) === false && resolveStickyNotifications(undefined) === false);
check('isSubagentSession 只认 origin === "subagent"', (() => {
	const ctxFor = (byId) => ({ sessions: { list: { getSnapshot: () => ({ ids: [], byId }) } } });
	return isSubagentSession(ctxFor({ a: { origin: 'subagent' } }), 'a') === true
		&& isSubagentSession(ctxFor({ b: { parentId: 'a' } }), 'b') === false // fork：有 parentId 但 origin 不是 subagent
		&& isSubagentSession(ctxFor({ c: {} }), 'c') === false
		&& isSubagentSession(ctxFor({}), 'missing') === false // 行还没进列表：不当子智能体
		&& isSubagentSession({ sessions: { list: { getSnapshot: () => { throw new Error('boom'); } } } }, 'a') === false;
})());

check('排障钩子暴露了状态与版本号', typeof windowStub.__dshTaskReminder?.state === 'function' && typeof windowStub.__dshTaskReminder.version === 'string', String(windowStub.__dshTaskReminder?.version));
// 版本号写在 client.js 与 package.json 两处，漂了就发错版本的包（1.4.4 之前漂过）。
check('client.js 的版本号与 package.json 一致', PLUGIN_VERSION === packageJson.version, `client.js=${PLUGIN_VERSION} package.json=${packageJson.version}`);
check('排障钩子带当场试一次（test）', typeof windowStub.__dshTaskReminder?.test === 'function');
check('排障钩子带只放音（sound）', typeof windowStub.__dshTaskReminder?.sound === 'function');
check('排障钩子带直接跳会话（jump）', typeof windowStub.__dshTaskReminder?.jump === 'function');
check('排障状态覆盖七个配置、弹窗时机、通知权限、前台状态与检查更新', (() => {
	const state = windowStub.__dshTaskReminder.state();
	return ['notify', 'notifyMode', 'notifyLanguage', 'notifyLanguageResolved', 'sound', 'soundChoice', 'volume', 'subagent', 'focused', 'notificationPermission', 'notificationSupported', 'update'].every((key) => key in state) && !('toasts' in state) && !('popup' in state);
})());
check('排障状态里的检查更新就是设置页那一行（未查过时 idle + 当前版本）', (() => {
	const state = windowStub.__dshTaskReminder.state().update;
	return state.phase === 'idle' && state.current === PLUGIN_VERSION && state.latest === null;
})());
check('做种后 s1 记为 running、s2/s3 记为空闲', JSON.stringify(windowStub.__dshTaskReminder.state().running) === JSON.stringify([['s1', true], ['s2', false], ['s3', false]]), JSON.stringify(windowStub.__dshTaskReminder.state().running));

/** 取一个元素的直接子元素（桩里单数组参数会产生一层嵌套，统一拍平）。 */
const kidsOf = (node) => (Array.isArray(node.children) ? node.children : []).flat(Infinity);
/** 整页渲染设置页并拍平成节点表。 */
const renderSection = () => {
	const nodes = [];
	const walk = (node) => {
		if (node === null || typeof node !== 'object') return;
		nodes.push(node);
		for (const child of (Array.isArray(node.children) ? node.children : []).flat(Infinity)) walk(child);
	};
	walk(section.entry.component(sectionFace()));
	return nodes;
};
let sectionNodes = renderSection();
/** 按渲染顺序收集设置页里的全部文本（用来断言某段说明确实出现在页面上）。 */
const sectionTexts = () => {
	const texts = [];
	const walk = (node) => {
		if (typeof node === 'string') {
			texts.push(node);
			return;
		}
		if (node === null || typeof node !== 'object') return;
		for (const child of (Array.isArray(node.children) ? node.children : []).flat(Infinity)) walk(child);
	};
	walk(section.entry.component(sectionFace()));
	return texts;
};
check('弹窗时机那一行把两档的说明都摆出来', (() => {
	const texts = sectionTexts();
	return texts.includes(zh['notify.mode.always.description']) && texts.includes(zh['notify.mode.unfocused.description']);
})(), JSON.stringify(sectionTexts().filter((text) => text.includes('弹窗') || text.includes('前台') || text.includes('失焦'))));
check('两档说明各占一行（block），不是挤成一句', (() => {
	const lines = sectionNodes.filter((node) => node?.props?.style?.display === 'block'
		&& (Array.isArray(node.children) ? node.children : []).flat(Infinity).some((child) => typeof child === 'string'
			&& (child === zh['notify.mode.always.description'] || child === zh['notify.mode.unfocused.description'])));
	return lines.length === 2;
})(), '说明行不是两个 block 元素');

// 通知权限自动申请：首次装载 + 弹窗默认开着 + 权限未定 → 替用户申请一次并记账。
check('首次装载即替用户申请一次通知权限', notificationLog.requested === 1, String(notificationLog.requested));
check('申请记录落进 localStorage（之后不再自动问）', windowStub.localStorage.getItem('dsh.task-reminder.permission-asked') === '1', windowStub.localStorage.getItem('dsh.task-reminder.permission-asked'));
check('自动申请不改动弹窗开关本身', face.notifyStore.getSnapshot() === true);

// 装载即创建 AudioContext：Windows 音频设备冷初始化（3-5 秒）在页面加载时
// 提前付掉；无手势时 context 被自动播放策略挂在 suspended 不渲染，只排一条
// 听不见的预热音。第一次用户手势负责 resume 与兜底预热。
check('装载即创建 AudioContext（设备初始化提前付掉）', audioLog.contexts === 1, String(audioLog.contexts));
check('装载期只排一条听不见的预热音（gain 0，无可闻提示音）', audioLog.oscillators.length === 1 && audioLog.gains.length === 1 && audioLog.gains[0].peak === null, JSON.stringify(audioLog.gains));
fireWindow('pointerdown');
check('第一次用户手势只做 resume/兜底，不再建 context、不再加预热音', audioLog.contexts === 1 && audioLog.oscillators.length === 1, `${audioLog.contexts} / ${audioLog.oscillators.length}`);

// ---------------------------------------------------------------------------
// 完成事件驱动：边沿、两条通道、去重、两种弹窗时机
// ---------------------------------------------------------------------------

/**
 * 宿主转发事件 api-session/status 的插件回调。raw 版本原样转给插件（演练「同一次
 * 停止的重复边沿」时用它制造假的 running=true→false，回合号不动）；statusListener
 * 是常规入口：running=true 代表新回合开始，先把合成日志的回合号 +1 再转给插件。
 */
const rawStatusListener = listeners.find((entry) => entry.name === 'api-session/status').fn;
const statusListener = (sessionId, running) => {
	if (running === true) nextTurn();
	rawStatusListener(sessionId, running);
};
const resetAudioLog = () => {
	audioLog.oscillators.length = 0;
	audioLog.gains.length = 0;
	audioLog.bufferSources.length = 0;
};
const resetNotificationLog = () => {
	notificationLog.created.length = 0;
	notificationLog.requested = 0;
	notificationLog.closed = 0;
	notificationLog.focused = 0;
};
/** 完成一次任务（走事件通道，s2 专用）。 */
const completeOnce = () => {
	statusListener('s2', true);
	statusListener('s2', false);
};
/** 兜底/对账定时器到点：把未取消的定时器条目当场打到（桩里时间不走，手动推进）。 */
const flushTimers = () => {
	for (const entry of timerEntries) {
		if (entry.cancelled || entry.fired) continue;
		entry.fired = true;
		entry.fn();
	}
};

console.log('');
console.log('完成事件（停止边沿 → turn/end 分类）');

// 权限授予后：默认时机「任何情况都弹」—— 页面有焦点也弹。停止边沿读得
// turn/end{completed}：提示音与弹窗在同一次处理里发出，没有延迟窗口。
FakeNotification.permission = 'granted';
resetNotificationLog();
resetAudioLog();
completeOnce();
await tick();
check('完成边沿：分类读得 completed → 提示音与弹窗同轮发出', notificationLog.created.length === 1 && audioLog.oscillators.length === 2, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
check('任务完成即发一条系统弹窗（默认任何情况都弹）', notificationLog.created.length === 1, String(notificationLog.created.length));
check('弹窗标题/正文', notificationLog.created[0]?.title === '对话任务已完成' && notificationLog.created[0]?.options?.body === '另一个会话', JSON.stringify(notificationLog.created[0]));
check('tag 按类型固定（等待 / 完成 / 出错各一个槽位，同类型替换上一条）', notificationLog.created[0]?.options?.tag === `${NOTIFICATION_TAG}-${NOTIFY_KIND_COMPLETED}`
	&& notificationLog.created[0]?.options?.renotify === true, String(notificationLog.created[0]?.options?.tag));
check('通知标记 silent：声音只由插件自己那套负责（不叠系统提示音）', notificationLog.created[0]?.options?.silent === true, JSON.stringify(notificationLog.created[0]?.options));
// 「弹窗一直挂着」（requireInteraction）默认关：横幅收进通知中心之后再点，
// Electron 在 Windows 上不投递 click（electron#29461），打开后横幅不走、点击
// 必定送达 —— 代价是横幅占屏幕，所以默认关、由设置页那个开关控制（5 类都生效）。
check('默认关闭「弹窗一直挂着」：完成类不设 requireInteraction', notificationLog.created[0]?.options?.requireInteraction === false, JSON.stringify(notificationLog.created[0]?.options));
check('弹窗记进 stats.notifications', windowStub.__dshTaskReminder.state().stats.notifications === 1, String(windowStub.__dshTaskReminder.state().stats.notifications));
check('提示音每次完成都响（页面有焦点也响）', audioLog.oscillators.length === 2 && audioLog.gains.length === 2, String(audioLog.oscillators.length));
check('排障状态记录完成来源为 event', windowStub.__dshTaskReminder.state().stats.lastCompletion?.source === 'event');
// 保活：非持久通知的 JS 对象一旦被回收，点击就再也到不了 onclick；插件热重载
// 还会让旧模块作用域变孤儿、连 onclick 闭包一起收走。所以通知对象压在页面级
// 保活表（window.__dshTaskReminderToasts）里，跨实例按住，点击时才释放。
const toastRegistry = windowStub.__dshTaskReminderToasts;
check('通知对象压在页面级保活表里（按类型留最近一条）', toastRegistry instanceof Map
	&& toastRegistry.get(NOTIFY_KIND_COMPLETED) === notificationLog.created[0], String(toastRegistry?.size));
notificationLog.created[0].onclick();
check('点击弹窗：窗口回前台并打开对应会话、关闭弹窗', notificationLog.focused === 1 && opened.includes('s2') && notificationLog.closed === 1, JSON.stringify(notificationLog));
check('点击弹窗留痕：lastJump 记下会话 / 来源 page / ok', windowStub.__dshTaskReminder.state().stats.lastJump?.ok === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.via === 'page'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.sessionId === 's2', JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
check('点击弹窗留痕：成功次数进 stats.jumps', windowStub.__dshTaskReminder.state().stats.jumps === 1, String(windowStub.__dshTaskReminder.state().stats.jumps));
check('点击后从保活表释放对应类型', toastRegistry.get(NOTIFY_KIND_COMPLETED) === undefined, String(toastRegistry?.size));
check('点击留痕：lastClick 记下 kind / 会话（null 才说明 handler 没跑）', windowStub.__dshTaskReminder.state().stats.lastClick?.kind === NOTIFY_KIND_COMPLETED
	&& windowStub.__dshTaskReminder.state().stats.lastClick?.sessionId === 's2'
	&& windowStub.__dshTaskReminder.state().stats.clicks === 1, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastClick));
// 通知对象比插件实例活得久：插件热重载后点旧通知，回调闭包里的 ctx 已经 dispose。
// 所以回调只查页面级转发表（window.__dshTaskReminderClickRouter），表指向当前实例。
const clickRouter = windowStub.__dshTaskReminderClickRouter;
check('页面级点击转发表已装上处理函数', clickRouter !== undefined && typeof clickRouter.handler === 'function', JSON.stringify(Object.keys(clickRouter ?? {})));
const routed = [];
const previousHandler = clickRouter.handler;
clickRouter.handler = (sessionId) => routed.push(sessionId); // 冒充「新实例」
notificationLog.created[0].onclick();
check('旧通知点击走转发表：交给当前实例（不是闭包里的旧 ctx）', routed.length === 1 && routed[0] === 's2', JSON.stringify(routed));
clickRouter.handler = previousHandler;
// 排障钩子：不用等弹窗也能当场跳一次 —— 把「点击有没有送达」与「跳转本身成不成」拆开。
const openedBeforeDebugJump = opened.length;
check('jump() 直接跳会话并留痕（via = debug）', windowStub.__dshTaskReminder.jump('s3') === true
	&& opened.length === openedBeforeDebugJump + 1 && opened.at(-1) === 's3'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.via === 'debug'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.sessionId === 's3', JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
// 跨工作区：openSession 只在当前工作区内生效 —— 目标会话在别的工作区时它既不抛错
// 也不切界面（2026-10-07 实测：lastJump ok:true、抬窗 204、mountedSession 没变）。
// 所以必须先 openWorkspace 切过去，再 openSession 开目标会话。
// 把「当前会话」放回 ws-ds：桩里的 openSession 会同步搬 mainReference（与真实
// replaceMain 一致），上面那次 jump('s3') 已经把它搬走了。
ctxStub.uiWorkspace.mainReference = { sessionId: 's1' };
workspaceSnapshot = {
	items: [{ workspaceId: 'ws-ds', sessionIds: ['s1', 's2'] }, { workspaceId: 'ws-other', sessionIds: ['s9'] }],
	pinnedSessionIds: [],
	archivedSessionIds: [],
};
const openedBeforeCross = opened.length;
const workspacesBeforeCross = openedWorkspaces.length;
check('跨工作区跳转：先切工作区、不急着开会话', windowStub.__dshTaskReminder.jump('s9') === true
	&& openedWorkspaces.length === workspacesBeforeCross + 1 && openedWorkspaces.at(-1) === 'ws-other'
	&& opened.length === openedBeforeCross, JSON.stringify({ workspaces: openedWorkspaces, opened }));
await tick();
check('跨工作区跳转：工作区落地后打开目标会话', opened.at(-1) === 's9', JSON.stringify(opened.slice(-2)));
check('跨工作区跳转留痕带 crossWorkspace 且最终 ok', windowStub.__dshTaskReminder.state().stats.lastJump?.crossWorkspace === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.ok === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.sessionId === 's9', JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
// mainSession = DSH 自己的当前会话（mainReference）：openSession 生效后它应当已经是
// 目标会话 —— 这是「会话到底切没切」不依赖 DOM 的判据。
check('跳转留痕带 mainSession（openSession 生效后 mainReference 就是目标会话）',
	windowStub.__dshTaskReminder.state().stats.lastJump?.mainSession === 's9'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.mainSessionBefore === 's1',
	JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
// 跳完要核对「界面真的挂到目标会话上了」才开始滚动：跨工作区挂载慢，早滚会滚错会话。
clearQuestionStage();
// 再放回 ws-ds 的会话：目标 s9 已在当前工作区时不走跨工作区那条路，本条要验的
// 正是跨工作区的挂载核对。
ctxStub.uiWorkspace.mainReference = { sessionId: 's1' };
const timersBeforeVerify = timerEntries.length;
windowStub.__dshTaskReminder.jump('s9');
await tick();
check('跨工作区跳完先排核对定时器（不立刻滚动）', timerEntries.length > timersBeforeVerify
	&& timerEntries.at(-1)?.ms === QUESTION_POLL_MS
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.mounted === false
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.crossWorkspace === true
	&& windowStub.__dshTaskReminder.state().stats.lastQuestionJump === undefined, JSON.stringify({ timers: timerEntries.length, jump: windowStub.__dshTaskReminder.state().stats.lastJump }));
installQuestionStage({ mountedSession: 's9', rows: [] });
flushTimers();
check('目标会话挂上来后：核对通过并开始落到提问位置', windowStub.__dshTaskReminder.state().stats.lastJump?.mounted === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.ok === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.verifiedBy === 'dom+main', JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
clearQuestionStage();
workspaceSnapshot = { items: [], pinnedSessionIds: [], archivedSessionIds: [] };

// ---------------------------------------------------------------------------
// 跳转路径：openSession 在别的会话上是**静默无效**的（不抛错、也不切界面）。
// 2026-10-07 那次真实点击正是踩了这个：crossWorkspace=false、lastJump.ok=true，
// 而 DSH 的 mainReference 压根没动 —— 用户看到的就是「点了不跳会话」。
// 所以：目标工作区认得出、当前工作区认不出时也要走「先切工作区」；首开没生效
// 就当场补救；核对轮询里再升级一次。
// ---------------------------------------------------------------------------

console.log('');
console.log('跳转路径（跨工作区 / openSession 静默无效）');

// 1) 当前工作区认不出来（工作区快照里没有 mainReference 那个会话）：也要切工作区。
clearQuestionStage();
ctxStub.uiWorkspace.mainReference = { sessionId: 's-unknown-ws' };
workspaceSnapshot = { items: [{ workspaceId: 'ws-other', sessionIds: ['s9'] }], pinnedSessionIds: [], archivedSessionIds: [] };
const openedBeforeUnknown = opened.length;
const wsBeforeUnknown = openedWorkspaces.length;
check('当前工作区认不出、目标工作区认得出：走「先切工作区」而不是直接 openSession',
	windowStub.__dshTaskReminder.jump('s9') === true
	&& openedWorkspaces.length === wsBeforeUnknown + 1 && openedWorkspaces.at(-1) === 'ws-other'
	&& opened.length === openedBeforeUnknown
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.crossWorkspace === true,
	JSON.stringify({ workspaces: openedWorkspaces.slice(-2), opened: opened.slice(-2), jump: windowStub.__dshTaskReminder.state().stats.lastJump }));
await tick();
check('认不出当前工作区也照样把目标会话开出来（mainSession = 目标）',
	opened.at(-1) === 's9' && windowStub.__dshTaskReminder.state().stats.lastJump?.mainSession === 's9',
	JSON.stringify({ opened: opened.slice(-2), jump: windowStub.__dshTaskReminder.state().stats.lastJump }));

// 2) 同工作区首开没生效（mainReference 没动）：当场改走「切工作区再开会话」。
clearQuestionStage();
workspaceSnapshot = {
	items: [{ workspaceId: 'ws-ds', sessionIds: ['s1', 's-stuck'] }, { workspaceId: 'ws-other', sessionIds: ['s9'] }],
	pinnedSessionIds: [],
	archivedSessionIds: [],
};
ctxStub.uiWorkspace.mainReference = { sessionId: 's1' };
silentOpenSessions.add('s-stuck');
const wsBeforeRecover = openedWorkspaces.length;
check('同工作区首开没生效：当场补救成「先切工作区、再开会话」（不把 5 秒耗在无效的 openSession 上）',
	windowStub.__dshTaskReminder.jump('s-stuck') === true
	&& openedWorkspaces.length === wsBeforeRecover + 1 && openedWorkspaces.at(-1) === 'ws-ds'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.recoveredBy === 'open-workspace'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.mainSessionBefore === 's1',
	JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
await tick();
check('补救那一步仍没生效时如实留痕（mainSession 还是原会话，不假报成功）',
	windowStub.__dshTaskReminder.state().stats.lastJump?.mainSession === 's1',
	JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));

// 3) 核对轮询里的升级重试：一直静默无效 → 轮询发现没切过去 → 再升级一次并救回来。
clearQuestionStage();
silentOpenSessions.delete('s-stuck');
workspaceSnapshot = { items: [{ workspaceId: 'ws-ds', sessionIds: ['s1'] }, { workspaceId: 'ws-other', sessionIds: ['s-retry'] }], pinnedSessionIds: [], archivedSessionIds: [] };
ctxStub.uiWorkspace.mainReference = { sessionId: 's1' };
silentOpenSessions.add('s-retry');
windowStub.__dshTaskReminder.jump('s-retry');
await tick();
silentOpenSessions.delete('s-retry'); // 升级之后这次 openSession 才生效
flushTimers();
await tick();
check('核对轮询发现没切过去：升级成「切工作区再开会话」，并记 recoveredBy',
	windowStub.__dshTaskReminder.state().stats.lastJump?.recoveredBy === 'open-workspace-retry'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.crossWorkspace === true,
	JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
flushTimers();
check('升级重试后会话切过去：核对通过（mainSession = 目标）',
	windowStub.__dshTaskReminder.state().stats.lastJump?.mounted === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.mainSession === 's-retry',
	JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
clearQuestionStage();
silentOpenSessions.clear();
workspaceSnapshot = { items: [], pinnedSessionIds: [], archivedSessionIds: [] };
ctxStub.uiWorkspace.mainReference = { sessionId: 's1' };

// 桌面壳（DSH Desktop / Electron）：渲染进程的 window.focus() 拉不起最小化 /
// 已关进托盘的窗口，改请宿主半侧跑一次 dsh://open（second-instance →
// focusPrimaryWindow）。**点通知一律发请求**：Electron 里窗口被别的窗口挡住 /
// 最小化时 document.hasFocus() 仍可能报 true（2026-10-07 用户实测：点弹窗不抬窗，
// 手动 POST 同一条路由立刻抬起），按它跳过就等于永远唤不起。
// 普通浏览器（没有 dshDesktop 全局）完全不走这条路。
const desktopRequests = [];
windowStub.dshDesktop = { protocolVersion: 1 };
windowStub.fetch = (input, init) => {
	desktopRequests.push({ input, init });
	return Promise.resolve({ status: 204 });
};
setFocus({ hidden: false, focused: false });
notificationLog.created[0].onclick();
check('桌面壳里窗口失焦时点弹窗会请宿主唤醒窗口', desktopRequests.length === 1 && desktopRequests[0].input === DESKTOP_ACTIVATION_ROUTE && desktopRequests[0].init?.method === 'POST', JSON.stringify(desktopRequests));
setFocus({ hidden: true, focused: true });
notificationLog.created[0].onclick();
check('桌面壳里窗口最小化时点弹窗同样请宿主唤醒', desktopRequests.length === 2, JSON.stringify(desktopRequests));
setFocus({ hidden: false, focused: true });
notificationLog.created[0].onclick();
check('页面自称有焦点也照发请求（hasFocus 不可信，跳过就唤不起）', desktopRequests.length === 3, JSON.stringify(desktopRequests));
check('留痕记下点击那一刻的自述焦点（只用于判断，不再决定发不发）', windowStub.__dshTaskReminder.state().stats.lastActivation?.focused === true, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastActivation));
delete windowStub.dshDesktop;
setFocus({ hidden: false, focused: false });
notificationLog.created[0].onclick();
check('普通浏览器里点弹窗不发唤醒请求', desktopRequests.length === 3, JSON.stringify(desktopRequests));
check('留痕：没有桌面壳全局 → no-desktop', windowStub.__dshTaskReminder.state().stats.lastActivation?.reason === 'no-desktop', JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastActivation));

// 唤醒留痕（stats.lastActivation）：这条链路以前全静默，复现「点了没抬窗」时
// 只能猜；现在每个去路（不发 / 发出 / 应答 / 失败）都记一笔。
windowStub.dshDesktop = { protocolVersion: 1 };
setFocus({ hidden: false, focused: false });
notificationLog.created[0].onclick();
await tick();
check('留痕：发出请求并收到 204 → answered', windowStub.__dshTaskReminder.state().stats.lastActivation?.reason === 'answered' && windowStub.__dshTaskReminder.state().stats.lastActivation?.status === 204, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastActivation));
windowStub.fetch = () => Promise.reject(new Error('connect-failed'));
notificationLog.created[0].onclick();
await tick();
check('留痕：请求失败 → failed 并带上原因', windowStub.__dshTaskReminder.state().stats.lastActivation?.reason === 'failed' && String(windowStub.__dshTaskReminder.state().stats.lastActivation?.error).includes('connect-failed'), JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastActivation));
delete windowStub.fetch;
setFocus({ hidden: false, focused: true });

// 「仅非前台窗口」：页面有焦点 → 不弹，记 skippedFocused。
face.setNotifyMode('unfocused');
resetNotificationLog();
resetAudioLog();
completeOnce();
await tick();
check('仅非前台窗口时：页面有焦点不弹窗', notificationLog.created.length === 0, String(notificationLog.created.length));
check('仅非前台窗口时：有焦点的完成记进 skippedFocused', windowStub.__dshTaskReminder.state().stats.skippedFocused === 1, String(windowStub.__dshTaskReminder.state().stats.skippedFocused));
check('仅非前台窗口时：提示音照响', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));

// 窗口失焦（人在别的应用）：要弹。
setFocus({ hidden: false, focused: false });
check('排障状态跟上失焦（focused=false）', windowStub.__dshTaskReminder.state().focused === false, JSON.stringify(windowStub.__dshTaskReminder.state().focused));
resetNotificationLog();
completeOnce();
await tick();
check('仅非前台窗口时：窗口失焦完成任务弹窗', notificationLog.created.length === 1, String(notificationLog.created.length));

// 标签页被切走：要弹。
setFocus({ hidden: true, focused: true });
check('排障状态跟上标签页隐藏', windowStub.__dshTaskReminder.state().focused === false);
resetNotificationLog();
completeOnce();
await tick();
check('仅非前台窗口时：标签页切走完成任务弹窗', notificationLog.created.length === 1, String(notificationLog.created.length));

// 回到有焦点的可见窗口：重新静默。
setFocus({ hidden: false, focused: true });
check('回到有焦点的窗口时 focused 归位', windowStub.__dshTaskReminder.state().focused === true);
resetNotificationLog();
completeOnce();
await tick();
check('回到前台后仅非前台窗口时不再弹', notificationLog.created.length === 0, String(notificationLog.created.length));

// 「任何情况都弹」：任何前台状态下都弹。
face.setNotifyMode('always');
for (const focus of [{ hidden: false, focused: true }, { hidden: true, focused: true }, { hidden: false, focused: false }]) {
	setFocus(focus);
	resetNotificationLog();
	completeOnce();
	await tick();
	check(`任何情况都弹：${JSON.stringify(focus)} 下完成也弹窗`, notificationLog.created.length === 1, String(notificationLog.created.length));
}
setFocus({ hidden: false, focused: true });

// running→running 的重复事件、以及非 running→非 running 都不再触发。
const before = windowStub.__dshTaskReminder.state().stats.notifications;
statusListener('s2', false);
statusListener('s2', false);
await tick();
check('同一边沿不重复触发', windowStub.__dshTaskReminder.state().stats.notifications === before);

// 通道二：官方会话列表的 running 位变化独立驱动完成（s3 专用，互不干扰）。
resetNotificationLog();
setRunning('s3', true);
setRunning('s3', false);
await tick();
check('列表通道独立收到完成并发弹窗', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === '第三个会话', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
check('排障状态记录完成来源为 list', windowStub.__dshTaskReminder.state().stats.lastCompletion?.source === 'list');

// 两条通道同时看到同一次完成：只触发一次（共用边沿表）。
resetNotificationLog();
const completedBefore = windowStub.__dshTaskReminder.state().stats.completed;
setRunning('s3', true);
statusListener('s3', true);
setRunning('s3', false);
statusListener('s3', false);
await tick();
check('两条通道去重：同一次完成只发一次', notificationLog.created.length === 1, String(notificationLog.created.length));
check('去重后 completed 只加一', windowStub.__dshTaskReminder.state().stats.completed === completedBefore + 1, `${windowStub.__dshTaskReminder.state().stats.completed} vs ${completedBefore + 1}`);

// 关掉弹窗开关：不再发送（提示音不受影响）。
resetNotificationLog();
resetAudioLog();
face.setNotify(false);
completeOnce();
await tick();
check('关掉系统弹窗后不再发送', notificationLog.created.length === 0 && face.notifyStore.getSnapshot() === false, String(notificationLog.created.length));
check('关掉弹窗后提示音照响', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
face.setNotify(true);

// ---------------------------------------------------------------------------
// 子智能体会话过滤（默认关）：lead / 非 lead 起的子代理不比普通对话提醒
// ---------------------------------------------------------------------------

console.log('');
console.log('子智能体过滤（默认关）');

// 子智能体会话：官方列表里 `origin === 'subagent'`（这正是侧边栏判定子会话
// 可见性用的字段）。sub 列表已有行（通道二能看到），status 快照通道也覆盖它；
// fork 出来的会话带 parentId 但 origin 不是 'subagent'，不能一起挡掉。
for (const [id, origin] of [['sub', 'subagent'], ['fork', undefined]]) {
	hostList.byId[id] = { title: id, displayTitle: id, running: false, ...(origin === undefined ? {} : { origin }) };
}
hostList.ids.push('sub', 'fork');
setStatusRunning('sub', false);
setStatusRunning('fork', false);

/** 宿主转发事件 api-session/error 的回调（下面几段共用）。 */
const errorListener = listeners.find((entry) => entry.name === 'api-session/error')?.fn;
check('子智能体过滤段落：api-session/error 订阅回调可用', typeof errorListener === 'function');

check('子智能体开关默认关，普通会话不受影响', face.subagentStore.getSnapshot() === false && face.notifyStore.getSnapshot() === true);

// 本段会在开关打开时故意报几条子智能体的错误 / 待答，排障计数因此会先涨一截：
// 停止分类那一段的「第几条」断言改为按增量比（开关关掉的那些一条都不会计），
// 基准在这段跑完、进入分类段落时再取一次。
let errorsBeforeClassify = 0;
let questionsBeforeClassify = 0;

// ① 子智能体完成：不弹也不响。
statusListener('sub', true);
resetNotificationLog();
resetAudioLog();
statusListener('sub', false);
await tick();
check('子智能体完成（默认关）：不弹窗也不响音', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);

// ② 子智能体出错：同样不报。
resetNotificationLog();
resetAudioLog();
errorListener('sub', 'subagent boom');
check('子智能体出错（默认关）：不弹窗也不响音', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);

// ③ 子智能体挂起问题：不报，也不该污染待答集合影响它的下一次停止。
resetNotificationLog();
resetAudioLog();
setPendingInteraction('sub', { sessionId: 'sub', kind: 'question', key: 'question:sub', questions: [{ id: 'q1', question: '子智能体的问题？' }] });
check('子智能体挂起问题（默认关）：不弹窗也不响音', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
setPendingInteraction('sub', null);

// ④ fork 出来的会话（有 parentId、origin 不是 subagent）：照常提醒 —— 过滤只能
//    认 origin，认 parentId 会把用户的复制会话一起静音。
setRunning('fork', true);
resetNotificationLog();
setRunning('fork', false);
await tick();
check('fork 会话（非 subagent）照常提醒', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === 'fork', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));

// ⑤ 打开开关：三种停止都恢复（完成 / 出错 / 挂起问题）。
face.setSubagent(true);
check('打开后写入子智能体开关', face.subagentStore.getSnapshot() === true);
statusListener('sub', true);
resetNotificationLog();
resetAudioLog();
statusListener('sub', false);
await tick();
check('打开开关后：子智能体完成也提醒（正文是子会话名）', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === 'sub' && audioLog.oscillators.length === 2, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
resetNotificationLog();
resetAudioLog();
statusListener('sub', true);
errorListener('sub', 'subagent boom 2');
check('打开开关后：子智能体出错也提醒', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '任务出错已停止' && notificationLog.created[0]?.options?.body === 'subagent boom 2', JSON.stringify(notificationLog.created[0]));
resetNotificationLog();
setPendingInteraction('sub', { sessionId: 'sub', kind: 'question', key: 'question:sub2', questions: [{ id: 'q1', question: '第二个子问题？' }] });
check('打开开关后：子智能体挂起问题也提醒', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === '第二个子问题？', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
setPendingInteraction('sub', null);

// ⑥ 关回去：子智能体立刻恢复静音（子智能体再接着跑 → 停止也不报）。
face.setSubagent(false);
statusListener('sub', true);
resetNotificationLog();
resetAudioLog();
statusListener('sub', false);
await tick();
check('关回去后：子智能体停止重新静音', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);

// ---------------------------------------------------------------------------
// 出错停止（api-session/error）与等你回答（pendingInteraction 出现边沿）
// ---------------------------------------------------------------------------

console.log('');
console.log('停止分类、出错与待答');

check('分类段落：api-session/error 订阅回调可用', typeof errorListener === 'function');
// 子智能体段落已经报过几条，之后的绝对条数断言从这两个基准重新起算。
errorsBeforeClassify = windowStub.__dshTaskReminder.state().stats.errors;
questionsBeforeClassify = windowStub.__dshTaskReminder.state().stats.questions;
check('只读订阅了 uiSession.sessionStatus（不碰 user-questions 应答链）', statusSubscribers.size === 1 && !listeners.some((entry) => entry.name === 'user-questions/request'), String(statusSubscribers.size));
check('排障状态带 questions / errors 计数', (() => {
	const stats = windowStub.__dshTaskReminder.state().stats;
	return 'questions' in stats && 'errors' in stats;
})());

// ① 独立的出错（无完成边沿）：错误弹窗立即发，正文是错误信息。
// 上面「关掉弹窗」那一轮在 s2 上留了完成票据（门控关掉也照记，见 client.js 的
// reportCompletion），而这里的测试时间是冻结的、票据不会自然过期；先让 s2 进入
// 新一轮（running=true 清掉上一张票据，这正是生产里的行为），这次错误才算真正
// 独立的停止 —— 否则它会被当成那次完成的晚到错误，只撤回、不重响。
resetNotificationLog();
resetAudioLog();
statusListener('s2', true);
errorListener('s2', '400 Bad Request: invalid model');
check('出错即发错误弹窗（标题/正文）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '任务出错已停止' && notificationLog.created[0]?.options?.body === '400 Bad Request: invalid model', JSON.stringify(notificationLog.created[0]));
check('错误记进 stats.errors', windowStub.__dshTaskReminder.state().stats.errors === errorsBeforeClassify + 1, String(windowStub.__dshTaskReminder.state().stats.errors));
check('出错也响提示音', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));

// ② 停止边沿分类为 error：只发错误弹窗，不出现完成弹窗（网关错误场景）。
resetNotificationLog();
resetAudioLog();
fakeTurnEndReason = { kind: 'error', error: { message: '401 AuthError: Invalid API key.', code: 'AUTH' } };
completeOnce();
await tick();
check('分类为 error：只弹错误一条（无完成弹窗）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '任务出错已停止', JSON.stringify(notificationLog.created.map((item) => item.title)));
check('错误正文取 turn/end 里的网关原文', notificationLog.created[0]?.options?.body === '401 AuthError: Invalid API key.', JSON.stringify(notificationLog.created[0]?.options?.body));
check('分类错误也响一次提示音', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
check('分类错误记进 stats.errors', windowStub.__dshTaskReminder.state().stats.errors === errorsBeforeClassify + 2, String(windowStub.__dshTaskReminder.state().stats.errors));

// ③ 分类已报错误，后到的 api-session/error 不重复报（一次停止一次）。
errorListener('s2', '401 AuthError: Invalid API key.');
check('后到的错误事件被去重（一次停止只报一次）', notificationLog.created.length === 1 && audioLog.oscillators.length === 2, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);

// ④ 无序：错误事件先到、边沿后到 —— 边沿分类同为 error，仍只一条。
resetNotificationLog();
resetAudioLog();
const completedBefore4 = windowStub.__dshTaskReminder.state().stats.completed;
statusListener('s2', true);
errorListener('s2', 'kaput');
statusListener('s2', false);
await tick();
check('先错误事件后边沿：只报一条错误', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === 'kaput', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
check('这条错误只响一次音', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
check('合并后 completed 不增加（这次停止按错误计）', windowStub.__dshTaskReminder.state().stats.completed === completedBefore4, `${windowStub.__dshTaskReminder.state().stats.completed} vs ${completedBefore4}`);

// ⑤ 取消（aborted）、询问已报（blocked）、崩溃孤儿（interrupted）：不弹不响。
for (const kind of ['aborted', 'blocked', 'interrupted']) {
	resetNotificationLog();
	resetAudioLog();
	fakeTurnEndReason = { kind };
	completeOnce();
	await tick();
	check(`${kind}：不弹窗也不响音`, notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
}
fakeTurnEndReason = { kind: 'completed' };

// ⑥ max-tokens（输出到达上限被截断）：按完成报。
resetNotificationLog();
resetAudioLog();
fakeTurnEndReason = { kind: 'max-tokens' };
completeOnce();
await tick();
check('max-tokens：按完成报（截断也要提醒）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '对话任务已完成', JSON.stringify(notificationLog.created.map((item) => item.title)));
fakeTurnEndReason = { kind: 'completed' };

// ⑦ 兜底：分类读不到（retain/open 失败）→ 按完成报；错误 5 秒内后到 →
//    撤回完成弹窗只留错误、不重响提示音。
fakeUsingThrows = true;
resetNotificationLog();
resetAudioLog();
completeOnce();
flushTimers();
check('兜底：分类读不到按完成报', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '对话任务已完成', JSON.stringify(notificationLog.created.map((item) => item.title)));
check('兜底完成响了一次音', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
errorListener('s2', 'boom-late');
check('晚到错误撤回完成弹窗只留错误', notificationLog.created.length === 2 && notificationLog.created[1]?.title === '任务出错已停止' && notificationLog.closed === 1, JSON.stringify(notificationLog.created.map((item) => item.title)));
check('晚到错误不重响提示音（一次停止一次音）', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
fakeUsingThrows = false;

// ⑦b 同一场景，但弹窗被门控关掉：晚到的错误不能再补响一声（修复前会双响）。
//     票据若只在「弹窗真发出去」时才记，门控关掉时就没有票据，同一次停止的错误
//     会被当成一次新停止、再响一次。
face.setNotify(false);
fakeUsingThrows = true;
resetNotificationLog();
resetAudioLog();
completeOnce();
flushTimers();
const chimesGatedFallback = audioLog.oscillators.length;
errorListener('s2', 'boom-late-gated');
check('关掉弹窗：兜底完成仍响一次音', chimesGatedFallback === 2, String(chimesGatedFallback));
check('关掉弹窗：晚到错误不补响也不弹窗', audioLog.oscillators.length === chimesGatedFallback && notificationLog.created.length === 0, `${audioLog.oscillators.length} 音 / ${notificationLog.created.length} 弹窗`);
fakeUsingThrows = false;
await face.setNotify(true);

// ⑧ 重复边沿（列表陈旧回放 running=true 后再翻 false）：同一次停止只报一次。
//    场景：分类在途（读持久日志的 RPC 被闸门摁住）时，陈旧投影把边沿表
//    冲回 true，再翻 false 产生第二次边沿——只应报一次完成。
let gateRelease;
fakeUsingGate = new Promise((resolve) => { gateRelease = resolve; });
resetNotificationLog();
resetAudioLog();
const completedBeforeDup = windowStub.__dshTaskReminder.state().stats.completed;
statusListener('s2', true);  // 先把 s2 立成 running（⑦ 之后它是空闲）
statusListener('s2', false); // 边沿 #1 → 分类在途
statusListener('s2', true);  // 陈旧回放：边沿表回 true（作废票据与在途标记）
statusListener('s2', false); // 边沿 #2 → 再一次 complete()
flushTimers();               // 两个兜底定时器都到点
check('重复边沿：兜底也只报一次完成', notificationLog.created.length === 1, String(notificationLog.created.length));
gateRelease();
await tick();
check('在途分类落地后仍只一条、completed 只加一', notificationLog.created.length === 1 && windowStub.__dshTaskReminder.state().stats.completed === completedBeforeDup + 1, `${notificationLog.created.length} / completed ${windowStub.__dshTaskReminder.state().stats.completed} vs ${completedBeforeDup + 1}`);
check('重复抑制记进 stats.stopDuplicates', windowStub.__dshTaskReminder.state().stats.stopDuplicates >= 1, String(windowStub.__dshTaskReminder.state().stats.stopDuplicates));
fakeUsingGate = null;

// ⑧-b 停止时读到上一个回合的 turn/end（未闭合的 turn/start 之后没有本次
//    回合的 turn/end）：不当成已完成——重试等本次回合的 turn/end 落盘。
//    场景（点停止）：本次的 turn/end{aborted} 还没落盘，倒序先看到的是
//    上一个回合的 turn/end{completed}。
fakeEventEntries = [
	{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
	{ type: 'event', event: { type: 'turn/start', seq: 2, time: 2, data: { turn: 2 } } },
];
statusListener('s2', true); // s2 回到 running（上一用例之后它是空闲）
resetNotificationLog();
resetAudioLog();
const completedBeforeStale = windowStub.__dshTaskReminder.state().stats.completed;
statusListener('s2', false); // 边沿 → 读到「旧 completed + 未闭合 start」
await tick();
check('未闭合回合的旧 turn/end：不立刻报完成', notificationLog.created.length === 0 && windowStub.__dshTaskReminder.state().stats.completed === completedBeforeStale, `${notificationLog.created.length} / completed ${windowStub.__dshTaskReminder.state().stats.completed} vs ${completedBeforeStale}`);
// 本次回合的 turn/end{aborted} 落盘（取消）：重试读到它 → 不报。
fakeEventEntries = [...fakeEventEntries, { type: 'event', event: { type: 'turn/end', seq: 3, time: 3, data: { turn: 2, reason: { kind: 'aborted' } } } }];
await new Promise((resolve) => { setTimeout(resolve, 250); }); // 等 120ms 重试拍落
check('本次 turn/end{aborted} 落盘后：取消不报完成', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
fakeEventEntries = null;

// ⑧-c 第三通道：sessionStatus 快照的 running 位独立驱动完成——fork 出来的
//    子会话列表投影不可靠（陈旧 / 不翻）时，这条路仍能收到完成（s4 专用，
//    列表与事件全程不动它）。
resetNotificationLog();
resetAudioLog();
setStatusRunning('s4', true);  // 快照显示开始跑（列表行始终不翻）
await tick();
setStatusRunning('s4', false); // 快照显示跑完 → running 边沿
await tick();
check('第三通道：sessionStatus running 边沿独立收到完成', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === 's4', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
check('第三通道的完成来源记为 status', windowStub.__dshTaskReminder.state().stats.lastCompletion?.source === 'status', String(windowStub.__dshTaskReminder.state().stats.lastCompletion?.source));

// ⑨ 新任务开始冲掉对账票据：错误 → running=true → 完成各自播报（s3 专用，
//    避开上一次停止的 5 秒去重窗口）。
resetNotificationLog();
resetAudioLog();
errorListener('s3', 'early failure');
statusListener('s3', true);
statusListener('s3', false);
await tick();
check('新 running 冲掉票据后：错误与完成各自播报', notificationLog.created.length === 2, JSON.stringify(notificationLog.created.map((item) => item.title)));

// ---------------------------------------------------------------------------
// 回合号判据（1.5.4）：同一个 turn 的重复停止边沿只报一条
// ---------------------------------------------------------------------------

console.log('');
console.log('回合号判据（同一次停止）');

const statsNow = () => windowStub.__dshTaskReminder.state().stats;

// ⑨-b 把合成日志钉在固定回合号上（fakeEventEntries），先经事件通道报一次；再把
//      5 秒对账窗口快进过期，用**列表通道**回放「假的 running=true → 再翻回 false」
//      制造第二次边沿 —— 桌面端正是通道一稀疏、上一轮的完成票据没人清的情形，
//      此时只有回合号判据挡得住（现行实现会再弹一条）。
resetNotificationLog();
resetAudioLog();
hostList = { ids: [...hostList.ids, 's5'], byId: { ...hostList.byId, s5: { title: '第五个会话', displayTitle: '第五个会话', running: false } } };
const dupBeforeTurn = statsNow().stopDuplicates;
const completedBeforeTurn = statsNow().completed;
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 501, reason: { kind: 'completed' } } } }];
statusListener('s5', true);
statusListener('s5', false); // 边沿 #1 → 分类读到回合 501 → 报一条
await tick();
check('回合号判据：第一次停止边沿照报一条', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === '第五个会话', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
const realNowDup = Date.now;
try {
	Date.now = () => realNowDup() + REPORT_GRACE_MS + 1000; // 5 秒对账窗口已过期
	setRunning('s5', true);  // 列表陈旧回放：假的 running=true（不清账本、不动日志）
	setRunning('s5', false); // 边沿 #2 → 分类读到的还是回合 501
	await tick();
} finally {
	Date.now = realNowDup;
}
check('回合号判据：同回合的第二次边沿不再报（5 秒窗口过期也挡得住）', notificationLog.created.length === 1, JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
check('回合号判据：被丢掉的重复边沿记进 stats.stopDuplicates', statsNow().stopDuplicates === dupBeforeTurn + 1, `${statsNow().stopDuplicates} vs ${dupBeforeTurn + 1}`);
check('回合号判据：同回合不重复计入 completed', statsNow().completed === completedBeforeTurn + 1, `${statsNow().completed} vs ${completedBeforeTurn + 1}`);
fakeEventEntries = null;

// ⑩ 等你回答：pendingInteraction 出现边沿（只读 sessionStatus，不碰应答链）。
resetNotificationLog();
resetAudioLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:1', questions: [{ id: 'q1', question: '要用哪个数据库？' }] });
check('出现问题即发「提问」弹窗（正文是首个问题）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '提问' && notificationLog.created[0]?.options?.body === '要用哪个数据库？', JSON.stringify(notificationLog.created[0]));
check('默认关闭：等待类也不设 requireInteraction', notificationLog.created[0]?.options?.requireInteraction === false, JSON.stringify(notificationLog.created[0]?.options));
check('等待类弹窗按类型选标题：提问 → 提问、plan-review → 方案待确认', WAIT_TITLE_KEYS.question === 'toast.question.title' && WAIT_TITLE_KEYS['plan-review'] === 'toast.plan.title' && WAIT_TITLE_KEYS.approval === 'toast.approval.title', JSON.stringify(WAIT_TITLE_KEYS));
check('等待类弹窗共用 waiting 槽位', notificationLog.created[0]?.options?.tag === `${NOTIFICATION_TAG}-${NOTIFY_KIND_WAITING}`, String(notificationLog.created[0]?.options?.tag));
check('待答记进 stats.questions', windowStub.__dshTaskReminder.state().stats.questions === questionsBeforeClassify + 1, String(windowStub.__dshTaskReminder.state().stats.questions));
check('待答也响提示音', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));

// ⑪ 询问待答期间的停止边沿：不报（那次停止由询问弹窗负责）。
statusListener('s2', true);
resetNotificationLog();
resetAudioLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:1b', questions: [{ id: 'q1', question: '再问一次？' }] });
check('待答中同会话不重复提醒（边沿集合去重）', notificationLog.created.length === 0, String(notificationLog.created.length));
statusListener('s2', false);
await tick();
check('询问待答时到达的停止边沿不报完成', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);

// ⑫ 回答后紧随的完成不报（一次交互一次提醒）；豁免有界 + 会话再跑起来即作废。
check('完成豁免窗口有界（不会把整轮完成静音）', QUESTION_GRACE_MS > 0 && QUESTION_GRACE_MS <= 120000, String(QUESTION_GRACE_MS));
statusListener('s2', true);
setPendingInteraction('s2', null);
resetNotificationLog();
resetAudioLog();
statusListener('s2', false);
await tick();
check('询问回答后紧随的完成不报（grace）', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
resetNotificationLog();
resetAudioLog();
completeOnce();
await tick();
check('grace 消费后：下一次完成照常报', notificationLog.created.length === 1, String(notificationLog.created.length));

// ⑫-b 回答完 Agent 又干了一会儿活（超过豁免窗口）：回合结束照报。
// 1.5.1 的静音 bug：豁免只由「转发事件」那条通道清理，桌面端收不到转发
// 事件时它会一直挂到会话结束，把真正的回合完成吞掉。
resetNotificationLog();
resetAudioLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:grace-window', questions: [{ id: 'q1', question: '继续吗？' }] });
resetNotificationLog(); // 上面这条提问自己会弹「等待你的回答」，不计入本节断言
resetAudioLog();
setPendingInteraction('s2', null); // 回答 → 开启豁免窗口
const realDateNow = Date.now;
try {
	Date.now = () => realDateNow() + QUESTION_GRACE_MS + 1000; // 快进过窗口
	statusListener('s2', false);
	await tick();
} finally {
	Date.now = realDateNow;
}
check('回答后超过豁免窗口的完成照报', notificationLog.created.length === 1, String(notificationLog.created.length));
// 快进期间记下的对账票据带着未来时间戳：用一次 running=true 把它清掉，
// 免得后面的用例被去重窗口挡住。
statusListener('s2', true);
resetNotificationLog();
resetAudioLog();

// ⑫-c 回答后（会话仍算在跑）又观测到 running=true：豁免立刻作废 → 本轮结束提醒。
// 桌面端 0 条转发事件，第三通道（sessionStatus）的持续观测就是作废时机。
resetNotificationLog();
resetAudioLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:grace-resume', questions: [{ id: 'q1', question: '还继续吗？' }] });
resetNotificationLog();
resetAudioLog();
setPendingInteraction('s2', null); // 回答 → 开启豁免窗口（running 一直为 true）
setStatusRunning('s2', true);      // 会话又跑起来（第三通道看到 running=true）→ 豁免作废
statusListener('s2', false);       // 这一轮结束 → 必须提醒
await tick();
check('会话再跑起来后豁免作废：本轮完成照报', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '对话任务已完成', JSON.stringify(notificationLog.created.map((item) => item.title)));

// ⑬ 同一会话的待答不重复提醒；回答后（interaction 消失）再次挂起才再提醒。
resetNotificationLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:2', questions: [{ id: 'q1', question: '第二个问题？' }] });
check('同一会话的待答不重复提醒', notificationLog.created.length === 1, String(notificationLog.created.length));
setPendingInteraction('s2', null);
setPendingInteraction('s2', { sessionId: 's2', kind: 'plan-review', key: 'question:3', questions: [{ id: 'q1', question: '计划可以吗？' }] });
check('回答后再次挂起才再提醒', notificationLog.created.length === 2 && notificationLog.created[1]?.options?.body === '计划可以吗？', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
// 会话整个从快照里消失（被删除 / 归档）：清出待答集合，之后再挂起仍算新边沿。
dropSessionFromStatus('s2');
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:9', questions: [{ id: 'q1', question: '回来后的新问题？' }] });
check('会话从快照消失后再挂起仍提醒', notificationLog.created.length === 3 && notificationLog.created[2]?.options?.body === '回来后的新问题？', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
setPendingInteraction('s2', null);

// ⑬-b 等待类通知的收尾：消散即收掉，通知中心不留陈旧条目（陈旧条目点下去
// 什么都不发生 —— 「有时点了不跳」的疑凶）。带按钮的审批通知早有这条（1.6.0），
// 提问 / 方案待确认 / 退回普通样式的审批现在补上。
resetNotificationLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:close-1', questions: [{ id: 'q1', question: '收尾测试？' }] });
check('等待通知记进 waitingToasts（排障可见）', windowStub.__dshTaskReminder.state().waitingToasts.includes('s2'), JSON.stringify(windowStub.__dshTaskReminder.state().waitingToasts));
const closedBeforeSettle = notificationLog.closed;
setPendingInteraction('s2', null); // 用户已回答 → 挂起消散
check('挂起消散：等待类通知被收掉（不留陈旧条目）', notificationLog.closed === closedBeforeSettle + 1, `${closedBeforeSettle} → ${notificationLog.closed}`);
check('收掉后 waitingToasts 不再记着这个会话', !windowStub.__dshTaskReminder.state().waitingToasts.includes('s2'), JSON.stringify(windowStub.__dshTaskReminder.state().waitingToasts));
resetNotificationLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'plan-review', key: 'plan:close-2', questions: [{ id: 'q1', question: '会话要没了？' }] });
const closedBeforeDrop = notificationLog.closed;
dropSessionFromStatus('s2'); // 会话被删除 / 归档
check('会话从快照消失：未结清的等待通知也收掉', notificationLog.closed === closedBeforeDrop + 1 && !windowStub.__dshTaskReminder.state().waitingToasts.includes('s2'), `${closedBeforeDrop} → ${notificationLog.closed}`);

// ⑭ 待答也受时机门控：仅非前台窗口 + 页面有焦点 → 不弹，记 skippedFocused。
const skippedBefore = windowStub.__dshTaskReminder.state().stats.skippedFocused;
face.setNotifyMode('unfocused');
resetNotificationLog();
setPendingInteraction('s3', { sessionId: 's3', kind: 'question', key: 'question:4', questions: [{ id: 'q1', question: 's3 的问题？' }] });
check('仅非前台窗口时：有焦点不弹待答窗', notificationLog.created.length === 0, String(notificationLog.created.length));
check('被门控的待答记进 skippedFocused', windowStub.__dshTaskReminder.state().stats.skippedFocused === skippedBefore + 1, String(windowStub.__dshTaskReminder.state().stats.skippedFocused));
face.setNotifyMode('always');
setPendingInteraction('s3', null);

// ---------------------------------------------------------------------------
// 回合号判据（1.5.4）：新回合照报、错误优先保留、同回合的 error 与 completion 不各报
// ---------------------------------------------------------------------------

console.log('');
console.log('回合号判据（新回合 / 错误优先 / 同回合两种原因）');

// 本节新增几个专用会话（避开前面用例的账本残留）。s5 已在「同一次停止」那节登记。
hostList = {
	ids: [...hostList.ids, 's6', 's7', 's8', 's9'],
	byId: {
		...hostList.byId,
		...Object.fromEntries([['s6', '第六个会话'], ['s7', '第七个会话'], ['s8', '第八个会话'], ['s9', '第九个会话']]
			.map(([id, title]) => [id, { title, displayTitle: title, running: false }])),
	},
};

// ⑮ 新回合在上一轮停止后 **5 秒内**完成 → 照报（本次回归点；现行实现按完成票据吞掉）。
//    只用第三通道（sessionStatus 快照）启动新回合：桌面端通道一稀疏，账本里上一轮
//    的完成票据没人清；时钟冻结，票据一定还在 5 秒窗口内。
resetNotificationLog();
resetAudioLog();
const freshBeforeTurn = statsNow().completed;
const realNowFresh = Date.now;
const frozenNow = realNowFresh();
try {
	Date.now = () => frozenNow; // 冻结时钟：上一轮的完成票据不会自然过期
	fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 601, reason: { kind: 'completed' } } } }];
	setStatusRunning('s6', true);
	statusListener('s6', false); // 回合 601 完成 → 报一条
	await tick();
	// 紧接着的新回合（601 → 602），距上一次停止远不到 5 秒
	fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { turn: 602, reason: { kind: 'completed' } } } }];
	setStatusRunning('s6', true); // 第三通道启动新回合：不清账本
	statusListener('s6', false); // 回合 602 完成 → 必须照报
	await tick();
} finally {
	Date.now = realNowFresh;
}
check('回合号判据：新回合在上一轮停止后 5 秒内完成照报（回归点）', notificationLog.created.length === 2 && notificationLog.created[1]?.options?.body === '第六个会话', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
check('回合号判据：两次完成都计入 completed（新回合没被当成重复边沿）', statsNow().completed === freshBeforeTurn + 2, `${statsNow().completed} vs ${freshBeforeTurn + 2}`);
check('回合号判据：两次完成各响一次提示音', audioLog.oscillators.length === 4, String(audioLog.oscillators.length));
fakeEventEntries = null;

// ⑯ 错误优先（5 秒窗口保留给这个方向）：错误先报，随后 5 秒内到达的完成不报。
//    用第三通道观测 running（不清账本），时钟冻结保证错误票据仍在窗口内。
resetNotificationLog();
resetAudioLog();
const errorsBeforePriority = statsNow().errors;
const completedBeforePriority = statsNow().completed;
const realNowPriority = Date.now;
const frozenPriority = realNowPriority();
try {
	Date.now = () => frozenPriority;
	errorListener('s7', 'boom-first'); // 错误先到（api-session/error 不带回合号）
	setStatusRunning('s7', true);      // 新回合开始（第三通道，不清账本）
	statusListener('s7', false);       // 停止边沿 → 分类读到回合 701 completed
	await tick();
} finally {
	Date.now = realNowPriority;
}
check('错误优先：错误先报（标题 / 网关原文正文）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '任务出错已停止' && notificationLog.created[0]?.options?.body === 'boom-first', JSON.stringify(notificationLog.created.map((item) => [item.title, item.options?.body])));
check('错误优先：5 秒内到达的完成不再报一条', statsNow().completed === completedBeforePriority && notificationLog.created.length === 1, `${statsNow().completed} vs ${completedBeforePriority}`);
check('错误优先：这次停止只响一次提示音', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
check('错误优先：错误计入 stats.errors', statsNow().errors === errorsBeforePriority + 1, `${statsNow().errors} vs ${errorsBeforePriority + 1}`);
fakeEventEntries = null;

// ⑰ 完成 → 错误：完成弹窗被撤回、只留错误、不重响提示音（回合号已知的完成路径）。
resetNotificationLog();
resetAudioLog();
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 801, reason: { kind: 'completed' } } } }];
setStatusRunning('s8', true);
statusListener('s8', false);
await tick();
check('完成 → 错误：完成弹窗先发出', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '对话任务已完成', JSON.stringify(notificationLog.created.map((item) => item.title)));
errorListener('s8', 'boom-after');
check('完成 → 错误：完成弹窗被撤回、错误弹窗补上', notificationLog.created.length === 2 && notificationLog.created[1]?.title === '任务出错已停止' && notificationLog.closed === 1, JSON.stringify({ titles: notificationLog.created.map((item) => item.title), closed: notificationLog.closed }));
check('完成 → 错误：不重响提示音（一次停止一次音）', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
fakeEventEntries = null;

// ⑱ 同一个回合的 error 与 completion 不会各报一次。两种顺序都用回合号挡下：
//    日志里这一回合的 turn/end 在两次边沿之间「抖动」（陈旧读 / 投影回放），
//    第二次边沿分类出的 reason 与第一次不同，但它是同一次停止。
resetNotificationLog();
resetAudioLog();
const dupBeforeSameTurn = statsNow().stopDuplicates;
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 901, reason: { kind: 'error', error: { message: 'same-turn boom' } } } } }];
statusListener('s9', true);
statusListener('s9', false);
await tick();
check('同回合 (a)：先按错误报一条', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '任务出错已停止' && notificationLog.created[0]?.options?.body === 'same-turn boom', JSON.stringify(notificationLog.created.map((item) => [item.title, item.options?.body])));
resetNotificationLog();
resetAudioLog();
const completedBeforeSameTurn = statsNow().completed;
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { turn: 901, reason: { kind: 'completed' } } } }];
statusListener('s9', true);  // 通道一的假 running=true 清掉旧票据：只剩回合号判据
statusListener('s9', false);
await tick();
check('同回合 (a)：完成不再另报一条（不弹窗也不响音）', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
check('同回合 (a)：重复边沿记进 stats.stopDuplicates', statsNow().stopDuplicates === dupBeforeSameTurn + 1, `${statsNow().stopDuplicates} vs ${dupBeforeSameTurn + 1}`);
check('同回合 (a)：不重复计入 completed', statsNow().completed === completedBeforeSameTurn, `${statsNow().completed} vs ${completedBeforeSameTurn}`);
// 反序：先按完成报（回合 902），同回合的错误分类边沿不再另报一条。
resetNotificationLog();
resetAudioLog();
const errorsBeforeSameTurn = statsNow().errors;
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 902, reason: { kind: 'completed' } } } }];
statusListener('s9', true);
statusListener('s9', false);
await tick();
check('同回合 (b)：先按完成报一条', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '对话任务已完成', JSON.stringify(notificationLog.created.map((item) => item.title)));
resetNotificationLog();
resetAudioLog();
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { turn: 902, reason: { kind: 'error', error: { message: 'same-turn late boom' } } } } }];
statusListener('s9', true);
statusListener('s9', false);
await tick();
check('同回合 (b)：错误不再另报一条、也不重响', notificationLog.created.length === 0 && audioLog.oscillators.length === 0, `${notificationLog.created.length} / ${audioLog.oscillators.length}`);
check('同回合 (b)：错误计数不变', statsNow().errors === errorsBeforeSameTurn, `${statsNow().errors} vs ${errorsBeforeSameTurn}`);

// ⑲ 对抗：同一个回合的边沿风暴只报一条；换一个回合再刮一轮只多报一条。
//    rawStatusListener 连发 3 组「假 running=true → false」，每组之间让分类落地：
//    通道一每次都会清掉在途守卫与时间票据，旧实现（5 秒窗口）在这里会把同一次
//    停止弹成两条 —— 新判据是回合号，弹窗数必须正好等于不同回合数（重复弹窗是
//    本次加固的红线）。
resetNotificationLog();
resetAudioLog();
const stormSession = 's10';
hostList = { ids: [...hostList.ids, stormSession], byId: { ...hostList.byId, [stormSession]: { title: '第十个会话', displayTitle: '第十个会话', running: false } } };
const stormBefore = statsNow().completed;
const stormEdges = async () => {
	for (let i = 0; i < 3; i += 1) {
		rawStatusListener(stormSession, true);  // 假的 running=true：清在途守卫与时间票据
		rawStatusListener(stormSession, false); // 边沿
		await tick();                           // 这一次的分类先落地，再接下一组
	}
};
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 1001, reason: { kind: 'completed' } } } }];
await stormEdges();
check('边沿风暴：同一个回合的 3 组边沿只报一条', notificationLog.created.length === 1 && statsNow().completed === stormBefore + 1, `${notificationLog.created.length} / completed ${statsNow().completed} vs ${stormBefore + 1}`);
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 2, time: 2, data: { turn: 1002, reason: { kind: 'completed' } } } }];
await stormEdges();
check('边沿风暴：换一个回合后再刮一轮只多报一条', notificationLog.created.length === 2 && statsNow().completed === stormBefore + 2, `${notificationLog.created.length} / completed ${statsNow().completed} vs ${stormBefore + 2}`);
check('边沿风暴：两次弹窗分别属于两个回合（正文同会话）', notificationLog.created.every((item) => item.options?.body === '第十个会话'), JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
fakeEventEntries = null;

// ⑳ 兜底路径（读不到原因 = 也就读不到回合号）：兜底报过完成之后，同一次停止的
//    重复边沿仍由 5 秒窗口挡下。无号边沿不能变得可重复 —— 这是有意保守的一侧：
//    宁可漏掉「兜底报告后 5 秒内的新回合」，也不为它冒重复弹窗的风险。
resetNotificationLog();
resetAudioLog();
const fallbackSession = 's11';
hostList = { ids: [...hostList.ids, fallbackSession], byId: { ...hostList.byId, [fallbackSession]: { title: '第十一个会话', displayTitle: '第十一个会话', running: false } } };
const dupBeforeFallback = statsNow().stopDuplicates;
fakeUsingThrows = true; // 分类读不到（retain 失败）→ 走兜底
statusListener(fallbackSession, true);
statusListener(fallbackSession, false);
flushTimers(); // 兜底定时器到点 → 报一条完成（回合号未知）
check('兜底路径：读不到原因时按完成报一条', notificationLog.created.length === 1, JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
setStatusRunning(fallbackSession, true);  // 快照通道的重复观测（不清账本）
statusListener(fallbackSession, false);   // 同一次停止的第二条边沿
flushTimers();                            // 这次分类也读不到 → 同样走兜底
check('兜底路径：无号边沿的重复仍由 5 秒窗口挡下（只一条）', notificationLog.created.length === 1, JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
check('兜底路径：重复被记进 stats.stopDuplicates', statsNow().stopDuplicates === dupBeforeFallback + 1, `${statsNow().stopDuplicates} vs ${dupBeforeFallback + 1}`);
fakeUsingThrows = false;

// ---------------------------------------------------------------------------
// 系统弹窗（Web Notification）：权限路径 + 不支持 + 竞态
// ---------------------------------------------------------------------------

console.log('');
console.log('系统弹窗');

// ① 权限被拒：不弹窗也不反复问。
FakeNotification.permission = 'denied';
resetNotificationLog();
await face.setNotify(false);
await face.setNotify(true);
check('权限被拒时开启开关也不再问浏览器', notificationLog.requested === 0 && face.permissionStore.getSnapshot() === 'denied', face.permissionStore.getSnapshot());
resetAudioLog();
completeOnce();
flushTimers();
check('权限被拒时不再发弹窗', notificationLog.created.length === 0, String(notificationLog.created.length));
check('权限被拒时提示音照旧', audioLog.oscillators.length === 2, String(audioLog.oscillators.length));

// ② 权限待定：开启开关即申请；允许后生效。
FakeNotification.permission = 'default';
resetNotificationLog();
FakeNotification.requestPermission = () => {
	notificationLog.requested += 1;
	FakeNotification.permission = 'granted';
	return Promise.resolve('granted');
};
await face.setNotify(true);
await tick();
check('权限待定时开启开关会申请一次', notificationLog.requested === 1, String(notificationLog.requested));
check('授权后权限状态跟进', face.permissionStore.getSnapshot() === 'granted', face.permissionStore.getSnapshot());
resetNotificationLog();
completeOnce();
flushTimers();
check('授权后任务完成恢复发弹窗', notificationLog.created.length === 1, String(notificationLog.created.length));

// ③ 关掉开关：完成不再发。
resetNotificationLog();
await face.setNotify(false);
completeOnce();
flushTimers();
check('权限链路③：关掉开关后完成不再发', notificationLog.created.length === 0 && face.notifyStore.getSnapshot() === false);
await face.setNotify(true);
FakeNotification.permission = 'granted';

// ④ 浏览器不支持 Notification：探测与调用全部安静失败。
const savedNotification = windowStub.Notification;
delete windowStub.Notification;
const notifierUnsupported = createNotifier();
check('不支持 Notification 时 supported 为假', notifierUnsupported.supported === false && notifierUnsupported.permission() === 'unsupported');
check('不支持时 show 安静返回 null', notifierUnsupported.show('标题', '正文', () => {}) === null);
check('不支持时 request 安静 resolve unsupported', await notifierUnsupported.request() === 'unsupported');
windowStub.Notification = savedNotification;
check('支持时 supported 为真且权限现读', createNotifier().supported === true && createNotifier().permission() === FakeNotification.permission);

// ⑤ 权限被用户在站点设置里重置回「询问」：设置页给出「申请通知权限」按钮，
//    点它即发起申请，不必先把开关拨关再拨开。
FakeNotification.permission = 'default';
FakeNotification.requestPermission = () => {
	notificationLog.requested += 1;
	FakeNotification.permission = 'granted';
	return Promise.resolve('granted');
};
await face.setNotify(true);
await tick();
FakeNotification.permission = 'default';
face.permissionStore.set('default');
resetNotificationLog();
sectionNodes = renderSection();
const permissionButton = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '申请通知权限');
check('权限待定且弹窗开着时，设置页给出「申请通知权限」按钮', permissionButton !== undefined, JSON.stringify(sectionNodes.filter((node) => node.type === 'button').map((node) => node.children?.[0])));
permissionButton.props.onClick();
check('点「申请通知权限」即申请一次', notificationLog.requested === 1, String(notificationLog.requested));
await tick();
check('授权后权限状态跟进到 granted', face.permissionStore.getSnapshot() === 'granted', face.permissionStore.getSnapshot());

// ⑥ 竞态回归：申请还没回来时用户又拨了关，过期的申请结果不得覆盖新状态。
FakeNotification.permission = 'default';
let resolveHung;
FakeNotification.requestPermission = () => {
	notificationLog.requested += 1;
	return new Promise((resolve) => { resolveHung = resolve; });
};
const hungRequest = face.setNotify(true);
FakeNotification.permission = 'denied';
await face.setNotify(false);
resolveHung('default');
await hungRequest;
check('过期申请结果不覆盖新状态（申请竞态回归）', face.permissionStore.getSnapshot() === 'denied', face.permissionStore.getSnapshot());
await face.setNotify(true);
check('竞态后开关写回仍正常', face.notifyStore.getSnapshot() === true && face.permissionStore.getSnapshot() === 'denied', face.permissionStore.getSnapshot());
FakeNotification.permission = 'granted';

// ---------------------------------------------------------------------------
// 设置页：整页渲染 + 控件 + 交互
// ---------------------------------------------------------------------------

console.log('');
console.log('设置页');

// 默认态：四个开关 + 弹窗时机（二选一，默认「任何情况都弹」）+ 音效四选一 + 自定义音效 + 音量步进 + 恢复默认。
sectionNodes = renderSection();
const switches = sectionNodes.filter((node) => node.type === 'Switch');
check('设置页渲染四个开关（系统弹窗 / 子智能体提醒 / 弹窗一直挂着 / 提示音）', switches.length === 4, String(switches.length));
check('系统弹窗排在第一位且默认开启', switches[0]?.props?.label === '系统弹窗' && switches[0]?.props?.checked === true, JSON.stringify(switches.map((node) => [node.props.label, node.props.checked])));
check('子智能体提醒默认关闭（第二行）', switches[1]?.props?.label === '子智能体提醒' && switches[1]?.props?.checked === false, JSON.stringify(switches.map((node) => [node.props.label, node.props.checked])));
check('「弹窗一直挂着」默认关闭（第三行）', switches[2]?.props?.label === '弹窗一直挂着' && switches[2]?.props?.checked === false, JSON.stringify(switches.map((node) => [node.props.label, node.props.checked])));
check('提示音开关默认开启', switches[3]?.props?.label === '完成提示音' && switches[3]?.props?.checked === true);
check('四个开关的 onChange 都接到了写回函数', switches.every((node) => typeof node.props.onChange === 'function'));
check('设置页没有「试听」按钮（切换音效即发声）', !sectionNodes.some((node) => node.type === 'button' && node.children?.[0] === '试听'));

const segmentedGroups = sectionNodes.filter((node) => node.type === 'div' && node.props?.role === 'group'
	&& node.props?.['aria-label'] === '弹窗时机');
const modeButtons = kidsOf(segmentedGroups[0]).filter((node) => node.type === 'button' && typeof node.props?.['aria-pressed'] === 'boolean');
check('弹窗时机是二选一分段控件', modeButtons.length === 2, String(modeButtons.length));
check('弹窗时机两个选项的文案与顺序', JSON.stringify(modeButtons.map((node) => node.children?.[0])) === JSON.stringify(['任何情况都弹', '仅非前台窗口']), JSON.stringify(modeButtons.map((node) => node.children?.[0])));
check('默认选中「任何情况都弹」', modeButtons[0]?.props['aria-pressed'] === true && modeButtons[1]?.props['aria-pressed'] === false);
check('弹窗时机两档上下排（不是左右并排）', segmentedGroups[0]?.props?.style?.flexDirection === 'column'
	&& segmentedGroups[0]?.props?.style?.alignItems === 'stretch', JSON.stringify(segmentedGroups[0]?.props?.style));
modeButtons[1].props.onClick();
check('点「仅非前台窗口」即写回配置', face.notifyModeStore.getSnapshot() === 'unfocused', face.notifyModeStore.getSnapshot());
modeButtons[0].props.onClick();
check('点「任何情况都弹」即写回配置', face.notifyModeStore.getSnapshot() === 'always');
switches[0].props.onChange(false);
check('关掉系统弹窗后时机行不再出现', !renderSection().some((node) => node.type === 'div' && node.props?.role === 'group' && node.props?.['aria-label'] === '弹窗时机'), '时机行仍存在');
switches[0].props.onChange(true);
sectionNodes = renderSection();

// 通知语言：只有两档（简体中文 / English）。默认 auto 不在选项里，而是把当前
// 生效语言显示成选中的那一档 —— 界面中文时就是「简体中文」被选中。
const languageGroupOf = (nodes) => nodes.find((node) => node.type === 'div' && node.props?.role === 'group'
	&& node.props?.['aria-label'] === '通知语言');
const languageButtons = kidsOf(languageGroupOf(sectionNodes)).filter((node) => node.type === 'button' && typeof node.props?.['aria-pressed'] === 'boolean');
check('通知语言仍是左右并排（上下排只用在弹窗时机那一行）', languageGroupOf(sectionNodes)?.props?.style?.flexDirection !== 'column'
	&& languageGroupOf(sectionNodes)?.props?.style?.flexDirection === undefined, JSON.stringify(languageGroupOf(sectionNodes)?.props?.style));
check('通知语言是二选一分段控件，没有「跟随界面」这一档', languageButtons.length === 2
	&& JSON.stringify(languageButtons.map((node) => node.children?.[0])) === JSON.stringify(['简体中文', 'English']), JSON.stringify(languageButtons.map((node) => node.children?.[0])));
check('默认（auto）时把界面语言显示为选中档：界面中文 → 简体中文', face.notifyLanguageStore.getSnapshot() === 'auto'
	&& languageButtons[0]?.props['aria-pressed'] === true && languageButtons[1]?.props['aria-pressed'] === false,
	JSON.stringify({ stored: face.notifyLanguageStore.getSnapshot(), pressed: languageButtons.map((node) => node.props['aria-pressed']) }));
languageButtons[1].props.onClick();
check('点 English 即钉住（写回配置，且选中 English）', face.notifyLanguageStore.getSnapshot() === 'en'
	&& kidsOf(languageGroupOf(renderSection())).filter((node) => node.type === 'button')[1]?.props['aria-pressed'] === true,
	face.notifyLanguageStore.getSnapshot());
// 回到 auto：界面语言切成英文后，选中档应当跟着变成 English。
face.setNotifyLanguage('auto');
activeLocale = 'en-US';
notifyLocaleChange();
const followedButtons = kidsOf(languageGroupOf(renderSection())).filter((node) => node.type === 'button');
check('auto 档跟随界面：界面英文 → 选中 English（不需要用户再选一次）', face.notifyLanguageStore.getSnapshot() === 'auto'
	&& followedButtons[1]?.props['aria-pressed'] === true && followedButtons[0]?.props['aria-pressed'] === false,
	JSON.stringify(followedButtons.map((node) => node.props['aria-pressed'])));
activeLocale = 'zh-CN';
face.setNotifyLanguage('auto');
notifyLocaleChange();

const soundGroup = sectionNodes.find((node) => node.type === 'div' && node.props?.role === 'group'
	&& node.props?.['aria-label'] === '提示音音效');
const soundSegmentedButtons = kidsOf(soundGroup).filter((node) => node.type === 'button' && typeof node.props?.['aria-pressed'] === 'boolean');
check('音效选择是五选一分段控件（四种合成 + 自定义）', soundSegmentedButtons.length === 5 && soundSegmentedButtons.filter((node) => node.props['aria-pressed'] === true).length === 1, String(soundSegmentedButtons.length));
check('音效分段按钮文案与顺序', JSON.stringify(soundSegmentedButtons.map((node) => node.children?.[0])) === JSON.stringify(['两声（经典）', '三声上扬', '上升琶音', '圆润三角波', '自定义']), JSON.stringify(soundSegmentedButtons.map((node) => node.children?.[0])));
check('默认选中第一种音效', soundSegmentedButtons[0]?.props['aria-pressed'] === true);
const stepperGroups = sectionNodes.filter((node) => node.type === 'div' && node.props?.role === 'group'
	&& kidsOf(node).some((child) => child.props?.['aria-label'] === '减小'));
check('音量一个步进器（卡片宽高已删除）', stepperGroups.length === 1 && JSON.stringify(stepperGroups.map((node) => node.props['aria-label'])) === JSON.stringify(['提示音音量']), JSON.stringify(stepperGroups.map((node) => node.props['aria-label'])));
const decOf = (group) => kidsOf(group).find((node) => node.props?.['aria-label'] === '减小');
const incOf = (group) => kidsOf(group).find((node) => node.props?.['aria-label'] === '增大');
check('步进器有增减按钮', decOf(stepperGroups[0]) !== undefined && incOf(stepperGroups[0]) !== undefined);
check('音量在界内时增减都可用', decOf(stepperGroups[0]).props.disabled === false && incOf(stepperGroups[0]).props.disabled === false);
const resetButton = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '恢复默认');
check('设置页有「恢复默认」按钮，默认值时置灰', resetButton !== undefined && resetButton.props.disabled === true, String(resetButton?.props?.disabled));
check('默认值时恢复默认行显示「已是默认设置」文案', sectionNodes.some((node) => node.children?.[0] === '当前已是默认设置。'));
check('音量行说明带当前值（插值）', sectionNodes.some((node) => node.children?.[0] === '提示音的整体增益，当前 80%；0 为静音'), JSON.stringify(sectionNodes.map((node) => node.children?.[0]).filter((text) => typeof text === 'string' && text.includes('增益'))));

// 交互：切音效即发声；步进器改音量；恢复默认。
resetAudioLog();
soundSegmentedButtons[1].props.onClick(); // 三声上扬
check('切换音效立即发声（三声上扬 3 音，按当前音量 master 1.0）', face.soundChoiceStore.getSnapshot() === 1
	&& audioLog.oscillators.length === 3 && audioLog.gains.length === 3
	&& closeTo(audioLog.oscillators[0].freq, 1046.5) && closeTo(audioLog.oscillators[1].freq, 1318.51) && closeTo(audioLog.oscillators[2].freq, 1567.98)
	&& closeTo(audioLog.gains[0].peak, 0.4) && closeTo(audioLog.gains[1].peak, 0.4) && closeTo(audioLog.gains[2].peak, 0.42), JSON.stringify(audioLog.gains.map((gain) => gain.peak)));
resetAudioLog();
soundSegmentedButtons[2].props.onClick(); // 上升琶音
check('再切到上升琶音立即发声（4 音）', face.soundChoiceStore.getSnapshot() === 2 && audioLog.oscillators.length === 4, String(audioLog.oscillators.length));
incOf(stepperGroups[0]).props.onClick();
check('点音量「+」按步进 +5', face.volumeStore.getSnapshot() === 85, String(face.volumeStore.getSnapshot()));

// 恢复默认：先弄花，再一键写回。
face.setNotify(false);
face.setNotifyMode('unfocused');
face.setSound(false);
face.setSoundChoice(3);
face.setVolume(40);
// 后加的两个配置也一并拨离默认值：恢复默认必须把它们写回，
// 否则「钉住了通知语言 / 弹窗一直挂着，点恢复默认却没还原」不会被任何断言发现。
face.setSticky(true);
face.setNotifyLanguage('en');
sectionNodes = renderSection();
const resetButtonAfter = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '恢复默认');
check('改花后「恢复默认」按钮置灰解除', resetButtonAfter?.props?.disabled === false, String(resetButtonAfter?.props?.disabled));
check('改花后说明换成短句（不再罗列默认值清单）', sectionNodes.some((node) => typeof node.children?.[0] === 'string' && node.children[0].startsWith('把上面的设置写回出厂值')));
resetButtonAfter.props.onClick();
check('恢复默认写回全部八个配置（弹窗回开、时机回任何情况都弹、子智能体回关、语言回跟随界面、弹窗不再一直挂着）', face.notifyStore.getSnapshot() === true && face.notifyModeStore.getSnapshot() === 'always' && face.soundStore.getSnapshot() === true
	&& face.soundChoiceStore.getSnapshot() === 0 && face.volumeStore.getSnapshot() === 80 && face.subagentStore.getSnapshot() === false
	&& face.stickyStore.getSnapshot() === false && face.notifyLanguageStore.getSnapshot() === 'auto',
	JSON.stringify(windowStub.__dshTaskReminder.state()));

// 权限被拒时设置页给出提示。
FakeNotification.permission = 'denied';
await face.setNotify(true);
sectionNodes = renderSection();
check('权限被拒时设置页给出提示', sectionNodes.some((node) => node.children?.[0] === '浏览器已拒绝本站点的通知权限，请到地址栏的站点权限里改为「允许」后再试。'));
FakeNotification.permission = 'granted';

// ---------------------------------------------------------------------------
// 提示音路径：音效切换、音量整档 +20、静音；回收时关掉 AudioContext
// ---------------------------------------------------------------------------

console.log('');
console.log('提示音');

face.setSound(true);
face.setVolume(80);

/** 完成一次任务并返回本次新排的音（分类落地后才有音）。 */
const playOnce = async () => {
	resetAudioLog();
	statusListener('s2', true);
	statusListener('s2', false);
	await tick();
	return {
		oscillators: [...audioLog.oscillators],
		gains: [...audioLog.gains],
	};
};

// 第二种：三声上扬。
face.setSoundChoice(1);
let played = await playOnce();
check('三声上扬：三个正弦音', played.oscillators.length === 3 && played.gains.length === 3
	&& played.oscillators.every((oscillator) => oscillator.type === 'sine'), String(played.oscillators.length));
check('三声上扬：C6 → E6 → G6', closeTo(played.oscillators[0].freq, 1046.5) && closeTo(played.oscillators[1].freq, 1318.51) && closeTo(played.oscillators[2].freq, 1567.98), JSON.stringify(played.oscillators.map((oscillator) => oscillator.freq)));
check('三声上扬：节奏 0 / 0.15 / 0.30 秒', closeTo(played.oscillators[0].startAt, 0) && closeTo(played.oscillators[1].startAt, 0.15) && closeTo(played.oscillators[2].startAt, 0.3), JSON.stringify(played.oscillators.map((oscillator) => oscillator.startAt)));

// 第三种：上升琶音。
face.setSoundChoice(2);
played = await playOnce();
check('上升琶音：四个正弦音', played.oscillators.length === 4 && played.oscillators.every((oscillator) => oscillator.type === 'sine'), String(played.oscillators.length));
check('上升琶音：C5 → E5 → G5 → C6', closeTo(played.oscillators[0].freq, 523.25) && closeTo(played.oscillators[1].freq, 659.25) && closeTo(played.oscillators[2].freq, 783.99) && closeTo(played.oscillators[3].freq, 1046.5), JSON.stringify(played.oscillators.map((oscillator) => oscillator.freq)));
check('上升琶音：每 0.07 秒一音', closeTo(played.oscillators[1].startAt, 0.07) && closeTo(played.oscillators[2].startAt, 0.14) && closeTo(played.oscillators[3].startAt, 0.21), JSON.stringify(played.oscillators.map((oscillator) => oscillator.startAt)));

// 第四种：圆润三角波。
face.setSoundChoice(3);
played = await playOnce();
check('圆润三角波：两个三角波音', played.oscillators.length === 2 && played.oscillators.every((oscillator) => oscillator.type === 'triangle'), JSON.stringify(played.oscillators.map((oscillator) => oscillator.type)));
check('圆润三角波：E5 → B5', closeTo(played.oscillators[0].freq, 659.25) && closeTo(played.oscillators[1].freq, 987.77), JSON.stringify(played.oscillators.map((oscillator) => oscillator.freq)));

// 音量整档 +20：显示值 +20 折成 master。
face.setSoundChoice(0);
face.setVolume(80);
played = await playOnce();
check('显示 80 → master 1.0（原 100 的响度）', closeTo(played.gains[0].peak, 0.4375) && closeTo(played.gains[1].peak, 0.3625), JSON.stringify(played.gains.map((gain) => gain.peak)));
face.setVolume(50);
played = await playOnce();
check('显示 50 → master 0.7（相当于原 70）', closeTo(played.gains[0].peak, 0.4375 * 0.7) && closeTo(played.gains[1].peak, 0.3625 * 0.7), JSON.stringify(played.gains.map((gain) => gain.peak)));
face.setVolume(100);
played = await playOnce();
check('显示 100 → master 1.2（相当于原 120）', closeTo(played.gains[0].peak, 0.4375 * 1.2) && closeTo(played.gains[1].peak, 0.3625 * 1.2), JSON.stringify(played.gains.map((gain) => gain.peak)));

// 静音：0% 一条音都不排。
face.setVolume(0);
played = await playOnce();
check('音量 0 为静音：不排任何音', played.oscillators.length === 0, String(played.oscillators.length));
face.setVolume(80);

// 提示音关掉：再完成也一条音都不多排。
const oscillatorsAfterPlay = audioLog.oscillators.length;
face.setSound(false);
completeOnce();
await tick();
check('提示音关掉后不再排音', audioLog.oscillators.length === oscillatorsAfterPlay, String(audioLog.oscillators.length - oscillatorsAfterPlay));
face.setSound(true);

check('AudioContext 全局只建一个（首次提示音时惰性创建，之后复用）', audioLog.contexts === 1, String(audioLog.contexts));

// 自动播放策略：context 被挂在 suspended 时，play 仍尝试 resume 且拒绝不外抛；
// 用户的第一次点击 / 按键把 context 拉活，之后的完成提示音才响得出来。
const firstCtx = audioLog.instances[0];
check('桩里拿得到唯一 AudioContext 实例', firstCtx !== undefined && audioLog.instances.length === 1, String(audioLog.instances.length));
firstCtx.state = 'suspended';
firstCtx.resume = () => {
	audioLog.resumed += 1;
	return Promise.reject(new Error('resume blocked without a user gesture'));
};
const resumedBefore = audioLog.resumed;
await playOnce();
check('context 挂起时完成提示音仍尝试 resume（被拒也不抛、不留未处理 rejection）', audioLog.resumed === resumedBefore + 1, String(audioLog.resumed - resumedBefore));
check('挂起时排障状态记下 context 状态', windowStub.__dshTaskReminder.state().stats.lastSound?.state === 'suspended' && windowStub.__dshTaskReminder.state().stats.lastSound?.scheduled === true, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastSound));
firstCtx.resume = function grantedResume() {
	audioLog.resumed += 1;
	firstCtx.state = 'running';
	return Promise.resolve();
};
fireWindow('pointerdown');
check('用户第一次点击把挂起的 AudioContext 拉活', firstCtx.state === 'running' && audioLog.resumed === resumedBefore + 2, `${firstCtx.state} / resumed ${audioLog.resumed - resumedBefore} 次`);

// 切走标签页 / 失焦期间排下的音压在挂起的时钟上：回到前台时 sync 顺手拉活，
// 这些音立即续播，不会出现"过了很久才响"。
firstCtx.state = 'suspended';
firstCtx.resume = function grantedResume2() {
	audioLog.resumed += 1;
	firstCtx.state = 'running';
	return Promise.resolve();
};
fireDom('visibilitychange');
check('标签页恢复可见时拉活 AudioContext（挂起期间排的音立即续播）', firstCtx.state === 'running' && audioLog.resumed === resumedBefore + 3, `${firstCtx.state} / resumed ${audioLog.resumed - resumedBefore} 次`);

// 排障钩子：test(kind) 三种停止都能当场触发 + 放音；sound() 只放音。
resetNotificationLog();
resetAudioLog();
FakeNotification.permission = 'granted';
windowStub.__dshTaskReminder.test();
check('test() 当场发一条「任务完成」弹窗（取列表第一个会话的名）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '对话任务已完成' && notificationLog.created[0]?.options?.body === '旧任务', JSON.stringify(notificationLog.created));
check('test() 按当前音效与音量放提示音', audioLog.oscillators.length === 2 && audioLog.gains.length === 2 && closeTo(audioLog.gains[0].peak, 0.4375), `${audioLog.oscillators.length} / ${audioLog.gains.length}`);
resetAudioLog();
windowStub.__dshTaskReminder.test('error');
check("test('error') 当场发一条「出错停止」弹窗（不经过判定）", notificationLog.created.length === 2 && notificationLog.created[1]?.title === '任务出错已停止' && notificationLog.created[1]?.options?.body?.includes('400'), JSON.stringify(notificationLog.created[1]));
check("test('error') 也放提示音", audioLog.oscillators.length === 2, String(audioLog.oscillators.length));
resetAudioLog();
windowStub.__dshTaskReminder.test('question');
check("test('question') 当场发一条「提问」弹窗", notificationLog.created.length === 3 && notificationLog.created[2]?.title === '提问', JSON.stringify(notificationLog.created[2]));
resetAudioLog();
windowStub.__dshTaskReminder.test('plan-review');
check("test('plan-review') 当场发一条「方案待确认」弹窗（也接受简写 'plan'）", notificationLog.created.length === 4
	&& notificationLog.created[3]?.title === zh['toast.plan.title'] && notificationLog.created[3]?.options?.tag === `${NOTIFICATION_TAG}-${NOTIFY_KIND_WAITING}`, JSON.stringify(notificationLog.created[3]));
resetAudioLog();
swShown.length = 0;
windowStub.__dshTaskReminder.test('approval');
check("test('approval') 走带按钮的链路（桥 active 时，不发普通通知）", swShown.length === 1
	&& swShown[0]?.title === zh['toast.approval.title'] && swShown[0]?.options?.actions?.length === 2
	&& notificationLog.created.length === 4, JSON.stringify({ swShown: swShown.length, plain: notificationLog.created.length }));
resetAudioLog();
windowStub.__dshTaskReminder.sound();
check('sound() 只放音不发弹窗', audioLog.oscillators.length === 2 && notificationLog.created.length === 4, String(audioLog.oscillators.length));

// 「弹窗一直挂着」开关：默认关（上面各条已断言 false）；打开后 5 类通知都带
// requireInteraction —— 横幅不自动收进通知中心，逼用户点横幅，点击必定送达。
face.setSticky(true);
check('打开「弹窗一直挂着」：写回开关', face.stickyStore.getSnapshot() === true);
resetNotificationLog();
windowStub.__dshTaskReminder.test('completed');
check('打开后：完成类通知带 requireInteraction', notificationLog.created.at(-1)?.options?.requireInteraction === true, JSON.stringify(notificationLog.created.at(-1)?.options));
windowStub.__dshTaskReminder.test('question');
check('打开后：等待类（提问）通知带 requireInteraction', notificationLog.created.at(-1)?.options?.requireInteraction === true
	&& notificationLog.created.at(-1)?.title === zh['toast.question.title'], JSON.stringify(notificationLog.created.at(-1)?.options));
swShown.length = 0;
windowStub.__dshTaskReminder.test('approval');
check('打开后：带按钮的审批通知也带 requireInteraction', swShown.at(-1)?.options?.requireInteraction === true
	&& swShown.at(-1)?.options?.actions?.length === 2, JSON.stringify(swShown.at(-1)?.options));
face.setSticky(false);
check('关回去：横幅恢复自动收（默认态）', face.stickyStore.getSnapshot() === false);
resetNotificationLog();

// ---------------------------------------------------------------------------
// 通知语言（只影响通知文案；设置页本身仍跟随界面语言）
// ---------------------------------------------------------------------------

console.log('');
console.log('通知语言');

face.setNotify(true);
face.setNotifyMode('always');
resetNotificationLog();
resetAudioLog();
activeLocale = 'en-US';
face.setNotifyLanguage('auto');
windowStub.__dshTaskReminder.test('completed');
check('auto 跟随界面：界面英文 → 通知取英文文案', notificationLog.created.length === 1 && notificationLog.created[0]?.title === en['toast.completed.title'], String(notificationLog.created[0]?.title));
check('排障状态给出 auto 折算后的语言', windowStub.__dshTaskReminder.state().notifyLanguage === 'auto' && windowStub.__dshTaskReminder.state().notifyLanguageResolved === 'en', JSON.stringify(windowStub.__dshTaskReminder.state().notifyLanguageResolved));
resetNotificationLog();
activeLocale = 'zh-CN';
face.setNotifyLanguage('en');
windowStub.__dshTaskReminder.test('completed');
check('钉住 English：界面中文时通知仍取英文', notificationLog.created.length === 1 && notificationLog.created[0]?.title === en['toast.completed.title'], String(notificationLog.created[0]?.title));
resetNotificationLog();
face.setNotifyLanguage('zh');
activeLocale = 'en-US';
windowStub.__dshTaskReminder.test('question');
check('钉住简体中文：界面英文时通知仍取中文', notificationLog.created.length === 1 && notificationLog.created[0]?.title === zh['toast.question.title'], String(notificationLog.created[0]?.title));
check('通知语言写回做了归一化（坏值退回 auto）', (face.setNotifyLanguage('bogus'), face.notifyLanguageStore.getSnapshot() === 'auto'), String(face.notifyLanguageStore.getSnapshot()));
check('设置页文案不受通知语言影响（钉英文也不影响界面文案）', (face.setNotifyLanguage('en'), face.t('notify.language.title') === zh['notify.language.title']), face.t('notify.language.title'));
face.setNotifyLanguage('auto');
activeLocale = 'zh-CN';

// 宿主写死的英文：方案待审的问题原文来自 dsh-plan-mode 的 exit_plan_mode
// （`Approve this plan and leave plan mode?`），宿主客户端有自己的中文字典，但
// 通知正文取的是挂起载荷里的原文，不跟界面语言走。插件按通知语言补一层逐字对照：
// 中文换、英文原样透传、认不出的文本（用户 / 模型自己写的）绝不翻译。
resetNotificationLog();
face.setNotifyLanguage('zh');
setPendingInteraction('s4', { sessionId: 's4', kind: 'plan-review', key: 'host:plan-1', questions: [{ id: 'q1', question: 'Approve this plan and leave plan mode?' }] });
check('中文通知语言：方案待审正文的宿主英文换成中文', notificationLog.created.length === 1
	&& notificationLog.created[0]?.title === zh['toast.plan.title']
	&& notificationLog.created[0]?.options?.body === '同意执行这份计划并退出计划模式？', JSON.stringify(notificationLog.created[0]));
setPendingInteraction('s4', null);
resetNotificationLog();
face.setNotifyLanguage('en');
setPendingInteraction('s4', { sessionId: 's4', kind: 'plan-review', key: 'host:plan-2', questions: [{ id: 'q1', question: 'Approve this plan and leave plan mode?' }] });
check('英文通知语言：宿主英文原文原样透传', notificationLog.created.length === 1
	&& notificationLog.created[0]?.options?.body === 'Approve this plan and leave plan mode?', JSON.stringify(notificationLog.created[0]?.options?.body));
setPendingInteraction('s4', null);
resetNotificationLog();
face.setNotifyLanguage('zh');
setPendingInteraction('s4', { sessionId: 's4', kind: 'plan-review', key: 'host:plan-3', questions: [{ id: 'q1', question: '这份计划先不改，能跑通吗？' }] });
check('认不出的原文原样透传（只做逐字对照，不猜着翻）', notificationLog.created.length === 1
	&& notificationLog.created[0]?.options?.body === '这份计划先不改，能跑通吗？', JSON.stringify(notificationLog.created[0]?.options?.body));
setPendingInteraction('s4', null);
resetNotificationLog();
face.setNotifyLanguage('auto');

// ---------------------------------------------------------------------------
// 完成未读补漏（页面刷新 / 插件热重载期间跑完的后台会话）
// ---------------------------------------------------------------------------

console.log('');
console.log('完成未读补漏');

// s9 是这一节新引入的会话：插件本次装载从没见过它的 running 边沿，
// 正好模拟「页面刷新前就跑完了」——只有宿主的「完成未读」电平能救回来。
hostList = { ids: [...hostList.ids, 's9'], byId: { ...hostList.byId, s9: { title: '第九个会话', displayTitle: '第九个会话', running: false } } };
resetNotificationLog();
resetAudioLog();
const completedBeforeUnread = statsNow().completed;
const unreadBefore = statsNow().unreadRecovered;
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 601, reason: { kind: 'completed' } } } }];
setCompletionUnread('s9', true);
await tick();
check('「完成未读」电平补报一条完成（边沿是盲区的那种）', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === '第九个会话', JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
check('补报计入 stats.unreadRecovered 与 completed', statsNow().unreadRecovered === unreadBefore + 1 && statsNow().completed === completedBeforeUnread + 1, JSON.stringify({ unread: statsNow().unreadRecovered, completed: statsNow().completed }));
check('排障状态记着已补报的会话', windowStub.__dshTaskReminder.state().completionUnreadReported.includes('s9'), JSON.stringify(windowStub.__dshTaskReminder.state().completionUnreadReported));
const unreadAfterFirst = statsNow().unreadRecovered;
setCompletionUnread('s9', true);
await tick();
check('同一段未读只补一次（电平没熄灭就不重复弹）', notificationLog.created.length === 1 && statsNow().unreadRecovered === unreadAfterFirst, JSON.stringify({ created: notificationLog.created.length, unread: statsNow().unreadRecovered }));
setCompletionUnread('s9', false);
await tick();
check('电平熄灭（打开会话 / 再跑 / 会话消失）即解锁', !windowStub.__dshTaskReminder.state().completionUnreadReported.includes('s9'), JSON.stringify(windowStub.__dshTaskReminder.state().completionUnreadReported));
// 新的一段未读（新回合）照常补报：锁是按「未读实例」算的。
resetNotificationLog();
fakeEventEntries = [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 602, reason: { kind: 'completed' } } } }];
setCompletionUnread('s9', true);
await tick();
check('新的一段未读照常补报', notificationLog.created.length === 1 && statsNow().unreadRecovered === unreadAfterFirst + 1, JSON.stringify(notificationLog.created.map((item) => item.options?.body)));
setCompletionUnread('s9', false);
await tick();
// 挂起的等待不算完成：宿主在有待答交互时也会点亮这个电平，不能被当成完成。
hostList = { ids: [...hostList.ids, 's10'], byId: { ...hostList.byId, s10: { title: '第十个会话', displayTitle: '第十个会话', running: false } } };
resetNotificationLog();
setPendingInteraction('s10', { sessionId: 's10', kind: 'question', key: 'question:unread', questions: [{ id: 'q1', question: '未读电平也跟着亮？' }] });
resetNotificationLog();
setCompletionUnread('s10', true);
await tick();
check('有 pendingInteraction 时电平补漏让位给等待提醒（不额外报完成）', notificationLog.created.every((item) => item.title !== zh['toast.completed.title']), JSON.stringify(notificationLog.created.map((item) => item.title)));
setPendingInteraction('s10', null);
setCompletionUnread('s10', false);
fakeEventEntries = null;

// ---------------------------------------------------------------------------
// Service Worker 半侧：同一份字节在 worker 上下文里只装点击转信
// ---------------------------------------------------------------------------

console.log('');
console.log('Service Worker 半侧（同源 bundle 当 worker 跑）');

const workerRelayed = [];
const workerListeners = new Map();
const workerClients = [
	{ visibilityState: 'hidden', postMessage: (msg) => workerRelayed.push({ to: 'hidden', msg }), focus: () => Promise.resolve() },
	{ visibilityState: 'visible', postMessage: (msg) => workerRelayed.push({ to: 'visible', msg }), focus: () => Promise.resolve() },
];
const workerStub = {
	registration: {},
	addEventListener: (name, fn) => { workerListeners.set(name, fn); },
	BroadcastChannel: class {
		constructor(name) { this.name = name; }
		postMessage(message) { workerRelayed.push({ to: 'broadcast', msg: message }); }
		close() {}
	},
	clients: { matchAll: () => Promise.resolve(workerClients) },
};
// worker 上下文：window 为 undefined、self 是 worker 全局 —— 外壳必须走 worker 分支。
new Function('window', 'self', 'document', source)(undefined, workerStub, undefined);
check('worker 上下文装了 notificationclick 转信（不碰 __ModuleLoader__）', typeof workerListeners.get('notificationclick') === 'function', JSON.stringify([...workerListeners.keys()]));

workerListeners.get('notificationclick')({
	action: 'approve',
	notification: { close: () => { workerRelayed.push({ closed: true }); }, data: { key: 'approval:3', sessionId: 's2' } },
});
await tick();
check('worker 把「同意」转给页面（广播 + 逐窗口两路并发）', workerRelayed.some((entry) => entry.to === 'broadcast' && entry.msg?.action === 'approve')
	&& workerRelayed.some((entry) => entry.to === 'visible' && entry.msg?.action === 'approve'), JSON.stringify(workerRelayed));
check('转信消息带上 key / sessionId / 来源标记', workerRelayed.some((entry) => entry.msg?.key === 'approval:3' && entry.msg?.sessionId === 's2'
	&& entry.msg?.source === BRIDGE_SOURCE && entry.msg?.type === BRIDGE_MESSAGE_TYPE), JSON.stringify(workerRelayed.map((entry) => entry.msg)));
check('按钮点击不让任何窗口 navigate（在通知上裁决不该抢焦点）', workerRelayed.every((entry) => entry.msg === undefined || entry.msg.navigate === false), JSON.stringify(workerRelayed.map((entry) => entry.msg?.navigate)));
check('worker 收到点击先关掉那条通知', workerRelayed.some((entry) => entry.closed === true));

workerRelayed.length = 0;
workerListeners.get('notificationclick')({ action: '', notification: { close: () => {}, data: { sessionId: 's2' } } });
await tick();
const navigations = workerRelayed.filter((entry) => entry.msg !== undefined).map((entry) => ({ to: entry.to, navigate: entry.msg.navigate }));
check('正文点击：只让一个窗口 navigate，且优先可见的那个', navigations.filter((entry) => entry.navigate === true).length === 1
	&& navigations.some((entry) => entry.to === 'visible' && entry.navigate === true), JSON.stringify(navigations));

check('worker 的频道名固定（页面与 worker 必须一致）', BRIDGE_CHANNEL === 'dsh-task-reminder:bridge', BRIDGE_CHANNEL);
check('isServiceWorkerScope 只认 worker 全局', isServiceWorkerScope({ registration: {}, addEventListener: () => {} }) === true
	&& isServiceWorkerScope(windowStub) === false && isServiceWorkerScope(undefined) === false && isServiceWorkerScope(null) === false);
check('只认启动图里自己那一行 bundle URL', findSelfBundleUrl([
	{ id: 'some-other-plugin', url: '/plugins/some-other-plugin/client.js' },
	{ id: PLUGIN_PACKAGE_NAME, url: '/plugins/@hawkongz/dsh-task-reminder/??/client.js&rev=abc123' },
]) === '/plugins/@hawkongz/dsh-task-reminder/??/client.js&rev=abc123'
	&& findSelfBundleUrl([{ id: 'dsh-task-reminder', url: 'x' }]) === 'x'
	&& findSelfBundleUrl([{ id: 'dsh-task-reminder-extra', url: 'y' }]) === null
	&& findSelfBundleUrl(undefined) === null && findSelfBundleUrl([]) === null);
check('桥对外形状：active 之前 show() 一律 false（不假装发了按钮通知）', (() => {
	const bridge = createActionBridge();
	return typeof bridge.state === 'string' && bridge.active === false
		&& typeof bridge.onMessage === 'function' && typeof bridge.onStateChange === 'function'
		&& bridge.show('标题', {}) === false && bridge.closeTag('x') === undefined;
})());

// ---------------------------------------------------------------------------
// 审批快捷裁决（页面侧：注册 worker、带按钮的通知、点击 → answer）
// ---------------------------------------------------------------------------

console.log('');
console.log('审批快捷裁决（通知上的同意 / 拒绝）');

check('桥注册的是启动图里自己那一行的 bundle URL', swRegisterCalls === 1 && swRegisterUrls[0] === windowStub.__DSH_BOOT__.entries[1].url, JSON.stringify(swRegisterUrls));
check('桥状态 active（worker 注册成功）', windowStub.__dshTaskReminder.state().approvalBridge === 'active', String(windowStub.__dshTaskReminder.state().approvalBridge));

// 审批挂起 → 走 worker 弹带两个按钮的持久通知。
resetNotificationLog();
swShown.length = 0;
FakeNotification.permission = 'granted';
face.setNotify(true);
face.setNotifyMode('always');
answeredOutcomes.length = 0;
const approvalA = {
	sessionId: 's3',
	kind: 'approval',
	key: 'approval:7',
	answer: (outcome) => { answeredOutcomes.push(outcome); return Promise.resolve(); },
};
setPendingInteraction('s3', approvalA);
check('审批挂起：走 worker 弹通知，而不是 Notification 构造函数', swShown.length === 1 && notificationLog.created.length === 0, JSON.stringify({ swShown: swShown.length, plain: notificationLog.created.length }));
check('审批通知：标题是「审批请求」+ 两个按钮（同意 / 拒绝）', swShown[0]?.title === zh['toast.approval.title']
	&& swShown[0]?.options?.actions?.map((item) => item.action).join(',') === 'approve,reject'
	&& swShown[0]?.options?.actions?.[0]?.title === zh['toast.approve']
	&& swShown[0]?.options?.actions?.[1]?.title === zh['toast.reject'], JSON.stringify(swShown[0]));
check('审批通知带 data.key / sessionId，并且 silent（声音只由插件负责）', swShown[0]?.options?.data?.key === 'approval:7' && swShown[0]?.options?.data?.sessionId === 's3'
	&& swShown[0]?.options?.silent === true && swShown[0]?.options?.renotify === true, JSON.stringify(swShown[0]?.options));
check('带按钮的通知自己占 tag 槽位（不会被别的等待顶掉）', String(swShown[0]?.options?.tag).includes('approval:7'), String(swShown[0]?.options?.tag));
check('默认关闭：带按钮的审批通知也不设 requireInteraction', swShown[0]?.options?.requireInteraction === false, JSON.stringify(swShown[0]?.options));
check('排障状态列着这条未结清的审批通知', windowStub.__dshTaskReminder.state().approvalToasts.includes('approval:7'), JSON.stringify(windowStub.__dshTaskReminder.state().approvalToasts));

// worker 转回「同意」→ 调审批对象自己的 answer('allowed-once')
const pageChannel = broadcastChannels[broadcastChannels.length - 1];
pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: 'approve', key: 'approval:7', sessionId: 's3', navigate: false } });
await tick();
check('点「同意」：调 answer("allowed-once")（＝审批卡片的「允许一次」）', answeredOutcomes.join(',') === APPROVAL_GRANT, JSON.stringify(answeredOutcomes));
check('裁决记进 stats.decisions 与 lastDecision', windowStub.__dshTaskReminder.state().stats.decisions === 1 && windowStub.__dshTaskReminder.state().stats.lastDecision?.outcome === APPROVAL_GRANT, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastDecision));
check('裁决后账上不再留这条通知，并清掉它的 tag', !windowStub.__dshTaskReminder.state().approvalToasts.includes('approval:7'), JSON.stringify(windowStub.__dshTaskReminder.state().approvalToasts));
check('关通知时按 tag 找（只关这一条，不动别的）', swClosed.includes(String(swShown[0]?.options?.tag)), JSON.stringify(swClosed));

pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: 'approve', key: 'approval:7', sessionId: 's3', navigate: false } });
await tick();
check('重复点击是空操作（不会裁决第二次）', answeredOutcomes.length === 1, JSON.stringify(answeredOutcomes));

// 「拒绝」→ answer('rejected')
setPendingInteraction('s3', null);
swShown.length = 0;
setPendingInteraction('s3', { sessionId: 's3', kind: 'approval', key: 'approval:8', answer: (outcome) => { answeredOutcomes.push(outcome); return Promise.resolve(); } });
pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: 'reject', key: 'approval:8', sessionId: 's3', navigate: false } });
await tick();
check('点「拒绝」：调 answer("rejected")', answeredOutcomes.join(',') === `${APPROVAL_GRANT},${APPROVAL_REJECT}`, JSON.stringify(answeredOutcomes));

// 陈旧通知：等待已经被新请求顶替（key 变了）→ 什么都不裁决
setPendingInteraction('s3', null);
swShown.length = 0;
setPendingInteraction('s3', { sessionId: 's3', kind: 'approval', key: 'approval:9', answer: (outcome) => { answeredOutcomes.push(outcome); return Promise.resolve(); } });
const answeredBeforeStale = answeredOutcomes.length;
pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: 'approve', key: 'approval:8', sessionId: 's3', navigate: false } });
await tick();
check('陈旧通知（key 已被新请求顶替）不裁决任何东西', answeredOutcomes.length === answeredBeforeStale, JSON.stringify(answeredOutcomes));

// 页面里从别处裁决（审批卡片 / 别的标签页）→ 等待消散，按钮通知一并收掉
swClosed.length = 0;
const toastsBeforeTeardown = windowStub.__dshTaskReminder.state().approvalToasts.slice();
setPendingInteraction('s3', null);
check('等待消散：未结清的审批通知被收掉（不留点了没用的按钮）', swClosed.length >= 1 && toastsBeforeTeardown.includes('approval:9'), JSON.stringify({ closed: swClosed, toasts: toastsBeforeTeardown }));

// 没有 answer 方法的审批（别的形状 / 老宿主）：退回普通无按钮通知
resetNotificationLog();
swShown.length = 0;
setPendingInteraction('s3', { sessionId: 's3', kind: 'approval', key: 'approval:11' });
check('没有 answer 的审批：退回普通通知（不假装有按钮）', swShown.length === 0 && notificationLog.created.length === 1
	&& notificationLog.created[0]?.options?.tag === `${NOTIFICATION_TAG}-${NOTIFY_KIND_WAITING}`, JSON.stringify({ swShown: swShown.length, plain: notificationLog.created[0]?.options?.tag }));
setPendingInteraction('s3', null);

// 审批通知的正文：工具名 + 理由（displayReason 按通知语言取）。宿主侧审批
// 交互（PendingApproval）不带 questions 列表 —— 曾经的 bug 是正文恒等于
// 会话名：通知上带着「同意 / 拒绝」却看不出要批准什么（1.6.1 修）。
resetNotificationLog();
swShown.length = 0;
setPendingInteraction('s3', {
	sessionId: 's3', kind: 'approval', key: 'approval:body', answer: () => Promise.resolve(),
	toolName: 'bash',
	reason: 'escalate sandbox to danger-full-access: 用户要求再弹一次审批',
	displayReason: {
		en: 'Allow this operation with danger-full-access permissions: user asked for another approval popup',
		zh: '允许本次操作使用 danger-full-access 权限：用户要求再弹一次审批',
	},
});
check('审批正文：工具名 + displayReason 中文文案（不退回会话名「第三个会话」）', swShown.length === 1
	&& swShown[0]?.options?.body === 'bash：允许本次操作使用 danger-full-access 权限：用户要求再弹一次审批', JSON.stringify(swShown[0]?.options?.body));
setPendingInteraction('s3', null);

// 通知语言钉英文：取 displayReason.en，分隔符用半角冒号。
resetNotificationLog();
swShown.length = 0;
face.setNotifyLanguage('en');
setPendingInteraction('s3', {
	sessionId: 's3', kind: 'approval', key: 'approval:body-en', answer: () => Promise.resolve(),
	toolName: 'bash',
	displayReason: {
		en: 'Allow this operation with danger-full-access permissions: user asked for another approval popup',
		zh: '允许本次操作使用 danger-full-access 权限：用户要求再弹一次审批',
	},
});
check('通知语言钉英文：审批正文取 displayReason.en', swShown[0]?.options?.body === 'bash: Allow this operation with danger-full-access permissions: user asked for another approval popup', JSON.stringify(swShown[0]?.options?.body));
setPendingInteraction('s3', null);

// 没有 displayReason：退回未本地化的 reason。
resetNotificationLog();
swShown.length = 0;
face.setNotifyLanguage('auto');
setPendingInteraction('s3', { sessionId: 's3', kind: 'approval', key: 'approval:body-raw', answer: () => Promise.resolve(), toolName: 'bash', reason: 'escalate sandbox to danger-full-access: raw reason' });
check('没有 displayReason：正文用未本地化的 reason', swShown[0]?.options?.body === 'bash：escalate sandbox to danger-full-access: raw reason', JSON.stringify(swShown[0]?.options?.body));
setPendingInteraction('s3', null);

// 工具与理由都没有：退回会话名（兜底，不是审批内容本身）。
resetNotificationLog();
swShown.length = 0;
setPendingInteraction('s3', { sessionId: 's3', kind: 'approval', key: 'approval:body-empty', answer: () => Promise.resolve() });
check('工具与理由都缺：退回会话名（兜底）', swShown[0]?.options?.body === '第三个会话', JSON.stringify(swShown[0]?.options?.body));
setPendingInteraction('s3', null);

// 排障用的测试审批：点了只回一条测试反馈，不裁决任何真实请求
resetNotificationLog();
swShown.length = 0;
windowStub.__dshTaskReminder.test('approval');
check("test('approval') 发的是带按钮的测试审批通知", swShown.length === 1 && swShown[0]?.options?.data?.key === TEST_APPROVAL_KEY, JSON.stringify(swShown[0]?.options?.data));
pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: 'approve', key: TEST_APPROVAL_KEY, sessionId: null, navigate: false } });
check('测试审批点「同意」：只回一条测试反馈', notificationLog.created.length === 1 && notificationLog.created[0]?.options?.body === zh['test.approved'], JSON.stringify(notificationLog.created));
check('测试审批也记进 stats.decisions（并标了 test）', windowStub.__dshTaskReminder.state().stats.lastDecision?.test === true, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastDecision));

// 正文点击转回页面：navigate 只对一个窗口为真
const openedBeforeBridge = opened.length;
pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: '', key: null, sessionId: 's2', navigate: false } });
check('navigate=false（别的标签页收到的那份）：不切会话', opened.length === openedBeforeBridge, JSON.stringify(opened.slice(-2)));
pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: '', key: null, sessionId: 's2', navigate: true } });
check('navigate=true：打开提醒所属的会话', opened.at(-1) === 's2', String(opened.at(-1)));
check('带按钮通知的正文点击也留痕（via = sw）', windowStub.__dshTaskReminder.state().stats.lastJump?.ok === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.via === 'sw'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.sessionId === 's2', JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
pageChannel.onmessage({ data: { source: 'other-plugin', type: BRIDGE_MESSAGE_TYPE, action: 'approve', key: 'approval:8', sessionId: 's3', navigate: true } });
check('来源标记不对的消息直接忽略', opened.at(-1) === 's2');
// 收尾：把上面那次「打开会话」排下的「落到提问」轮询打空（还没装会话画面 →
// 一定是 no-column），别让它留到下面那节用例里被一起触发。
clearQuestionStage();
for (let i = 0; i < QUESTION_MAX_ATTEMPTS + 2; i += 1) flushTimers();
clearQuestionStage();

// ---------------------------------------------------------------------------
// 点弹窗落到你这次提问的位置（DSH 没有滚动 API → 自己把最后一条你的消息对到顶部）
// ---------------------------------------------------------------------------

console.log('');
console.log('点弹窗落到你的提问位置');

check('定位参数取自 DSH 界面（列 / 滚动口 / 挂载点会话号 / 你的消息两种类型 / 对齐偏移）',
	QUESTION_FLOW_ATTR === 'data-chat-flow' && QUESTION_SCROLL_ATTR === 'data-conversation-scroll'
	&& QUESTION_SESSION_ATTR === 'data-conversation-session'
	&& QUESTION_ROW_ATTR === 'data-chat-flow-kind' && QUESTION_ROW_KINDS.join(',') === 'user,steering'
	&& QUESTION_ROW_SELECTOR === QUESTION_ROW_SELECTOR_STUB
	&& QUESTION_ALIGN_MARGIN === 24 && QUESTION_ALIGN_TOLERANCE < QUESTION_ALIGN_MARGIN
	&& QUESTION_POLL_MS > 0 && QUESTION_MAX_ATTEMPTS >= 2 && QUESTION_STABLE_ATTEMPTS >= 1,
	JSON.stringify({ QUESTION_FLOW_ATTR, QUESTION_SCROLL_ATTR, QUESTION_SESSION_ATTR, QUESTION_ROW_ATTR, QUESTION_ROW_KINDS, QUESTION_ROW_SELECTOR, QUESTION_ALIGN_MARGIN, QUESTION_ALIGN_TOLERANCE }));
check('「你的消息」只认 user / steering（turn-trigger 是系统唤醒行，不在选择器里）',
	!QUESTION_ROW_SELECTOR.includes('turn-trigger') && QUESTION_ROW_SELECTOR.includes('"user"') && QUESTION_ROW_SELECTOR.includes('"steering"'));
check('导语不再承诺落到对话底部，改成落到你这次提问的位置',
	!zh['intro'].includes('底部') && zh['intro'].includes('你这次提问的位置')
	&& !en['intro'].includes('at the bottom') && en['intro'].includes('at your last question'), zh['intro']);

// 找行：DOM 顺序的最后一条「你的消息」；助手行不在候选里，hidden 行要跳过。
clearQuestionStage();
check('读不到 DOM / 没有会话流列 → 找不到行（静默收工）',
	findLatestQuestionRow(null) === null && findLatestQuestionRow(undefined) === null && findLatestQuestionRow({}) === null);
const finderStage = installQuestionStage({ rows: [
	{ kind: 'assistant-step', contentTop: 100 },
	{ kind: 'user', contentTop: 700 },
	{ kind: 'steering', contentTop: 1300 },
	{ kind: 'assistant-step', contentTop: 1900 },
] });
const finderCandidates = finderStage.column.rows.filter((row) => row.kind === 'user' || row.kind === 'steering');
check('候选只有 user / steering（助手行被选择器挡掉）', finderStage.column.querySelectorAll(QUESTION_ROW_SELECTOR_STUB).length === 2);
check('找最后一条你的消息（steering 比 user 新，取 steering）', findLatestQuestionRow(finderStage.column) === finderCandidates[1], String(finderCandidates.indexOf(findLatestQuestionRow(finderStage.column))));
const hiddenStage = installQuestionStage({ rows: [
	{ kind: 'user', contentTop: 700 },
	{ kind: 'user', contentTop: 1300, hidden: true },
	{ kind: 'user', contentTop: 1900, hiddenAncestor: true },
] });
check('带 hidden 的行、藏在 hidden 祖先里的行都跳过 → 取上一条', findLatestQuestionRow(hiddenStage.column) === hiddenStage.rows[0], String(hiddenStage.rows.indexOf(findLatestQuestionRow(hiddenStage.column))));
const allHiddenStage = installQuestionStage({ rows: [
	{ kind: 'user', contentTop: 700, hidden: true },
	{ kind: 'user', contentTop: 1300, hiddenAncestor: true },
] });
check('全被藏起来时一行都找不到（不硬滚）', findLatestQuestionRow(allHiddenStage.column) === null);
clearQuestionStage();

// 滚动容器：优先列祖先上的 [data-conversation-scroll]，没有就退回列的父节点。
const innerStage = installQuestionStage({ rows: [{ kind: 'user', contentTop: 700 }] });
check('没有外层滚动口时用列的父节点（聊天自己的 _scroll）', questionScroller(innerStage.column) === innerStage.inner, JSON.stringify(Boolean(questionScroller(innerStage.column))));
const outerStage = installQuestionStage({ withOuter: true, rows: [{ kind: 'user', contentTop: 700 }] });
check('有共享会话壳的滚动口时用它（与应用的 closest(...) ?? list 同规则）', questionScroller(outerStage.column) === outerStage.outer && questionScroller(outerStage.column) !== outerStage.inner);
const bareStage = installQuestionStage({ rows: [{ kind: 'user', contentTop: 700 }] });
bareStage.column.parentElement = null;
check('两级都拿不到时返回 null（这一节直接收工，不当成对齐）', questionScroller(bareStage.column) === null && questionScroller(null) === null);
clearQuestionStage();

// 对齐：行顶 = 滚动口顶 + margin；已经在容差内不写；那个方向滚不动了也不写。
const alignStage = installQuestionStage({ rows: [{ kind: 'user', contentTop: 800 }] });
check('行在下面：写一次 scrollTop 把它对到 24px 处', alignQuestionRow(alignStage.rows[0], alignStage.scroller) === 'moved' && alignStage.scroller.scrollTop === 800 - QUESTION_ALIGN_MARGIN, String(alignStage.scroller.scrollTop));
check('写完再量：已在容差内 → aligned（且不再写）', alignQuestionRow(alignStage.rows[0], alignStage.scroller) === 'aligned' && alignStage.scroller.scrollTop === 800 - QUESTION_ALIGN_MARGIN);
const nearStage = installQuestionStage({ scrollTop: 600, rows: [{ kind: 'user', contentTop: 600 + QUESTION_ALIGN_MARGIN }] });
check('本来就在 24px 处：什么也不写', alignQuestionRow(nearStage.rows[0], nearStage.scroller) === 'aligned' && nearStage.scroller.scrollTop === 600);
const topStage = installQuestionStage({ rows: [{ kind: 'user', contentTop: 10 }] });
check('行靠顶（要往上滚但它已经在顶上）：算就位，不写（否则每拍加一点会把视口推走）',
	alignQuestionRow(topStage.rows[0], topStage.scroller) === 'aligned' && topStage.scroller.scrollTop === 0, String(topStage.scroller.scrollTop));
const bottomStage = installQuestionStage({ scrollTop: 3400, scrollHeight: 4000, rows: [{ kind: 'user', contentTop: 5000 }] });
check('行靠底（要往下滚但已经到底）：同样算就位，不写',
	alignQuestionRow(bottomStage.rows[0], bottomStage.scroller) === 'aligned' && bottomStage.scroller.scrollTop === 3400, String(bottomStage.scroller.scrollTop));
check('读不到几何时按就位处理（不能因为量不到就反复写）', alignQuestionRow(null, alignStage.scroller) === 'aligned' && alignQuestionRow({}, alignStage.scroller) === 'aligned');
clearQuestionStage();

// 点完成弹窗：打开会话 + 轮到你的提问处，连续两拍坐稳后自己收工。
FakeNotification.permission = 'granted';
face.setNotifyMode('always');
face.setNotify(true);
resetNotificationLog();
resetAudioLog();
completeOnce();
await tick();
check('完成先弹一条通知（准备点它）', notificationLog.created.length === 1, String(notificationLog.created.length));
const clickStage = installQuestionStage({ rows: [
	{ kind: 'user', contentTop: 700 },
	{ kind: 'assistant-step', contentTop: 1300 },
	{ kind: 'user', contentTop: 2600 },
	{ kind: 'assistant-step', contentTop: 3200 },
] });
const timersBeforeClick = timerEntries.length;
notificationLog.created[0].onclick();
check('点弹窗仍然打开对应会话', opened.at(-1) === 's2', String(opened.at(-1)));
check('点弹窗后排下第一拍轮询', timerEntries.length === timersBeforeClick + 1, String(timerEntries.length - timersBeforeClick));
flushTimers();
check('轮询把最后一条你的消息对到视口顶部 24px 处', clickStage.scroller.scrollTop === 2600 - QUESTION_ALIGN_MARGIN, String(clickStage.scroller.scrollTop));
check('坐稳后不再继续轮询（两拍确认 + 一拍落位 = 3 拍）', timerEntries.length === timersBeforeClick + 1 + QUESTION_STABLE_ATTEMPTS, String(timerEntries.length - timersBeforeClick));
check('排障结果记成 aligned（写在 stats.lastQuestionJump）', statsNow().lastQuestionJump?.result === 'aligned' && statsNow().lastQuestionJump?.sessionId === 's2', JSON.stringify(statsNow().lastQuestionJump));

// 等待类弹窗（审批 / 提问 / 方案）走的也是同一条落地规则（用户要求三类一致）。
clearQuestionStage();
resetNotificationLog();
const bridgeStage = installQuestionStage({ rows: [{ kind: 'user', contentTop: 900 }] });
const openedBeforeBridge2 = opened.length;
pageChannel.onmessage({ data: { source: BRIDGE_SOURCE, type: BRIDGE_MESSAGE_TYPE, action: '', key: null, sessionId: 's3', navigate: true } });
check('审批弹窗正文点击：仍然打开对应会话', opened.length === openedBeforeBridge2 + 1 && opened.at(-1) === 's3', String(opened.at(-1)));
flushTimers();
check('等待类弹窗也落到你的提问处（不再是底部）', bridgeStage.scroller.scrollTop === 900 - QUESTION_ALIGN_MARGIN, String(bridgeStage.scroller.scrollTop));
check('排障结果记的是这次点击的会话', statsNow().lastQuestionJump?.sessionId === 's3' && statsNow().lastQuestionJump?.result === 'aligned', JSON.stringify(statsNow().lastQuestionJump));

// 切会话要一拍才落地：挂载点还写着上一次的会话时先不动，到上限如实记 other-session。
clearQuestionStage();
const otherStage = installQuestionStage({ mountedSession: 's-old', rows: [{ kind: 'user', contentTop: 900 }] });
resetNotificationLog();
completeOnce();
await tick();
const timersBeforeOther = timerEntries.length;
const openedBeforeOther = opened.length;
notificationLog.created[0].onclick();
flushTimers();
check('挂载的还是上一次的会话：一像素都不动，到上限记 other-session',
	otherStage.scroller.scrollTop === 0 && timerEntries.length === timersBeforeOther + QUESTION_MAX_ATTEMPTS && statsNow().lastQuestionJump?.result === 'other-session',
	JSON.stringify({ top: otherStage.scroller.scrollTop, added: timerEntries.length - timersBeforeOther, last: statsNow().lastQuestionJump }));
// 目标没挂上来的那几拍里要补开会话（幂等）：首开 1 次 + 15 拍里每 4 拍补一次（3 次）= 4 次。
// 这条修的是同工作区小概率「openSession 被 DSH 自己的导航/恢复盖掉」。
check('挂载对不上时补开一次会话（首开 + 每 4 拍共 4 次）',
	opened.slice(openedBeforeOther).filter((id) => id === 's2').length === 4,
	JSON.stringify(opened.slice(openedBeforeOther)));

// 挂载点已经是刚打开的那个会话：照常对齐（会话号对不上只是「再等一拍」，不是放弃）。
const switchedStage = installQuestionStage({ mountedSession: 's2', rows: [{ kind: 'user', contentTop: 1200 }] });
resetNotificationLog();
completeOnce();
await tick();
notificationLog.created[0].onclick();
flushTimers();
check('会话号对上后照常对齐（核对只是延后，不会白等）', switchedStage.scroller.scrollTop === 1200 - QUESTION_ALIGN_MARGIN && statsNow().lastQuestionJump?.result === 'aligned', String(switchedStage.scroller.scrollTop));
check('挂载点会话号的读取：有属性读得到，没有这层属性时给 null（跳过核对）',
	mountedSessionId(installQuestionStage({ mountedSession: 's9' }).column) === 's9'
	&& mountedSessionId(installQuestionStage({}).column) === null && mountedSessionId(null) === null,
	JSON.stringify([mountedSessionId(installQuestionStage({ mountedSession: 's9' }).column), mountedSessionId(installQuestionStage({}).column)]));

// 认不出会话画面（DSH 界面变了 / 还不是聊天视图）：轮询到上限自己停，不抛不卡。
clearQuestionStage();
resetNotificationLog();
completeOnce();
await tick();
const timersBeforeGiveUp = timerEntries.length;
notificationLog.created[0].onclick();
flushTimers();
check('找不到会话画面：轮询到上限自动停止', timerEntries.length === timersBeforeGiveUp + QUESTION_MAX_ATTEMPTS, String(timerEntries.length - timersBeforeGiveUp));
check('放弃时记成 no-column（排障一眼看出是界面没认出来）', statsNow().lastQuestionJump?.result === 'no-column', JSON.stringify(statsNow().lastQuestionJump));

// 会话画面在、但没有「你的消息」行：同样到上限收工。
installQuestionStage({ rows: [{ kind: 'assistant-step', contentTop: 700 }] });
resetNotificationLog();
completeOnce();
await tick();
const timersBeforeNoQuestion = timerEntries.length;
notificationLog.created[0].onclick();
flushTimers();
check('有会话画面但没有你的消息：轮询到上限后记 no-question',
	timerEntries.length === timersBeforeNoQuestion + QUESTION_MAX_ATTEMPTS && statsNow().lastQuestionJump?.result === 'no-question',
	JSON.stringify({ added: timerEntries.length - timersBeforeNoQuestion, last: statsNow().lastQuestionJump }));

// 排障钩子：不点弹窗也能当场跑一次（现场验证定位规则用）。
clearQuestionStage();
const debugStage = installQuestionStage({ rows: [{ kind: 'user', contentTop: 1500 }] });
windowStub.__dshTaskReminder.focusQuestion('s7');
check('focusQuestion() 当场排一拍轮询（不用等弹窗）', timerEntries.at(-1)?.fired === false && timerEntries.at(-1)?.ms === QUESTION_POLL_MS, JSON.stringify(timerEntries.at(-1)));
flushTimers();
check('focusQuestion() 同样把行对到 24px 处并记进排障统计',
	debugStage.scroller.scrollTop === 1500 - QUESTION_ALIGN_MARGIN && statsNow().lastQuestionJump?.sessionId === 's7', JSON.stringify(statsNow().lastQuestionJump));

// 排障一行报告：一条命令看清「跑到哪一步 + DSH 那套 DOM 还在不在」。
const reportStage = installQuestionStage({ withOuter: true, mountedSession: 's2', rows: [
	{ kind: 'assistant-step', contentTop: 200 },
	{ kind: 'user', contentTop: 900 },
] });
windowStub.__dshTaskReminder.focusQuestion('s2');
flushTimers();
const reportText = windowStub.__dshTaskReminder.report();
const report = JSON.parse(reportText);
check('report() 一行说全：跑到哪一步 + 会话号 + 会话流列 / 你的消息行 / 滚动口计数',
	report.build === PLUGIN_BUILD && report.version === PLUGIN_VERSION
	&& report.lastQuestionJump?.result === 'aligned' && report.mountedSession === 's2'
	&& report.column === 1 && report.questionRows === 1 && report.scrollHosts === 1,
	reportText);
check('report() 给出滚动口几何与行在视口里的位置（对齐后＝24px）',
	report.scroller?.scrollTop === 900 - QUESTION_ALIGN_MARGIN && report.scroller?.clientHeight === 600
	&& report.rowTopInView === QUESTION_ALIGN_MARGIN && report.row?.height === 60,
	JSON.stringify({ scroller: report.scroller, rowTopInView: report.rowTopInView, row: report.row }));
check('report() 带上「这份实例装载时刻 / 现在 / 点击多久前」：旧记录不会冒充刚才那次',
	typeof report.instanceStartedAt === 'number' && typeof report.now === 'number'
	&& report.now >= report.instanceStartedAt && typeof report.clickAgeMs === 'number'
	&& report.clickBeforeThisInstance === false, JSON.stringify({ started: report.instanceStartedAt, now: report.now, age: report.clickAgeMs }));
check('report() 把全部会话流列列出来（选中是不是眼前那一列，只有这份清单答得了）',
	Array.isArray(report.columns) && report.columns.length === 1
	&& report.columns[0].session === 's2' && report.columns[0].hidden === false && report.columns[0].questionRows === 1,
	JSON.stringify(report.columns));
// 留痕跨热重载保留：点击 / 跳转 / 落位三笔都同时写进页面级表，插件换一份实例也能读到。
const clickDiagStore = windowStub.__dshTaskReminderClickRouter?.clickDiag;
const jumpDiagStore = windowStub.__dshTaskReminderClickRouter?.jumpDiag;
check('点击 / 跳转 / 落位留痕都压在页面级表里（跨热重载不丢）',
	clickDiagStore?.last?.sessionId === 's2' && clickDiagStore.count >= 1
	&& jumpDiagStore?.last?.sessionId === 's2' && jumpDiagStore?.question?.sessionId === 's2',
	JSON.stringify({ click: clickDiagStore?.last, jump: jumpDiagStore?.last, question: jumpDiagStore?.question }));
check('留痕取更新的那份：实例里没有（刚热重载过）就用页面级；两边都有就按时间取新',
	(() => {
		const shared = { at: 200, sessionId: 's-shared' };
		return newerRecord(null, shared) === shared && newerRecord(shared, null) === shared
			&& newerRecord({ at: 100, sessionId: 's-instance' }, shared) === shared
			&& newerRecord({ at: 300, sessionId: 's-newer' }, shared).sessionId === 's-newer'
			&& newerRecord(null, null) === null;
	})(), JSON.stringify({ nullShared: newerRecord(null, null) }));
const plantedOlderClick = { at: 1, kind: 'completed', sessionId: 's-old' };
const plantedClick = { ...clickDiagStore.last };
clickDiagStore.last = plantedOlderClick;
const olderReport = JSON.parse(windowStub.__dshTaskReminder.report());
check('页面级表里是更旧的一次点击：report() 仍报更新的那份（旧记录不会冒充刚才那次）',
	olderReport.lastClick?.sessionId === 's2' && olderReport.clickBeforeThisInstance === false
	&& typeof olderReport.clickAgeMs === 'number', JSON.stringify(olderReport.lastClick));
clickDiagStore.last = plantedClick;
clearQuestionStage();
const emptyReport = JSON.parse(windowStub.__dshTaskReminder.report());
check('没有会话画面时 report() 不抛：计数 0、几何全 null（一眼看出断在哪）',
	emptyReport.column === 0 && emptyReport.questionRows === 0 && emptyReport.scrollHosts === 0
	&& emptyReport.mountedSession === null && emptyReport.scroller === null && emptyReport.rowTopInView === null,
	JSON.stringify(emptyReport));
clearQuestionStage();

// ---------------------------------------------------------------------------
// 多个会话流列同时挂着：对齐必须落在**目标会话那一列**上
// （实测桌面端 DOM 里同时有 3 个 [data-chat-flow]、网页端 30 个；原先盲取
//  第一个，可能对着别的会话滚一遍 —— 留痕写着 aligned、用户眼前一动没动）
// ---------------------------------------------------------------------------

console.log('');
console.log('会话流列的选择');

check('isHiddenElement：自带 hidden / 藏在 hidden 祖先里都算藏起来', (() => {
	const hiddenSelf = { hasAttribute: (name) => name === 'hidden', closest: () => null };
	const hiddenAncestor = { hasAttribute: () => false, closest: (selector) => (selector === '[hidden]' ? {} : null) };
	const visible = { hasAttribute: () => false, closest: () => null };
	return isHiddenElement(hiddenSelf) === true && isHiddenElement(hiddenAncestor) === true
		&& isHiddenElement(visible) === false && isHiddenElement(null) === false;
})());
const multiStage = installQuestionStage({
	mountedSession: 's-other',
	rows: [{ kind: 'user', contentTop: 700 }],
	extraColumns: [
		{ mountedSession: 's-target', rows: [{ kind: 'user', contentTop: 1500 }] },
		{ mountedSession: 's-hidden', hidden: true, rows: [{ kind: 'user', contentTop: 2000 }] },
	],
});
check('pickConversationColumn：命中挂载会话号等于目标的那一列（不是 DOM 里第一个）',
	pickConversationColumn(documentStub, 's-target') === multiStage.extras[0].column,
	JSON.stringify(multiStage.extras.map((entry) => entry.column.closest(QUESTION_SESSION_SELECTOR)?.getAttribute('data-conversation-session'))));
check('pickConversationColumn：目标列不在时退回第一个**可见**列（藏起来的不算）',
	pickConversationColumn(documentStub, 's-missing') === multiStage.column && pickConversationColumn(documentStub, null) === multiStage.column);
check('conversationColumnInfo：把所有列连同会话号 / 藏没藏 / 行数 / 滚动口一起报出来',
	conversationColumnInfo(documentStub).length === 3
	&& conversationColumnInfo(documentStub)[0].session === 's-other'
	&& conversationColumnInfo(documentStub)[1].session === 's-target' && conversationColumnInfo(documentStub)[1].questionRows === 1
	&& conversationColumnInfo(documentStub)[2].hidden === true,
	JSON.stringify(conversationColumnInfo(documentStub)));
check('全部列都藏起来时仍退回第一个列（不比「取第一个」差）', (() => {
	installQuestionStage({ mountedSession: 's-a', extraColumns: [{ mountedSession: 's-b', hidden: true }] });
	const picked = pickConversationColumn(documentStub, 's-b');
	return picked !== null && picked.closest(QUESTION_SESSION_SELECTOR)?.getAttribute('data-conversation-session') === 's-a';
})(), JSON.stringify(conversationColumnInfo(documentStub)));
// 集成：点击提醒落到目标会话那一列上，别的列一像素都不动。
const multiClickStage = installQuestionStage({
	mountedSession: 's-other',
	rows: [{ kind: 'user', contentTop: 700 }],
	extraColumns: [{ mountedSession: 's2', rows: [{ kind: 'user', contentTop: 1500 }] }],
});
windowStub.__dshTaskReminder.focusQuestion('s2');
flushTimers();
check('多列时对齐落在目标会话那一列上（另一列的滚动位置不动）',
	multiClickStage.extras[0].column.parentElement.scrollTop === 1500 - QUESTION_ALIGN_MARGIN
	&& multiClickStage.scroller.scrollTop === 0
	&& statsNow().lastQuestionJump?.result === 'aligned',
	JSON.stringify({ target: multiClickStage.extras[0].column.parentElement.scrollTop, other: multiClickStage.scroller.scrollTop, last: statsNow().lastQuestionJump }));
check('report() 报的 mountedSession 与列清单能对上看的是不是同一列',
	JSON.parse(windowStub.__dshTaskReminder.report()).columns.length === 2, windowStub.__dshTaskReminder.report());
clearQuestionStage();

// 现实里见过的 DOM 形状（2026-10-07 现场 report）：三个会话流列**共用**一个挂着
// `data-conversation-session` 的外层壳，于是列上读出来的会话号全是同一个 —— DOM
// 根本分辨不了显示了哪个会话。这时唯一可信的判据是 DSH 自己的 mainReference。
ctxStub.uiWorkspace.mainReference = { sessionId: 's1' };
workspaceSnapshot = {
	items: [{ workspaceId: 'ws-ds', sessionIds: ['s1'] }, { workspaceId: 'ws-other', sessionIds: ['s-target'] }],
	pinnedSessionIds: [],
	archivedSessionIds: [],
};
clearQuestionStage();
installQuestionStage({
	mountedSession: 's-shared',
	rows: [{ kind: 'user', contentTop: 700 }],
	extraColumns: [
		{ mountedSession: 's-shared', hidden: true },
		{ mountedSession: 's-shared', hidden: true },
	],
});
windowStub.__dshTaskReminder.jump('s-target');
await tick();
flushTimers();
check('多个列共用外层会话壳（列上会话号分辨不了）时：按 mainReference 判成功，不误报 mounted:false',
	windowStub.__dshTaskReminder.state().stats.lastJump?.mounted === true
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.verifiedBy === 'main-reference'
	&& windowStub.__dshTaskReminder.state().stats.lastJump?.mainSession === 's-target',
	JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastJump));
check('report() 里 mainSession 与 mountedSession 各自独立报出（分辨不了时一眼看出该信哪个）', (() => {
	const live = JSON.parse(windowStub.__dshTaskReminder.report());
	return live.mainSession === 's-target' && live.mountedSession === 's-shared';
})(), windowStub.__dshTaskReminder.report());
clearQuestionStage();
workspaceSnapshot = { items: [], pinnedSessionIds: [], archivedSessionIds: [] };
ctxStub.uiWorkspace.mainReference = { sessionId: 's1' };

// ---------------------------------------------------------------------------
// 自定义音效：上传本机音频（IndexedDB 存字节 + decodeAudioData 解码 + 播放）
// ---------------------------------------------------------------------------

console.log('');
console.log('自定义音效');

/** 桩里的「本机音频文件」：只带插件用到的那四个字段。 */
const makeAudioFile = (name, size) => ({
	name,
	size,
	type: 'audio/mpeg',
	arrayBuffer: async () => new ArrayBuffer(16),
});
/** 让自定义音效的异步链路（IndexedDB → 解码 → 试听）全部落地。 */
const settle = async (rounds = 4) => {
	for (let i = 0; i < rounds; i += 1) await tick();
};
const customState = () => windowStub.__dshTaskReminder.state().customSound;
const storedRecord = () => idbBacking.records.get('custom');

face.setVolume(80);
resetAudioLog();
face.setCustomSound(makeAudioFile('ding.mp3', 120 * 1024));
await settle();
check('选文件即存进 IndexedDB（唯一那条记录带音频字节）', storedRecord()?.name === 'ding.mp3' && typeof storedRecord()?.blob?.arrayBuffer === 'function', JSON.stringify(Object.keys(storedRecord() ?? {})));
check('元数据落持久 store（文件名 / 字节数）', face.customMetaStore.getSnapshot()?.name === 'ding.mp3' && face.customMetaStore.getSnapshot()?.size === 122880, JSON.stringify(face.customMetaStore.getSnapshot()));
check('选完文件即切到自定义档', face.soundChoiceStore.getSnapshot() === CUSTOM_SOUND_CHOICE, String(face.soundChoiceStore.getSnapshot()));
check('解码成功后状态就绪、音频在内存里', customState().status === 'ready' && customState().decoded === true, JSON.stringify(customState()));
check('解码成功后当场试听一次（显示 80 → master 1.0）', audioLog.bufferSources.length === 1 && closeTo(audioLog.gains[0]?.peak, 1), `${audioLog.bufferSources.length} / ${JSON.stringify(audioLog.gains.map((gain) => gain.peak))}`);

// 完成边沿：自定义档播解码好的音频，不再排合成音；音量同样整档 +20。
resetAudioLog();
played = await playOnce();
check('完成时自定义档播的是音频（不排合成音）', audioLog.bufferSources.length === 1 && audioLog.oscillators.length === 0, `${audioLog.bufferSources.length} / ${audioLog.oscillators.length}`);
check('自定义音效按当前音量给增益（80 → 1.0）', closeTo(audioLog.gains[0]?.peak, 1), JSON.stringify(audioLog.gains.map((gain) => gain.peak)));
check('排障状态标明这次放的是自定义音效', windowStub.__dshTaskReminder.state().stats.lastSound?.custom === true, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastSound));

// 音量作用在同一处：显示 50 → master 0.7。
face.setVolume(50);
resetAudioLog();
played = await playOnce();
check('自定义音效同样受音量控制（50 → master 0.7）', closeTo(audioLog.gains[0]?.peak, 0.7), JSON.stringify(audioLog.gains.map((gain) => gain.peak)));
face.setVolume(80);

// 换文件：记录被覆盖，旧解码结果不残留。
resetAudioLog();
face.setCustomSound(makeAudioFile('second.wav', 64 * 1024));
await settle();
check('换文件覆盖同一条记录（后一个生效）', storedRecord()?.name === 'second.wav' && face.customMetaStore.getSnapshot()?.name === 'second.wav', String(storedRecord()?.name));
check('换文件后状态仍就绪', customState().status === 'ready' && customState().decoded === true, JSON.stringify(customState()));

// 清除：删记录、元数据回空、正在用自定义档时回落第一种合成音效。
face.clearCustomSound();
await settle();
check('清除后 IndexedDB 记录被删掉', storedRecord() === undefined, JSON.stringify(storedRecord()));
check('清除后元数据回空、状态回 idle', face.customMetaStore.getSnapshot() === null && customState().status === 'idle', JSON.stringify(customState()));
check('清除时正在用自定义档：音效档回落第一种', face.soundChoiceStore.getSnapshot() === 0, String(face.soundChoiceStore.getSnapshot()));
resetAudioLog();
played = await playOnce();
check('清除后完成回到合成音效（两声、不排 buffer）', audioLog.oscillators.length === 2 && audioLog.bufferSources.length === 0, `${audioLog.oscillators.length} / ${audioLog.bufferSources.length}`);

// 解码失败（编码不支持 / 文件损坏）：状态如实写，播放在自定义档回落合成音。
audioLog.decodeFails = true;
face.setCustomSound(makeAudioFile('broken.ogg', 32 * 1024));
await settle();
check('解码失败状态如实写 decode-failed、没有可播的音频', customState().status === 'decode-failed' && customState().decoded === false, JSON.stringify(customState()));
check('解码失败仍记着文件名（用户可以重选或清除）', face.customMetaStore.getSnapshot()?.name === 'broken.ogg', JSON.stringify(face.customMetaStore.getSnapshot()));
audioLog.decodeFails = false;
resetAudioLog();
played = await playOnce();
check('自定义档但没有可播音频：完成时回落第一种合成音效', audioLog.oscillators.length === 2 && audioLog.bufferSources.length === 0 && windowStub.__dshTaskReminder.state().stats.lastSound?.customFallback === true, JSON.stringify(windowStub.__dshTaskReminder.state().stats.lastSound));

// 超过 5MB 上限：直接挡下，不写本地存储、不动已有元数据。
const recordBeforeLarge = storedRecord();
face.setCustomSound(makeAudioFile('huge.wav', CUSTOM_SOUND_MAX_BYTES + 1));
await settle();
check('超过上限的文件被挡下、不写存储、不改元数据', customState().status === 'too-large' && storedRecord() === recordBeforeLarge && face.customMetaStore.getSnapshot()?.name === 'broken.ogg', JSON.stringify(customState()));

// 写不进去（配额满 / 隐私模式）：状态如实写 store-failed，元数据不动。
idbBacking.failPut = true;
face.setCustomSound(makeAudioFile('quota.mp3', 8 * 1024));
await settle();
idbBacking.failPut = false;
check('本地存储写不进去时如实提示、不假装保存', customState().status === 'store-failed' && face.customMetaStore.getSnapshot()?.name === 'broken.ogg', JSON.stringify(customState()));

// 浏览器没有 IndexedDB：如实提示不支持。
const savedIndexedDb = windowStub.indexedDB;
delete windowStub.indexedDB;
face.setCustomSound(makeAudioFile('nodb.mp3', 8 * 1024));
await settle();
check('浏览器没有 IndexedDB 时提示不支持', customState().status === 'unsupported', JSON.stringify(customState()));
windowStub.indexedDB = savedIndexedDb;

// 设置页：第五档 + 隐藏文件选择框 + 选择/清除按钮 + 状态说明。
face.setCustomSound(makeAudioFile('ding.mp3', 120 * 1024));
await settle();
sectionNodes = renderSection();
const soundButtons = kidsOf(sectionNodes.find((node) => node.type === 'div' && node.props?.['aria-label'] === '提示音音效')).filter((node) => node.type === 'button');
const fileInput = sectionNodes.find((node) => node.type === 'input' && node.props?.type === 'file');
const pickButton = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '选择文件');
const clearButton = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '清除');
check('第五档「自定义」当前选中', soundButtons.length === 5 && soundButtons[4]?.children?.[0] === '自定义' && soundButtons[4]?.props['aria-pressed'] === true, JSON.stringify(soundButtons.map((node) => [node.children?.[0], node.props['aria-pressed']])));
// 五档控件比描述还宽：这一行必须是上下排（stacked），否则描述会被挤成一列单字。
const soundChoiceRow = sectionNodes.find((node) => {
	const kids = kidsOf(node);
	const hasTitle = kids.some((child) => kidsOf(child).some((grand) => grand.children?.[0] === '提示音音效'));
	const hasGroup = kids.some((child) => kidsOf(child).some((grand) => grand.props?.role === 'group' && grand.props?.['aria-label'] === '提示音音效'));
	return hasTitle && hasGroup;
});
check('音效行改成上下排：描述拿整行宽度、分段控件另起一行', soundChoiceRow?.props?.style?.flexDirection === 'column', JSON.stringify(soundChoiceRow?.props?.style));
check('分段控件可折行、按钮文字不折行（窄窗口也不会挤压描述）', soundGroup?.props?.style?.flexWrap === 'wrap' && soundButtons.every((node) => node.props?.style?.whiteSpace === 'nowrap'), JSON.stringify({ wrap: soundGroup?.props?.style?.flexWrap, buttons: soundButtons.map((node) => node.props?.style?.whiteSpace) }));
check('自定义音效行有隐藏文件选择框（accept=audio/*）', fileInput?.props?.accept === 'audio/*' && fileInput?.props?.style?.display === 'none', JSON.stringify(fileInput?.props));
check('有文件时同时给出「选择文件」与「清除」', pickButton !== undefined && clearButton !== undefined);
check('说明文案显示当前文件名与大小', sectionNodes.some((node) => typeof node.children?.[0] === 'string' && node.children[0].includes('ding.mp3') && node.children[0].includes('120 KB')), JSON.stringify(sectionNodes.map((node) => node.children?.[0]).filter((text) => typeof text === 'string' && text.includes('当前文件'))));

// 点「选择文件」：打开文件选择框并清掉旧值（允许连续选同一个文件）。
let fileDialogOpened = 0;
fileInput.props.ref.current = { value: 'stale', click: () => { fileDialogOpened += 1; } };
pickButton.props.onClick();
check('点「选择文件」打开文件选择框并清掉旧值', fileDialogOpened === 1 && fileInput.props.ref.current.value === '', `${fileDialogOpened} / ${fileInput.props.ref.current.value}`);

// 文件选择框的 onChange：直接把 File 交给写回链路。
fileInput.props.onChange({ target: { files: [makeAudioFile('picked.mp3', 4096)] } });
await settle();
check('文件选择框选中文件后写回生效', face.customMetaStore.getSnapshot()?.name === 'picked.mp3' && customState().status === 'ready', JSON.stringify(customState()));

// 点「清除」：删文件、回落合成音效；没有文件时不再显示「清除」。
clearButton.props.onClick();
await settle();
sectionNodes = renderSection();
check('点「清除」删掉文件并回落合成音效', storedRecord() === undefined && face.customMetaStore.getSnapshot() === null && face.soundChoiceStore.getSnapshot() === 0, JSON.stringify(customState()));
check('没有文件时只显示「选择文件」，不显示「清除」', sectionNodes.some((node) => node.type === 'button' && node.children?.[0] === '选择文件') && !sectionNodes.some((node) => node.type === 'button' && node.children?.[0] === '清除'));
check('没有文件时说明只留「选择本机音频文件…」', sectionNodes.some((node) => typeof node.children?.[0] === 'string' && node.children[0].startsWith('选择本机音频文件')));

/** 再造一次干净装载：证明装载期完全不碰音频硬件。 */
const audioLog2 = { contexts: 0, oscillators: 0, gains: 0 };
class FakeAudioContext2 {
	constructor() {
		audioLog2.contexts += 1;
		this.currentTime = 0;
		this.state = 'running';
		this.destination = {};
	}
	resume() { return Promise.resolve(); }
	close() { return Promise.resolve(); }
	createOscillator() { audioLog2.oscillators += 1; return { type: '', frequency: { setValueAtTime: () => {} }, connect: (node) => node, start: () => {}, stop: () => {} }; }
	createGain() { audioLog2.gains += 1; return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: (node) => node }; }
	createBufferSource() { return { buffer: null, connect: (node) => node, start: () => {} }; }
	decodeAudioData(data, onSuccess) { if (typeof onSuccess === 'function') onSuccess({ duration: 0.4 }); }
}
const windowStub2 = {
	__ModuleLoader__: { load: (loaded) => { definition2 = loaded; } },
	AudioContext: FakeAudioContext2,
	indexedDB: FakeIndexedDB,
	addEventListener: () => {},
	removeEventListener: () => {},
};
let definition2;
const documentStub2 = {
	head: { appendChild: () => {} },
	createElement: (tag) => ({ tag, dataset: {}, textContent: '', remove() {} }),
	hidden: false,
	hasFocus: () => true,
	addEventListener: () => {},
	removeEventListener: () => {},
};
// 冷启动恢复：先在 IndexedDB 里放一条「上次上传过」的记录，第二次装载应当
// 自动恢复（元数据 + 解码），不需要用户重新选文件。
idbBacking.records.set('custom', { name: 'boot.mp3', size: 2048, type: 'audio/mpeg', at: 1, blob: makeAudioFile('boot.mp3', 2048) });
new Function('window', 'document', source)(windowStub2, documentStub2);
if (definition2 === undefined) throw new Error('verify-client: 第二次装载没有捕获到工厂');
const plugin2 = definition2.factory(requireStub);
plugin2.apply({
	effect: (fn) => fn(),
	locale: { register: () => () => {}, bind: () => (key) => key },
	slots: { inject: () => {}, register: (options, component) => ({ options, component }) },
	sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } },
	remote: { $on: () => () => {} },
	uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
	uiWorkspace: { openSession: () => {} },
	timer: { timeout: () => () => {} },
});
check('第二次装载同样只建 context 与预热音，不排可闻提示音', audioLog2.contexts === 1 && audioLog2.oscillators === 1 && audioLog2.gains === 1, JSON.stringify(audioLog2));
await settle();
check('冷启动自动从 IndexedDB 恢复自定义音效（就绪 + 已解码）', windowStub2.__dshTaskReminder.state().customSound.status === 'ready' && windowStub2.__dshTaskReminder.state().customSound.decoded === true, JSON.stringify(windowStub2.__dshTaskReminder.state().customSound));
check('冷启动恢复的文件名取自 IndexedDB 记录', windowStub2.__dshTaskReminder.state().customSound.meta?.name === 'boot.mp3', JSON.stringify(windowStub2.__dshTaskReminder.state().customSound.meta));
check('恢复解码不额外建音频节点（仍只一条预热音）', audioLog2.contexts === 1 && audioLog2.oscillators === 1 && audioLog2.gains === 1, JSON.stringify(audioLog2));

// ---------------------------------------------------------------------------
// 检查更新：设置页最底部那一行 + 两条宿主路由的往返
// ---------------------------------------------------------------------------

console.log('');
console.log('检查更新');

check('宿主更新路由写死在浏览器半侧（检查 / 更新各一条）', UPDATE_CHECK_ROUTE === '/api/task-reminder/update-check' && UPDATE_APPLY_ROUTE === '/api/task-reminder/update', `${UPDATE_CHECK_ROUTE} ${UPDATE_APPLY_ROUTE}`);
check('更新路由地址：浏览器带根、桌面壳相对（dsh-app 里带斜杠会被当前端路由丢掉）', updateRouteUrl(UPDATE_CHECK_ROUTE, 'https:') === UPDATE_CHECK_ROUTE && updateRouteUrl(UPDATE_CHECK_ROUTE, 'dsh-app:') === 'api/task-reminder/update-check', JSON.stringify([updateRouteUrl(UPDATE_CHECK_ROUTE, 'https:'), updateRouteUrl(UPDATE_CHECK_ROUTE, 'dsh-app:')]));
check('版本比较：常规递增 / 逐位补齐 / 预发布小于正式版', compareVersions('1.6.0', '1.5.5') > 0
	&& compareVersions('1.5.5', '1.5.5') === 0 && compareVersions('1.5.4', '1.5.5') < 0
	&& compareVersions('1.6', '1.6.0') === 0 && compareVersions('1.10.0', '1.9.9') > 0
	&& compareVersions('1.7.0-beta.1', '1.6.0') > 0 && compareVersions('1.7.0', '1.7.0-beta.2') > 0
	&& compareVersions('1.7.0-beta.2', '1.7.0-beta.10') < 0 && compareVersions('v1.6.0', '1.6.0') === 0, JSON.stringify([compareVersions('1.6', '1.6.0'), compareVersions('1.10.0', '1.9.9'), compareVersions('1.7.0-beta.2', '1.7.0-beta.10')]));
check('认不出的版本按相等处理（宁可不说有新版）', compareVersions('', '1.0.0') === 0 && compareVersions(undefined, '1.0.0') === 0 && compareVersions('latest', '1.0.0') === 0);
check('isNewerVersion 只认更高的版本', isNewerVersion('1.6.1', '1.6.0') === true && isNewerVersion('1.6.0', '1.6.0') === false && isNewerVersion('1.5.5', '1.6.0') === false && isNewerVersion(undefined, '1.6.0') === false);
check('更新初值：还没查、当前版本就是本份代码的版本、不持久化', UPDATE_IDLE.phase === 'idle' && UPDATE_IDLE.current === PLUGIN_VERSION && UPDATE_IDLE.latest === null && UPDATE_IDLE.error === null);

const checkState = updateReducer(UPDATE_IDLE, { type: 'check-result', result: { ok: true, current: '1.5.5', latest: '1.6.0', registry: 'https://registry.npmjs.org/', local: null, updatable: true, error: null } });
const sameState = updateReducer(UPDATE_IDLE, { type: 'check-result', result: { ok: true, current: '1.6.0', latest: '1.6.0', updatable: true } });
const reportedFailure = updateReducer(UPDATE_IDLE, { type: 'check-result', result: { ok: false, current: '1.6.0', latest: null, error: 'HTTP 500' } });
const localState = updateReducer(UPDATE_IDLE, { type: 'check-result', result: { ok: true, current: '1.5.5', latest: '1.6.0', updatable: false, local: 'link:../dsh-task-reminder' } });
check('检查出新版 → available（带源与能力）', checkState.phase === 'available' && checkState.latest === '1.6.0' && checkState.updatable === true && checkState.registry === 'https://registry.npmjs.org/', JSON.stringify(checkState));
check('同版 / 源上更旧 → latest', sameState.phase === 'latest' && updateReducer(UPDATE_IDLE, { type: 'check-result', result: { ok: true, current: '1.6.0', latest: '1.5.5' } }).phase === 'latest');
check('宿主报错 → failed，原因原样留着', reportedFailure.phase === 'failed' && reportedFailure.error === 'HTTP 500');
check('本地开发安装：查得到新版，但不给一键升级', localState.phase === 'available' && updatePresentation(localState).descKey === 'update.local' && updatePresentation(localState).action === 'check');
check('更新开始 → updating（按钮转圈、禁用）', (() => {
	const state = updateReducer(checkState, { type: 'update-start' });
	return state.phase === 'updating' && state.latest === '1.6.0' && updatePresentation(state).disabled === true;
})());
check('更新成功 → done（版本换成新装的、按钮变刷新页面）', (() => {
	const state = updateReducer(updateReducer(checkState, { type: 'update-start' }), { type: 'update-result', result: { ok: true, current: '1.5.5', latest: '1.6.0', application: 'restart-required', error: null } });
	const view = updatePresentation(state);
	return state.phase === 'done' && state.to === '1.6.0' && view.labelKey === 'update.reload' && view.action === 'reload';
})());
check('更新失败 → failed，带宿主的原始说明，并提醒「可能其实已经装完」', (() => {
	const state = updateReducer(checkState, { type: 'update-result', result: { ok: false, error: '包管理器退出码 1' } });
	const view = updatePresentation(state);
	return state.phase === 'failed' && state.step === 'update' && view.descKey === 'update.applyFailed' && view.descParams.reason === '包管理器退出码 1';
})());
check('查版本失败与装新版失败分开说（前者不提「已经装完」）', (() => {
	const view = updatePresentation({ ...UPDATE_IDLE, phase: 'failed', step: 'check', error: 'HTTP 500' });
	return view.descKey === 'update.failed' && !zh[view.descKey].includes('已经装完') && zh['update.applyFailed'].includes('已经装完');
})());
check('连不上宿主 / 答复读不出来也如实报失败', updateReducer(UPDATE_IDLE, { type: 'check-failed', reason: 'http' }).phase === 'failed'
	&& updateReducer(UPDATE_IDLE, { type: 'check-failed' }).error === 'unknown');
check('每一格相位都有中英文案与合法动作', [UPDATE_IDLE, checkState, sameState, localState, reportedFailure,
	{ ...UPDATE_IDLE, phase: 'checking' },
	{ ...checkState, phase: 'updating' },
	{ ...checkState, phase: 'done', to: '1.6.0' },
	{ ...checkState, phase: 'available', updatable: false, local: null }].every((state) => {
	const view = updatePresentation(state);
	return ['check', 'apply', 'reload'].includes(view.action)
		&& typeof zh[view.descKey] === 'string' && zh[view.descKey] !== '' && typeof en[view.descKey] === 'string' && en[view.descKey] !== ''
		&& typeof zh[view.labelKey] === 'string' && zh[view.labelKey] !== '' && typeof en[view.labelKey] === 'string' && en[view.labelKey] !== '';
}));
check('没有 pluginManager 的组合同样如实说明（不显示一个点了没用的按钮）', (() => {
	const view = updatePresentation({ ...checkState, updatable: false, local: null });
	return view.descKey === 'update.unavailable' && view.labelParams.latest === '1.6.0';
})());
check('设置页 face 带「检查更新」的 store 与三个动作', face.updateStore.getSnapshot().phase === 'idle' && face.updateStore.getSnapshot().current === PLUGIN_VERSION
	&& ['checkUpdate', 'applyUpdate', 'reloadPage'].every((name) => typeof face[name] === 'function'));
check('「检查更新」排在「恢复默认」之后（是整页最后一行）', (() => {
	const texts = sectionTexts();
	const update = texts.lastIndexOf('检查更新');
	const reset = texts.lastIndexOf('恢复默认');
	return update > reset && update >= 0 && reset >= 0;
})(), JSON.stringify(sectionTexts().filter((text) => text.includes('更新') || text.includes('默认'))));
check('那一行此刻写着当前版本（还没查过）', sectionTexts().some((text) => text.includes(`当前版本 v${PLUGIN_VERSION}`)), JSON.stringify(sectionTexts().slice(-6)));

// 往返：检查 → 更新 → 刷新，走的就是设置页那个按钮会走的两条路。
const updateCalls = [];
let pageReloads = 0;
windowStub.location = { reload: () => { pageReloads += 1; } };
windowStub.fetch = (url, options) => {
	updateCalls.push({ url, options });
	const payload = String(url).endsWith('update-check')
		? { ok: true, current: '1.5.5', latest: '1.6.0', registry: 'https://registry.npmjs.org/', local: null, updatable: true, error: null }
		: { ok: true, current: '1.5.5', latest: '1.6.0', application: 'restart-required', error: null };
	return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
};
await face.checkUpdate();
check('检查更新：POST 到宿主路由，状态推到「有新版」', updateCalls[0]?.url === UPDATE_CHECK_ROUTE && updateCalls[0]?.options?.method === 'POST'
	&& face.updateStore.getSnapshot().phase === 'available' && updatePresentation(face.updateStore.getSnapshot()).labelKey === 'update.apply',
	JSON.stringify({ calls: updateCalls.map((call) => call.url), phase: face.updateStore.getSnapshot().phase }));
await face.applyUpdate();
check('一键更新：带目标版本，宿主答「重启生效」后状态为 done', updateCalls[1]?.url === UPDATE_APPLY_ROUTE
	&& JSON.parse(updateCalls[1]?.options?.body ?? '{}').version === '1.6.0'
	&& face.updateStore.getSnapshot().phase === 'done' && face.updateStore.getSnapshot().to === '1.6.0',
	JSON.stringify({ calls: updateCalls.map((call) => call.url), phase: face.updateStore.getSnapshot().phase }));
face.reloadPage();
check('更新完成后按钮是「刷新页面」并且真的刷新', pageReloads === 1 && updatePresentation(face.updateStore.getSnapshot()).labelKey === 'update.reload');
windowStub.fetch = () => Promise.resolve({ ok: false, status: 404 });
await face.checkUpdate();
check('宿主路由不存在（404）如实报失败，不假装已是最新', face.updateStore.getSnapshot().phase === 'failed', face.updateStore.getSnapshot().error);
windowStub.fetch = () => Promise.reject(new Error('offline'));
await face.checkUpdate();
check('连不上宿主也如实报失败（不把没查到当成已最新）', face.updateStore.getSnapshot().phase === 'failed' && face.updateStore.getSnapshot().error.includes('offline'), face.updateStore.getSnapshot().error);

// ---------------------------------------------------------------------------
// 回收：effects 逆序销毁
// ---------------------------------------------------------------------------

console.log('');
console.log('回收');
// 卸载守卫：把一次停止分类摁在途，再走真正的卸载路径（跑所有 ctx.effect 清理）。
// 落地的那次分类已经属于一个死实例（热重载 / 停用 / 换新实例），不得再弹窗、再放音。
let unloadGateRelease;
fakeUsingGate = new Promise((resolve) => { unloadGateRelease = resolve; });
resetNotificationLog();
resetAudioLog();
statusListener('s2', true);
statusListener('s2', false); // 停止边沿 → 分类被闸门摁在途
for (const { disposer } of [...effects].reverse()) if (typeof disposer === 'function') disposer();
unloadGateRelease();
await tick();
await tick();
await tick();
check('卸载后落地的分类不再弹窗（死实例上不提醒）', notificationLog.created.length === 0, String(notificationLog.created.length));
check('卸载后落地的分类不再放音', audioLog.oscillators.length === 0, String(audioLog.oscillators.length));
fakeUsingGate = null;
check('排障钩子被移除', windowStub.__dshTaskReminder === undefined);
check('事件订阅被退订', listeners.every((entry) => entry.disposed === true));
check('会话列表订阅被退订', listListeners.size === 0, String(listListeners.size));
check('焦点/可见性/手势监听被退订', [...domListeners.document.values()].every((set) => set.size === 0) && [...domListeners.window.values()].every((set) => set.size === 0), JSON.stringify([...domListeners.window.entries()].map(([type, set]) => [type, set.size])));
check('回收时关掉了 AudioContext', audioLog.closed === 1, String(audioLog.closed));
check('回收时对账/兜底定时器被取消', timerEntries.every((entry) => entry.cancelled || entry.fired), JSON.stringify(timerEntries.filter((entry) => !entry.cancelled && !entry.fired)));
check('回收时清掉页面级点击转发表里的处理函数', windowStub.__dshTaskReminderClickRouter !== undefined
	&& windowStub.__dshTaskReminderClickRouter.handler === null, JSON.stringify(windowStub.__dshTaskReminderClickRouter));

console.log('');
if (failures.length > 0) {
	console.error(`verify-client: ${failures.length} 项失败`);
	process.exit(1);
}
console.log('verify-client: 全部通过');
