/**
 * dsh-task-reminder 浏览器半侧的 Node 自检。
 *
 * 为什么需要它：这个插件的关键行为都不在渲染里，而在 apply 的接线与
 * 「running → 非 running」边沿判据上 —— 事件订阅、做种、非对话窗口判定、
 * 六个配置的默认值/读写/恢复默认、切换音效即时发声、音量整档 +20 的换算、
 * 卡宽卡高写进卡片内联样式、系统通知的权限路径，以及卡片堆叠上限与定时器回收。
 * 页面里没有浏览器控制能力时，这些也必须被真机（Node）跑过，而不是只靠肉眼审阅。
 *
 * 做法：给 client.js 一个极简的 `window.__ModuleLoader__` 桩以取得工厂，
 * 再用桩服务（locale / slots / sessions / remote / uiWorkspace / timer）跑
 * apply，直接驱动完成事件、调用设置页与浮层组件。断言失败时以非零码退出。
 *
 * 用法：node test/verify-client.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

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

/** 样式标签落在 createdNodes 里，dispose 时置 removed。 */
const createdNodes = [];

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
/** 改焦点/可见性状态并派发事件（插件的 sync 每次事件都重算）。 */
const setFocus = ({ hidden, focused }) => {
	focusState.hidden = hidden === true;
	focusState.focused = focused !== false;
	fireDom('visibilitychange');
	fireDom('focus');
	fireDom('blur');
};

const documentStub = {
	head: { appendChild: (node) => createdNodes.push(node) },
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
FakeNotification.permission = 'granted';
FakeNotification.requestPermission = () => {
	notificationLog.requested += 1;
	return Promise.resolve(FakeNotification.permission);
};

/** Web Audio 录音桩：记录振荡器与增益节点，验证「提示音真的排了音、参数正确」。 */
const audioLog = { contexts: 0, oscillators: [], gains: [], resumed: 0, closed: 0 };
class FakeAudioContext {
	constructor() {
		audioLog.contexts += 1;
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

const windowStub = {
	__ModuleLoader__: { load: (loaded) => { definition = loaded; } },
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
	CSS,
	CSS_TEXT,
	DEFAULTS,
	DEFAULT_SOUND_CHOICE,
	HEIGHT_MAX,
	HEIGHT_MIN,
	HEIGHT_PERSIST_KEY,
	HEIGHT_STEP,
	MAX_TOASTS,
	NOTIFY_PERSIST_KEY,
	NOTIFICATION_TAG,
	NS,
	PLUGIN_VERSION,
	SOUND_CHOICES,
	SOUND_CHOICE_PERSIST_KEY,
	SOUND_PERSIST_KEY,
	STACK_INSET_PX,
	STYLE_TAG_ID,
	TOAST_TTL_MS,
	VOLUME_BOOST,
	VOLUME_MAX,
	VOLUME_MIN,
	VOLUME_PERSIST_KEY,
	VOLUME_STEP,
	WIDTH_MAX,
	WIDTH_MIN,
	WIDTH_PERSIST_KEY,
	WIDTH_STEP,
	clampVolume,
	clampSize,
	createChime,
	createNotifier,
	en,
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
// 静态面：模块身份、文案、样式、音效表、归一化函数
// ---------------------------------------------------------------------------

console.log('模块与文案');
check('浏览器半侧模块 id 是 dsh-task-reminder', definition.id === 'dsh-task-reminder', definition.id);
check('插件形状正确（name / inject / apply）', plugin.name === 'dsh-task-reminder' && typeof plugin.apply === 'function'
	&& JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale', 'sessions', 'remote', 'uiWorkspace', 'timer']), JSON.stringify(plugin.inject));
check('inject 覆盖 remote / sessions / uiWorkspace / timer', ['remote', 'sessions', 'uiWorkspace', 'timer'].every((name) => plugin.inject.includes(name)));

const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
check('中英文案键集合一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), JSON.stringify({ zhKeys, enKeys }));
check('全部文案非空', zhKeys.every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('「完成提醒弹窗」开关文案已移除，且没有任何「试听」按钮文案', !('settings.popup.title' in zh) && !('settings.popup.description' in zh)
	&& !('preview' in zh) && !Object.keys(zh).some((key) => zh[key] === '试听'), JSON.stringify(Object.keys(zh).filter((key) => key.startsWith('preview'))));
check('设置页有导航标题与导语', typeof zh['nav'] === 'string' && zh['nav'] !== '' && typeof zh['intro'] === 'string' && zh['intro'] !== '');
check('提醒卡有标题 / 查看 / 关闭三条文案', ['toast.title', 'toast.open', 'toast.close'].every((key) => typeof zh[key] === 'string' && zh[key] !== ''));
check('通知/提示音两个开关各有标题与说明', ['settings.notify.title', 'settings.notify.description', 'settings.sound.title', 'settings.sound.description'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('音效/音量/宽高/恢复默认各有文案', ['sound.choice.title', 'sound.choice.description', 'volume.title', 'volume.description', 'width.title', 'width.description', 'height.title', 'height.description', 'reset.title', 'reset.description', 'reset.descriptionDefault'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('四种音效各有名字文案', SOUND_CHOICES.every((choice) => typeof zh[choice.nameKey] === 'string' && zh[choice.nameKey] !== '' && typeof en[choice.nameKey] === 'string' && en[choice.nameKey] !== ''));
check('通知权限有三条提示文案', ['notify.unsupported', 'notify.denied', 'notify.pending'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));
check('步进器有增减无障碍标签', typeof zh['decrease'] === 'string' && typeof zh['increase'] === 'string' && typeof en['decrease'] === 'string' && typeof en['increase'] === 'string');

const braces = (text) => (text.match(/\{/g) ?? []).length === (text.match(/\}/g) ?? []).length;
check('样式花括号配平', braces(CSS_TEXT));
check('样式不含 undefined/NaN', !CSS_TEXT.includes('undefined') && !CSS_TEXT.includes('NaN'), CSS_TEXT);
check(`弹窗贴在右下角 ${STACK_INSET_PX}px`, CSS_TEXT.includes(`right:${STACK_INSET_PX}px`) && CSS_TEXT.includes(`bottom:${STACK_INSET_PX}px`) && CSS_TEXT.includes('position:fixed') && STACK_INSET_PX === 8);
check('弹窗默认宽度放大到 420px', CSS_TEXT.includes('width:min(420px,calc(100vw - 16px))'), CSS_TEXT);
check('卡片默认宽度与 DEFAULTS.width 一致', CSS_TEXT.includes(`width:min(${DEFAULTS.width}px`));
check('样式只走主题 token（不写死颜色，深浅色自动跟随）', CSS_TEXT.includes('var(--dsw-alias-bg-overlay)') && CSS_TEXT.includes('var(--dsw-alias-label-secondary)') && CSS_TEXT.includes('var(--dsw-alias-state-success-primary)'));
check('字号/内边距随卡宽一起放大', CSS_TEXT.includes('font-size:14px') && CSS_TEXT.includes('padding:12px 14px') && CSS_TEXT.includes('width:24px;height:24px'));
check('提醒卡同屏上限 ≥ 1', Number.isInteger(MAX_TOASTS) && MAX_TOASTS >= 1, String(MAX_TOASTS));
check('提醒卡停留时长为正', TOAST_TTL_MS > 0, String(TOAST_TTL_MS));

const persistKeys = [NOTIFY_PERSIST_KEY, SOUND_PERSIST_KEY, SOUND_CHOICE_PERSIST_KEY, VOLUME_PERSIST_KEY, WIDTH_PERSIST_KEY, HEIGHT_PERSIST_KEY];
check('六个配置各有独立持久化键', new Set(persistKeys).size === 6 && persistKeys.every((key) => key.startsWith('dsh.task-reminder.')), persistKeys.join(' / '));
check('弹窗开关的持久化键已移除', !persistKeys.includes('dsh.task-reminder.popup'));
check('音效选择落在 dsh.task-reminder.sound-choice', SOUND_CHOICE_PERSIST_KEY === 'dsh.task-reminder.sound-choice');
check('音量/宽高持久化键符合约定', VOLUME_PERSIST_KEY === 'dsh.task-reminder.volume' && WIDTH_PERSIST_KEY === 'dsh.task-reminder.width' && HEIGHT_PERSIST_KEY === 'dsh.task-reminder.height');
check('系统通知 tag 固定', typeof NOTIFICATION_TAG === 'string' && NOTIFICATION_TAG === 'dsh-task-reminder');

console.log('音效表、音量换算与归一化');
check('四种音效', Array.isArray(SOUND_CHOICES) && SOUND_CHOICES.length === 4, String(SOUND_CHOICES.length));
check('音效 id 互不重复', new Set(SOUND_CHOICES.map((choice) => choice.id)).size === SOUND_CHOICES.length, SOUND_CHOICES.map((choice) => choice.id).join());
check('每种音效至少两个音、参数都为正', SOUND_CHOICES.every((choice) => choice.notes.length >= 2
	&& choice.notes.every((noteSpec) => noteSpec.frequency > 0 && noteSpec.duration > 0 && noteSpec.peak > 0 && noteSpec.peak <= 1 && noteSpec.at >= 0)));
check('音效波形只有正弦与三角', SOUND_CHOICES.every((choice) => choice.type === 'sine' || choice.type === 'triangle'));
check('四种音效的节奏/频率表两两不同（听得出区别）', (() => {
	const shapes = SOUND_CHOICES.map((choice) => choice.notes.map((noteSpec) => `${noteSpec.frequency}@${noteSpec.at}`).join(','));
	return new Set(shapes).size === SOUND_CHOICES.length;
})());
check('默认值符合验收（通知/声音开、第一种音效、音量 80、宽 420、高自动）', DEFAULTS.notify === true && DEFAULTS.sound === true && DEFAULTS.soundChoice === 0 && DEFAULTS.volume === 80 && DEFAULTS.width === 420 && DEFAULTS.height === 0, JSON.stringify(DEFAULTS));
check('DEFAULT_SOUND_CHOICE 指向第一种', DEFAULT_SOUND_CHOICE === 0 && SOUND_CHOICES[DEFAULT_SOUND_CHOICE]?.id === 'two-tone');
check('音量整档上调 20（VOLUME_BOOST=20）', VOLUME_BOOST === 20, String(VOLUME_BOOST));
check('显示 80 = 原 100 的响度（master 1.0，峰值 0.4375/0.3625）', closeTo(SOUND_CHOICES[0].notes[0].peak * (DEFAULTS.volume + VOLUME_BOOST) / 100, 0.4375) && closeTo(SOUND_CHOICES[0].notes[1].peak * (DEFAULTS.volume + VOLUME_BOOST) / 100, 0.3625), JSON.stringify(SOUND_CHOICES[0].notes));
check('显示 100 = 原 120 的响度（上限不削波，峰值仍 < 1）', SOUND_CHOICES.every((choice) => choice.notes.every((noteSpec) => noteSpec.peak * (VOLUME_MAX + VOLUME_BOOST) / 100 < 1)));
check('音量说明只保留增益与插值，不带上调解释（按用户要求去掉）', zh['volume.description'] === '提示音的整体增益，当前 {value}%；0 为静音'
	&& en['volume.description'] === 'Overall gain of the chime, currently {value}%; 0 mutes it'
	&& !zh['volume.description'].includes('整档') && !en['volume.description'].includes('shifted up by 20'), JSON.stringify({ zh: zh['volume.description'], en: en['volume.description'] }));
check('提醒卡预览区有标题/说明/示例会话文案', ['preview.title', 'preview.description', 'preview.sampleSession'].every((key) => typeof zh[key] === 'string' && zh[key] !== '' && typeof en[key] === 'string' && en[key] !== ''));

check('resolveSoundChoice 接受合法下标（含 0）', [0, 1, 2, 3].every((index) => resolveSoundChoice(index) === index));
check('resolveSoundChoice 夹住越界与坏值', resolveSoundChoice(9) === 3 && resolveSoundChoice(-2) === 0 && resolveSoundChoice(Number.NaN) === DEFAULT_SOUND_CHOICE && resolveSoundChoice('x') === DEFAULT_SOUND_CHOICE && resolveSoundChoice(null) === DEFAULT_SOUND_CHOICE);
check('resolveSoundChoice 四舍五入到整数档', resolveSoundChoice(1.4) === 1 && resolveSoundChoice(2.6) === 3);
check('clampVolume 夹住 0~100', clampVolume(0) === 0 && clampVolume(100) === 100 && clampVolume(140) === 100 && clampVolume(-5) === 0);
check('clampVolume 坏值退回默认音量', clampVolume(Number.NaN) === DEFAULTS.volume && clampVolume('loud') === DEFAULTS.volume && clampVolume(null) === DEFAULTS.volume);
check('clampSize 支持区间自定义', clampSize(200, 0, 10, 5) === 10 && clampSize(-1, 0, 10, 5) === 0 && clampSize(3, 0, 10, 5) === 3);
check('音量区间覆盖 0~100 且步进为正', VOLUME_MIN === 0 && VOLUME_MAX === 100 && VOLUME_STEP > 0);
check('卡宽区间包含默认 420 且上限更宽', WIDTH_MIN < DEFAULTS.width && DEFAULTS.width < WIDTH_MAX && WIDTH_STEP === 10);
check('卡高 0 = 自动，区间上限为正', HEIGHT_MIN === 0 && DEFAULTS.height === 0 && HEIGHT_MAX > 0 && HEIGHT_STEP > 0);

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

const sessionsStub = {
	list: {
		getSnapshot: () => hostList,
		subscribe(listener) {
			listListeners.add(listener);
			return () => listListeners.delete(listener);
		},
	},
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
			const entry = { fn, ms, disposed: false };
			timerEntries.push(entry);
			return () => {
				entry.disposed = true;
			};
		},
	},
};

console.log('');
console.log('apply（桩服务）');
plugin.apply(ctxStub);

check('注册了 task-reminder 字典（zh/en）', dictionaries.length === 1 && dictionaries[0].ns === NS && typeof dictionaries[0].dicts?.zh?.['toast.title'] === 'string' && typeof dictionaries[0].dicts?.en?.['toast.title'] === 'string');
check('挂载了自有样式标签', createdNodes.some((node) => node.tag === 'style' && node.dataset.pluginCss === STYLE_TAG_ID));
check('样式文本写进了标签', createdNodes.find((node) => node.dataset?.pluginCss === STYLE_TAG_ID)?.textContent === CSS_TEXT);
check('订阅了 api-session/status 完成事件', listeners.some((entry) => entry.name === 'api-session/status' && typeof entry.fn === 'function'));
check('订阅了官方会话列表（第二通道）', listListeners.size === 1, String(listListeners.size));
check('effects 全部登记（字典 / 事件 / 列表 / 焦点 / 样式 / 定时器 / 排障）', effects.length >= 7, String(effects.length));

const overlay = injections.find((item) => item.name === 'shell.overlay');
check('弹窗注册在 shell.overlay', overlay !== undefined && overlay.entry.options.id === 'task-reminder' && overlay.entry.options.order === 50 && overlay.entry.options.locale === NS, JSON.stringify(overlay?.entry.options));
check('弹窗 inject face 带 hooks(toasts/width/height) + dismiss + openSession', typeof overlay.entry.options.inject().hooks?.toasts?.getSnapshot === 'function'
	&& typeof overlay.entry.options.inject().hooks?.width?.getSnapshot === 'function'
	&& typeof overlay.entry.options.inject().hooks?.height?.getSnapshot === 'function'
	&& typeof overlay.entry.options.inject().dismiss === 'function'
	&& typeof overlay.entry.options.inject().openSession === 'function');

const generalRows = injections.filter((item) => item.name === 'settings.general.item');
check('「设置 → 通用」里不再有两行开关（迁出）', generalRows.length === 0, String(generalRows.length));

const section = injections.find((item) => item.name === 'settings.section');
check('独立设置页注册在 settings.section', section !== undefined && section.entry.options.id === 'task-reminder' && section.entry.options.locale === NS, JSON.stringify(section?.entry.options));
check('设置页 order 避开 chat-locator(41)', section.entry.options.order === 44, String(section.entry.options.order));
check('设置页导航标题走本地化', section.entry.options.label() === '任务提醒', section.entry.options.label());
const sectionFace = () => section.entry.options.inject();
const face = sectionFace();
check('设置页 face 带六个配置 store 与写回函数', ['notifyStore', 'soundStore', 'soundChoiceStore', 'volumeStore', 'widthStore', 'heightStore', 'permissionStore'].every((name) => typeof face[name]?.getSnapshot === 'function')
	&& ['setNotify', 'setSound', 'setSoundChoice', 'setVolume', 'setWidth', 'setHeight'].every((name) => typeof face[name] === 'function'));
check('设置页 face 不再带弹窗开关与试听', !('popupStore' in face) && !('setPopup' in face) && !('preview' in face));
check('设置页 face 带恢复默认、通知支持标志与本地化函数', typeof face.reset === 'function' && typeof face.notifySupported === 'boolean' && typeof face.t === 'function');
check('浏览器桩支持 Notification 时 notifySupported 为真', face.notifySupported === true);

check('八个 store：六个持久化 + 权限/卡片列表不持久化', persistedStores.length === 8
	&& persistedStores[0].options?.persist?.name === NOTIFY_PERSIST_KEY
	&& persistedStores[1].options?.persist?.name === SOUND_PERSIST_KEY
	&& persistedStores[2].options?.persist?.name === SOUND_CHOICE_PERSIST_KEY
	&& persistedStores[3].options?.persist?.name === VOLUME_PERSIST_KEY
	&& persistedStores[4].options?.persist?.name === WIDTH_PERSIST_KEY
	&& persistedStores[5].options?.persist?.name === HEIGHT_PERSIST_KEY
	&& persistedStores[6].options === undefined
	&& persistedStores[7].options === undefined, JSON.stringify(persistedStores.map((store) => store.options?.persist?.name)));
check('六个配置默认值符合出厂表', face.notifyStore.getSnapshot() === DEFAULTS.notify
	&& face.soundStore.getSnapshot() === DEFAULTS.sound
	&& face.soundChoiceStore.getSnapshot() === DEFAULTS.soundChoice
	&& face.volumeStore.getSnapshot() === DEFAULTS.volume
	&& face.widthStore.getSnapshot() === DEFAULTS.width
	&& face.heightStore.getSnapshot() === DEFAULTS.height);
check('系统通知默认开启', face.notifyStore.getSnapshot() === true);

check('排障钩子暴露了状态', typeof windowStub.__dshTaskReminder?.state === 'function' && windowStub.__dshTaskReminder.version === PLUGIN_VERSION);
check('排障钩子带当场试一次（test）', typeof windowStub.__dshTaskReminder?.test === 'function');
check('排障钩子带只放音（sound）', typeof windowStub.__dshTaskReminder?.sound === 'function');
check('排障状态覆盖六个配置与通知权限', (() => {
	const state = windowStub.__dshTaskReminder.state();
	return ['notify', 'sound', 'soundChoice', 'volume', 'width', 'height', 'notificationPermission', 'notificationSupported'].every((key) => key in state) && !('popup' in state);
})());
check('做种后 s1 记为 running、s2/s3 记为空闲', JSON.stringify(windowStub.__dshTaskReminder.state().running) === JSON.stringify([['s1', true], ['s2', false], ['s3', false]]), JSON.stringify(windowStub.__dshTaskReminder.state().running));

// ---------------------------------------------------------------------------
// 完成事件驱动：边沿、面板判定、常驻卡片、堆叠与回收
// ---------------------------------------------------------------------------

const statusListener = listeners.find((entry) => entry.name === 'api-session/status').fn;
const overlayComponent = overlay.entry.component;
const overlayFace = () => overlay.entry.options.inject();
const toastsNow = () => overlayFace().hooks.toasts.getSnapshot();
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
/**
 * 把 inject face 换成渲染器会递进组件的 props：hooks.toasts 物化成 useToasts。
 * @returns 浮层组件的 prop 包。
 */
const overlayComponentProps = () => {
	const face = overlayFace();
	return {
		useToasts: (selector) => selector(face.hooks.toasts.getSnapshot()),
		useWidth: (selector) => selector(face.hooks.width.getSnapshot()),
		useHeight: (selector) => selector(face.hooks.height.getSnapshot()),
		dismiss: face.dismiss,
		openSession: face.openSession,
	};
};

/** 让浮层组件“渲染”一次，把面板状态报进去。 */
const reportPanel = (activePanelId, withHook = true) => {
	overlayComponent({
		...overlayComponentProps(),
		usePanelInfo: withHook ? (selector) => selector({ activePanelId }) : undefined,
		t,
	});
};

console.log('');
console.log('完成事件');

// 浮层尚未渲染：view.panelHook=false → 按“非对话窗口”处理，不静默失效。
resetAudioLog();
resetNotificationLog();
statusListener('s1', false);
check('没拿到面板钩子时不静默失效：仍弹卡', toastsNow().length === 1 && toastsNow()[0].title === '旧任务', JSON.stringify(toastsNow()));
check('每弹一张卡都挂一个自动收起定时器（TTL 正确）', timerEntries.length === 1 && timerEntries[0].ms === TOAST_TTL_MS && timerEntries[0].disposed === false);
check('默认 80 音量（整档 +20 → master 1.0）排两声、峰值 0.4375/0.3625', audioLog.oscillators.length === 2 && audioLog.gains.length === 2
	&& closeTo(audioLog.oscillators[0].freq, 987.77) && closeTo(audioLog.oscillators[1].freq, 1318.51)
	&& closeTo(audioLog.gains[0].peak, 0.4375) && closeTo(audioLog.gains[1].peak, 0.3625)
	&& audioLog.oscillators.every((oscillator) => oscillator.type === 'sine'), JSON.stringify(audioLog.gains.map((gain) => gain.peak)));
check('系统通知默认开启：完成即发通知', notificationLog.created.length === 1, String(notificationLog.created.length));
check('通知标题/正文/标记', notificationLog.created[0]?.title === '对话任务已完成' && notificationLog.created[0]?.options?.body === '旧任务' && notificationLog.created[0]?.options?.tag === NOTIFICATION_TAG, JSON.stringify(notificationLog.created[0]));

// 清场：手动关掉卡片。
overlayFace().dismiss(toastsNow()[0].id);
check('dismiss 移除卡片并销毁它的定时器', toastsNow().length === 0 && timerEntries[0].disposed === true);

// 正看着对话窗口（activePanelId === null）：保持安静。
reportPanel(null);
const cardsBeforeWatching = toastsNow().length;
const notificationsBeforeWatching = notificationLog.created.length;
statusListener('s2', true);
statusListener('s2', false);
check('在对话窗口时任务完成不打扰', toastsNow().length === cardsBeforeWatching, JSON.stringify(toastsNow()));
check('在对话窗口时也不发通知', notificationLog.created.length === notificationsBeforeWatching);
check('对话窗口内的完成记进 skippedInConversation', windowStub.__dshTaskReminder.state().stats.skippedInConversation === 1, String(windowStub.__dshTaskReminder.state().stats.skippedInConversation));

// 失焦 / 切走标签页：主区还停在对话窗口，但人已经不在这个窗口前 —— 要提醒。
// （这正是「在别的应用里等任务跑完却收不到提醒」的修复场景。）
reportPanel(null);
setFocus({ hidden: false, focused: false });
check('排障状态跟上失焦（away）', windowStub.__dshTaskReminder.state().away === true && windowStub.__dshTaskReminder.state().inConversationWindow === true, JSON.stringify(windowStub.__dshTaskReminder.state()));
statusListener('s2', true);
statusListener('s2', false);
check('窗口失焦（人在别的应用）时任务完成也提醒', toastsNow().length === 1 && toastsNow()[0].sessionId === 's2', JSON.stringify(toastsNow()));
overlayFace().dismiss(toastsNow()[0].id);

reportPanel(null);
setFocus({ hidden: true, focused: true });
check('排障状态跟上标签页隐藏', windowStub.__dshTaskReminder.state().away === true);
statusListener('s2', true);
statusListener('s2', false);
check('标签页被切走时任务完成也提醒', toastsNow().length === 1 && toastsNow()[0].sessionId === 's2', JSON.stringify(toastsNow()));
overlayFace().dismiss(toastsNow()[0].id);

// 回到可见且有焦点的对话窗口：重新静默。
setFocus({ hidden: false, focused: true });
check('回到有焦点的对话窗口时 away 归位', windowStub.__dshTaskReminder.state().away === false);
statusListener('s2', true);
statusListener('s2', false);
check('回到对话窗口且窗口有焦点时不打扰', toastsNow().length === 0, JSON.stringify(toastsNow()));

// 停在其它面板：弹卡。
reportPanel('settings');
statusListener('s2', true);
statusListener('s2', false);
check('停在非对话窗口时任务完成弹一张卡', toastsNow().length === 1 && toastsNow()[0].sessionId === 's2' && toastsNow()[0].title === '另一个会话', JSON.stringify(toastsNow()));

// running→running 的重复事件、以及非 running→非 running 都不再触发。
const before = toastsNow().length;
statusListener('s2', false);
statusListener('s2', false);
check('同一边沿不重复触发', toastsNow().length === before);

// 通道二：官方会话列表的 running 位变化独立驱动完成（s3 专用，互不干扰）。
setRunning('s3', true);
setRunning('s3', false);
check('列表通道独立收到完成并弹卡', toastsNow().length === before + 1 && toastsNow().at(-1).sessionId === 's3' && toastsNow().at(-1).title === '第三个会话', JSON.stringify(toastsNow().at(-1)));
check('排障状态记录完成来源为 list', windowStub.__dshTaskReminder.state().stats.lastCompletion?.source === 'list' && windowStub.__dshTaskReminder.state().stats.completed >= 1, JSON.stringify(windowStub.__dshTaskReminder.state().stats));
overlayFace().dismiss(toastsNow().at(-1).id);

// 两条通道同时看到同一次完成：只触发一次（共用边沿表）。
const beforeDedup = toastsNow().length;
const completedBefore = windowStub.__dshTaskReminder.state().stats.completed;
setRunning('s3', true);
statusListener('s3', true);
setRunning('s3', false);
statusListener('s3', false);
check('两条通道去重：同一次完成只弹一张卡', toastsNow().length === beforeDedup + 1, JSON.stringify(toastsNow()));
check('去重后 completed 只加一', windowStub.__dshTaskReminder.state().stats.completed === completedBefore + 1, `${windowStub.__dshTaskReminder.state().stats.completed} vs ${completedBefore + 1}`);
overlayFace().dismiss(toastsNow().at(-1).id);

// 卡片是常驻通道：提示音与通知全关也照样弹卡。
face.setSound(false);
face.setNotify(false);
const cardsBeforeAllOff = toastsNow().length;
resetAudioLog();
resetNotificationLog();
statusListener('s2', true);
statusListener('s2', false);
check('提示音与通知全关时卡片照弹（常驻通道）', toastsNow().length === cardsBeforeAllOff + 1, JSON.stringify(toastsNow().length - cardsBeforeAllOff));
check('提示音与通知全关时既不放音也不发通知', audioLog.oscillators.length === 0 && notificationLog.created.length === 0);
overlayFace().dismiss(toastsNow().at(-1).id);

// 重新打开提示音，验证堆叠上限与「查看」。
face.setSound(true);
for (let round = 0; round < MAX_TOASTS + 2; round += 1) {
	statusListener('s2', true);
	statusListener('s2', false);
}
check(`同屏最多 ${MAX_TOASTS} 张卡`, toastsNow().length === MAX_TOASTS, String(toastsNow().length));
const evicted = timerEntries.filter((entry) => entry.disposed).length;
check('被挤掉的卡定时器已回收', evicted >= MAX_TOASTS - 1, String(evicted));

const sessionToast = toastsNow()[0];
overlayFace().openSession(sessionToast.sessionId);
check('「查看」回到对应会话', opened.includes('s2'), JSON.stringify(opened));
check('「查看」后该会话的卡被收起', toastsNow().every((toast) => toast.sessionId !== 's2'), JSON.stringify(toastsNow()));

// 制造一张新卡，供下面的渲染断言使用。
statusListener('s2', true);
statusListener('s2', false);
check('弹卡功能持续可用', toastsNow().length === 1, JSON.stringify(toastsNow()));

// ---------------------------------------------------------------------------
// 组件渲染：浮层卡面（含宽高内联样式）与设置页
// ---------------------------------------------------------------------------

// 当场试一次：不经过完成判定与面板判定，直接弹卡 + 放音。
for (const toast of toastsNow()) overlayFace().dismiss(toast.id);
face.setSoundChoice(0);
face.setVolume(80);
resetAudioLog();
windowStub.__dshTaskReminder.test();
check('test() 当场弹一张卡（取列表第一个会话的名）', toastsNow().length === 1 && toastsNow()[0].sessionId === 's1' && toastsNow()[0].title === '旧任务', JSON.stringify(toastsNow()));
check('test() 按当前音效与音量放提示音', audioLog.oscillators.length === 2 && audioLog.gains.length === 2 && closeTo(audioLog.gains[0].peak, 0.4375), `${audioLog.oscillators.length} / ${audioLog.gains.length}`);

console.log('');
console.log('组件渲染');

reportPanel('settings');
const flatten = (node, into = []) => {
	if (node === null || typeof node !== 'object') return into;
	into.push(node);
	for (const child of (Array.isArray(node.children) ? node.children : []).flat(Infinity)) flatten(child, into);
	return into;
};
let cards = overlayComponent({ ...overlayComponentProps(), usePanelInfo: (selector) => selector({ activePanelId: 'settings' }), t });
let nodes = flatten(cards);
check('有卡时浮层渲染右下角容器', nodes[0]?.props?.className === CSS.stack && nodes[0]?.props?.role === 'status', JSON.stringify(nodes[0]?.props));
check('卡片带会话标题', nodes.some((node) => node.type === 'div' && node.children?.[0] === '旧任务'));
const cardNode = nodes.find((node) => node.props?.className === CSS.toast);
check('卡片默认宽 420px 且不写高度（随内容自动）', cardNode?.props?.style?.width === '420px' && cardNode?.props?.style?.maxWidth === 'calc(100vw - 16px)' && cardNode?.props?.style?.height === undefined, JSON.stringify(cardNode?.props?.style));
const openButton = nodes.find((node) => node.type === 'button' && node.children?.[0] === '查看');
check('卡片有「查看」按钮且绑定了 openSession', openButton !== undefined && typeof openButton.props.onClick === 'function');
const closeButton = nodes.find((node) => node.type === 'button' && node.props?.['aria-label'] === '关闭提醒');
check('卡片有关闭按钮且绑定了 dismiss', closeButton !== undefined && typeof closeButton.props.onClick === 'function');

// 卡宽卡高可调：写进卡片内联样式。
face.setWidth(300);
face.setHeight(200);
cards = overlayComponent({ ...overlayComponentProps(), usePanelInfo: (selector) => selector({ activePanelId: 'settings' }), t });
nodes = flatten(cards);
const sizedCard = nodes.find((node) => node.props?.className === CSS.toast);
check('调宽调高后写进卡片内联样式', sizedCard?.props?.style?.width === '300px' && sizedCard?.props?.style?.height === '200px', JSON.stringify(sizedCard?.props?.style));
face.setWidth(DEFAULTS.width);
face.setHeight(DEFAULTS.height);

overlayFace().dismiss(toastsNow()[0].id);
cards = overlayComponent({ ...overlayComponentProps(), usePanelInfo: (selector) => selector({ activePanelId: 'settings' }), t });
check('没有卡时浮层渲染 null', cards === null);
check('浮层卸载渲染后仍持续上报面板状态', windowStub.__dshTaskReminder.state().panelHook === true && windowStub.__dshTaskReminder.state().inConversationWindow === false);

// 设置页：整页渲染 + 控件 + 交互。
// 先把通知开关恢复成默认开启，供下面的「默认态」断言使用。
face.setNotify(true);
/** 取一个元素的直接子元素（桩里单数组参数会产生一层嵌套，统一拍平）。 */
const kidsOf = (node) => (Array.isArray(node.children) ? node.children : []).flat(Infinity);
const renderSection = () => flatten(section.entry.component(sectionFace()));
let sectionNodes = renderSection();
const switches = sectionNodes.filter((node) => node.type === 'Switch');
check('设置页渲染两个开关（系统通知 / 提示音），没有弹窗开关', switches.length === 2, String(switches.length));
check('系统通知排在第一位且默认开启', switches[0]?.props?.label === '系统通知' && switches[0]?.props?.checked === true, JSON.stringify(switches.map((node) => [node.props.label, node.props.checked])));
check('提示音开关默认开启', switches[1]?.props?.label === '完成提示音' && switches[1]?.props?.checked === true);
check('两个开关的 onChange 都接到了写回函数', switches.every((node) => typeof node.props.onChange === 'function'));
check('设置页没有「试听」按钮（切换音效即发声）', !sectionNodes.some((node) => node.type === 'button' && node.children?.[0] === '试听'));
const segmentedButtons = sectionNodes.filter((node) => node.type === 'button' && typeof node.props?.['aria-pressed'] === 'boolean');
check('音效选择是四选一分段控件', segmentedButtons.length === 4 && segmentedButtons.filter((node) => node.props['aria-pressed'] === true).length === 1, String(segmentedButtons.length));
check('音效分段按钮文案与顺序', JSON.stringify(segmentedButtons.map((node) => node.children?.[0])) === JSON.stringify(['两声（经典）', '三声上扬', '上升琶音', '圆润三角波']), JSON.stringify(segmentedButtons.map((node) => node.children?.[0])));
check('默认选中第一种音效', segmentedButtons[0]?.props['aria-pressed'] === true);
const stepperGroups = sectionNodes.filter((node) => node.type === 'div' && node.props?.role === 'group'
	&& kidsOf(node).some((child) => child.props?.['aria-label'] === '减小'));
check('音量/卡宽/卡高三个步进器', stepperGroups.length === 3 && JSON.stringify(stepperGroups.map((node) => node.props['aria-label'])) === JSON.stringify(['提示音音量', '提醒卡宽度', '提醒卡高度']), JSON.stringify(stepperGroups.map((node) => node.props['aria-label'])));
const decOf = (group) => kidsOf(group).find((node) => node.props?.['aria-label'] === '减小');
const incOf = (group) => kidsOf(group).find((node) => node.props?.['aria-label'] === '增大');
check('每个步进器都有增减按钮', stepperGroups.every((group) => decOf(group) !== undefined && incOf(group) !== undefined));
check('高度为 0（自动）时只让增大', decOf(stepperGroups[2]).props.disabled === true && incOf(stepperGroups[2]).props.disabled === false);
check('音量与宽度在界内时增减都可用', decOf(stepperGroups[0]).props.disabled === false && incOf(stepperGroups[0]).props.disabled === false
	&& decOf(stepperGroups[1]).props.disabled === false && incOf(stepperGroups[1]).props.disabled === false);
const resetButton = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '恢复默认');
check('设置页有「恢复默认」按钮，默认值时置灰', resetButton !== undefined && resetButton.props.disabled === true, String(resetButton?.props?.disabled));
check('默认值时恢复默认行显示「已是默认值」文案', sectionNodes.some((node) => node.children?.[0] === '当前各项都已经是默认值。'));
check('音量行说明带当前值（插值）', sectionNodes.some((node) => node.children?.[0] === '提示音的整体增益，当前 80%；0 为静音'), JSON.stringify(sectionNodes.map((node) => node.children?.[0]).filter((text) => typeof text === 'string' && text.includes('增益'))));
check('卡宽/卡高行说明带当前值（插值）', sectionNodes.some((node) => node.children?.[0] === '提醒卡宽度，当前 420px；窗口过窄时自动收缩，不会顶出可视范围')
	&& sectionNodes.some((node) => node.children?.[0] === '提醒卡高度，当前 0px；0 表示不限制，随内容自动撑开'));

// 提醒卡大小预览：默认态 / 实时跟随宽高 / 按钮不接线。
const previewCard = sectionNodes.find((node) => node.props?.className === CSS.toast);
check('设置页有提醒卡预览（默认宽 420px、不写高度）', previewCard !== undefined && previewCard?.props?.style?.width === '420px' && previewCard?.props?.style?.height === undefined, JSON.stringify(previewCard?.props?.style));
check('预览区有标题与说明', sectionNodes.some((node) => node.children?.[0] === '提醒卡预览')
	&& sectionNodes.some((node) => node.children?.[0] === '按当前宽高实时画出的样例卡；调整宽度 / 高度时这里立即生效'));
check('预览卡带示例会话名', sectionNodes.some((node) => node.children?.[0] === '示例会话'));
const previewButtons = sectionNodes.filter((node) => node.type === 'button' && (node.children?.[0] === '查看' || node.children?.[0] === '×'));
check('预览卡按钮只作样子：不接线、不进 Tab 序', previewButtons.length === 2
	&& previewButtons.every((node) => node.props.onClick === undefined && node.props.tabIndex === -1), JSON.stringify(previewButtons.map((node) => [node.children?.[0], node.props.onClick, node.props.tabIndex])));
face.setWidth(300);
face.setHeight(120);
sectionNodes = renderSection();
const previewCardSized = sectionNodes.find((node) => node.props?.className === CSS.toast);
check('调宽调高后预览卡立即生效（300px × 120px）', previewCardSized?.props?.style?.width === '300px' && previewCardSized?.props?.style?.height === '120px', JSON.stringify(previewCardSized?.props?.style));
face.setWidth(DEFAULTS.width);
face.setHeight(DEFAULTS.height);

// 交互：切音效即发声；步进器改音量/宽高；恢复默认。
resetAudioLog();
segmentedButtons[1].props.onClick(); // 三声上扬
check('切换音效立即发声（三声上扬 3 音，按当前音量 master 1.0）', face.soundChoiceStore.getSnapshot() === 1
	&& audioLog.oscillators.length === 3 && audioLog.gains.length === 3
	&& closeTo(audioLog.oscillators[0].freq, 1046.5) && closeTo(audioLog.oscillators[1].freq, 1318.51) && closeTo(audioLog.oscillators[2].freq, 1567.98)
	&& closeTo(audioLog.gains[0].peak, 0.4) && closeTo(audioLog.gains[1].peak, 0.4) && closeTo(audioLog.gains[2].peak, 0.42), JSON.stringify(audioLog.gains.map((gain) => gain.peak)));
resetAudioLog();
segmentedButtons[2].props.onClick(); // 上升琶音
check('再切到上升琶音立即发声（4 音）', face.soundChoiceStore.getSnapshot() === 2 && audioLog.oscillators.length === 4, String(audioLog.oscillators.length));
incOf(stepperGroups[0]).props.onClick();
check('点音量「+」按步进 +5', face.volumeStore.getSnapshot() === 85, String(face.volumeStore.getSnapshot()));
decOf(stepperGroups[1]).props.onClick();
check('点宽度「−」按步进 −10', face.widthStore.getSnapshot() === 410, String(face.widthStore.getSnapshot()));
incOf(stepperGroups[2]).props.onClick();
check('点高度「+」按步进 +20（0 → 20）', face.heightStore.getSnapshot() === 20, String(face.heightStore.getSnapshot()));

// 恢复默认：先弄花，再一键写回。
face.setNotify(false);
face.setSound(false);
face.setSoundChoice(3);
face.setVolume(40);
face.setWidth(640);
face.setHeight(400);
sectionNodes = renderSection();
const resetButtonAfter = sectionNodes.find((node) => node.type === 'button' && node.children?.[0] === '恢复默认');
check('改花后「恢复默认」按钮置灰解除', resetButtonAfter?.props?.disabled === false, String(resetButtonAfter?.props?.disabled));
check('改花后说明换成默认值清单', sectionNodes.some((node) => typeof node.children?.[0] === 'string' && node.children[0].startsWith('一键写回全部默认值')));
resetButtonAfter.props.onClick();
check('恢复默认写回全部六个配置（通知回开）', face.notifyStore.getSnapshot() === true && face.soundStore.getSnapshot() === true
	&& face.soundChoiceStore.getSnapshot() === 0 && face.volumeStore.getSnapshot() === 80
	&& face.widthStore.getSnapshot() === 420 && face.heightStore.getSnapshot() === 0,
	JSON.stringify(windowStub.__dshTaskReminder.state()));

// ---------------------------------------------------------------------------
// 系统通知（Web Notification）：三种权限路径 + 不支持
// ---------------------------------------------------------------------------

console.log('');
console.log('系统通知');

// ① 已授权：完成即发通知；点击通知 → 窗口回前台 + 打开会话 + 关闭通知。
FakeNotification.permission = 'granted';
resetNotificationLog();
const notificationsBeforeGrant = windowStub.__dshTaskReminder.state().stats.notifications;
statusListener('s2', true);
statusListener('s2', false);
check('开启后任务完成发一条系统通知', notificationLog.created.length === 1, String(notificationLog.created.length));
check('通知标题/正文/标记', notificationLog.created[0]?.title === '对话任务已完成' && notificationLog.created[0]?.options?.body === '另一个会话' && notificationLog.created[0]?.options?.tag === NOTIFICATION_TAG, JSON.stringify(notificationLog.created[0]));
check('通知记进 stats.notifications', windowStub.__dshTaskReminder.state().stats.notifications === notificationsBeforeGrant + 1, String(windowStub.__dshTaskReminder.state().stats.notifications));
notificationLog.created[0].onclick();
check('点击通知：窗口回前台并打开对应会话、关闭通知', notificationLog.focused === 1 && opened.includes('s2') && notificationLog.closed === 1, JSON.stringify(notificationLog));
for (const toast of toastsNow()) overlayFace().dismiss(toast.id);

// ② 权限被拒：通知通道不生效（但卡片/提示音照旧），设置页给出提示。
FakeNotification.permission = 'denied';
resetNotificationLog();
await face.setNotify(false);
await face.setNotify(true);
check('权限被拒时开启开关也不再问浏览器', notificationLog.requested === 0 && face.permissionStore.getSnapshot() === 'denied');
resetAudioLog();
statusListener('s2', true);
statusListener('s2', false);
check('权限被拒时不再发通知', notificationLog.created.length === 0, String(notificationLog.created.length));
check('权限被拒时卡片与提示音照旧', toastsNow().some((toast) => toast.sessionId === 's2') && audioLog.oscillators.length === 2, JSON.stringify([toastsNow().length, audioLog.oscillators.length]));
for (const toast of toastsNow()) overlayFace().dismiss(toast.id);
sectionNodes = renderSection();
check('权限被拒时设置页给出提示', sectionNodes.some((node) => node.children?.[0] === '浏览器已拒绝本站点的通知权限，请到地址栏的站点权限里改为「允许」后再试。'));

// ③ 权限待定：开启开关即申请；允许后生效。
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
statusListener('s2', true);
statusListener('s2', false);
check('授权后任务完成恢复发通知', notificationLog.created.length === 1, String(notificationLog.created.length));
for (const toast of toastsNow()) overlayFace().dismiss(toast.id);
sectionNodes = renderSection();
check('授权后不再显示拒绝提示', !sectionNodes.some((node) => typeof node.children?.[0] === 'string' && node.children[0].includes('已拒绝')));

// ④ 关掉开关：完成不再发通知。
resetNotificationLog();
await face.setNotify(false);
statusListener('s2', true);
statusListener('s2', false);
check('关掉系统通知后不再发送', notificationLog.created.length === 0 && face.notifyStore.getSnapshot() === false);
for (const toast of toastsNow()) overlayFace().dismiss(toast.id);

// ⑤ 浏览器不支持 Notification：探测与调用全部安静失败。
const savedNotification = windowStub.Notification;
delete windowStub.Notification;
const notifierUnsupported = createNotifier();
check('不支持 Notification 时 supported 为假', notifierUnsupported.supported === false && notifierUnsupported.permission() === 'unsupported');
check('不支持时 show 安静返回 null', notifierUnsupported.show('标题', '正文', () => {}) === null);
check('不支持时 request 安静 resolve unsupported', await notifierUnsupported.request() === 'unsupported');
windowStub.Notification = savedNotification;
check('支持时 supported 为真且权限现读', createNotifier().supported === true && createNotifier().permission() === FakeNotification.permission);

// ---------------------------------------------------------------------------
// 提示音路径：音效切换、音量整档 +20、静音；回收时关掉 AudioContext
// ---------------------------------------------------------------------------

console.log('');
console.log('提示音');

/** 完成一次任务并返回本次新排的音。 */
const playOnce = () => {
	resetAudioLog();
	statusListener('s2', true);
	statusListener('s2', false);
	return {
		oscillators: [...audioLog.oscillators],
		gains: [...audioLog.gains],
	};
};

face.setSound(true);

// 第二种：三声上扬。
face.setSoundChoice(1);
let played = playOnce();
check('三声上扬：三个正弦音', played.oscillators.length === 3 && played.gains.length === 3
	&& played.oscillators.every((oscillator) => oscillator.type === 'sine'), String(played.oscillators.length));
check('三声上扬：C6 → E6 → G6', closeTo(played.oscillators[0].freq, 1046.5) && closeTo(played.oscillators[1].freq, 1318.51) && closeTo(played.oscillators[2].freq, 1567.98), JSON.stringify(played.oscillators.map((oscillator) => oscillator.freq)));
check('三声上扬：节奏 0 / 0.15 / 0.30 秒', closeTo(played.oscillators[0].startAt, 0) && closeTo(played.oscillators[1].startAt, 0.15) && closeTo(played.oscillators[2].startAt, 0.3), JSON.stringify(played.oscillators.map((oscillator) => oscillator.startAt)));

// 第三种：上升琶音。
face.setSoundChoice(2);
played = playOnce();
check('上升琶音：四个正弦音', played.oscillators.length === 4 && played.oscillators.every((oscillator) => oscillator.type === 'sine'), String(played.oscillators.length));
check('上升琶音：C5 → E5 → G5 → C6', closeTo(played.oscillators[0].freq, 523.25) && closeTo(played.oscillators[1].freq, 659.25) && closeTo(played.oscillators[2].freq, 783.99) && closeTo(played.oscillators[3].freq, 1046.5), JSON.stringify(played.oscillators.map((oscillator) => oscillator.freq)));
check('上升琶音：每 0.07 秒一音', closeTo(played.oscillators[1].startAt, 0.07) && closeTo(played.oscillators[2].startAt, 0.14) && closeTo(played.oscillators[3].startAt, 0.21), JSON.stringify(played.oscillators.map((oscillator) => oscillator.startAt)));

// 第四种：圆润三角波。
face.setSoundChoice(3);
played = playOnce();
check('圆润三角波：两个三角波音', played.oscillators.length === 2 && played.oscillators.every((oscillator) => oscillator.type === 'triangle'), JSON.stringify(played.oscillators.map((oscillator) => oscillator.type)));
check('圆润三角波：E5 → B5', closeTo(played.oscillators[0].freq, 659.25) && closeTo(played.oscillators[1].freq, 987.77), JSON.stringify(played.oscillators.map((oscillator) => oscillator.freq)));

// 音量整档 +20：显示值 +20 折成 master。
face.setSoundChoice(0);
face.setVolume(80);
played = playOnce();
check('显示 80 → master 1.0（原 100 的响度）', closeTo(played.gains[0].peak, 0.4375) && closeTo(played.gains[1].peak, 0.3625), JSON.stringify(played.gains.map((gain) => gain.peak)));
face.setVolume(50);
played = playOnce();
check('显示 50 → master 0.7（相当于原 70）', closeTo(played.gains[0].peak, 0.4375 * 0.7) && closeTo(played.gains[1].peak, 0.3625 * 0.7), JSON.stringify(played.gains.map((gain) => gain.peak)));
face.setVolume(100);
played = playOnce();
check('显示 100 → master 1.2（相当于原 120）', closeTo(played.gains[0].peak, 0.4375 * 1.2) && closeTo(played.gains[1].peak, 0.3625 * 1.2), JSON.stringify(played.gains.map((gain) => gain.peak)));

// 静音：0% 一条音都不排。
face.setVolume(0);
played = playOnce();
check('音量 0 为静音：不排任何音', played.oscillators.length === 0, String(played.oscillators.length));
face.setVolume(80);

// 提示音关掉：再完成也一条音都不多排。
const oscillatorsAfterPlay = audioLog.oscillators.length;
face.setSound(false);
statusListener('s2', true);
statusListener('s2', false);
check('提示音关掉后不再排音', audioLog.oscillators.length === oscillatorsAfterPlay, String(audioLog.oscillators.length - oscillatorsAfterPlay));
face.setSound(true);

check('AudioContext 全局只建一个（首次提示音时惰性创建，之后复用）', audioLog.contexts === 1, String(audioLog.contexts));

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
	uiWorkspace: { openSession: () => {} },
	timer: { timeout: () => () => {} },
});
check('装载期不抢建 AudioContext', audioLog2.contexts === 0 && audioLog2.oscillators === 0, JSON.stringify(audioLog2));

// ---------------------------------------------------------------------------
// 回收：effects 逆序销毁
// ---------------------------------------------------------------------------

console.log('');
console.log('回收');
for (const { disposer } of [...effects].reverse()) if (typeof disposer === 'function') disposer();
check('样式标签被移除', createdNodes.find((node) => node.dataset?.pluginCss === STYLE_TAG_ID)?.removed === true);
check('排障钩子被移除', windowStub.__dshTaskReminder === undefined);
check('事件订阅被退订', listeners.every((entry) => entry.disposed === true));
check('会话列表订阅被退订', listListeners.size === 0, String(listListeners.size));
check('焦点/可见性监听被退订', [...domListeners.document.values()].every((set) => set.size === 0) && [...domListeners.window.values()].every((set) => set.size === 0), JSON.stringify([...domListeners.document.entries()].map(([type, set]) => [type, set.size])));
check('回收时关掉了 AudioContext', audioLog.closed === 1, String(audioLog.closed));

console.log('');
if (failures.length > 0) {
	console.error(`verify-client: ${failures.length} 项失败`);
	process.exit(1);
}
console.log('verify-client: 全部通过');
