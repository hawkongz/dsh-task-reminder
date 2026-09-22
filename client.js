/**
 * dsh-task-reminder —— 浏览器半侧（DSH Web）。
 *
 * 目标：对话任务（Agent 回合）停止时发送 Windows 系统弹窗，并播放提示音 ——
 *   1. 系统弹窗走 Web Notification API（操作系统右下角原生通知，浏览器退到
 *      后台也看得到；点击回到该会话）。三种停止原因都提醒：任务完成、
 *      Agent 抛出问题等你回答（ask_user_question 挂起）、出错停止（如 400
 *      的红色错误）；同一次停止的错误与完成只报一次；
 *   2. 播放一声提示音（三种停止都响，不管在不在对话窗口；四种合成音效可选，
 *      音量可调；切换音效即时发声试听）。
 * 弹窗时机二选一：「任何情况都弹」任务一停止就弹；「仅非前台窗口」在切走
 * 标签页或浏览器窗口失焦（人在别的应用）时才弹。没有应用内卡片：弹窗是唯一
 * 视觉通道。提醒方式、音效、音量全部在「设置 → 任务提醒」独立页里配置，值落
 * 浏览器本地存储，重启后仍在；「恢复默认」一键写回出厂值。
 *
 * 七条实现要点：
 *
 * 1. 「任务完成」的信号有三条通道，共用一张 running 边沿表，天然去重：
 *    通道一：宿主转发事件 `api-session/status`（`API_REMOTE_FORWARDED_EVENTS`
 *    白名单内），浏览器侧 `ctx.remote.$on(name, listener)` 订阅；
 *    通道二：官方会话列表自身的 running 位（`ctx.sessions.list`）；
 *    通道三：`ctx.uiSession.sessionStatus` 快照里每个会话的 running 位（与
 *    sidebar 运行指示灯同源；fork 出来的子会话列表投影不可靠——陈旧 /
 *    不翻，这条路是最可靠的一路）。转发事件万一没递到本插件，另外两条
 *    路仍能收到完成。
 * 2. 「等你回答」读 `ctx.uiSession.sessionStatus`（根级只读快照：
 *    sessionId → { running, pendingInteraction, completionUnread }）：
 *    pendingInteraction 从无到有就是 Agent 阻塞在等用户（ask_user_question /
 *    plan-review）。同一个快照的 running 位同时是完成检测的第三通道
 *    （见要点 1）。只读订阅，绝不参与 user-questions/request 应答链。
 * 3. 「出错停止」接宿主转发事件 `api-session/error`(sessionId, message)。
 *    一次停止只报一次、报对一次：停止边沿（running→非 running）到达时读
 *    会话持久日志最后一条 `turn/end` 的 reason 分类——completed /
 *    max-tokens 报完成，error 报错误（正文取 reason.error.message，即
 *    网关原文）且不出现完成弹窗，aborted / blocked / interrupted 不报
 *    （取消、询问已报、崩溃孤儿回合）。读的同时取最后一条 `turn/start`：
 *    最新回合还没闭合（start 比 end 新）说明手里是上一个回合的 turn/end，
 *    当次读不到、重试等它落盘——否则点停止会误报「完成」。分类读不到才
 *    退回完成弹窗，此时 5 秒内后到的 api-session/error 撤回完成弹窗只留
 *    错误（错误优先，不重复响音）；后到的同类报告也按窗口去重。同一次
 *    停止的重复边沿（分类在途时列表陈旧回放）由在途守卫与完成→完成
 *    去重双兜底，只报一次。
 *    询问（pendingInteraction 出现边沿）单独弹「等待你的回答」；回答后
 *    紧随的那次完成不报（一次交互一次提醒）。
 * 4. 「窗口是否在前台」只看两个信号：标签页可见（document.hidden === false）
 *    且窗口有焦点（document.hasFocus()）。切走标签页、窗口失焦（人在别的
 *    应用里）都算非前台；拿不到这两个信号时按「在前台」处理（宁可少弹，
 *    也不在用户盯着看的时候乱弹 —— 除非用户选「任何情况都弹」）。
 * 5. 系统弹窗走标准 Web Notification API（普通浏览器与桌面壳都支持）：
 *    默认开启；权限还是 default 时首次装载替用户申请一次（localStorage
 *    记账只问一次），设置页另有「申请通知权限」按钮；被拒绝 / 不支持时在
 *    设置页给出对应提示，不假装生效。权限按 Origin 生效，授权一次本站点
 *    全部通用。每条通知独立 tag，互不顶替。
 * 6. 提示音用 Web Audio 现场合成，不引入任何音频文件：四种音效（两声 /
 *    三声上扬 / 上升琶音 / 圆润三角波）各有频率与节奏表，峰值按 100% 音量
 *    给出，再乘上「用户音量 + 20」折算出的 master 增益后写进包络 —— 整档
 *    比刻度上调 20，显示 80 就是原 100 的响度。AudioContext 装载即建、
 *    第一次用户手势 resume（首声延迟只剩浏览器设备启动那一截，任何网页
 *    都躲不掉）；被自动播放策略挂在 suspended 时拒绝不外抛。
 * 7. 设置是「设置」面板里的独立页（「设置 → 通用」里不再占行）：
 *    `ctx.slots.inject('settings.section', …)`（参考 dsh-chat-locator 的
 *    LocatorSection），order 避开 chat-locator(41)；页面自行渲染全部控件
 *    与恢复默认。值用 `createSnapshotStore(value, { persist: { name } })`
 *    落浏览器本地存储，因此不需要宿主半侧注册设置命名空间。
 * 8. 所有资源（字典、$on 订阅、sessionStatus 订阅、定时器、排障钩子）都挂
 *    ctx.effect，插件卸载时整体回收。
 *
 * @module dsh-task-reminder/client
 */
window.__ModuleLoader__.load({
	id: '@hawkongz/dsh-task-reminder',
	factory(require) {
		const React = require('react');
		const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
		const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives');

		/** 本地化命名空间（同时是设置页文案的键空间）。 */
		const NS = 'task-reminder';
		/** 版本号，随排障钩子暴露。 */
		const PLUGIN_VERSION = '1.4.2';

		/** 五个可配置项的本地持久化键（createSnapshotStore 的 persist.name）。 */
		const NOTIFY_PERSIST_KEY = 'dsh.task-reminder.notify';
		const NOTIFY_MODE_PERSIST_KEY = 'dsh.task-reminder.notify-mode';
		const SOUND_PERSIST_KEY = 'dsh.task-reminder.sound';
		const SOUND_CHOICE_PERSIST_KEY = 'dsh.task-reminder.sound-choice';
		const VOLUME_PERSIST_KEY = 'dsh.task-reminder.volume';

		/** 音量区间与步进（百分比）。 */
		const VOLUME_MIN = 0;
		const VOLUME_MAX = 100;
		const VOLUME_STEP = 5;
		/**
		 * 音量整档上调量：显示值 + 20 再折成 master 增益。
		 * 于是显示 80 就是原 100 的响度（master 1.0），显示 0 仍为静音。
		 */
		const VOLUME_BOOST = 20;

		/** 弹窗时机：任何情况都弹 / 仅非前台窗口才弹。 */
		const NOTIFY_MODE_ALWAYS = 'always';
		const NOTIFY_MODE_UNFOCUSED = 'unfocused';
		/** 默认时机：任何情况都弹。 */
		const DEFAULT_NOTIFY_MODE = NOTIFY_MODE_ALWAYS;
		/** @type {ReadonlyArray<{ id: string, nameKey: string }>} */
		const NOTIFY_MODES = Object.freeze([
			Object.freeze({ id: NOTIFY_MODE_ALWAYS, nameKey: 'notify.mode.always' }),
			Object.freeze({ id: NOTIFY_MODE_UNFOCUSED, nameKey: 'notify.mode.unfocused' }),
		]);

		/** 全部出厂值：「恢复默认」按这份表逐项写回。 */
		const DEFAULTS = Object.freeze({
			notify: true,
			notifyMode: DEFAULT_NOTIFY_MODE,
			sound: true,
			soundChoice: 0,
			volume: 80,
		});

		/**
		 * 四种合成音效。peak 是「显示音量 100」时的包络峰值：
		 * 默认显示 80%（整档 +20 → master 1.0）时第一种的实际峰值 0.4375 / 0.3625。
		 * 三角波同等峰值听起来更响，所以圆润那一档的 peak 给得低一些。
		 * @type {ReadonlyArray<{ id: string, nameKey: string, type: OscillatorType, notes: ReadonlyArray<{ frequency: number, at: number, duration: number, peak: number }> }>}
		 */
		const SOUND_CHOICES = Object.freeze([
			Object.freeze({
				id: 'two-tone',
				nameKey: 'sound.choice.two-tone',
				type: 'sine',
				notes: Object.freeze([
					Object.freeze({ frequency: 987.77, at: 0, duration: 0.16, peak: 0.4375 }), // B5
					Object.freeze({ frequency: 1318.51, at: 0.17, duration: 0.24, peak: 0.3625 }), // E6
				]),
			}),
			Object.freeze({
				id: 'three-tone',
				nameKey: 'sound.choice.three-tone',
				type: 'sine',
				notes: Object.freeze([
					Object.freeze({ frequency: 1046.5, at: 0, duration: 0.14, peak: 0.4 }), // C6
					Object.freeze({ frequency: 1318.51, at: 0.15, duration: 0.14, peak: 0.4 }), // E6
					Object.freeze({ frequency: 1567.98, at: 0.3, duration: 0.26, peak: 0.42 }), // G6
				]),
			}),
			Object.freeze({
				id: 'arpeggio',
				nameKey: 'sound.choice.arpeggio',
				type: 'sine',
				notes: Object.freeze([
					Object.freeze({ frequency: 523.25, at: 0, duration: 0.09, peak: 0.42 }), // C5
					Object.freeze({ frequency: 659.25, at: 0.07, duration: 0.09, peak: 0.42 }), // E5
					Object.freeze({ frequency: 783.99, at: 0.14, duration: 0.09, peak: 0.42 }), // G5
					Object.freeze({ frequency: 1046.5, at: 0.21, duration: 0.22, peak: 0.44 }), // C6
				]),
			}),
			Object.freeze({
				id: 'triangle',
				nameKey: 'sound.choice.triangle',
				type: 'triangle',
				notes: Object.freeze([
					Object.freeze({ frequency: 659.25, at: 0, duration: 0.2, peak: 0.3 }), // E5
					Object.freeze({ frequency: 987.77, at: 0.21, duration: 0.3, peak: 0.34 }), // B5
				]),
			}),
		]);
		/** 默认音效（第一种）。 */
		const DEFAULT_SOUND_CHOICE = 0;

		/** 系统通知的 tag：同一会话的重复通知在系统层替换，不堆一摞。 */
		const NOTIFICATION_TAG = 'dsh-task-reminder';
		/** 「已经替用户申请过通知权限」的记账键（localStorage）：只问一次。 */
		const PERMISSION_ASKED_KEY = 'dsh.task-reminder.permission-asked';

		const zh = {
			'nav': '任务提醒',
			'intro': '对话任务（Agent 回合）停止时发送 Windows 系统弹窗（Web Notification，操作系统右下角原生通知，浏览器退到后台也看得到；点击弹窗回到该会话），并播放提示音。三种停止都会提醒：任务完成、Agent 抛出问题等你回答（ask_user_question 挂起）、出错停止（任何让回合失败的错误：网关 HTTP 错误如 400 / 401 / 429 / 500 / 502、服务商故障、连接失败）；同一次停止只报一次（错误优先）。弹窗时机二选一：「任何情况都弹」不管窗口是否在前台；「仅非前台窗口」在切走标签页或浏览器窗口失焦（人在别的应用）时才弹。首次装载时代码会替您申请一次浏览器通知权限（按 Origin 生效，授权一次本站点全部通用，已授权则不会再问）；所有设置写入浏览器本地存储，重启后仍在，「恢复默认」一键回到出厂值。',
			'settings.notify.title': '系统弹窗',
			'toast.completed.title': '对话任务已完成',
			'toast.question.title': '等待你的回答',
			'toast.error.title': '任务出错已停止',
			'settings.notify.description': '任务完成时发送一条 Windows 系统弹窗；点击它回到该会话。默认开启；首次装载时代码会替您申请一次浏览器通知权限（已授权则不会再问）',
			'notify.mode.title': '弹窗时机',
			'notify.mode.description': '「任何情况都弹」：任务一完成就弹，不管浏览器窗口是否在前台；「仅非前台窗口」：切走标签页或浏览器窗口失焦（人在别的应用）时才弹。',
			'notify.mode.always': '任何情况都弹',
			'notify.mode.unfocused': '仅非前台窗口',
			'notify.unsupported': '当前浏览器不支持系统弹窗，这一项不会生效（提示音不受影响）。',
			'notify.denied': '浏览器已拒绝本站点的通知权限，请到地址栏的站点权限里改为「允许」后再试。',
			'notify.pending': '已发出权限申请：在弹出的浏览器对话框里选择「允许」后即可收到系统弹窗。',
			'notify.request': '申请通知权限',
			'settings.sound.title': '完成提示音',
			'settings.sound.description': '对话任务完成后播放提示音（不管是否正在对话窗口）',
			'sound.choice.title': '提示音音效',
			'sound.choice.description': '四种合成音效，用 Web Audio 现场生成，不加载任何音频文件；点选即按当前音量发声。浏览器重启后第一次播放有 3-5 秒延迟（音频设备冷启动），之后立即出声',
			'sound.choice.two-tone': '两声（经典）',
			'sound.choice.three-tone': '三声上扬',
			'sound.choice.arpeggio': '上升琶音',
			'sound.choice.triangle': '圆润三角波',
			'volume.title': '提示音音量',
			'volume.description': '提示音的整体增益，当前 {value}%；0 为静音',
			'reset.title': '恢复默认',
			'reset.description': '一键写回全部默认值：系统弹窗开（任何情况都弹）、提示音开、第一种音效、音量 80。',
			'reset.descriptionDefault': '当前各项都已经是默认值。',
			'reset': '恢复默认',
			'decrease': '减小',
			'increase': '增大',
		};
		const en = {
			'nav': 'Task reminder',
			'intro': 'When a conversation task (agent turn) stops, a Windows system toast goes out (Web Notification, the native notification in the bottom-right corner of your OS, visible while the browser is in the background; click it to return to that session) and a chime plays. Three stop reasons are covered: task complete, the agent is waiting for your answer (ask_user_question pending), and an error stop (any failed turn — a gateway HTTP error such as 400 / 401 / 429 / 500 / 502, a provider outage, or a connection failure) — one stop is reported once, with the error taking precedence. The toast timing has two modes: Always, no matter whether the browser window is in the foreground, or Only when unfocused, which fires when you switch the tab away or the browser window loses focus (you are in another app). On the first load the code asks for browser notification permission once (per origin, shared by every plugin on this site; never asked again once granted); all settings are stored in browser local storage and survive restarts, and Restore defaults puts everything back in one click.',
			'settings.notify.title': 'System toast',
			'toast.completed.title': 'Task complete',
			'toast.question.title': 'Waiting for your answer',
			'toast.error.title': 'Task stopped with an error',
			'settings.notify.description': 'Send a Windows system toast when a task finishes; clicking it returns to that session. On by default; the browser asks for notification permission once on the first load (never asked again once granted)',
			'notify.mode.title': 'Toast timing',
			'notify.mode.description': 'Always: toast as soon as a task finishes, whether or not the browser window is in the foreground. Only when unfocused: toast only when you switch the tab away or the browser window loses focus (you are in another app).',
			'notify.mode.always': 'Always',
			'notify.mode.unfocused': 'Only when unfocused',
			'notify.unsupported': 'This browser does not support system toasts, so this option has no effect (the chime is unaffected).',
			'notify.denied': 'The browser has denied notification permission for this site; allow it in the site permissions of the address bar and try again.',
			'notify.pending': 'Permission requested: choose Allow in the browser prompt and system toasts start working.',
			'notify.request': 'Request notification permission',
			'settings.sound.title': 'Completion sound',
			'settings.sound.description': 'Play a chime once a conversation task finishes, whether or not you are in the conversation window',
			'sound.choice.title': 'Chime effect',
			'sound.choice.description': 'Four synthesized chimes generated live with Web Audio; no audio files are loaded. Picking one plays it at the current volume. The first play after a browser restart can take 3-5 s (audio-device cold start); afterwards it is immediate',
			'sound.choice.two-tone': 'Two-tone (classic)',
			'sound.choice.three-tone': 'Rising three-tone',
			'sound.choice.arpeggio': 'Rising arpeggio',
			'sound.choice.triangle': 'Soft triangle',
			'volume.title': 'Chime volume',
			'volume.description': 'Overall gain of the chime, currently {value}%; 0 mutes it',
			'reset.title': 'Restore defaults',
			'reset.description': 'Writes every value back to its factory default: system toast on (always), chime on, first effect, 80% volume.',
			'reset.descriptionDefault': 'Everything is already at its factory value.',
			'reset': 'Restore defaults',
			'decrease': 'Decrease',
			'increase': 'Increase',
		};

		/**
		 * 前台状态上报：标签页被切走或窗口失焦（人在别的应用）时 focused = false。
		 * 拿不到信号时保持 true（宁可少弹，也不在用户盯着看时乱弹 —— 除非
		 * 用户选「任何情况都弹」）。
		 */
		const view = { focused: true };

		/**
		 * 取整数并夹到区间内；非法值退回兜底。
		 * @param value - 任意来源的值（本地存储读出来的可能是坏数据）。
		 * @param min - 区间下限。
		 * @param max - 区间上限。
		 * @param fallback - 非法值时的兜底。
		 * @returns 夹好的整数。
		 */
		function clampInteger(value, min, max, fallback) {
			const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : Number.NaN;
			if (!Number.isFinite(number)) return fallback;
			return Math.min(max, Math.max(min, number));
		}

		/**
		 * 归一化音量（0~100 的整数百分比）。
		 * @param value - 任意来源的值。
		 * @returns 夹到 [VOLUME_MIN, VOLUME_MAX] 的整数。
		 */
		function clampVolume(value) {
			return clampInteger(value, VOLUME_MIN, VOLUME_MAX, DEFAULTS.volume);
		}

		/**
		 * 归一化音效选择（音效表下标）。0 是合法值，不能用真值判断短路。
		 * @param value - 任意来源的值。
		 * @returns [0, SOUND_CHOICES.length - 1] 内的整数下标。
		 */
		function resolveSoundChoice(value) {
			const index = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : Number.NaN;
			if (!Number.isFinite(index)) return DEFAULT_SOUND_CHOICE;
			return clampInteger(index, 0, SOUND_CHOICES.length - 1, DEFAULT_SOUND_CHOICE);
		}

		/**
		 * 归一化弹窗时机。坏值（本地存储旧数据）退回默认时机。
		 * @param value - 任意来源的值。
		 * @returns 'always' 或 'unfocused'。
		 */
		function resolveNotifyMode(value) {
			if (value === NOTIFY_MODE_ALWAYS || value === NOTIFY_MODE_UNFOCUSED) return value;
			return DEFAULT_NOTIFY_MODE;
		}

		/**
		 * 取会话的展示名（ durable 标题 → 展示名 → 会话 id ）。
		 * @param ctx - 客户端根上下文。
		 * @param sessionId - 会话 id。
		 * @returns 通知正文里显示的名字。
		 */
		function titleOf(ctx, sessionId) {
			try {
				const row = ctx.sessions.list.getSnapshot().byId?.[sessionId];
				if (row !== undefined && row !== null) {
					const title = row.title ?? row.displayTitle;
					if (typeof title === 'string' && title !== '') return title;
				}
			} catch {
				// 读不到列表就退回会话 id，提醒本身不依赖标题。
			}
			return sessionId;
		}

		/**
		 * Web Audio 现场合成的提示音：按音效表排音，包络峰值乘上用户音量。
		 * AudioContext 惰性创建：首次提醒通常已在用户交互之后，能直接响；
		 * 被自动播放策略挂在 suspended 时，用户的第一次点击 / 按键会预热并
		 * 把它拉活。切走标签页 / 失焦期间排下的音，回到前台时立即续播。
		 * @returns { play, warm, resume, dispose } 播放、预热、拉活与回收。
		 */
		function createChime() {
			let audio = null;
			/** 输出管路是否已预热（只预一次）。 */
			let primed = false;
			/**
			 * 拉活 AudioContext。自动播放策略下，没有用户手势时浏览器会把
			 * context 挂在 suspended，resume() 也直接拒绝；点击 / 按键等
			 * 用户手势里调用本函数即可放行。拒绝不外抛：完成提示音不该被音频
			 * 策略炸掉，也不该在控制台留下未处理的 rejection。
			 */
			function revive() {
				if (audio === null || audio.state !== 'suspended') return;
				try {
					const reviving = audio.resume();
					if (reviving !== null && typeof reviving === 'object' && typeof reviving.then === 'function') {
						reviving.catch(() => {});
					}
				} catch {
					// 浏览器这会儿不让恢复：等下一个用户手势再试。
				}
			}
			/**
			 * 排一个音：快速起振，指数衰减，杜绝爆音。
			 * @param noteSpec - 音效表里的一条 { frequency, at, duration, peak }。
			 * @param at - 起始时刻（秒，相对 audio.currentTime）。
			 * @param master - master 增益（0~1，用户音量）。
			 * @param type - 波形（档位级：sine / triangle）。
			 */
			function note(noteSpec, at, master, type) {
				const oscillator = audio.createOscillator();
				const envelope = audio.createGain();
				const peak = Math.max(0.0001, noteSpec.peak * master);
				oscillator.type = type;
				oscillator.frequency.setValueAtTime(noteSpec.frequency, at);
				envelope.gain.setValueAtTime(0.0001, at);
				envelope.gain.exponentialRampToValueAtTime(peak, at + 0.015);
				envelope.gain.exponentialRampToValueAtTime(0.0001, at + noteSpec.duration);
				oscillator.connect(envelope);
				envelope.connect(audio.destination);
				oscillator.start(at);
				oscillator.stop(at + noteSpec.duration + 0.02);
			}
			return {
				/** 供用户手势监听调用：拉活被挂起的 AudioContext。 */
				resume: revive,
				/**
				 * 在用户手势里预热 AudioContext：把音频设备的初始化挪到第一次
				 * 交互，完成提示音与切音效试听都能立即出声，没有首声延迟。
				 * 同时播一条 gain=0 的极短音，强制音频线程与输出设备转起来
				 * （浏览器首次播放前的设备初始化任何网页都躲不掉，只能提前付）。
				 */
				warm() {
					try {
						if (typeof window === 'undefined') return;
						const Ctor = window.AudioContext ?? window.webkitAudioContext;
						if (Ctor === undefined) return;
						audio ??= new Ctor();
						if (audio.state === 'suspended') revive();
						if (primed) return;
						primed = true;
						try {
							const primerOsc = audio.createOscillator();
							const primerGain = audio.createGain();
							primerGain.gain.value = 0; // 听不见：只为把输出设备转起来
							primerOsc.connect(primerGain);
							primerGain.connect(audio.destination);
							primerOsc.start();
							primerOsc.stop(audio.currentTime + 0.01);
						} catch {
							// 预热音失败无所谓：正式提示音照排。
						}
					} catch {
						// 预热失败不影响以后：play 里还会再试一次。
					}
				},
				/**
				 * 按当前设置播放一遍。
				 * @param choice - 音效下标（或坏值，内部归一化）。
				 * @param volume - 音量显示值（或坏值，内部归一化）。
				 * @returns { scheduled, state } 是否真的排了音、播放时的 context 状态。
				 */
				play(choice, volume) {
					try {
						if (typeof window === 'undefined') return { scheduled: false, state: 'no-window' };
						const volumePercent = clampVolume(volume);
						if (volumePercent <= 0) return { scheduled: false, state: 'muted' }; // 0 = 静音：一条音都不排。
						const Ctor = window.AudioContext ?? window.webkitAudioContext;
						if (Ctor === undefined) return { scheduled: false, state: 'unsupported' };
						audio ??= new Ctor();
						// 被自动播放策略挂在 suspended 时先尝试拉活；这一下拉不动也照排，
						// 下一个用户手势恢复后这些音仍会播出来。
						if (audio.state === 'suspended') revive();
						const now = audio.currentTime;
						const spec = SOUND_CHOICES[resolveSoundChoice(choice)];
						// 整档上调 20：显示 80 → master 1.0（原 100 的响度）。
						const master = (volumePercent + VOLUME_BOOST) / 100;
						for (const noteSpec of spec.notes) {
							note(noteSpec, now + noteSpec.at, master, spec.type);
						}
						return { scheduled: true, state: audio.state };
					} catch {
						// 音频不可用就安静退场，弹窗与其它提醒方式不受影响。
						return { scheduled: false, state: 'failed' };
					}
				},
				dispose() {
					const closing = audio;
					audio = null;
					if (closing !== null && typeof closing.close === 'function') {
						try {
							void closing.close();
						} catch {
							// 已经关干净了。
						}
					}
				},
			};
		}

		/**
		 * 系统通知（Web Notification API）。支持探测、权限申请、弹出三步；
		 * 每一步都容忍失败：弹窗发不出去时提示音照旧。
		 * 权限状态每次现读（用户随时能在站点权限里改），不缓存。
		 * @returns { supported, permission, request, show }。
		 */
		function createNotifier() {
			/** 当前是否具备发通知的条件（浏览器支持且已授权）。 */
			const granted = () => typeof window !== 'undefined'
				&& typeof window.Notification === 'function'
				&& window.Notification.permission === 'granted';
			return {
				/** 浏览器有没有 Notification 构造器。 */
				get supported() {
					return typeof window !== 'undefined' && typeof window.Notification === 'function';
				},
				/** 当前权限：granted / denied / default / unsupported。 */
				permission() {
					if (!this.supported) return 'unsupported';
					const value = window.Notification.permission;
					return typeof value === 'string' ? value : 'default';
				},
				/**
				 * 申请通知权限。already granted/denied 时不再问；
				 * 必须在用户手势里调用（设置页打开开关就是手势）。
				 * @returns Promise<权限字符串>，失败时 resolve 当前权限。
				 */
				request() {
					if (!this.supported) return Promise.resolve('unsupported');
					const current = this.permission();
					if (current !== 'default') return Promise.resolve(current);
					try {
						const settlement = window.Notification.requestPermission();
						if (settlement !== null && typeof settlement === 'object' && typeof settlement.then === 'function') {
							return Promise.resolve(settlement).catch(() => this.permission());
						}
						return Promise.resolve(this.permission());
					} catch {
						return Promise.resolve(this.permission());
					}
				},
				/**
				 * 弹一条系统通知；点击时把窗口拉回前台并打开对应会话。
				 * @param title - 通知标题。
				 * @param body - 通知正文（会话名）。
				 * @param onClick - 点击通知时的回调。
				 * @returns 通知对象；没发出去时返回 null。
				 */
				show(title, body, onClick) {
					try {
						if (!granted()) return null;
						// 每条通知一个独立 tag：后一条不再顶掉前一条。固定 tag 的
						// 「同一会话替换」在提醒场景里反而让用户"什么都没看到"。
						const notification = new window.Notification(title, { body, tag: `${NOTIFICATION_TAG}-${Date.now()}` });
						notification.onclick = () => {
							try {
								if (typeof window.focus === 'function') window.focus();
							} catch {
								// 拉不起前台也不影响打开会话。
							}
							if (typeof onClick === 'function') onClick();
							try {
								notification.close();
							} catch {
								// 已经关掉了。
							}
						};
						return notification;
					} catch {
						// 通知失败不影响其它提醒方式。
						return null;
					}
				},
			};
		}

		//#region 设置页界面（settings.section 独立页）
		const SECTION_STYLE = {
			display: 'flex',
			flexDirection: 'column',
			width: '100%',
			maxWidth: '760px',
			color: 'var(--dsw-alias-label-primary)',
		};
		const INTRO_STYLE = {
			margin: '0 0 8px',
			color: 'var(--dsw-alias-label-secondary)',
			fontSize: '13px',
			lineHeight: '20px',
		};
		const NOTICE_STYLE = {
			margin: '0 0 8px',
			color: 'var(--dsw-alias-state-warn-primary)',
			fontSize: '12px',
			lineHeight: '18px',
		};
		const ROW_STYLE = {
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			padding: '16px 0',
			borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
		};
		const ROW_TEXT_STYLE = {
			display: 'flex',
			flexDirection: 'column',
			flex: '1',
			gap: '4px',
			minWidth: '0',
			paddingRight: '24px',
		};
		const ROW_TITLE_STYLE = {
			color: 'var(--dsw-alias-label-primary)',
			fontSize: '14px',
			fontWeight: 400,
			lineHeight: '22px',
		};
		const ROW_DESC_STYLE = {
			color: 'var(--dsw-alias-label-secondary)',
			fontSize: '12px',
			fontWeight: 400,
			lineHeight: '18px',
		};
		const ROW_CONTROL_STYLE = {
			display: 'flex',
			alignItems: 'center',
			flex: 'none',
		};
		const PILL_STYLE = {
			display: 'inline-flex',
			alignItems: 'center',
			height: '36px',
			padding: '0 4px',
			gap: '2px',
			borderRadius: '18px',
			background: 'var(--dsw-alias-bg-layer-2)',
		};
		const STEP_BUTTON_STYLE = {
			width: '28px',
			height: '28px',
			border: 'none',
			borderRadius: '50%',
			background: 'transparent',
			color: 'var(--dsw-alias-label-primary)',
			fontSize: '16px',
			lineHeight: '1',
			cursor: 'pointer',
			padding: '0',
		};
		const STEP_VALUE_STYLE = {
			minWidth: '34px',
			textAlign: 'center',
			fontSize: '14px',
			lineHeight: '22px',
			fontVariantNumeric: 'tabular-nums',
		};
		const SEGMENT_BUTTON_STYLE = {
			height: '30px',
			padding: '0 14px',
			border: 'none',
			borderRadius: '15px',
			background: 'transparent',
			color: 'var(--dsw-alias-label-secondary)',
			fontSize: '13px',
			lineHeight: '20px',
			cursor: 'pointer',
		};
		const SEGMENT_ACTIVE_STYLE = {
			background: 'var(--dsw-alias-bg-layer-1)',
			color: 'var(--dsw-alias-label-primary)',
			boxShadow: '0 1px 2px rgba(0, 0, 0, 0.12)',
		};
		const ACTION_BUTTON_STYLE = {
			height: '32px',
			padding: '0 14px',
			border: '1px solid var(--dsw-alias-border-l2)',
			borderRadius: '16px',
			background: 'transparent',
			color: 'var(--dsw-alias-label-primary)',
			fontSize: '13px',
			lineHeight: '20px',
			cursor: 'pointer',
			whiteSpace: 'nowrap',
		};

		/** 设置页里的一行：文案在左、控件在右。 */
		function SettingRow({ rowKey, title, desc, control }) {
			return React.createElement('div', { style: ROW_STYLE, key: rowKey }, [
				React.createElement('div', { style: ROW_TEXT_STYLE, key: 'text' }, [
					React.createElement('div', { style: ROW_TITLE_STYLE, key: 'title' }, title),
					React.createElement('div', { style: ROW_DESC_STYLE, key: 'desc' }, desc),
				]),
				React.createElement('div', { style: ROW_CONTROL_STYLE, key: 'control' }, control),
			]);
		}

		/** 数字步进器（− 值 +）。 */
		function Stepper({ value, min, max, stepSize = 1, label, onChange, t }) {
			const step = (delta) => {
				const next = Math.min(max, Math.max(min, value + delta * stepSize));
				if (next !== value) onChange(next);
			};
			const button = (key, text, delta, disabled, hint) => React.createElement('button', {
				key,
				type: 'button',
				disabled,
				'aria-label': hint,
				onClick: () => step(delta),
				style: { ...STEP_BUTTON_STYLE, opacity: disabled ? 0.35 : 1, cursor: disabled ? 'default' : 'pointer' },
			}, text);
			return React.createElement('div', { style: PILL_STYLE, role: 'group', 'aria-label': label }, [
				button('dec', '−', -1, value <= min, t('decrease')),
				React.createElement('span', { key: 'value', style: STEP_VALUE_STYLE }, String(value)),
				button('inc', '+', 1, value >= max, t('increase')),
			]);
		}

		/** 分段控件（二选一 / 多选一）。 */
		function Segmented({ value, options, label, onChange }) {
			return React.createElement('div', { style: PILL_STYLE, role: 'group', 'aria-label': label }, options.map((option) => React.createElement('button', {
				key: String(option.id),
				type: 'button',
				'aria-pressed': value === option.id,
				onClick: () => onChange(option.id),
				style: value === option.id ? { ...SEGMENT_BUTTON_STYLE, ...SEGMENT_ACTIVE_STYLE } : SEGMENT_BUTTON_STYLE,
			}, option.label)));
		}

		/** 「恢复默认」按钮；已是默认值时置灰。 */
		function TextButton({ disabled, label, onClick }) {
			return React.createElement('button', {
				type: 'button',
				disabled,
				'aria-label': label,
				onClick: () => {
					if (!disabled) onClick();
				},
				style: { ...ACTION_BUTTON_STYLE, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' },
			}, label);
		}

		/**
		 * 「任务提醒」设置页：系统弹窗开关与时机、提示音开关、音效与音量、恢复默认。
		 * 切换音效即时发声（按当前音量），不需要另点「试听」。
		 * @param props.notifyStore - 系统弹窗开关 store。
		 * @param props.notifyModeStore - 弹窗时机 store。
		 * @param props.soundStore - 提示音开关 store。
		 * @param props.soundChoiceStore - 音效下标 store。
		 * @param props.volumeStore - 音量 store。
		 * @param props.permissionStore - 通知权限状态 store（界面提示用）。
		 * @param props.setNotify - 写回系统弹窗开关（含权限申请）。
		 * @param props.setNotifyMode - 写回弹窗时机。
		 * @param props.setSound - 写回提示音开关。
		 * @param props.setSoundChoice - 写回音效下标（切换即发声）。
		 * @param props.setVolume - 写回音量。
		 * @param props.reset - 恢复默认。
		 * @param props.notifySupported - 浏览器是否支持系统通知。
		 * @param props.t - 本地化函数。
		 * @returns 设置页元素。
		 */
		function ReminderSection(props) {
			const notify = React.useSyncExternalStore(props.notifyStore.subscribe, props.notifyStore.getSnapshot);
			const notifyMode = React.useSyncExternalStore(props.notifyModeStore.subscribe, props.notifyModeStore.getSnapshot);
			const sound = React.useSyncExternalStore(props.soundStore.subscribe, props.soundStore.getSnapshot);
			const soundChoice = React.useSyncExternalStore(props.soundChoiceStore.subscribe, props.soundChoiceStore.getSnapshot);
			const volume = React.useSyncExternalStore(props.volumeStore.subscribe, props.volumeStore.getSnapshot);
			const permission = React.useSyncExternalStore(props.permissionStore.subscribe, props.permissionStore.getSnapshot);
			const t = props.t;
			const isDefault = notify === DEFAULTS.notify
				&& notifyMode === DEFAULTS.notifyMode
				&& sound === DEFAULTS.sound
				&& soundChoice === DEFAULTS.soundChoice
				&& volume === DEFAULTS.volume;
			const switchRow = (rowKey, titleKey, descKey, value, setValue) => React.createElement(SettingRow, {
				key: rowKey,
				rowKey,
				title: t(titleKey),
				desc: t(descKey),
				control: React.createElement(Switch, {
					checked: value === true,
					onChange: (next) => setValue(next === true),
					label: t(titleKey),
				}),
			});
			const children = [
				React.createElement('p', { style: INTRO_STYLE, key: 'intro' }, t('intro')),
				switchRow('notify', 'settings.notify.title', 'settings.notify.description', notify, props.setNotify),
			];
			// 弹窗时机：开关关着时不占一行。
			if (notify === true) {
				children.push(React.createElement(SettingRow, {
					key: 'notify-mode',
					rowKey: 'notify-mode',
					title: t('notify.mode.title'),
					desc: t('notify.mode.description'),
					control: React.createElement(Segmented, {
						value: notifyMode,
						label: t('notify.mode.title'),
						options: NOTIFY_MODES.map((mode) => ({ id: mode.id, label: t(mode.nameKey) })),
						onChange: (next) => props.setNotifyMode(next),
					}),
				}));
			}
			children.push(switchRow('sound', 'settings.sound.title', 'settings.sound.description', sound, props.setSound));
			children.push(React.createElement(SettingRow, {
				key: 'sound-choice',
				rowKey: 'sound-choice',
				title: t('sound.choice.title'),
				desc: t('sound.choice.description'),
				control: React.createElement(Segmented, {
					value: soundChoice,
					label: t('sound.choice.title'),
					options: SOUND_CHOICES.map((choice, index) => ({ id: index, label: t(choice.nameKey) })),
					onChange: (next) => props.setSoundChoice(next),
				}),
			}));
			children.push(React.createElement(SettingRow, {
				key: 'volume',
				rowKey: 'volume',
				title: t('volume.title'),
				desc: t('volume.description', { value: volume }),
				control: React.createElement(Stepper, {
					value: volume,
					min: VOLUME_MIN,
					max: VOLUME_MAX,
					stepSize: VOLUME_STEP,
					label: t('volume.title'),
					onChange: (next) => props.setVolume(next),
					t,
				}),
			}));
			children.push(React.createElement(SettingRow, {
				key: 'reset',
				rowKey: 'reset',
				title: t('reset.title'),
				desc: isDefault ? t('reset.descriptionDefault') : t('reset.description'),
				control: React.createElement(TextButton, {
					disabled: isDefault,
					label: t('reset'),
					onClick: () => props.reset(),
				}),
			}));
			// 通知权限提示：不支持 / 被拒绝 / 等待用户在选择框里点「允许」。
			let notifyHint = null;
			let showPermissionButton = false;
			if (props.notifySupported !== true) notifyHint = t('notify.unsupported');
			else if (permission === 'denied') notifyHint = t('notify.denied');
			else if (permission === 'default' && notify === true) {
				// 弹窗默认开着，但浏览器权限还没问过：给一个一键申请的入口。
				notifyHint = t('notify.pending');
				showPermissionButton = true;
			}
			if (notifyHint !== null) {
				children.push(React.createElement('p', { style: NOTICE_STYLE, key: 'notify-hint' }, notifyHint));
			}
			if (showPermissionButton) {
				children.push(React.createElement('div', { style: { padding: '0 0 16px' }, key: 'notify-request' },
					React.createElement(TextButton, {
						disabled: false,
						label: t('notify.request'),
						onClick: () => props.setNotify(true),
					})));
			}
			return React.createElement('div', { style: SECTION_STYLE }, children);
		}
		//#endregion

		/**
		 * 挂载插件：字典、五个持久化配置、完成事件订阅、前台跟踪、独立设置页。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-task-reminder: dictionaries');
			const t = ctx.locale.bind(NS);

			// 五个配置：值落浏览器本地持久存储，重启后仍在；不需要宿主设置命名空间。
			const notifyStore = createSnapshotStore(DEFAULTS.notify, { persist: { name: NOTIFY_PERSIST_KEY } });
			const notifyModeStore = createSnapshotStore(DEFAULTS.notifyMode, { persist: { name: NOTIFY_MODE_PERSIST_KEY } });
			const soundStore = createSnapshotStore(DEFAULTS.sound, { persist: { name: SOUND_PERSIST_KEY } });
			const soundChoiceStore = createSnapshotStore(DEFAULTS.soundChoice, { persist: { name: SOUND_CHOICE_PERSIST_KEY } });
			const volumeStore = createSnapshotStore(DEFAULTS.volume, { persist: { name: VOLUME_PERSIST_KEY } });
			// 通知权限状态只活在内存里（浏览器随时可能被用户改），供设置页提示。
			const notifier = createNotifier();
			const permissionStore = createSnapshotStore(notifier.permission());
			// 每个会话最近一次听到的 running 状态，用来识别「running → 非 running」的边沿。
			const runningSessions = new Map();
			// 一次停止只报一次、报对一次：停止边沿到达时读会话持久日志最后一条
			// turn/end 的 reason 分类（completed / max-tokens → 完成，error →
			// 错误且不出现完成弹窗，aborted / blocked / interrupted → 不报）。
			// 分类读不到时退回完成弹窗，用对账窗口兜底：5 秒内后到的
			// api-session/error 撤回完成弹窗只留错误、不重响提示音。
			const REPORT_GRACE_MS = 5000;
			// 分类时限放宽到 700ms、重试加到 3 次：turn/end 落盘不在回合边界
			// 同步 flush，取消（aborted）的 turn/end 常要再等一两拍才读得到。
			const CLASSIFY_TIMEOUT_MS = 700;
			const CLASSIFY_RETRIES = 3;
			const CLASSIFY_RETRY_MS = 120;
			const recentReports = new Map(); // sessionId → { kind, notification, at, cancel }
			// 一次性 grace：询问回答后紧随的那次完成不报（一次交互一次提醒）。
			const questionGrace = new Set(); // sessionId
			// 同一次停止的分类在途标记（token）：分类是异步的（RPC 读持久日志），
			// 窗口期内列表陈旧回放把边沿表冲回 true 再翻 false 会产生第二次边沿，
			// 此时直接忽略——同一次停止只走一次分类。
			const completing = new Map(); // sessionId → token
			// 有待答交互（ask_user_question / plan-review）的会话集合，按出现边沿提醒。
			const pendingQuestions = new Set();
			// 排障计数：三条通道各收到多少、三种停止各报了多少、重复抑制多少。
			const stats = {
				events: 0,
				listTicks: 0,
				completed: 0,
				questions: 0,
				errors: 0,
				skippedFocused: 0,
				sounds: 0,
				notifications: 0,
				stopDuplicates: 0,
				recentStops: [], // 最近 6 条 { kind, sessionId, at }
				lastEvent: null,
				lastCompletion: null,
				lastQuestion: null,
				lastError: null,
				lastSound: null,
			};
			const chime = createChime();
			// 装载即创建 AudioContext（Windows 音频设备的冷初始化要 3-5 秒，让它
			// 在页面加载时提前付掉）；此刻无用户手势，context 会被自动播放策略
			// 挂在 suspended 且不渲染，第一条 gain=0 的预热音也仅是排队。真正
			// 开始播放要等第一次用户手势 —— 届时只剩毫秒级的 resume。
			// （浏览器控制台会留一条 "AudioContext was not allowed to start" 的
			// 提示，这是自动播放策略的正常记录，不是错误。）
			chime.warm();

			// 在途权限申请的序号：每次写回开关、每次自动申请都使它失效，
			// 避免申请结果在用户又拨过关之后才回来，把新状态覆盖成过期值。
			let notifyRequestSeq = 0;
			const applyPermissionResult = (seq, result) => {
				if (seq !== notifyRequestSeq) return; // 过期结果丢弃
				permissionStore.set(typeof result === 'string' ? result : notifier.permission());
			};
			/**
			 * 写回系统弹窗开关；从关到开时若权限还是 default，借这个用户手势申请。
			 * @param next - 目标值。
			 * @returns 申请权限的 Promise（无需申请时返回 undefined）。
			 */
			const setNotify = (next) => {
				const on = next === true;
				notifyStore.set(on);
				const seq = (notifyRequestSeq += 1);
				if (!on || !notifier.supported) {
					if (notifier.supported) permissionStore.set(notifier.permission());
					return undefined;
				}
				const current = notifier.permission();
				if (current !== 'default') {
					permissionStore.set(current);
					return undefined;
				}
				return notifier.request().then((result) => applyPermissionResult(seq, result));
			};
			/** 写回弹窗时机（坏值归一化到默认档）。 */
			const setNotifyMode = (next) => notifyModeStore.set(resolveNotifyMode(next));
			/** 写回提示音开关。 */
			const setSound = (next) => soundStore.set(next === true);
			/**
			 * 写回音效下标（坏值归一化到默认档），并立即按新音效与当前音量发声 ——
			 * 在设置页切换音效就是试听，不用再多点一步。
			 * @param next - 目标音效下标。
			 */
			const setSoundChoice = (next) => {
				const resolved = resolveSoundChoice(next);
				soundChoiceStore.set(resolved);
				chime.play(resolved, volumeStore.getSnapshot());
			};
			/** 写回音量百分比。 */
			const setVolume = (next) => volumeStore.set(clampVolume(next));
			/** 恢复默认：五个配置全部写回出厂值，权限提示同步刷新。 */
			const resetAll = () => {
				notifyStore.set(DEFAULTS.notify);
				notifyModeStore.set(DEFAULTS.notifyMode);
				soundStore.set(DEFAULTS.sound);
				soundChoiceStore.set(DEFAULTS.soundChoice);
				volumeStore.set(DEFAULTS.volume);
				if (notifier.supported) permissionStore.set(notifier.permission());
			};

			/**
			 * 发一条系统弹窗：点击时窗口回前台并打开对应会话。
			 * @param title - 弹窗标题（按停止原因选）。
			 * @param body - 弹窗正文（会话名 / 问题 / 错误信息）。
			 * @param sessionId - 相关会话。
			 */
			const notify = (title, body, sessionId) => {
				const notification = notifier.show(title, body, () => {
					try {
						ctx.uiWorkspace.openSession(sessionId);
					} catch {
						// 会话打开失败也不影响弹窗本身。
					}
				});
				if (notification !== null) stats.notifications += 1;
				return notification;
			};

			/** 按当前开关排一次提示音，并记进排障计数。 */
			const chimeNow = () => {
				if (soundStore.getSnapshot() !== true) return;
				const sounded = chime.play(soundChoiceStore.getSnapshot(), volumeStore.getSnapshot());
				if (sounded?.scheduled === true) stats.sounds += 1;
				stats.lastSound = { ...sounded, at: Date.now() };
			};

			/**
			 * 弹窗门控（三种停止共用）：开关 + 弹窗时机。
			 * @returns true = 该发；false = 被开关或时机挡下。
			 */
			const shouldNotify = () => {
				if (notifyStore.getSnapshot() !== true) return false;
				// 「仅非前台窗口」：标签页被切走或浏览器窗口失焦（人在别的应用）才弹；
				// 「任何情况都弹」不看前台状态，每次停止都弹。
				if (notifyModeStore.getSnapshot() === NOTIFY_MODE_UNFOCUSED && view.focused) {
					stats.skippedFocused += 1;
					return false;
				}
				return true;
			};

			/**
			 * 记录一次 running 观测，判断「是不是刚跑完」。
			 * 三条检测通道（转发事件 + 官方会话列表 + sessionStatus 快照）共用
			 * 这张表：谁先看到边沿谁触发，后到的那方看到的已是非边沿，天然去重。
			 * @param sessionId - 会话 id。
			 * @param running - 是否正在运行。
			 * @returns 是否刚刚从 running 掉回非 running。
			 */
			const noteRunning = (sessionId, running) => {
				const wasRunning = runningSessions.get(sessionId) === true;
				runningSessions.set(sessionId, running === true);
				return running !== true && wasRunning;
			};

			/**
			 * 读会话持久日志最后一条 turn/end 的原因。turn/end 落盘不在回合
			 * 边界同步 flush，RPC 读存储会强制 flush；读不到就重试几次，
			 * 仍读不到返回 null（调用方走兜底）。
			 * 同时取最后一条 `turn/start`：最新回合还没闭合（start 比 end 新）时，
			 * 最后一条 turn/end 属于上一个回合（停止场景常是上一个回合的
			 * completed）——此时当次读不到，交给重试等本次回合的 turn/end 落盘，
			 * 避免把取消误报成「完成」。
			 * @param sessionId - 会话 id。
			 * @returns turn/end 的 reason，或 null。
			 */
			const readTurnEndReason = async (sessionId) => {
				for (let attempt = 0; ; attempt += 1) {
					let reason = null;
					try {
						reason = await ctx.sessions.using(sessionId, { source: 'task-reminder' }, async (reference) => {
							const binding = await reference.ready;
							const entries = binding.eventSource.getSnapshot().entries ?? [];
							let lastEnd = null; // 最后一条 turn/end
							let lastStart = null; // 最后一条 turn/start
							for (let i = entries.length - 1; i >= 0; i -= 1) {
								const entry = entries[i];
								if (entry?.type !== 'event') continue;
								if (lastEnd === null && entry.event?.type === 'turn/end') lastEnd = entry.event;
								if (lastStart === null && entry.event?.type === 'turn/start') lastStart = entry.event;
								if (lastEnd !== null && lastStart !== null) break;
							}
							if (lastEnd === null) return null;
							// 最新回合还没闭合：最后一条 turn/end 是上一个回合的，当次读不到。
							const endTurn = lastEnd.data?.turn;
							const startTurn = lastStart?.data?.turn;
							if (typeof endTurn === 'number' && typeof startTurn === 'number' && endTurn < startTurn) return null;
							return lastEnd.data?.reason ?? null;
						});
					} catch {
						// retain / open 失败（会话不在册、Host 侧拒绝等）：当次读不到。
					}
					if (reason !== null && reason !== undefined) return reason;
					if (attempt >= CLASSIFY_RETRIES) return null;
					await new Promise((resolve) => { setTimeout(resolve, CLASSIFY_RETRY_MS); });
				}
			};

			/** 错误弹窗正文：网关原文优先，空则退回会话名。 */
			const errorBody = (sessionId, message) => (typeof message === 'string' && message !== '' ? message : titleOf(ctx, sessionId));

			/**
			 * 记一笔近期报告（对账窗口内有效）：后到的冲突事件据此撤回完成
			 * 弹窗或跳过重复报告，到点自动遗忘。
			 * @param sessionId - 会话 id。
			 * @param kind - 'completion' | 'error'。
			 * @param notification - 实际发出的通知（被开关挡下时为 null）。
			 */
			const trackReport = (sessionId, kind, notification) => {
				const entry = { kind, notification, at: Date.now(), cancel: null };
				recentReports.set(sessionId, entry);
				// 排障轨迹：最近几条停止报告（复现双弹时看 sessionId 是否相同）。
				stats.recentStops.push({ kind, sessionId, at: entry.at });
				if (stats.recentStops.length > 6) stats.recentStops.shift();
				// 遗忘定时器不进 ctx.timer：它只是账本清理，卸载时随 map 一起丢弃；
				// 到点时若条目已换人（新报告）或已不在册，就不删。
				const handle = setTimeout(() => {
					if (recentReports.get(sessionId) === entry) recentReports.delete(sessionId);
				}, REPORT_GRACE_MS);
				entry.cancel = () => { clearTimeout(handle); };
			};

			/** 对账窗口内的近期报告；没有或已过期返回 undefined。 */
			const freshReport = (sessionId) => {
				const entry = recentReports.get(sessionId);
				if (entry === undefined || Date.now() - entry.at >= REPORT_GRACE_MS) return undefined;
				return entry;
			};

			/** 报一次完成：提示音 + 弹窗（均受各自开关门控），记入对账窗口。 */
			const reportCompletion = (sessionId, source) => {
				const prior = freshReport(sessionId);
				if (prior?.kind === 'error') return; // 本停止已按错误报过
				if (prior?.kind === 'completion') {
					// 同一次停止的重复边沿（通道重复触发 / 列表陈旧回放）：只报一次。
					stats.stopDuplicates += 1;
					return;
				}
				stats.completed += 1;
				stats.lastCompletion = { sessionId, source, at: Date.now() };
				chimeNow();
				if (!shouldNotify()) return;
				trackReport(sessionId, 'completion', notify(t('toast.completed.title'), titleOf(ctx, sessionId), sessionId));
			};

			/**
			 * 报一次错误：先去重（本停止已报过错误则跳过），再按兜底网处理
			 * （完成弹窗刚发过 → 撤回它只留错误，提示音已响过不重响），
			 * 最后提示音 + 弹窗，记入对账窗口。
			 * @param sessionId - 会话 id。
			 * @param message - 错误正文（网关原文）。
			 */
			const reportError = (sessionId, message) => {
				if (freshReport(sessionId)?.kind === 'error') return; // 本停止已按错误报过
				const prior = freshReport(sessionId);
				if (prior?.kind === 'completion') {
					// 兜底网：错误后到——撤回完成弹窗只留错误；音已响过，不重响。
					if (!shouldNotify()) return; // 保留完成弹窗作为唯一提醒
					if (prior.notification !== null) prior.notification.close();
					stats.errors += 1;
					stats.lastError = { sessionId, message, at: Date.now() };
					trackReport(sessionId, 'error', notify(t('toast.error.title'), errorBody(sessionId, message), sessionId));
					return;
				}
				stats.errors += 1;
				stats.lastError = { sessionId, message, at: Date.now() };
				chimeNow();
				if (!shouldNotify()) return;
				trackReport(sessionId, 'error', notify(t('toast.error.title'), errorBody(sessionId, message), sessionId));
			};

			/**
			 * 一轮对话任务结束（running → 非 running）：读会话持久日志最后一条
			 * turn/end 的 reason 决定报什么——完成 / 错误 / 不报（取消、询问
			 * 已报、崩溃孤儿回合）。读不到原因（兜底时限内）按完成报，由
			 * reportError 的对账网接手晚到的错误。询问待答期间与询问回答后
			 * 紧随的那次完成不报（一次交互一次提醒）。
			 * 分类是异步的：在途期间（completing 里有本会话的 token）到达的重复
			 * 边沿直接忽略——同一次停止只走一次分类、只报一次。
			 * @param sessionId - 会话 id。
			 * @param source - 触发来源（event / list / status），仅用于排障。
			 */
			const complete = (sessionId, source) => {
				if (pendingQuestions.has(sessionId)) return; // 询问待答：那次停止由询问弹窗负责
				if (completing.has(sessionId)) return; // 同一次停止的分类已在途（重复边沿）
				const grace = questionGrace.delete(sessionId);
				let settled = false;
				const token = {};
				completing.set(sessionId, token);
				const fallbackCancel = ctx.timer.timeout(() => {
					if (settled) return;
					settled = true;
					if (completing.get(sessionId) === token) completing.delete(sessionId);
					reportCompletion(sessionId, source); // 兜底：读不到原因就按完成报
				}, CLASSIFY_TIMEOUT_MS);
				void (async () => {
					try {
						const reason = await readTurnEndReason(sessionId);
						if (settled) return;
						settled = true;
						fallbackCancel();
						if (reason?.kind === 'error') {
							const failure = reason.error;
							reportError(sessionId, typeof failure?.message === 'string' ? failure.message : '');
							return;
						}
						// aborted（取消）/ blocked（询问已报）/ interrupted（崩溃孤儿）：不报。
						if (reason?.kind === 'aborted' || reason?.kind === 'blocked' || reason?.kind === 'interrupted') return;
						// completed / max-tokens / 读不到：按完成报（grace 期内不报）。
						if (!grace) reportCompletion(sessionId, source);
					} finally {
						if (completing.get(sessionId) === token) completing.delete(sessionId);
					}
				})();
			};

			// 用启动时的会话列表给 running 状态做种：页面加载前就在跑的任务，
			// 它的完成不会被误判成「新完成」而补弹一次。
			const seeded = ctx.sessions.list.getSnapshot();
			for (const id of seeded.ids ?? []) {
				const row = seeded.byId?.[id];
				if (row !== undefined && row !== null) runningSessions.set(id, row.running === true);
			}

			// 通道一：宿主转发事件 api-session/status(sessionId, running) —— running
			// 掉回非 running 就是一轮对话任务结束。running = true 时作废该会话的
			// grace、对账票据与在途分类标记（新任务开始，旧停止的对账到此为止）。
			ctx.effect(() => ctx.remote.$on('api-session/status', (sessionId, running) => {
				stats.events += 1;
				stats.lastEvent = { sessionId, running: running === true, at: Date.now(), source: 'event' };
				if (running === true) {
					questionGrace.delete(sessionId);
					completing.delete(sessionId); // 新任务开始：在途分类守卫作废
					const prior = recentReports.get(sessionId);
					if (prior !== undefined) {
						if (prior.cancel !== null) prior.cancel();
						recentReports.delete(sessionId);
					}
				}
				if (noteRunning(sessionId, running === true)) complete(sessionId, 'event');
			}), 'dsh-task-reminder: session status event');

			// 通道二：官方会话列表自身的 running 位（与 sidebar 运行指示灯同源，
			// 这套部署里证明是通的）。转发事件万一没递到本插件，这条路仍能收到完成。
			ctx.effect(() => ctx.sessions.list.subscribe(() => {
				stats.listTicks += 1;
				const snapshot = ctx.sessions.list.getSnapshot();
				for (const id of snapshot.ids ?? []) {
					const row = snapshot.byId?.[id];
					if (row === undefined || row === null) continue;
					if (noteRunning(id, row.running === true)) complete(id, 'list');
				}
			}), 'dsh-task-reminder: session status list');

			// 出错停止：宿主转发事件 api-session/error(sessionId, message) ——
			// 任何让回合失败的错误（网关 HTTP 错误、服务商故障、连接失败等）。
			// 去重与「撤回完成弹窗」的对账都在 reportError 里：一次停止只报
			// 一次、错误优先。
			ctx.effect(() => ctx.remote.$on('api-session/error', (sessionId, message) => {
				reportError(sessionId, message);
			}), 'dsh-task-reminder: session error event');
			// 等你回答 + 第三完成通道：uiSession.sessionStatus 快照 ——
			// pendingInteraction 出现边沿就是 Agent 阻塞在等用户操作（ask_user_question /
			// plan-review）；每个 entry 的 running 位同时是完成检测的第三来源（与
			// sidebar 运行指示灯同源，fork 会话的列表投影不可靠时这条路仍可靠）。
			// 只读观测这个根级快照，绝不订阅 user-questions/request —— 那是
			// waterfall 应答链，旁观者插进去会干扰官方问答 UI 应答。
			ctx.effect(() => ctx.uiSession.sessionStatus.subscribe(() => {
				const snapshot = ctx.uiSession.sessionStatus.getSnapshot();
				for (const [sessionId, status] of snapshot) {
					// running 位也计入边沿表（三条通道共用一张表，天然去重）。
					if (noteRunning(sessionId, status?.running === true)) complete(sessionId, 'status');
					const pending = status?.pendingInteraction;
					if (pending === undefined || pending === null) {
						// 这一轮挂起消散（用户已回答 / 交互关闭）：紧随的那次完成
						// 不报——一次交互一次提醒。
						if (pendingQuestions.delete(sessionId)) questionGrace.add(sessionId);
						continue;
					}
					if (pendingQuestions.has(sessionId)) continue; // 已提醒过这一轮
					pendingQuestions.add(sessionId);
					questionGrace.delete(sessionId); // 新一轮挂起：旧的 grace 作废
					stats.questions += 1;
					stats.lastQuestion = { sessionId, kind: pending.kind, at: Date.now() };
					chimeNow();
					if (!shouldNotify()) continue;
					const first = Array.isArray(pending.questions) ? pending.questions[0] : undefined;
					const body = typeof first?.question === 'string' && first.question !== '' ? first.question : titleOf(ctx, sessionId);
					notify(t('toast.question.title'), body, sessionId);
				}
				// 快照里已经完全没有的会话（被删除 / 归档）从待答集合里清掉，
				// 之后它再挂起问题时才算新的出现边沿。
				for (const sessionId of [...pendingQuestions]) {
					if (!snapshot.has(sessionId)) pendingQuestions.delete(sessionId);
				}
			}), 'dsh-task-reminder: pending questions');

			// 前台跟踪：标签页被切走 / 窗口失焦时 view.focused = false。
			ctx.effect(() => {
				const sync = () => {
					if (typeof document === 'undefined') return;
					const hidden = document.hidden === true;
					const unfocused = typeof document.hasFocus === 'function' && document.hasFocus() === false;
					view.focused = !hidden && !unfocused;
					// 切走/失焦期间 Chrome 可能挂起 AudioContext，期间排下的音
					// 会压在挂起的时钟上；回到前台时顺手拉活，让它们立刻续播。
					chime.resume();
				};
				sync();
				document.addEventListener('visibilitychange', sync);
				window.addEventListener('focus', sync);
				window.addEventListener('blur', sync);
				return () => {
					document.removeEventListener('visibilitychange', sync);
					window.removeEventListener('focus', sync);
					window.removeEventListener('blur', sync);
				};
			}, 'dsh-task-reminder: window focus');

			// 自动播放策略：没有用户手势时浏览器把 AudioContext 挂在 suspended，
			// resume() 也会被拒，完成提示音就此无声；第一次播放还要现建音频设备，
			// 首声会迟一拍。用户在页面上的第一次点击 / 按键就同时做两件事：
			// 预热（把设备初始化挪到手势里，之后零延迟）与拉活。
			ctx.effect(() => {
				if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
				const revive = () => {
					chime.warm();
					chime.resume();
				};
				window.addEventListener('pointerdown', revive, { capture: true });
				window.addEventListener('keydown', revive, { capture: true });
				return () => {
					window.removeEventListener('pointerdown', revive, { capture: true });
					window.removeEventListener('keydown', revive, { capture: true });
				};
			}, 'dsh-task-reminder: audio autoplay revival');

			// 系统弹窗默认开着：首次装载时替用户申请一次通知权限。浏览器的
			// Notification API 没有绕过权限的办法（任何插件都不行 —— OS toast
			// 一律要求 permission === 'granted'）。只问一次并记账，不每帧都弹；
			// 之后权限被重置回 default 时，设置页的「申请通知权限」按钮还能再问。
			// 权限按 Origin 共享：本站点授权一次，任何插件都通用。
			ctx.effect(() => {
				try {
					const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
					if (!storage || typeof storage.getItem !== 'function') return;
					if (storage.getItem(PERMISSION_ASKED_KEY) === '1') return;
					if (notifyStore.getSnapshot() !== true) return;
					if (!notifier.supported || notifier.permission() !== 'default') return;
					storage.setItem(PERMISSION_ASKED_KEY, '1');
					const seq = (notifyRequestSeq += 1);
					void notifier.request().then((result) => applyPermissionResult(seq, result));
				} catch {
					// 存储不可用（隐私模式等）就安静退场，设置页的申请按钮仍然可用。
				}
			}, 'dsh-task-reminder: notification permission prompt');
			ctx.effect(() => () => {
				chime.dispose();
			}, 'dsh-task-reminder: chime');
			// 回收对账票据与它们的遗忘定时器、grace 标记（卸载时不再有延迟回调落地）。
			ctx.effect(() => () => {
				for (const entry of recentReports.values()) {
					if (entry.cancel !== null) entry.cancel();
				}
				recentReports.clear();
				questionGrace.clear();
				completing.clear();
			}, 'dsh-task-reminder: report reconciliation');

			// 独立设置页：设置面板左侧导航里的「任务提醒」（order 避开 chat-locator 41）。
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'task-reminder',
				order: 44,
				label: () => t('nav'),
				locale: NS,
				inject: () => ({
					notifyStore,
					notifyModeStore,
					soundStore,
					soundChoiceStore,
					volumeStore,
					permissionStore,
					setNotify,
					setNotifyMode,
					setSound,
					setSoundChoice,
					setVolume,
					reset: resetAll,
					notifySupported: notifier.supported,
					t,
				}),
			}, ReminderSection));

			// 排障钩子：浏览器控制台执行 __dshTaskReminder.state() 可看前台状态、
			// 五个配置、通知权限与各会话 running 记录。
			const debug = {
				version: PLUGIN_VERSION,
				state: () => ({
					focused: view.focused,
					notify: notifyStore.getSnapshot(),
					notifyMode: notifyModeStore.getSnapshot(),
					sound: soundStore.getSnapshot(),
					soundChoice: soundChoiceStore.getSnapshot(),
					volume: volumeStore.getSnapshot(),
					notificationPermission: permissionStore.getSnapshot(),
					notificationSupported: notifier.supported,
					running: [...runningSessions.entries()],
					stats: { ...stats },
				}),
			};
			/**
			 * 当场触发一条提醒（不经过判定与门控），三种停止都能演示：
			 * `test()` / `test('completed')` 完成、`test('question')` 等你回答、
			 * `test('error')` 出错停止。专供验证三条链路是否都通。
			 * @param kind - 'completed'（默认）/ 'question' / 'error'。
			 * @param sessionId - 可选，指定用哪个会话的名字。
			 */
			debug.test = (kind, sessionId) => {
				const resolved = kind === 'question' || kind === 'error' ? kind : 'completed';
				const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ctx.sessions.list.getSnapshot().ids?.[0] ?? 'test';
				if (resolved === 'question') {
					stats.questions += 1;
					stats.lastQuestion = { sessionId: id, kind: 'question', at: Date.now() };
					notify(t('toast.question.title'), '排障测试：这是一条模拟的待答问题？', id);
				} else if (resolved === 'error') {
					stats.errors += 1;
					stats.lastError = { sessionId: id, message: '排障测试：模拟一条错误（如 400 Bad Request）', at: Date.now() };
					notify(t('toast.error.title'), '排障测试：模拟一条错误（如 400 Bad Request）', id);
				} else {
					stats.completed += 1;
					stats.lastCompletion = { sessionId: id, source: 'test', at: Date.now() };
					notify(t('toast.completed.title'), titleOf(ctx, id), id);
				}
				if (soundStore.getSnapshot() === true) chime.play(soundChoiceStore.getSnapshot(), volumeStore.getSnapshot());
			};
			/** 只放音：按当前音效与音量，供排障试听。 */
			debug.sound = () => chime.play(soundChoiceStore.getSnapshot(), volumeStore.getSnapshot());
			window.__dshTaskReminder = debug;
			ctx.effect(() => () => {
				if (window.__dshTaskReminder === debug) delete window.__dshTaskReminder;
			}, 'dsh-task-reminder: debug hook');
		}

		return {
			name: 'dsh-task-reminder',
			inject: ['slots', 'locale', 'sessions', 'remote', 'uiSession', 'uiWorkspace', 'timer'],
			apply,
			// 纯函数与常量出口：Node 自检直接校验，不参与运行时行为。
			diagnostics: {
				DEFAULTS,
				DEFAULT_NOTIFY_MODE,
				DEFAULT_SOUND_CHOICE,
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
			},
		};
	},
});
