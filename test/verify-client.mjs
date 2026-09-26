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
const audioLog = { contexts: 0, instances: [], oscillators: [], gains: [], resumed: 0, closed: 0 };
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
			gain: {
				setValueAtTime: () => {},
				// 每个包络 ramp 两次（起振峰值 → 衰减尾），只记第一条。
				exponentialRampToValueAtTime: (value) => { if (gain.peak === null) gain.peak = value; },
			},
			connect: (node) => node,
		};
		audioLog.gains.push(gain);
		return gain;
	}
}

/** localStorage 桩：记账「已经申请过通知权限」。 */
const localStorageBacking = {};
const windowStub = {
	__ModuleLoader__: { load: (loaded) => { definition = loaded; } },
	localStorage: {
		getItem: (key) => (Object.prototype.hasOwnProperty.call(localStorageBacking, key) ? localStorageBacking[key] : null),
		setItem: (key, value) => { localStorageBacking[key] = String(value); },
	},
	Notification: FakeNotification,
	AudioContext: FakeAudioContext,
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
	DEFAULTS,
	DEFAULT_NOTIFY_MODE,
	DESKTOP_ACTIVATION_ROUTE,
	NOTIFY_MODE_ALWAYS,
	NOTIFY_MODE_PERSIST_KEY,
	NOTIFY_MODE_UNFOCUSED,
	NOTIFY_MODES,
	NOTIFY_PERSIST_KEY,
	NOTIFICATION_TAG,
	NS,
	PLUGIN_VERSION,
	SOUND_CHOICES,
	SOUND_CHOICE_PERSIST_KEY,
	SOUND_PERSIST_KEY,
	VOLUME_BOOST,
	VOLUME_MAX,
	VOLUME_MIN,
	VOLUME_PERSIST_KEY,
	VOLUME_STEP,
	clampVolume,
	createChime,
	createNotifier,
	en,
	resolveNotifyMode,
	resolveSoundChoice,
	titleOf,
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
check('inject 覆盖 remote / sessions / uiSession / uiWorkspace / timer', ['remote', 'sessions', 'uiSession', 'uiWorkspace', 'timer'].every((name) => plugin.inject.includes(name)));

const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
check('中英文案键集合一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), JSON.stringify({ zhKeys, enKeys }));
check('全部文案非空', zhKeys.every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('应用内卡片相关文案已全部移除（卡片通道删除）', !('toast.title' in zh) && !('toast.open' in zh) && !('toast.close' in zh)
	&& !zhKeys.some((key) => key.startsWith('width.') || key.startsWith('height.') || key.startsWith('preview.')), JSON.stringify(zhKeys));
check('三种停止各有弹窗标题文案', ['toast.completed.title', 'toast.question.title', 'toast.error.title'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('没有「试听」按钮文案（切换音效即发声）', !Object.keys(zh).some((key) => zh[key] === '试听'));
check('设置页有导航标题与导语', typeof zh['nav'] === 'string' && zh['nav'] !== '' && typeof zh['intro'] === 'string' && zh['intro'] !== '');
check('弹窗/提示音两个开关各有标题与说明', ['settings.notify.title', 'settings.notify.description', 'settings.sound.title', 'settings.sound.description'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('弹窗时机有两种文案', ['notify.mode.title', 'notify.mode.description', 'notify.mode.always', 'notify.mode.unfocused'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('弹窗时机文案注明两种语义', zh['notify.mode.always'] === '任何情况都弹' && zh['notify.mode.unfocused'] === '仅非前台窗口'
	&& en['notify.mode.always'] === 'Always' && en['notify.mode.unfocused'] === 'Only when unfocused');
check('音效/音量/恢复默认各有文案', ['sound.choice.title', 'sound.choice.description', 'volume.title', 'volume.description', 'reset.title', 'reset.description', 'reset.descriptionDefault'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('四种音效各有名字文案', SOUND_CHOICES.every((choice) => typeof zh[choice.nameKey] === 'string' && zh[choice.nameKey] !== '' && typeof en[choice.nameKey] === 'string' && en[choice.nameKey] !== ''));
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

check('resolveSoundChoice 接受合法下标（含 0）', [0, 1, 2, 3].every((index) => resolveSoundChoice(index) === index));
check('resolveSoundChoice 夹住越界与坏值', resolveSoundChoice(9) === 3 && resolveSoundChoice(-2) === 0 && resolveSoundChoice(Number.NaN) === 0 && resolveSoundChoice('x') === 0 && resolveSoundChoice(null) === 0);
check('resolveSoundChoice 四舍五入到整数档', resolveSoundChoice(1.4) === 1 && resolveSoundChoice(2.6) === 3);
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
const timerEntries = [];
const effects = [];

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
const fakeEventWindow = () => ({
	entries: fakeEventEntries ?? [{ type: 'event', event: { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: fakeTurnEndReason } } }],
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
	const next = new Map(sessionStatusMap);
	if (interaction === null || interaction === undefined) next.set(sessionId, { running: next.get(sessionId)?.running ?? false, pendingInteraction: undefined, completionUnread: false });
	else next.set(sessionId, { running: true, pendingInteraction: interaction, completionUnread: false });
	sessionStatusMap = next;
	for (const listener of [...statusSubscribers]) listener();
};
/** 只改某个会话的 running 位并通知订阅者（第三完成通道专用，不动 pendingInteraction）。 */
const setStatusRunning = (sessionId, running) => {
	const next = new Map(sessionStatusMap);
	next.set(sessionId, { running: running === true, pendingInteraction: next.get(sessionId)?.pendingInteraction, completionUnread: false });
	sessionStatusMap = next;
	for (const listener of [...statusSubscribers]) listener();
};
/** 整个会话从快照里消失（被删除 / 归档）。 */
const dropSessionFromStatus = (sessionId) => {
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
		register(ns, dicts) {
			dictionaries.push({ ns, dicts });
			return () => {};
		},
		bind: () => t,
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
	uiWorkspace: { openSession: (id) => opened.push(id) },
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
check('没有注册 shell.overlay 浮层（卡片通道已删除）', !injections.some((item) => item.name === 'shell.overlay'), JSON.stringify(injections.map((item) => item.name)));
check('只注册了 settings.section 一个 slot', injections.length === 1 && injections[0].name === 'settings.section', JSON.stringify(injections.map((item) => item.name)));

const generalRows = injections.filter((item) => item.name === 'settings.general.item');
check('「设置 → 通用」里不再有两行开关（迁出）', generalRows.length === 0, String(generalRows.length));

const section = injections.find((item) => item.name === 'settings.section');
check('独立设置页注册在 settings.section', section !== undefined && section.entry.options.id === 'task-reminder' && section.entry.options.locale === NS, JSON.stringify(section?.entry.options));
check('设置页 order 避开 chat-locator(41)', section.entry.options.order === 44, String(section.entry.options.order));
check('设置页导航标题走本地化', section.entry.options.label() === '任务提醒', section.entry.options.label());
const sectionFace = () => section.entry.options.inject();
const face = sectionFace();
check('设置页 face 带五个配置 store 与写回函数', ['notifyStore', 'notifyModeStore', 'soundStore', 'soundChoiceStore', 'volumeStore', 'permissionStore'].every((name) => typeof face[name]?.getSnapshot === 'function')
	&& ['setNotify', 'setNotifyMode', 'setSound', 'setSoundChoice', 'setVolume'].every((name) => typeof face[name] === 'function'));
check('设置页 face 不带卡片相关（宽度/高度/预览/弹窗开关）', !('widthStore' in face) && !('heightStore' in face) && !('setWidth' in face) && !('setHeight' in face) && !('popupStore' in face) && !('preview' in face));
check('设置页 face 带恢复默认、通知支持标志与本地化函数', typeof face.reset === 'function' && typeof face.notifySupported === 'boolean' && typeof face.t === 'function');
check('浏览器桩支持 Notification 时 notifySupported 为真', face.notifySupported === true);

check('六个 store：五个持久化 + 权限状态不持久化', persistedStores.length === 6
	&& persistedStores[0].options?.persist?.name === NOTIFY_PERSIST_KEY
	&& persistedStores[1].options?.persist?.name === NOTIFY_MODE_PERSIST_KEY
	&& persistedStores[2].options?.persist?.name === SOUND_PERSIST_KEY
	&& persistedStores[3].options?.persist?.name === SOUND_CHOICE_PERSIST_KEY
	&& persistedStores[4].options?.persist?.name === VOLUME_PERSIST_KEY
	&& persistedStores[5].options === undefined, JSON.stringify(persistedStores.map((store) => store.options?.persist?.name)));
check('五个配置默认值符合出厂表', face.notifyStore.getSnapshot() === DEFAULTS.notify
	&& face.notifyModeStore.getSnapshot() === DEFAULTS.notifyMode
	&& face.soundStore.getSnapshot() === DEFAULTS.sound
	&& face.soundChoiceStore.getSnapshot() === DEFAULTS.soundChoice
	&& face.volumeStore.getSnapshot() === DEFAULTS.volume);
check('系统弹窗默认开启且时机为「任何情况都弹」', face.notifyStore.getSnapshot() === true && face.notifyModeStore.getSnapshot() === 'always');

check('排障钩子暴露了状态', typeof windowStub.__dshTaskReminder?.state === 'function' && windowStub.__dshTaskReminder.version === PLUGIN_VERSION);
// 版本号写在 client.js 与 package.json 两处，漂了就发错版本的包（1.4.4 之前漂过）。
check('client.js 的版本号与 package.json 一致', PLUGIN_VERSION === packageJson.version, `client.js=${PLUGIN_VERSION} package.json=${packageJson.version}`);
check('排障钩子带当场试一次（test）', typeof windowStub.__dshTaskReminder?.test === 'function');
check('排障钩子带只放音（sound）', typeof windowStub.__dshTaskReminder?.sound === 'function');
check('排障状态覆盖五个配置、弹窗时机、通知权限与前台状态', (() => {
	const state = windowStub.__dshTaskReminder.state();
	return ['notify', 'notifyMode', 'sound', 'soundChoice', 'volume', 'focused', 'notificationPermission', 'notificationSupported'].every((key) => key in state) && !('toasts' in state) && !('popup' in state);
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

const statusListener = listeners.find((entry) => entry.name === 'api-session/status').fn;
const resetAudioLog = () => {
	audioLog.oscillators.length = 0;
	audioLog.gains.length = 0;
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
check('每次弹窗独立 tag（后一条不顶掉前一条）', String(notificationLog.created[0]?.options?.tag).startsWith(`${NOTIFICATION_TAG}-`) && notificationLog.created[0].options.tag !== NOTIFICATION_TAG, String(notificationLog.created[0]?.options?.tag));
check('弹窗记进 stats.notifications', windowStub.__dshTaskReminder.state().stats.notifications === 1, String(windowStub.__dshTaskReminder.state().stats.notifications));
check('提示音每次完成都响（页面有焦点也响）', audioLog.oscillators.length === 2 && audioLog.gains.length === 2, String(audioLog.oscillators.length));
check('排障状态记录完成来源为 event', windowStub.__dshTaskReminder.state().stats.lastCompletion?.source === 'event');
notificationLog.created[0].onclick();
check('点击弹窗：窗口回前台并打开对应会话、关闭弹窗', notificationLog.focused === 1 && opened.includes('s2') && notificationLog.closed === 1, JSON.stringify(notificationLog));

// 桌面壳（DSH Desktop / Electron）：渲染进程的 window.focus() 拉不起最小化 /
// 已关进托盘的窗口，改请宿主半侧跑一次 dsh://open（second-instance →
// focusPrimaryWindow）。窗口本就在前台时不打扰宿主；普通浏览器（没有
// dshDesktop 全局）完全不走这条路。
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
check('桌面壳里窗口已在前台时点弹窗不请求唤醒', desktopRequests.length === 2, JSON.stringify(desktopRequests));
delete windowStub.dshDesktop;
setFocus({ hidden: false, focused: false });
notificationLog.created[0].onclick();
check('普通浏览器里点弹窗不发唤醒请求', desktopRequests.length === 2, JSON.stringify(desktopRequests));
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
// 出错停止（api-session/error）与等你回答（pendingInteraction 出现边沿）
// ---------------------------------------------------------------------------

console.log('');
console.log('停止分类、出错与待答');

const errorListener = listeners.find((entry) => entry.name === 'api-session/error')?.fn;
check('订阅了 api-session/error 出错事件', typeof errorListener === 'function');
check('只读订阅了 uiSession.sessionStatus（不碰 user-questions 应答链）', statusSubscribers.size === 1 && !listeners.some((entry) => entry.name === 'user-questions/request'), String(statusSubscribers.size));
check('排障状态带 questions / errors 计数', (() => {
	const stats = windowStub.__dshTaskReminder.state().stats;
	return 'questions' in stats && 'errors' in stats;
})());

// ① 独立的出错（无完成边沿）：错误弹窗立即发，正文是错误信息。
resetNotificationLog();
resetAudioLog();
errorListener('s2', '400 Bad Request: invalid model');
check('出错即发错误弹窗（标题/正文）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '任务出错已停止' && notificationLog.created[0]?.options?.body === '400 Bad Request: invalid model', JSON.stringify(notificationLog.created[0]));
check('错误记进 stats.errors', windowStub.__dshTaskReminder.state().stats.errors === 1, String(windowStub.__dshTaskReminder.state().stats.errors));
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
check('分类错误记进 stats.errors', windowStub.__dshTaskReminder.state().stats.errors === 2, String(windowStub.__dshTaskReminder.state().stats.errors));

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

// ⑩ 等你回答：pendingInteraction 出现边沿（只读 sessionStatus，不碰应答链）。
resetNotificationLog();
resetAudioLog();
setPendingInteraction('s2', { sessionId: 's2', kind: 'question', key: 'question:1', questions: [{ id: 'q1', question: '要用哪个数据库？' }] });
check('出现问题即发「等待你的回答」弹窗（正文是首个问题）', notificationLog.created.length === 1 && notificationLog.created[0]?.title === '等待你的回答' && notificationLog.created[0]?.options?.body === '要用哪个数据库？', JSON.stringify(notificationLog.created[0]));
check('待答记进 stats.questions', windowStub.__dshTaskReminder.state().stats.questions === 1, String(windowStub.__dshTaskReminder.state().stats.questions));
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

// ⑫ 回答后紧随的完成不报（一次交互一次提醒）；grace 消费后下一次照报。
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
check('关掉系统弹窗后不再发送', notificationLog.created.length === 0 && face.notifyStore.getSnapshot() === false);
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

// 默认态：两个开关 + 弹窗时机（二选一，默认「任何情况都弹」）+ 音效四选一 + 音量步进 + 恢复默认。
sectionNodes = renderSection();
const switches = sectionNodes.filter((node) => node.type === 'Switch');
check('设置页渲染两个开关（系统弹窗 / 提示音）', switches.length === 2, String(switches.length));
check('系统弹窗排在第一位且默认开启', switches[0]?.props?.label === '系统弹窗' && switches[0]?.props?.checked === true, JSON.stringify(switches.map((node) => [node.props.label, node.props.checked])));
check('提示音开关默认开启', switches[1]?.props?.label === '完成提示音' && switches[1]?.props?.checked === true);
check('两个开关的 onChange 都接到了写回函数', switches.every((node) => typeof node.props.onChange === 'function'));
check('设置页没有「试听」按钮（切换音效即发声）', !sectionNodes.some((node) => node.type === 'button' && node.children?.[0] === '试听'));

const segmentedGroups = sectionNodes.filter((node) => node.type === 'div' && node.props?.role === 'group'
	&& node.props?.['aria-label'] === '弹窗时机');
const modeButtons = kidsOf(segmentedGroups[0]).filter((node) => node.type === 'button' && typeof node.props?.['aria-pressed'] === 'boolean');
check('弹窗时机是二选一分段控件', modeButtons.length === 2, String(modeButtons.length));
check('弹窗时机两个选项的文案与顺序', JSON.stringify(modeButtons.map((node) => node.children?.[0])) === JSON.stringify(['任何情况都弹', '仅非前台窗口']), JSON.stringify(modeButtons.map((node) => node.children?.[0])));
check('默认选中「任何情况都弹」', modeButtons[0]?.props['aria-pressed'] === true && modeButtons[1]?.props['aria-pressed'] === false);
modeButtons[1].props.onClick();
check('点「仅非前台窗口」即写回配置', face.notifyModeStore.getSnapshot() === 'unfocused', face.notifyModeStore.getSnapshot());
modeButtons[0].props.onClick();
check('点「任何情况都弹」即写回配置', face.notifyModeStore.getSnapshot() === 'always');
switches[0].props.onChange(false);
check('关掉系统弹窗后时机行不再出现', !renderSection().some((node) => node.type === 'div' && node.props?.role === 'group' && node.props?.['aria-label'] === '弹窗时机'), '时机行仍存在');
switches[0].props.onChange(true);
sectionNodes = renderSection();

const soundGroup = sectionNodes.find((node) => node.type === 'div' && node.props?.role === 'group'
	&& node.props?.['aria-label'] === '提示音音效');
const soundSegmentedButtons = kidsOf(soundGroup).filter((node) => node.type === 'button' && typeof node.props?.['aria-pressed'] === 'boolean');
check('音效选择是四选一分段控件', soundSegmentedButtons.length === 4 && soundSegmentedButtons.filter((node) => node.props['aria-pressed'] === true).length === 1, String(soundSegmentedButtons.length));
check('音效分段按钮文案与顺序', JSON.stringify(soundSegmentedButtons.map((node) => node.children?.[0])) === JSON.stringify(['两声（经典）', '三声上扬', '上升琶音', '圆润三角波']), JSON.stringify(soundSegmentedButtons.map((node) => node.children?.[0])));
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
check('默认值时恢复默认行显示「已是默认值」文案', sectionNodes.some((node) => node.children?.[0] === '当前各项都已经是默认值。'));
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
sectionNodes = renderSection();
const resetButtonAfter = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '恢复默认');
check('改花后「恢复默认」按钮置灰解除', resetButtonAfter?.props?.disabled === false, String(resetButtonAfter?.props?.disabled));
check('改花后说明换成默认值清单', sectionNodes.some((node) => typeof node.children?.[0] === 'string' && node.children[0].startsWith('一键写回全部默认值')));
resetButtonAfter.props.onClick();
check('恢复默认写回全部五个配置（弹窗回开、时机回任何情况都弹）', face.notifyStore.getSnapshot() === true && face.notifyModeStore.getSnapshot() === 'always' && face.soundStore.getSnapshot() === true
	&& face.soundChoiceStore.getSnapshot() === 0 && face.volumeStore.getSnapshot() === 80,
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
check("test('question') 当场发一条「等待你的回答」弹窗", notificationLog.created.length === 3 && notificationLog.created[2]?.title === '等待你的回答', JSON.stringify(notificationLog.created[2]));
resetAudioLog();
windowStub.__dshTaskReminder.sound();
check('sound() 只放音不发弹窗', audioLog.oscillators.length === 2 && notificationLog.created.length === 3, String(audioLog.oscillators.length));

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
}
const windowStub2 = {
	__ModuleLoader__: { load: (loaded) => { definition2 = loaded; } },
	AudioContext: FakeAudioContext2,
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

// ---------------------------------------------------------------------------
// 回收：effects 逆序销毁
// ---------------------------------------------------------------------------

console.log('');
console.log('回收');
for (const { disposer } of [...effects].reverse()) if (typeof disposer === 'function') disposer();
check('排障钩子被移除', windowStub.__dshTaskReminder === undefined);
check('事件订阅被退订', listeners.every((entry) => entry.disposed === true));
check('会话列表订阅被退订', listListeners.size === 0, String(listListeners.size));
check('焦点/可见性/手势监听被退订', [...domListeners.document.values()].every((set) => set.size === 0) && [...domListeners.window.values()].every((set) => set.size === 0), JSON.stringify([...domListeners.window.entries()].map(([type, set]) => [type, set.size])));
check('回收时关掉了 AudioContext', audioLog.closed === 1, String(audioLog.closed));
check('回收时对账/兜底定时器被取消', timerEntries.every((entry) => entry.cancelled || entry.fired), JSON.stringify(timerEntries.filter((entry) => !entry.cancelled && !entry.fired)));

console.log('');
if (failures.length > 0) {
	console.error(`verify-client: ${failures.length} 项失败`);
	process.exit(1);
}
console.log('verify-client: 全部通过');
