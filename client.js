/**
 * dsh-task-reminder —— 浏览器半侧（DSH Web）。
 *
 * 目标：对话任务（Agent 回合）结束时，如果用户当前不在对话窗口，就提醒 ——
 *   1. 系统通知发不出时，右下角兜底弹出一张提醒卡（点「查看」回到该会话）；
 *   2. 播放一声提示音（每次完成都响，不管在不在对话窗口；四种合成音效可选，音量可调；切换音效即时发声试听）；
 *   3. 发送一条系统通知（Web Notification，OS 级 toast，退到后台也看得到，
 *      默认开启，首次开启时借用户手势申请权限）。
 * 提醒方式、音效、音量、卡片宽高全部在「设置 → 任务提醒」独立页里配置，
 * 值落浏览器本地存储，重启后仍在；「恢复默认」一键写回出厂值。
 *
 * 六条实现要点：
 *
 * 1. 「任务完成」的信号有两条通道，共用一张 running 边沿表，天然去重：
 *    通道一：宿主转发事件 `api-session/status`（`API_REMOTE_FORWARDED_EVENTS`
 *    白名单内），浏览器侧 `ctx.remote.$on(name, listener)` 订阅；
 *    通道二：官方会话列表自身的 running 位（`ctx.sessions.list`，与 sidebar
 *    运行指示灯同源）。转发事件万一没递到本插件，通道二仍能收到完成。
 * 2. 「是否在对话窗口」有两个信号，同时满足才算用户在看着这场对话：
 *    主区 activePanelId 为 null（对话窗口，借标准钩子 usePanelInfo 读）
 *    且 标签页可见（document.hidden === false）且窗口有焦点
 *    （document.hasFocus()）。切到其它面板、切走标签页、窗口失焦（人在别的
 *    应用里）都算非对话窗口；拿不到面板钩子时不静默失效：按「非对话窗口」
 *    处理并 console.warn 一次。
 * 3. 弹窗挂 `shell.overlay`（框架级浮层，不占用任何栏内空间），贴在右下角
 *    （8px），样式走主题 token，深浅色自动跟随；宽高由用户配置写进卡片内联
 *    样式。卡片是常驻通道（没有独立开关）；置顶到最前端由系统通知完成。
 *    提示音用 Web Audio 现场合成，不引入任何音频文件：四种音效
 *    （两声 / 三声上扬 / 上升琶音 / 圆润三角波）各有频率与节奏表，峰值按
 *    100% 音量给出，再乘上「用户音量 + 20」折算出的 master 增益后写进包络
 *    —— 整档比刻度上调 20，显示 80 就是原 100 的响度。
 * 4. 系统通知走标准 Web Notification API（普通浏览器与桌面壳都支持）：
 *    默认开启；开启时若浏览器权限还是 default，借用户打开开关这个手势
 *    申请权限；被拒绝 / 不支持时在设置页给出对应提示，不假装生效。
 * 5. 设置是「设置」面板里的独立页（「设置 → 通用」里不再占行）：
 *    `ctx.slots.inject('settings.section', …)`（参考 dsh-chat-locator 的
 *    LocatorSection），order 避开 chat-locator(41)；页面自行渲染全部控件
 *    与恢复默认。值用 `createSnapshotStore(value, { persist: { name } })`
 *    落浏览器本地存储，因此不需要宿主半侧注册设置命名空间。
 * 6. 所有资源（字典、$on 订阅、样式标签、定时器、排障钩子）都挂 ctx.effect，
 *    插件卸载时整体回收。
 *
 * @module dsh-task-reminder/client
 */
window.__ModuleLoader__.load({
	id: 'dsh-task-reminder',
	factory(require) {
		const React = require('react');
		const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
		const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives');

		/** 本地化命名空间（同时是设置页文案的键空间）。 */
		const NS = 'task-reminder';
		/** 样式标签标识，便于排障与幂等挂载。 */
		const STYLE_TAG_ID = 'dsh-task-reminder/reminder.css';
		/** 版本号，随排障钩子暴露。 */
		const PLUGIN_VERSION = '1.2.2';

		/** 提示卡停留时长（毫秒），到点自动收起。 */
		const TOAST_TTL_MS = 8000;
		/** 同屏最多堆几张贴卡；再有多余的先把最旧的挤掉。 */
		const MAX_TOASTS = 3;
		/** 浮层距窗口右下角的边距（px）。 */
		const STACK_INSET_PX = 8;

		/** 六个可配置项的本地持久化键（createSnapshotStore 的 persist.name）。 */
		const NOTIFY_PERSIST_KEY = 'dsh.task-reminder.notify';
		const SOUND_PERSIST_KEY = 'dsh.task-reminder.sound';
		const SOUND_CHOICE_PERSIST_KEY = 'dsh.task-reminder.sound-choice';
		const VOLUME_PERSIST_KEY = 'dsh.task-reminder.volume';
		const WIDTH_PERSIST_KEY = 'dsh.task-reminder.width';
		const HEIGHT_PERSIST_KEY = 'dsh.task-reminder.height';

		/** 音量区间与步进（百分比）。 */
		const VOLUME_MIN = 0;
		const VOLUME_MAX = 100;
		const VOLUME_STEP = 5;
		/**
		 * 音量整档上调量：显示值 + 20 再折成 master 增益。
		 * 于是显示 80 就是原 100 的响度（master 1.0），显示 0 仍为静音。
		 */
		const VOLUME_BOOST = 20;
		/** 卡片宽度区间与步进（px）。 */
		const WIDTH_MIN = 240;
		const WIDTH_MAX = 640;
		const WIDTH_STEP = 10;
		/** 卡片高度区间与步进（px）；0 = 不限制，随内容自动撑开。 */
		const HEIGHT_MIN = 0;
		const HEIGHT_MAX = 400;
		const HEIGHT_STEP = 20;

		/** 全部出厂值：「恢复默认」按这份表逐项写回。 */
		const DEFAULTS = Object.freeze({
			notify: true,
			sound: true,
			soundChoice: 0,
			volume: 80,
			width: 420,
			height: 0,
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

		const zh = {
			'nav': '任务提醒',
			'intro': '对话任务（Agent 回合）结束时，如果人不在对话窗口前，就按这里的设置提醒：系统通知发不出时右下角兜底弹出提醒卡片（点「查看」回到该会话）、播放提示音（不管在不在对话窗口，每次完成都响）、并发送一条系统通知。切换音效会立即按当前音量发声；所有设置写入浏览器本地存储，重启后仍在，「恢复默认」一键回到出厂值。',
			'toast.title': '对话任务已完成',
			'toast.open': '查看',
			'toast.close': '关闭提醒',
			'settings.notify.title': '系统通知',
			'settings.notify.description': '任务完成时发送一条系统通知（操作系统右下角弹出，应用退到后台也能看到）；点击通知回到该会话。默认开启，首次开启会向浏览器申请通知权限',
			'notify.unsupported': '当前浏览器不支持系统通知，这一项不会生效（应用内卡片与提示音不受影响）。',
			'notify.denied': '浏览器已拒绝本站点的通知权限，请到地址栏的站点权限里改为「允许」后再试。',
			'notify.pending': '已发出权限申请：在弹出的浏览器对话框里选择「允许」后即可收到系统通知。',
			'notify.request': '申请通知权限',
			'settings.sound.title': '完成提示音',
			'settings.sound.description': '对话任务完成后播放提示音（不管是否正在对话窗口）',
			'sound.choice.title': '提示音音效',
			'sound.choice.description': '四种合成音效，用 Web Audio 现场生成，不加载任何音频文件；点选即按当前音量发声',
			'sound.choice.two-tone': '两声（经典）',
			'sound.choice.three-tone': '三声上扬',
			'sound.choice.arpeggio': '上升琶音',
			'sound.choice.triangle': '圆润三角波',
			'volume.title': '提示音音量',
			'volume.description': '提示音的整体增益，当前 {value}%；0 为静音',
			'width.title': '提醒卡宽度',
			'width.description': '提醒卡宽度，当前 {value}px；窗口过窄时自动收缩，不会顶出可视范围',
			'height.title': '提醒卡高度',
			'height.description': '提醒卡高度，当前 {value}px；0 表示不限制，随内容自动撑开',
			'preview.title': '提醒卡预览',
			'preview.description': '按当前宽高实时画出的样例卡；调整宽度 / 高度时这里立即生效',
			'preview.sampleSession': '示例会话',
			'reset.title': '恢复默认',
			'reset.description': '一键写回全部默认值：系统通知开、提示音开、第一种音效、音量 80、卡宽 420px、卡高自动。',
			'reset.descriptionDefault': '当前各项都已经是默认值。',
			'reset': '恢复默认',
			'decrease': '减小',
			'increase': '增大',
		};
		const en = {
			'nav': 'Task reminder',
			'intro': 'When a conversation task (agent turn) finishes while you are away from the conversation window, this page decides how you are reminded: a bottom-right reminder card as the fallback when the system notification cannot be delivered (click Open to jump back), a chime on every completion, and a system notification. Picking a chime effect plays it right away at the current volume; all settings are stored in browser local storage and survive restarts, and Restore defaults puts everything back in one click.',
			'toast.title': 'Task complete',
			'toast.open': 'Open',
			'toast.close': 'Dismiss reminder',
			'settings.notify.title': 'System notification',
			'settings.notify.description': 'Send a system notification when a task finishes (an OS toast you can see while the app is in the background); clicking it returns to that session. On by default; turning it on asks the browser for notification permission',
			'notify.unsupported': 'This browser does not support system notifications, so this option has no effect (the in-app card and the chime are unaffected).',
			'notify.denied': 'The browser has denied notification permission for this site; allow it in the site permissions of the address bar and try again.',
			'notify.pending': 'Permission requested: choose Allow in the browser prompt and system notifications start working.',
			'notify.request': 'Request notification permission',
			'settings.sound.title': 'Completion sound',
			'settings.sound.description': 'Play a chime once a conversation task finishes, whether or not you are in the conversation window',
			'sound.choice.title': 'Chime effect',
			'sound.choice.description': 'Four synthesized chimes generated live with Web Audio; no audio files are loaded. Picking one plays it at the current volume',
			'sound.choice.two-tone': 'Two-tone (classic)',
			'sound.choice.three-tone': 'Rising three-tone',
			'sound.choice.arpeggio': 'Rising arpeggio',
			'sound.choice.triangle': 'Soft triangle',
			'volume.title': 'Chime volume',
			'volume.description': 'Overall gain of the chime, currently {value}%; 0 mutes it',
			'width.title': 'Card width',
			'width.description': 'Width of the reminder card, currently {value}px; it shrinks automatically in a narrow window and never overflows the viewport',
			'height.title': 'Card height',
			'height.description': 'Height of the reminder card, currently {value}px; 0 leaves it unconstrained and it grows with its content',
			'preview.title': 'Card preview',
			'preview.description': 'A sample card drawn at the current width and height; it updates as you adjust them',
			'preview.sampleSession': 'Example session',
			'reset.title': 'Restore defaults',
			'reset.description': 'Writes every value back to its factory default: system notification on, chime on, first effect, 80% volume, 420px width, automatic height.',
			'reset.descriptionDefault': 'Everything is already at its factory value.',
			'reset': 'Restore defaults',
			'decrease': 'Decrease',
			'increase': 'Increase',
		};

		/**
		 * 常驻 overlay 条目上报的主区状态。
		 * activePanelId：null = 对话窗口，非 null = 其它面板；
		 * panelHook：usePanelInfo 是否真的递到了条目手里；
		 * away：标签页被切走或窗口失焦（人在别的应用或别的标签页）时也为真。
		 */
		const view = { activePanelId: null, panelHook: false, away: false };
		let warnedNoPanelHook = false;

		/** 类名表（固定前缀，避免与宿主样式互相命中）。 */
		const CSS = {
			stack: 'tcr-stack',
			toast: 'tcr-toast',
			glyph: 'tcr-glyph',
			body: 'tcr-body',
			title: 'tcr-title',
			desc: 'tcr-desc',
			action: 'tcr-action',
			close: 'tcr-close',
		};

		/** 插件自有样式：右下角浮层（间距/字号/图标随默认卡宽一起放大）。 */
		const CSS_TEXT = [
			`.${CSS.stack}{position:fixed;right:${STACK_INSET_PX}px;bottom:${STACK_INSET_PX}px;z-index:1200;display:flex;flex-direction:column;gap:8px;pointer-events:none}`,
			`.${CSS.toast}{pointer-events:auto;box-sizing:border-box;display:flex;align-items:center;gap:12px;width:min(420px,calc(100vw - 16px));padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgb(0 0 0 / 18%);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;animation:tcr-enter .18s ease}`,
			'@keyframes tcr-enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
			`@media (prefers-reduced-motion:reduce){.${CSS.toast}{animation:none}}`,
			`.${CSS.glyph}{flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;color:var(--dsw-alias-state-success-primary)}`,
			`.${CSS.body}{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}`,
			`.${CSS.title}{font-weight:500;font-size:15px}`,
			`.${CSS.desc}{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
			`.${CSS.action},.${CSS.close}{flex:none;cursor:pointer;border:none;background:transparent;font:inherit;color:var(--dsw-alias-brand-primary);border-radius:8px;padding:4px 8px}`,
			`.${CSS.action}:hover,.${CSS.close}:hover{background:var(--dsw-alias-bg-layer-2)}`,
			`.${CSS.close}{color:var(--dsw-alias-label-secondary);padding:4px 6px;font-size:16px;line-height:1}`,
		].join('');

		/**
		 * 挂载插件样式标签。
		 * @returns 卸载时移除该标签的函数。
		 */
		function mountStyles() {
			if (typeof document === 'undefined') return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-task-reminder';
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

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
		 * 归一化卡片尺寸（px）。
		 * @param value - 任意来源的值。
		 * @param min - 区间下限。
		 * @param max - 区间上限。
		 * @param fallback - 非法值时的兜底。
		 * @returns 夹好区间的整数。
		 */
		function clampSize(value, min, max, fallback) {
			return clampInteger(value, min, max, fallback);
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
		 * 取会话的展示名（ durable 标题 → 展示名 → 会话 id ）。
		 * @param ctx - 客户端根上下文。
		 * @param sessionId - 会话 id。
		 * @returns 提醒卡上显示的名字。
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
		 * 被自动播放策略拦住时静默失败，不抛错。
		 * @returns { play, dispose } 播放与回收。
		 */
		function createChime() {
			let audio = null;
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
				/**
				 * 按当前设置播放一遍。
				 * @param choice - 音效下标（或坏值，内部归一化）。
				 * @param volume - 音量显示值（或坏值，内部归一化）。
				 */
				play(choice, volume) {
					try {
						if (typeof window === 'undefined') return;
						const volumePercent = clampVolume(volume);
						if (volumePercent <= 0) return; // 0 = 静音：一条音都不排。
						const Ctor = window.AudioContext ?? window.webkitAudioContext;
						if (Ctor === undefined) return;
						audio ??= new Ctor();
						if (audio.state === 'suspended') void audio.resume();
						const now = audio.currentTime;
						const spec = SOUND_CHOICES[resolveSoundChoice(choice)];
						// 整档上调 20：显示 80 → master 1.0（原 100 的响度）。
						const master = (volumePercent + VOLUME_BOOST) / 100;
						for (const noteSpec of spec.notes) {
							note(noteSpec, now + noteSpec.at, master, spec.type);
						}
					} catch {
						// 音频不可用就安静退场，提醒卡仍然在。
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
		 * 每一步都容忍失败：通知发不出去时弹窗与提示音照旧。
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
						const notification = new window.Notification(title, { body, tag: NOTIFICATION_TAG });
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

		/** 提醒卡左上角的对勾图标。 */
		function CheckGlyph() {
			return React.createElement(
				'svg',
				{ width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
				React.createElement('path', {
					fill: 'currentColor',
					d: 'M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5Zm2.72 4.98-3.4 4.36a.8.8 0 0 1-1.2.06L4.6 9.4a.8.8 0 1 1 1.14-1.12l.74.75 2.83-3.62a.8.8 0 1 1 1.21 1.07Z',
				}),
			);
		}

		/**
		 * 右下角提醒浮层：常驻 shell.overlay 的条目。
		 * 没有待提醒时渲染 null，但每次渲染都会把主区状态报给 apply 侧，
		 * 任务完成回调据此判断「用户此刻是否在对话窗口」。
		 * @param props.useToasts - 提醒卡列表的 selector hook（inject face）。
		 * @param props.useWidth - 卡宽（px）的 selector hook。
		 * @param props.useHeight - 卡高（px，0=自动）的 selector hook。
		 * @param props.dismiss - 收起一张卡。
		 * @param props.openSession - 跳到卡片对应的会话。
		 * @param props.usePanelInfo - 标准钩子：主区面板信息（布局包提供）。
		 * @param props.t - 本地化函数。
		 * @returns 浮层元素或 null。
		 */
		function ReminderOverlay({ useToasts, useWidth, useHeight, dismiss, openSession, usePanelInfo, t }) {
			const panelId = typeof usePanelInfo === 'function'
				? usePanelInfo((info) => info.activePanelId)
				: undefined;
			view.activePanelId = panelId ?? null;
			view.panelHook = typeof usePanelInfo === 'function';
			if (!view.panelHook && !warnedNoPanelHook) {
				warnedNoPanelHook = true;
				console.warn('dsh-task-reminder: shell.overlay 条目没有拿到 usePanelInfo，无法判断是否在对话窗口，提醒将按“非对话窗口”处理');
			}
			const toasts = useToasts((list) => list);
			const width = typeof useWidth === 'function' ? useWidth((value) => value) : DEFAULTS.width;
			const height = typeof useHeight === 'function' ? useHeight((value) => value) : DEFAULTS.height;
			if (toasts.length === 0) return null;
			// 卡宽写进内联样式（默认值与 CSS 的 min(420px, …) 一致）；
			// max-width 保留视口夹取，窄窗口下不会顶出屏幕。
			const cardStyle = { width: width + 'px', maxWidth: 'calc(100vw - 16px)' };
			if (height > 0) cardStyle.height = height + 'px';
			return React.createElement(
				'div',
				{ className: CSS.stack, role: 'status', 'aria-live': 'polite' },
				toasts.map((toast) => React.createElement(
					'div',
					{ key: toast.id, className: CSS.toast, style: cardStyle },
					React.createElement('span', { className: CSS.glyph, 'aria-hidden': true }, React.createElement(CheckGlyph)),
					React.createElement(
						'div',
						{ className: CSS.body },
						React.createElement('div', { className: CSS.title }, t('toast.title')),
						React.createElement('div', { className: CSS.desc, title: toast.title }, toast.title),
					),
					React.createElement(
						'button',
						{ type: 'button', className: CSS.action, onClick: () => openSession(toast.sessionId) },
						t('toast.open'),
					),
					React.createElement(
						'button',
						{
							type: 'button',
							className: CSS.close,
							'aria-label': t('toast.close'),
							onClick: () => dismiss(toast.id)
						},
						'×',
					),
				)),
			);
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

		/** 数字步进器（− 值 +）；`stepSize` 给宽高这类成十进位的量用。 */
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

		/** 音效选择：四选一分段控件。 */
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
		 * 设置页里的提醒卡预览：按当前宽高实时画一张样例卡（复用真实卡片的
		 * 类名与内联样式写法，所见即所得）；按钮只作样子，不接线、不进 Tab 序。
		 * @param props.width - 当前卡宽（px）。
		 * @param props.height - 当前卡高（px，0=自动）。
		 * @param props.t - 本地化函数。
		 * @returns 预览元素。
		 */
		function CardPreview({ width, height, t }) {
			const cardStyle = { width: width + 'px', maxWidth: '100%' };
			if (height > 0) cardStyle.height = height + 'px';
			return React.createElement('div', {
				style: {
					padding: '16px',
					borderRadius: '10px',
					background: 'var(--dsw-alias-bg-layer-1)',
				},
			}, React.createElement('div', { className: CSS.toast, style: cardStyle }, [
				React.createElement('span', { className: CSS.glyph, 'aria-hidden': true, key: 'glyph' }, React.createElement(CheckGlyph)),
				React.createElement('div', { className: CSS.body, key: 'body' }, [
					React.createElement('div', { className: CSS.title, key: 'title' }, t('toast.title')),
					React.createElement('div', { className: CSS.desc, key: 'desc', title: t('preview.sampleSession') }, t('preview.sampleSession')),
				]),
				React.createElement('button', { type: 'button', className: CSS.action, key: 'open', tabIndex: -1 }, t('toast.open')),
				React.createElement('button', { type: 'button', className: CSS.close, key: 'close', 'aria-label': t('toast.close'), tabIndex: -1 }, '×'),
			]));
		}

		/**
		 * 「任务提醒」设置页：系统通知与提示音开关、音效与音量、卡片宽高、恢复默认。
		 * 切换音效即时发声（按当前音量），不需要另点「试听」。
		 * @param props.notifyStore - 系统通知开关 store。
		 * @param props.soundStore - 提示音开关 store。
		 * @param props.soundChoiceStore - 音效下标 store。
		 * @param props.volumeStore - 音量 store。
		 * @param props.widthStore - 卡宽 store。
		 * @param props.heightStore - 卡高 store。
		 * @param props.permissionStore - 通知权限状态 store（界面提示用）。
		 * @param props.setNotify - 写回系统通知开关（含权限申请）。
		 * @param props.setSound - 写回提示音开关。
		 * @param props.setSoundChoice - 写回音效下标（切换即发声）。
		 * @param props.setVolume - 写回音量。
		 * @param props.setWidth - 写回卡宽。
		 * @param props.setHeight - 写回卡高。
		 * @param props.reset - 恢复默认。
		 * @param props.notifySupported - 浏览器是否支持系统通知。
		 * @param props.t - 本地化函数。
		 * @returns 设置页元素。
		 */
		function ReminderSection(props) {
			const notify = React.useSyncExternalStore(props.notifyStore.subscribe, props.notifyStore.getSnapshot);
			const sound = React.useSyncExternalStore(props.soundStore.subscribe, props.soundStore.getSnapshot);
			const soundChoice = React.useSyncExternalStore(props.soundChoiceStore.subscribe, props.soundChoiceStore.getSnapshot);
			const volume = React.useSyncExternalStore(props.volumeStore.subscribe, props.volumeStore.getSnapshot);
			const width = React.useSyncExternalStore(props.widthStore.subscribe, props.widthStore.getSnapshot);
			const height = React.useSyncExternalStore(props.heightStore.subscribe, props.heightStore.getSnapshot);
			const permission = React.useSyncExternalStore(props.permissionStore.subscribe, props.permissionStore.getSnapshot);
			const t = props.t;
			const isDefault = notify === DEFAULTS.notify
				&& sound === DEFAULTS.sound
				&& soundChoice === DEFAULTS.soundChoice
				&& volume === DEFAULTS.volume
				&& width === DEFAULTS.width
				&& height === DEFAULTS.height;
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
				switchRow('sound', 'settings.sound.title', 'settings.sound.description', sound, props.setSound),
				React.createElement(SettingRow, {
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
				}),
				React.createElement(SettingRow, {
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
				}),
				React.createElement(SettingRow, {
					key: 'width',
					rowKey: 'width',
					title: t('width.title'),
					desc: t('width.description', { value: width }),
					control: React.createElement(Stepper, {
						value: width,
						min: WIDTH_MIN,
						max: WIDTH_MAX,
						stepSize: WIDTH_STEP,
						label: t('width.title'),
						onChange: (next) => props.setWidth(next),
						t,
					}),
				}),
				React.createElement(SettingRow, {
					key: 'height',
					rowKey: 'height',
					title: t('height.title'),
					desc: t('height.description', { value: height }),
					control: React.createElement(Stepper, {
						value: height,
						min: HEIGHT_MIN,
						max: HEIGHT_MAX,
						stepSize: HEIGHT_STEP,
						label: t('height.title'),
						onChange: (next) => props.setHeight(next),
						t,
					}),
				}),
				React.createElement('div', {
					key: 'preview',
					style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px 0 4px' },
				}, [
					React.createElement('div', { key: 'title', style: ROW_TITLE_STYLE }, t('preview.title')),
					React.createElement(CardPreview, { key: 'body', width, height, t }),
					React.createElement('div', { key: 'desc', style: ROW_DESC_STYLE }, t('preview.description')),
				]),
				React.createElement(SettingRow, {
					key: 'reset',
					rowKey: 'reset',
					title: t('reset.title'),
					desc: isDefault ? t('reset.descriptionDefault') : t('reset.description'),
					control: React.createElement(TextButton, {
						disabled: isDefault,
						label: t('reset'),
						onClick: () => props.reset(),
					}),
				}),
			];
			// 通知权限提示：不支持 / 被拒绝 / 等待用户在选择框里点「允许」。
			let notifyHint = null;
			let showPermissionButton = false;
			if (props.notifySupported !== true) notifyHint = t('notify.unsupported');
			else if (permission === 'denied') notifyHint = t('notify.denied');
			else if (permission === 'default' && notify === true) {
				// 通知默认开着，但浏览器权限还没问过：给一个一键申请的入口。
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
		 * 挂载插件：字典、六个持久化配置、完成事件订阅、弹窗浮层、独立设置页。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-task-reminder: dictionaries');
			const t = ctx.locale.bind(NS);

			// 六个配置：值落浏览器本地持久存储，重启后仍在；不需要宿主设置命名空间。
			const notifyStore = createSnapshotStore(DEFAULTS.notify, { persist: { name: NOTIFY_PERSIST_KEY } });
			const soundStore = createSnapshotStore(DEFAULTS.sound, { persist: { name: SOUND_PERSIST_KEY } });
			const soundChoiceStore = createSnapshotStore(DEFAULTS.soundChoice, { persist: { name: SOUND_CHOICE_PERSIST_KEY } });
			const volumeStore = createSnapshotStore(DEFAULTS.volume, { persist: { name: VOLUME_PERSIST_KEY } });
			const widthStore = createSnapshotStore(DEFAULTS.width, { persist: { name: WIDTH_PERSIST_KEY } });
			const heightStore = createSnapshotStore(DEFAULTS.height, { persist: { name: HEIGHT_PERSIST_KEY } });
			// 通知权限状态只活在内存里（浏览器随时可能被用户改），供设置页提示。
			const notifier = createNotifier();
			const permissionStore = createSnapshotStore(notifier.permission());
			// 提醒卡列表只在内存里，不持久化。
			const toastStore = createSnapshotStore([]);
			// 每个会话最近一次听到的 running 状态，用来识别「running → 非 running」的边沿。
			const runningSessions = new Map();
			// 排障计数：事件/列表两条通道各收到多少、完成被哪种原因跳过。
			const stats = {
				events: 0,
				listTicks: 0,
				completed: 0,
				skippedInConversation: 0,
				soundWhileWatching: 0,
				notifications: 0,
				lastEvent: null,
				lastCompletion: null,
			};
			// toastId → 自动收起定时器的销毁函数。
			const timers = new Map();
			const chime = createChime();

			/** 写回提示音开关。 */
			const setSound = (next) => soundStore.set(next === true);
			/**
			 * 写回系统通知开关；从关到开时若权限还是 default，借这个用户手势申请。
			 * @param next - 目标值。
			 * @returns 申请权限的 Promise（无需申请时返回 undefined）。
			 */
			// 在途权限申请的序号：每次写回开关都使它失效，
			// 避免用户在申请还没回来时又拨过关，过期结果把新状态覆盖掉。
			let notifyRequestSeq = 0;
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
				return notifier.request().then((result) => {
					if (seq !== notifyRequestSeq) return; // 过期结果丢弃
					permissionStore.set(typeof result === 'string' ? result : notifier.permission());
				});
			};
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
			/** 写回卡宽（px）。 */
			const setWidth = (next) => widthStore.set(clampSize(next, WIDTH_MIN, WIDTH_MAX, DEFAULTS.width));
			/** 写回卡高（px，0=自动）。 */
			const setHeight = (next) => heightStore.set(clampSize(next, HEIGHT_MIN, HEIGHT_MAX, DEFAULTS.height));
			/** 恢复默认：六个配置全部写回出厂值，权限提示同步刷新。 */
			const resetAll = () => {
				notifyStore.set(DEFAULTS.notify);
				soundStore.set(DEFAULTS.sound);
				soundChoiceStore.set(DEFAULTS.soundChoice);
				volumeStore.set(DEFAULTS.volume);
				widthStore.set(DEFAULTS.width);
				heightStore.set(DEFAULTS.height);
				if (notifier.supported) permissionStore.set(notifier.permission());
			};

			/**
			 * 收起一张提醒卡，并取消它的自动收起定时器。
			 * @param id - 卡片 id。
			 */
			const dismiss = (id) => {
				toastStore.set(toastStore.getSnapshot().filter((toast) => toast.id !== id));
				const off = timers.get(id);
				if (off !== undefined) {
					off();
					timers.delete(id);
				}
			};

			/**
			 * 弹出一张提醒卡；超出同屏上限时先挤掉最旧的。
			 * @param sessionId - 完成任务的会话。
			 */
			const push = (sessionId) => {
				const current = toastStore.getSnapshot();
				const id = `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
				const next = [...current, { id, sessionId, title: titleOf(ctx, sessionId) }].slice(-MAX_TOASTS);
				for (const dropped of current) {
					if (!next.includes(dropped)) dismiss(dropped.id);
				}
				toastStore.set(next);
				timers.set(id, ctx.timer.timeout(() => dismiss(id), TOAST_TTL_MS));
			};

			/**
			 * 点「查看」：收起该会话的提醒卡，并回到那个会话。
			 * @param sessionId - 会话 id。
			 */
			const openSession = (sessionId) => {
				for (const toast of toastStore.getSnapshot()) {
					if (toast.sessionId === sessionId) dismiss(toast.id);
				}
				ctx.uiWorkspace.openSession(sessionId);
			};

			/**
			 * 发一条系统通知：点击时窗口回前台并打开对应会话。
			 * @param sessionId - 完成任务的会话。
			 * @param title - 通知正文（会话名）。
			 */
			const notify = (sessionId, title) => {
				const notification = notifier.show(t('toast.title'), title, () => openSession(sessionId));
				if (notification !== null) stats.notifications += 1;
			};

			/**
			 * 记录一次 running 观测，判断「是不是刚跑完」。
			 * 两条检测通道（转发事件 + 官方会话列表）共用这张表：谁先看到边沿谁触发，
			 * 后到的那方看到的已是非边沿，天然去重。
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
			 * 一轮对话任务结束：提示音不管人在不在都响；卡片与系统通知只在
			 * 用户不在对话窗口时出场。
			 * @param sessionId - 完成任务的会话。
			 * @param source - 触发来源（event / list），仅用于排障。
			 */
			const complete = (sessionId, source) => {
				stats.completed += 1;
				stats.lastCompletion = { sessionId, source, at: Date.now() };
				// 只有「主区停在对话窗口、标签页可见、窗口有焦点」三者同时成立，
				// 才算用户真的在看着这场对话 —— 其余一切（切到其它面板、切走标签页、
				// 窗口失焦人在别的应用里）都算非对话窗口，该提醒。
				const watching = view.panelHook && view.activePanelId === null && view.away !== true;
				// 提示音是「任务完成了」这个信号本身：不管人在不在对话窗口都响。
				if (soundStore.getSnapshot() === true) {
					chime.play(soundChoiceStore.getSnapshot(), volumeStore.getSnapshot());
					if (watching) stats.soundWhileWatching += 1;
				}
				if (watching) {
					// 正在看对话时卡片与通知保持安静，只留提示音。
					stats.skippedInConversation += 1;
					return;
				}
				// 通知要以「真的发得出去」为准：开了开关但权限没给，不算一条通道。
				const notifyGranted = notifier.supported && notifier.permission() === 'granted';
				const notifyWanted = notifyStore.getSnapshot() === true && notifyGranted;
				// 提醒卡是兜底通道：系统通知能发出去时不弹卡，一次完成只出一种提醒。
				if (!notifyWanted) push(sessionId);
				if (notifyWanted) notify(sessionId, titleOf(ctx, sessionId));
			};

			// 用启动时的会话列表给 running 状态做种：页面加载前就在跑的任务，
			// 它的完成不会被误判成「新完成」而补弹一次。
			const seeded = ctx.sessions.list.getSnapshot();
			for (const id of seeded.ids ?? []) {
				const row = seeded.byId?.[id];
				if (row !== undefined && row !== null) runningSessions.set(id, row.running === true);
			}

			// 通道一：宿主转发事件 api-session/status(sessionId, running) —— running
			// 掉回非 running 就是一轮对话任务结束。
			ctx.effect(() => ctx.remote.$on('api-session/status', (sessionId, running) => {
				stats.events += 1;
				stats.lastEvent = { sessionId, running: running === true, at: Date.now(), source: 'event' };
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
			// 标签页可见性与窗口焦点：被切走 / 失焦时 view.away = true。
			ctx.effect(() => {
				const sync = () => {
					if (typeof document === 'undefined') return;
					const hidden = document.hidden === true;
					const unfocused = typeof document.hasFocus === 'function' && document.hasFocus() === false;
					view.away = hidden || unfocused;
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
			ctx.effect(() => mountStyles(), 'dsh-task-reminder: styles');
			ctx.effect(() => () => {
				for (const off of timers.values()) off();
				timers.clear();
				chime.dispose();
			}, 'dsh-task-reminder: timers');

			// 右下角弹窗：框架级浮层，不占用任何栏内空间。
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'task-reminder',
				order: 50,
				locale: NS,
				inject: () => ({
					hooks: { toasts: toastStore, width: widthStore, height: heightStore },
					dismiss,
					openSession,
				}),
			}, ReminderOverlay));

			// 独立设置页：设置面板左侧导航里的「任务提醒」（order 避开 chat-locator 41）。
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'task-reminder',
				order: 44,
				label: () => t('nav'),
				locale: NS,
				inject: () => ({
					notifyStore,
					soundStore,
					soundChoiceStore,
					volumeStore,
					widthStore,
					heightStore,
					permissionStore,
					setNotify,
					setSound,
					setSoundChoice,
					setVolume,
					setWidth,
					setHeight,
					reset: resetAll,
					notifySupported: notifier.supported,
					t,
				}),
			}, ReminderSection));

			// 排障钩子：浏览器控制台执行 __dshTaskReminder.state() 可看面板状态、
			// 六个配置、当前卡片与各会话 running 记录。
			const debug = {
				version: PLUGIN_VERSION,
				state: () => ({
					panelHook: view.panelHook,
					activePanelId: view.activePanelId,
					away: view.away,
					inConversationWindow: view.panelHook ? view.activePanelId === null : null,
					notify: notifyStore.getSnapshot(),
					sound: soundStore.getSnapshot(),
					soundChoice: soundChoiceStore.getSnapshot(),
					volume: volumeStore.getSnapshot(),
					width: widthStore.getSnapshot(),
					height: heightStore.getSnapshot(),
					notificationPermission: permissionStore.getSnapshot(),
					notificationSupported: notifier.supported,
					toasts: toastStore.getSnapshot(),
					running: [...runningSessions.entries()],
					stats: { ...stats },
				}),
			};
			/**
			 * 当场试一次：弹一张卡（取列表里第一个会话的名），并按开关放提示音。
			 * 不经过完成判定与面板判定，专供验证弹窗与提示音是否工作。
			 * @param sessionId - 可选，指定用哪个会话的名字。
			 */
			debug.test = (sessionId) => {
				const id = sessionId ?? ctx.sessions.list.getSnapshot().ids?.[0] ?? 'test';
				push(id);
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
			inject: ['slots', 'locale', 'sessions', 'remote', 'uiWorkspace', 'timer'],
			apply,
			// 纯函数与常量出口：Node 自检直接校验，不参与运行时行为。
			diagnostics: {
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
			},
		};
	},
});
