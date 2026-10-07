/**
 * dsh-task-reminder —— 浏览器半侧（DSH Web 与 DSH 桌面端的渲染进程）。
 *
 * 目标：对话任务（Agent 回合）停止时发送 Windows 系统弹窗，并播放提示音 ——
 *   1. 系统弹窗走 Web Notification API（操作系统右下角原生通知，浏览器退到
 *      后台也看得到；点击回到该会话，并落到你这次提问的位置 —— 人读消息是自上
 *      而下的，落到最底部等于从答案的尾巴看起）。三种停止原因都提醒：任务完成、
 *      Agent 抛出问题等你回答（ask_user_question 挂起）、出错停止（如 400
 *      的红色错误）；同一次停止的错误与完成只报一次；
 *   2. 播放一声提示音（三种停止都响，不管在不在对话窗口；四种合成音效
 *      + 一档「自定义」（上传本机音频文件）可选，音量可调；切换音效即时发声
 *      试听）。
 * 弹窗时机二选一：「任何情况都弹」任务一停止就弹；「仅非前台窗口」在切走
 * 标签页或浏览器窗口失焦（人在别的应用）时才弹。没有应用内卡片：弹窗是唯一
 * 视觉通道。提醒方式、音效、音量全部在「设置 → 任务提醒」独立页里配置，值落
 * 浏览器本地存储，重启后仍在；「恢复默认」一键写回出厂值。
 *
 * **子智能体会话默认不提醒**：Agent Teams 的 lead 派出的子代理、以及任何非 lead
 * 智能体自己起的子代理，它们的停止都会以独立的 sessionId 出现在三条检测通道和
 * `api-session/error` 里；那些停止既不代表用户手上的对话跑完，一个回合里还可能
 * 连响好几次，因此默认挡掉。要连子智能体一起提醒，在设置页把「子智能体提醒」
 * 打开即可（值同样落本地存储，恢复默认会关回去）。
 *
 * 十一条实现要点：
 *
 * 1. 「任务完成」的信号有三条通道，共用一张 running 边沿表，天然去重：
 *    通道一：宿主转发事件 `api-session/status`（`API_REMOTE_FORWARDED_EVENTS`
 *    白名单内），浏览器侧 `ctx.remote.$on(name, listener)` 订阅；
 *    通道二：官方会话列表自身的 running 位（`ctx.sessions.list`）；
 *    通道三：`ctx.uiSession.sessionStatus` 快照里每个会话的 running 位（与
 *    sidebar 运行指示灯同源；fork 出来的子会话列表投影不可靠——陈旧 /
 *    不翻，这条路是最可靠的一路）。转发事件万一没递到本插件，另外两条
 *    路仍能收到完成。三条通道都先过子智能体闸（默认关，见要点 9）。
 * 2. 「等你回答」读 `ctx.uiSession.sessionStatus`（根级只读快照：
 *    sessionId → { running, pendingInteraction, completionUnread }）：
 *    pendingInteraction 从无到有就是 Agent 阻塞在等用户（ask_user_question /
 *    plan-review）。同一个快照的 running 位同时是完成检测的第三通道
 *    （见要点 1）。只读订阅，绝不参与 user-questions/request 应答链。
 *    提醒发出去的通知记在 waitingToasts，挂起消散（已回答 / 交互关闭 / 会话
 *    消失）即收掉 —— 通知中心不留「点了再也没有对应等待」的陈旧条目；点通知
 *    抬窗的每个去路（no-desktop / no-fetch / sent / answered / failed / error，
 *    带 `focused`）记在 stats.lastActivation，复现「点了没抬窗」时读它就知道
 *    断在哪一步；点通知**一律**发请求，不按页面自述的焦点状态跳过（见要点 5）。
 *    留痕还压在**页面级**表上（`window.__dshTaskReminderClickRouter` 的
 *    activationDiag / clickDiag）：插件热重载会把模块作用域换成新实例，只放在
 *    实例里的话现场证据会被清零；`report()` 因此还给出 instanceStartedAt /
 *    clickAgeMs / clickBeforeThisInstance，避免拿旧记录解释「刚才那次」。
 * 3. 「出错停止」接宿主转发事件 `api-session/error`(sessionId, message)。
 *    一次停止只报一次、报对一次：停止边沿（running→非 running）到达时读
 *    会话持久日志最后一条 `turn/end` 的 reason 分类——completed /
 *    max-tokens 报完成，error 报错误（正文取 reason.error.message，即
 *    网关原文）且不出现完成弹窗，aborted / blocked / interrupted 不报
 *    （取消、询问已报、崩溃孤儿回合）。读的同时取最后一条 `turn/start`：
 *    最新回合还没闭合（start 比 end 新）说明手里是上一个回合的 turn/end，
 *    当次读不到、重试等它落盘——否则点停止会误报「完成」。分类读不到才
 *    退回完成弹窗，此时 5 秒内后到的 api-session/error 撤回完成弹窗只留
 *    错误（错误优先，不重复响音）。
 *    「同一次停止」的判据是**回合号**（1.5.4）：分类把 turn/end 的
 *    `data.turn` 一并带出，与每个会话记下的「最近一次结清的回合号」相等
 *    就丢掉——确定性去重，不再看 5 秒窗口。5 秒窗口只留给「错误优先」
 *    两个方向（error→completion 不报、completion→error 撤回）和读不到
 *    回合号时的兜底：api-session/error 事件本身不带回合号，只能靠时间窗
 *    加语义。同一次停止的重复边沿（分类在途时列表陈旧回放）由在途守卫与
 *    回合号判据双兜底，只报一次；新回合在上一轮停止 5 秒内完成照报
 *    （桌面端通道一稀疏、上一轮的完成票据没人清，用 5 秒窗口会把新回合
 *    整条吞掉——1.5.4 修的就是这个）。兜底报的停止没有回合号可记，它的
 *    重复边沿仍只能靠这 5 秒窗口：这是有意保守的一侧——宁可漏掉「兜底
 *    报告之后 5 秒内的新回合」，也不为它冒重复弹窗的风险。
 *    询问（pendingInteraction 出现边沿）按挂起类型弹通知：审批请求 / 提问 /
 *    方案待确认各有标题，认不出类型时退回「等待你的回答」；审批的通知上还带
 *    「同意 / 拒绝」两个按钮（要点 11）。正文按类型取：提问 / 方案待确认取
 *    首个问题原文；审批交互不带 questions 列表，取 toolName + 理由
 *    （displayReason 按通知语言解析，退回 reason，工具与理由都空才退回会话名，
 *    见 approvalBodyText）—— 通知上带着「同意 / 拒绝」，正文就必须说清要
 *    批准什么。回答后
 *    紧随的那次完成不报（一次交互一次提醒）——但这个豁免有 45 秒窗口，
 *    且会话再次跑起来（任一通道的 running 位转 true）立刻作废：回答之后
 *    Agent 又接着干活的那些回合，结束照常提醒（否则一次提问会把整轮完成
 *    静音 —— 1.5.2 修的就是这个）。
 * 4. 「窗口是否在前台」只看两个信号：标签页可见（document.hidden === false）
 *    且窗口有焦点（document.hasFocus()）。切走标签页、窗口失焦（人在别的
 *    应用里）都算非前台；拿不到这两个信号时按「在前台」处理（宁可少弹，
 *    也不在用户盯着看的时候乱弹 —— 除非用户选「任何情况都弹」）。
 * 5. 系统弹窗走标准 Web Notification API（普通浏览器与桌面壳都支持）：
 *    默认开启；权限还是 default 时首次装载替用户申请一次（localStorage
 *    记账只问一次），设置页另有「申请通知权限」按钮；被拒绝 / 不支持时在
 *    设置页给出对应提示，不假装生效。权限按 Origin 生效，授权一次本站点
 *    全部通用。通知 tag 回到「每条独立」（1.5.5 的行为）：后一条不顶掉前一条 ——
 *    「按类型固定 tag + renotify」那版在 Windows 上会把上一条横幅替换掉，而被替换
 *    的那条在系统通知中心里点不动（Electron 在 Windows 上「通知中心里的条目」不投递
 *    click，electron#29461），现场表现就是「点了通知窗口抬不起来」。`silent: true`
 *    关掉浏览器自带的提示音，声音只由插件自己那套负责（设置页的提示音开关说了算）。
 *    点击弹窗：打开对应会话 + 关闭弹窗；
 *    拉回前台分两路 —— 普通浏览器 `window.focus()` 就够，桌面壳（DSH Desktop）
 *    的渲染进程拉不起最小化 / 托盘窗口，改由 `requestDesktopActivation()`
 *    请宿主半侧跑一次 `dsh://open`（宿主实现与理由见 index.js）。桌面壳里
 *    **每次点击都发这一次请求**：不按 `document.hasFocus()` 跳过（Electron
 *    里被挡住 / 最小化时它也会报 true，跳过就等于永远唤不起，见
 *    requestDesktopActivation 的说明）。
 * 6. 提示音用 Web Audio 现场合成，插件包里不装任何音频文件：四种合成音效
 *    （两声 / 三声上扬 / 上升琶音 / 圆润三角波）各有频率与节奏表，峰值按
 *    100% 音量给出，再乘上「用户音量 + 20」折算出的 master 增益后写进包络
 *    —— 整档比刻度上调 20，显示 80 就是原 100 的响度。第五档是「自定义」：
 *    用户在本机选一个音频文件，字节存进浏览器 IndexedDB（不是 localStorage，
 *    那里 5MB 同步写配额装不下音频），装载 / 换文件时 decodeAudioData 解码成
 *    AudioBuffer，播放走同一个 master 增益，首尾各加 10ms 淡入淡出防爆音。
 *    音频只在本机、不上传也不进包；IndexedDB / 解码 / 文件任一环节不可用时
 *    安静回落到第一种合成音效，提醒不会变哑。AudioContext 装载即建、第一次
 *    用户手势 resume（首声延迟只剩浏览器设备启动那一截，任何网页都躲不掉）；
 *    被自动播放策略挂在 suspended 时拒绝不外抛。
 * 7. 设置是「设置」面板里的独立页（「设置 → 通用」里不再占行）：
 *    `ctx.slots.inject('settings.section', …)`（参考 dsh-chat-locator 的
 *    LocatorSection），order 避开 chat-locator(41)；页面自行渲染全部控件
 *    与恢复默认。值用 `createSnapshotStore(value, { persist: { name } })`
 *    落浏览器本地存储，因此不需要宿主半侧注册设置命名空间。
 * 8. 「点弹窗回到你的提问位置」：DSH 打开会话时会恢复上次的阅读位置，所以点弹窗
 *    常常停在历史中间或最底部 —— 而人读消息是自上而下的，落点该是这次提问。
 *    DSH 没对外暴露滚动接口 —— `openSession(target)` 不收参数，`ctx.uiConversation`
 *    只有 binding / events / groups / imageUrl / inspectRequestPrompt /
 *    inspectSystemPrompt / views，聊天视图自己的滚动（`ChatViewport` /
 *    `useChatScroll`）不在包导出里，第三方插件够不着。于是这里退一步，在打开会话
 *    后自己把最后一条「你的消息」对齐到视口顶部：
 *      · 会话流容器：列，属性 `data-chat-flow` —— **DOM 里同时挂着好几个列**
 *        （实测桌面端 3 个、网页端 30 个：会话壳为多个会话/分区保留已挂载视图），
 *        所以按「挂载会话号等于目标的那一列」来挑（`pickConversationColumn`），
 *        挑不到才退回第一个可见列。盲取第一个会对着别的会话滚一遍：留痕写着
 *        aligned，而用户眼前一动没动；
 *      · 滚动容器：列最近的 `[data-conversation-scroll]`（共享会话壳的滚动口），
 *        没有这层时退回列的父节点（聊天自己的 `_scroll`，自身 overflow-y:auto）
 *        —— 与应用 `list.closest("[data-conversation-scroll]") ?? list` 同一套选择；
 *      · 你的消息行：`[data-chat-flow-kind="user"]` / `="steering"`
 *        （`turn-trigger` 是系统唤醒排队输入时补的说明行，不算提问）。
 *    对齐偏移 24px 与应用自己的「跳到第 N 轮」一致，也是「落到你提问的位置」的
 *    同一落点。历史挂上来要几拍、应用的 `reading.restore()` 也可能晚于第一拍
 *    落地，所以按固定节奏轮询重试，连续两拍都在容差内才收工；向下/向上已经滚不
 *    动（到顶、到底）也算就位，否则每拍再加一点像素会把视口慢慢推走。
 *    属性名与结构都属 DSH 内部实现，认不出来只影响这一步，不影响「打开会话」；
 *    另外核对挂载点上的 `data-conversation-session` 是不是刚打开的那个会话
 *    （切会话要一拍才落地，免得把上一次的视图对了一遍就收工），核对不上就继续
 *    重试，到上限记 'other-session'。每次的结果记在
 *    `state().stats.lastQuestionJump`（aligned / no-column / other-session /
 *    no-question / no-scroller / timeout）。轮询定时器挂 ctx.timer，卸载即取消。
 * 9. 所有资源（字典、$on 订阅、sessionStatus 订阅、定时器、排障钩子）都挂
 *    ctx.effect，插件卸载时整体回收。
 * 10. 子智能体过滤只认列表行上的 `origin === 'subagent'`（官方侧边栏判定子会话
 *    可见性用的就是这一个字段）：fork 出来的会话带 `parentId` 但 origin 不是
 *    'subagent'，照旧提醒。行还没进列表时读不到 origin，按「不是子智能体」
 *    处理 —— 宁可多提醒一条，也不把用户的真实回合静音。子智能体与父会话各自
 *    独立：挡下子智能体的停止不会让父会话那次完成静音。
 * 11. 审批通知上的「同意 / 拒绝」按钮：带按钮的系统通知只能由 Service Worker
 *    弹（`new Notification(..., { actions })` 直接抛 TypeError），所以这份
 *    bundle 同时被注册成自己的 Service Worker —— 文件顶部那层双上下文外壳
 *    就是这个（worker 里没有 window，先判上下文再碰 window）。worker 只干
 *    一件事：把「点了哪个按钮 / 点了正文」转回页面，正文点击顺带抬一个窗口
 *    （只有 notificationclick 带用户手势，页面事后 focus 可能抢不到前台）。
 *    真正的裁决发生在页面里：按通知带的 key 从 `sessionStatus` 快照重新解析
 *    活的审批对象，调它自己的 `answer('allowed-once' | 'rejected')`（＝审批
 *    卡片的「允许一次 / 拒绝」），一次点击只认领一条。任何一个环节不可用
 *    （不安全上下文、桌面壳 `dsh-app://` 注册不了 worker、拿不到 bundle URL）
 *    都退回普通通知并在设置页如实说明：不假装有按钮。注意作用域：所有客户端
 *    bundle 都在 `/plugins/` 路由下，worker 作用域是共享的 `/plugins/` —— 同一个
 *    Origin 只能有一个，同类插件（如 dsh-notify-me）同时装着会互相顶替。
 *
 * @module dsh-task-reminder/client
 */
// ───────────────────────── 双上下文外壳（要点 11） ─────────────────────────
// 同一份字节跑在两种上下文里：作为页面插件（下面整个工厂）和作为 Service
// Worker（只装一个点击转信器，给审批通知上的「同意 / 拒绝」按钮用）。worker
// 里没有 window，所以外壳先判上下文、再碰 window —— 顺序不能反。
// 所有常量与辅助函数都待在这层外壳里（不放脚本顶层）：顶层 `const` 会进全局
// 词法环境，插件被重新求值（HMR / 再次装载）时会直接抛「已声明」而整个失效。
// 工厂体保持原有缩进（外壳只加一层），免得为了美观把两千多行全部重排。
(function (root) {

/** 包名：启动图（__DSH_BOOT__.entries）里认自己那一行的 id，也是模块 id。 */
const PLUGIN_PACKAGE_NAME = '@hawkongz/dsh-task-reminder';
/** worker ↔ 页面的一次点击转信：频道名、来源标记、消息类型。 */
const BRIDGE_CHANNEL = 'dsh-task-reminder:bridge';
const BRIDGE_SOURCE = 'dsh-task-reminder';
const BRIDGE_MESSAGE_TYPE = 'notification';
/** 审批裁决的两个结果（与审批卡片自己调 answer 的取值一致）。 */
const APPROVAL_GRANT = 'allowed-once';
const APPROVAL_REJECT = 'rejected';
/** 排障用的测试审批 key：点了只反馈，不裁决任何真实请求。 */
const TEST_APPROVAL_KEY = 'test:approval';

/**
 * 这个上下文是不是 Service Worker：worker 全局有 registration、有
 * addEventListener，但没有 document。页面永远不满足，Node 自检桩也不满足
 * （桩上没有 registration）。
 * @param scope - 外壳拿到的根对象。
 * @returns 是 worker 上下文时为 true。
 */
function isServiceWorkerScope(scope) {
	return scope !== undefined && scope !== null
		&& typeof scope.registration === 'object' && scope.registration !== null
		&& typeof scope.addEventListener === 'function'
		&& typeof scope.document === 'undefined';
}

/**
 * 从启动图里挑出自己那一行 bundle URL。DOM 同源，因此这就是注册 Service
 * Worker 用的脚本 URL（老宿主没有启动图 / 桌面壳里拿不到时为 null，
 * 快捷裁决随即可用地退回普通通知）。
 * @param entries - `window.__DSH_BOOT__.entries`。
 * @returns bundle URL，或 null。
 */
function findSelfBundleUrl(entries) {
	if (!Array.isArray(entries)) return null;
	for (const entry of entries) {
		if (entry === null || entry === undefined) continue;
		const id = typeof entry.id === 'string' ? entry.id : '';
		const mine = id === PLUGIN_PACKAGE_NAME || id === 'dsh-task-reminder' || id.endsWith('/dsh-task-reminder');
		if (mine && typeof entry.url === 'string' && entry.url !== '') return entry.url;
	}
	return null;
}

/** 页面级的「点通知正文 → 打开会话」转发表挂在 window 上的键名。 */
const CLICK_ROUTER_KEY = '__dshTaskReminderClickRouter';

/**
 * 拿本页的点击转发表（没有就建一个）。
 *
 * 为什么需要它：**通知对象比插件实例活得久**。插件热重载 / 升级之后，系统通知
 * 中心里旧条目还在，点它的回调却是旧实例的闭包 —— 闭包里的 ctx 已经 dispose，
 * `openSession` 抛错被吞掉，表现就是「点了弹窗不跳会话」（而抬窗那条走的是
 * window.fetch，照样生效，于是症状只剩会话不切）。通知回调改成查这张表，表永远
 * 指向**当前**实例，旧条目也能跳。
 * @param root - 页面全局（默认 window；自检可注入桩）。
 * @returns 转发表；拿不到全局时返回 null。
 */
function clickRouterOf(root) {
	try {
		const owner = root ?? window;
		if (owner === null || owner === undefined) return null;
		if (owner[CLICK_ROUTER_KEY] === undefined) owner[CLICK_ROUTER_KEY] = { handler: null };
		return owner[CLICK_ROUTER_KEY];
	} catch {
		return null;
	}
}

/** 页面级的「保活通知」表挂在 window 上的键名。 */
const TOAST_REGISTRY_KEY = '__dshTaskReminderToasts';

/**
 * 从「实例内那份留痕」与「页面级那份留痕」里挑更新的一个。
 *
 * 存在的理由：插件热重载会把模块作用域整份换掉（`stats` 归零），而现场证据
 * （点了什么、跳到哪、对齐结果）恰恰最怕被清掉 —— 这次排查就踩到了「刚补完
 * 留痕、热重载一刷、证据变 null」。页面级那份压在 window 上，跨实例存活；
 * 取 `at` 更新的那个，既不丢历史，也不会拿旧记录冒充刚才那次。
 * @param instance - 当前实例里的留痕（可能为 null）。
 * @param shared - 页面级留痕（可能为 null）。
 * @returns 两者中 `at` 更新的那个；都为空时返回 null。
 */
function newerRecord(instance, shared) {
	if (instance === null || instance === undefined) return shared ?? null;
	if (shared === null || shared === undefined) return instance;
	return (shared.at ?? 0) > (instance.at ?? 0) ? shared : instance;
}

/**
 * 拿本页的通知保活表（没有就建一个）。
 *
 * 为什么必须保活、而且要挂在页面级：
 * 1. 非持久通知的 JS 对象一旦被回收，**点击就再也到不了 onclick**（Chromium
 *    行为，别处同类项目也是靠"留住对象"修的：hermes-agent 的
 *    fix(desktop): retain shown notifications so clicks reach their handlers）；
 * 2. 插件热重载会把旧模块作用域变成孤儿 —— 旧通知的 onclick 闭包跟着一起被
 *    回收，表现是「点了弹窗完全没反应」，连抬窗那一步都不会发生。
 * 挂在 window 上就能跨实例按住；点击 / 关闭 / 卸载时按类型释放。
 * @param root - 页面全局（默认 window；自检可注入桩）。
 * @returns 保活表；拿不到全局时返回 null。
 */
function toastRegistryOf(root) {
	try {
		const owner = root ?? window;
		if (owner === null || owner === undefined) return null;
		if (owner[TOAST_REGISTRY_KEY] === undefined) owner[TOAST_REGISTRY_KEY] = new Map();
		return owner[TOAST_REGISTRY_KEY];
	} catch {
		return null;
	}
}

/**
 * Service Worker 半侧：只转信，不做任何裁决。「点了哪个按钮」「正文被点了」
 * 都回报给页面（握有 pendingInteraction 的地方）；正文点击还要由这里抬窗 ——
 * 只有 notificationclick 带用户手势，页面事后调 window.focus() 可能在
 * Windows 的前台抢占里输掉。
 * @param scope - worker 全局（self）。
 */
function installNotificationClickRelay(scope) {
	/**
	 * 把一条消息转给所有同源页面：BroadcastChannel（同源页面通用）与逐窗口
	 * postMessage 两路并发，不保证顺序、两边都必须幂等。
	 * @param message - 要转的消息。
	 */
	const relay = (message) => {
		try {
			if (typeof scope.BroadcastChannel === 'function') {
				const channel = new scope.BroadcastChannel(BRIDGE_CHANNEL);
				channel.postMessage(message);
				try { channel.close(); } catch {}
			}
		} catch {}
		try {
			if (scope.clients === undefined || scope.clients === null || typeof scope.clients.matchAll !== 'function') return;
			scope.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
				for (const client of list ?? []) {
					try { client.postMessage(message); } catch {}
				}
			}, () => {});
		} catch {}
	};
	/**
	 * 正文点击：挑一个窗口（优先可见的）抬到前台，并且只把「切会话」交给它，
	 * 其余窗口收到 navigate: false —— 多个 DSH 标签页不该互相抢焦点、一起切会话。
	 * @param message - 基础消息（navigate 由本函数按窗口填）。
	 * @returns 完成回调的 Promise（交给 event.waitUntil）。
	 */
	const raiseOneWindow = (message) => {
		try {
			if (scope.clients === undefined || scope.clients === null || typeof scope.clients.matchAll !== 'function') {
				relay({ ...message, navigate: true });
				return Promise.resolve();
			}
			return scope.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
				const clients = list ?? [];
				let best = null;
				for (const client of clients) {
					if (best === null) best = client;
					if (client !== null && client !== undefined && client.visibilityState === 'visible') { best = client; break; }
				}
				for (const client of clients) {
					try { client.postMessage({ ...message, navigate: client === best }); } catch {}
				}
				if (best !== null && best !== undefined && typeof best.focus === 'function') {
					try {
						const focused = best.focus();
						if (focused !== null && typeof focused === 'object' && typeof focused.then === 'function') focused.then(() => {}, () => {});
					} catch {}
				}
			}, () => { relay({ ...message, navigate: true }); });
		} catch {
			return Promise.resolve();
		}
	};
	scope.addEventListener('notificationclick', (event) => {
		try {
			const notification = event?.notification;
			const data = notification !== null && notification !== undefined && typeof notification.data === 'object' && notification.data !== null
				? notification.data
				: {};
			const action = typeof event?.action === 'string' ? event.action : '';
			try {
				if (notification !== undefined && notification !== null && typeof notification.close === 'function') notification.close();
			} catch {}
			const message = {
				source: BRIDGE_SOURCE,
				type: BRIDGE_MESSAGE_TYPE,
				action,
				key: typeof data.key === 'string' ? data.key : null,
				sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
				navigate: false,
			};
			// 按钮点击：只转信，绝不抬窗（在通知上裁决不该把窗口拽起来）。
			const job = action === ''
				? raiseOneWindow(message)
				: Promise.resolve().then(() => relay(message));
			if (typeof event.waitUntil === 'function') event.waitUntil(job);
		} catch {}
	});
}

	if (root === undefined || root === null) return;
	if (isServiceWorkerScope(root)) {
		installNotificationClickRelay(root);
		return;
	}
	if (root.__ModuleLoader__ === undefined || typeof root.__ModuleLoader__.load !== 'function') return;
	root.__ModuleLoader__.load({
	id: PLUGIN_PACKAGE_NAME,
	factory(require) {
		const React = require('react');
		const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
		const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives');

		/** 本地化命名空间（同时是设置页文案的键空间）。 */
		const NS = 'task-reminder';
		/**
		 * 版本号，随排障钩子暴露。必须与 package.json 的 version 一致：
		 * 自检里有一条断言直接比这两处，版本漂了就会红。
		 */
		const PLUGIN_VERSION = '1.6.2';

		/**
		 * 这份客户端代码的「排障代号」：改了留痕 / 跳转逻辑就 +1。
		 * 现场只跑旧 bundle 时（设置页没刷新、profile 副本没同步），`report().build`
		 * 会诚实地说明这点 —— 否则会拿旧代码的表现去判新代码的对错。
		 */
		const PLUGIN_BUILD = 'focus-question-4';

		/** 八个可配置项的本地持久化键（createSnapshotStore 的 persist.name）。 */
		const NOTIFY_PERSIST_KEY = 'dsh.task-reminder.notify';
		const NOTIFY_MODE_PERSIST_KEY = 'dsh.task-reminder.notify-mode';
		const SOUND_PERSIST_KEY = 'dsh.task-reminder.sound';
		const SOUND_CHOICE_PERSIST_KEY = 'dsh.task-reminder.sound-choice';
		const VOLUME_PERSIST_KEY = 'dsh.task-reminder.volume';
		/** 子智能体会话提醒开关的持久化键（默认关，见文件头说明）。 */
		const SUBAGENT_PERSIST_KEY = 'dsh.task-reminder.subagent';
		/**
		 * 「弹窗一直挂着」开关的持久化键（**默认关**）：打开后 5 类通知都带
		 * `requireInteraction: true` —— 横幅不自动收进系统通知中心，逼用户点横幅。
		 * 为什么值得给一个开关：横幅被点才必定送得到页面（Electron 在 Windows 上
		 * 「点通知中心里的条目」不投递 click，见 electron#29461）；代价是横幅不走，
		 * 得自己点掉，所以默认关、按需开。
		 */
		const STICKY_PERSIST_KEY = 'dsh.task-reminder.sticky';
		/**
		 * 通知语言（auto / zh / en）的持久化键。只影响**通知文案**（弹窗
		 * 标题与正文、标签页标题标记）：设置页本身永远跟随界面语言，不受它影响。
		 */
		const NOTIFY_LANGUAGE_PERSIST_KEY = 'dsh.task-reminder.notify-language';
		/** 通知语言：跟随界面 / 简体中文 / English。 */
		const NOTIFY_LANGUAGE_AUTO = 'auto';
		const NOTIFY_LANGUAGE_ZH = 'zh';
		const NOTIFY_LANGUAGE_EN = 'en';
		/**
		 * 设置页里**可选**的两档。没有「跟随界面」这一档：默认值就是 auto
		 * （跟随界面），设置页把当前生效的语言直接显示成选中的那一档 ——
		 * 用户不动它就是跟随界面，动了就是钉住。少一档、少一次决策。
		 * @type {ReadonlyArray<{ id: string, nameKey: string }>}
		 */
		const NOTIFY_LANGUAGES = Object.freeze([
			Object.freeze({ id: NOTIFY_LANGUAGE_ZH, nameKey: 'notify.language.zh' }),
			Object.freeze({ id: NOTIFY_LANGUAGE_EN, nameKey: 'notify.language.en' }),
		]);

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
			// 子智能体的停止不算「你的对话跑完了」，默认不提醒（见文件头要点 10）。
			subagent: false,
			// 弹窗一直挂着（不自动收进通知中心）：默认关，因为它会让横幅占着屏幕。
			sticky: false,
			// 通知语言：默认跟随 DSH 界面语言（设置页本身也永远跟随界面）。
			notifyLanguage: NOTIFY_LANGUAGE_AUTO,
			// 自定义音效的元数据（文件名等）；音频本体在 IndexedDB，见要点 6。
			customSound: null,
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

		/**
		 * 自定义音效（上传本机音频）的档位下标：排在四种合成音效之后，因此它是
		 * 合法下标而不是音效表条目 —— SOUND_CHOICES 仍只有四种合成波形，自定义
		 * 音频的字节既不进插件包，也不进 localStorage。
		 */
		const CUSTOM_SOUND_CHOICE = SOUND_CHOICES.length;
		/** 自定义音效元数据（文件名 / 大小 / 类型）的持久化键；音频本体在 IndexedDB。 */
		const CUSTOM_SOUND_PERSIST_KEY = 'dsh.task-reminder.custom-sound';
		/** 自定义音频的 IndexedDB 库名 / 版本 / 对象仓库名 / 固定主键。 */
		const CUSTOM_SOUND_DB_NAME = 'dsh.task-reminder';
		const CUSTOM_SOUND_DB_VERSION = 1;
		const CUSTOM_SOUND_STORE_NAME = 'sounds';
		const CUSTOM_SOUND_RECORD_KEY = 'custom';
		/** 自定义音频的字节上限：5MB 够十几秒 mp3，同时挡住误选的大文件。 */
		const CUSTOM_SOUND_MAX_BYTES = 5 * 1024 * 1024;
		/** 自定义音效各状态对应的设置页说明文案键（见 CUSTOM_STATUS_KEYS 的用法）。 */
		const CUSTOM_SOUND_STATUS_KEYS = Object.freeze({
			idle: 'sound.custom.empty',
			loading: 'sound.custom.loading',
			ready: 'sound.custom.ready',
			missing: 'sound.custom.missing',
			'decode-failed': 'sound.custom.decodeFailed',
			'store-failed': 'sound.custom.storeFailed',
			'too-large': 'sound.custom.tooLarge',
			unsupported: 'sound.custom.unsupported',
		});

		/**
		 * 系统通知 tag 的前缀。真正的 tag 是「前缀-类型」（等待 / 完成 / 出错），
		 * 同一类型的新通知在系统通知中心里替换上一条 —— 通知是一次性的，留着
		 * 一长串没看的旧弹窗只会让通知中心变脏；不同类型各占一个槽位，互不干扰。
		 */
		const NOTIFICATION_TAG = 'dsh-task-reminder';
		/** 三类通知各自的 tag 后缀（见 NOTIFICATION_TAG 的说明）。 */
		const NOTIFY_KIND_WAITING = 'waiting';
		const NOTIFY_KIND_COMPLETED = 'completed';
		const NOTIFY_KIND_ERROR = 'error';
		/**
		 * 「等你操作」的弹窗标题按挂起类型选：审批请求 / 提问 / 方案待确认。
		 * 宿主给的 kind 认不出时（老宿主 / 新类型）退回通用标题「等待你的回答」，
		 * 提醒照发，只是不区分类型。
		 */
		const WAIT_TITLE_KEYS = Object.freeze({
			approval: 'toast.approval.title',
			'plan-review': 'toast.plan.title',
			question: 'toast.question.title',
		});
		/**
		 * 宿主自带挂起文案的逐字中文对照。
		 *
		 * 方案待审的问题原文是宿主写死的英文（`@deepseek-ai/dsh-plan-mode` 的
		 * `exit_plan_mode`：`Approve this plan and leave plan mode?`）。宿主客户端
		 * 有自己的词条（计划待审 / 同意执行，见 dsh-client-ui-user-questions 的
		 * locale 字典），但通知正文取的是**挂起载荷里的 question 原文**，不跟界面
		 * 语言走 —— 所以界面已经是中文，弹出来的通知正文还是英文。
		 *
		 * 通知在插件手里渲染，这里按通知语言补一层对照。只认**逐字命中**的宿主
		 * 文案：用户 / 模型自己写的问题、以及宿主以后改了措辞的文案一律原样透传，
		 * 绝不猜着翻译（宿主改词就往下补一条对照，键是英文原文）。
		 */
		const HOST_TEXT_ZH = Object.freeze({
			'Approve this plan and leave plan mode?': '同意执行这份计划并退出计划模式？',
		});
		/**
		 * 弹窗正文的最大长度：超过就按这个字数截断并加省略号。系统通知按自己的
		 * 宽度拦腰截断长正文（截痕落在哪不可控），这里截得可控；与
		 * updateErrorText 的 160 字惯例一致。
		 */
		const NOTIFY_BODY_MAX_CHARS = 160;
		/** 「已经替用户申请过通知权限」的记账键（localStorage）：只问一次。 */
		const PERMISSION_ASKED_KEY = 'dsh.task-reminder.permission-asked';
		/**
		 * 询问回答后的完成豁免窗口（见 apply 里的 questionGrace + 文件头要点 3）：
		 * 只豁免「回答完紧随」的那次完成。回答之后 Agent 常常还要跑几分钟，
		 * 那时候的回合结束是一次新的停止，必须照常提醒 —— 窗口太短只会多弹
		 * 一条（用户就坐在屏幕前），太长就会把真正的完成静音。
		 */
		const QUESTION_GRACE_MS = 45000;
		/**
		 * 对账窗口（见 apply 里的 recentReports + 文件头要点 3）：只留给
		 * 「错误优先」两个方向（error→completion 不报、completion→error 撤回）
		 * 与读不到回合号时的完成→完成兜底 —— api-session/error 事件本身不带
		 * 回合号，只能靠时间窗加语义。「同一次停止」的完成→完成去重已改由
		 * 回合号判据（lastReportedTurn）接管，不再受这个窗口影响。
		 */
		const REPORT_GRACE_MS = 5000;

		/**
		 * 「点弹窗回到你的提问位置」用的定位参数（见文件头要点 8）。DSH 没有对外
		 * 暴露滚动接口，只能在打开会话后自己把最后一条你的消息对到视口顶部。
		 * 认的全是 DSH 内部实现 —— 构建哈希变了不影响（属性名不是哈希），属性名与
		 * 结构变了就认不出来（只丢这一步，不影响打开会话）。
		 */
		/** 会话流容器（列）上的属性。 */
		const QUESTION_FLOW_ATTR = 'data-chat-flow';
		/** 共享会话壳的滚动口，在列的祖先上（没有这层时退回列的父节点）。 */
		const QUESTION_SCROLL_ATTR = 'data-conversation-scroll';
		/** 会话挂载点（列的更外层祖先）上的会话号：用来确认挂的就是刚打开的那个会话。 */
		const QUESTION_SESSION_ATTR = 'data-conversation-session';
		/** 消息行上的类型属性。 */
		const QUESTION_ROW_ATTR = 'data-chat-flow-kind';
		/** 算作「你的消息」的两种行（`turn-trigger` 是系统唤醒行，不算提问）。 */
		const QUESTION_ROW_KINDS = Object.freeze(['user', 'steering']);
		/** 行选择器：自检的 DOM 桩按同一串匹配，改这里必须同步改桩。 */
		const QUESTION_ROW_SELECTOR = QUESTION_ROW_KINDS.map((kind) => `[${QUESTION_ROW_ATTR}="${kind}"]`).join(', ');
		/** 对齐偏移：行顶落在滚动口顶边下方这么多像素（应用自己的「跳到第 N 轮」也是 24）。 */
		const QUESTION_ALIGN_MARGIN = 24;
		/** 对齐判定容差（像素）。 */
		const QUESTION_ALIGN_TOLERANCE = 2;
		/**
		 * 轮询间隔与次数（约 1.8 秒）：切到一个没打开过的会话要走一次宿主 RPC 取事件窗口，
		 * 历史挂上来的时间足够，又不至于拖太久。
		 */
		const QUESTION_POLL_MS = 120;
		const QUESTION_MAX_ATTEMPTS = 15;
		/** 连续几拍都对齐才算坐稳（应用的 reading.restore() 可能晚于第一拍落地）。 */
		const QUESTION_STABLE_ATTEMPTS = 2;
		/**
		 * 跨工作区跳转后的挂载核对拍数（约 5 秒）：DSH 切工作区是异步的，`openSession`
		 * 偶尔赶在切换落地之前 —— 留痕全绿、界面还挂在旧会话上。核对到目标会话真的
		 * 挂上来才开始「落到提问位置」，对不上就再开一次。
		 */
		const JUMP_VERIFY_ATTEMPTS = 40;

		/**
		 * 找会话流里最后一条「你的消息」行（＝这次提问）。DOM 顺序就是会话顺序，
		 * 所以倒着找第一条可用的就是最新那条。只认真正渲染出来的行：带 `hidden`
		 * 的、或藏在 hidden 祖先里的都不算 —— 应用的可见性判定就是
		 * `:not([hidden]):not([hidden] *)`。
		 * @param scope - 查询范围（真实环境传 `[data-chat-flow]` 列）。
		 * @returns 最后一条你的消息行；没有可用的行或读不到 DOM 时返回 null。
		 */
		function findLatestQuestionRow(scope) {
			try {
				if (scope === null || scope === undefined || typeof scope.querySelectorAll !== 'function') return null;
				const rows = Array.from(scope.querySelectorAll(QUESTION_ROW_SELECTOR));
				for (let index = rows.length - 1; index >= 0; index -= 1) {
					const row = rows[index];
					if (row === null || row === undefined) continue;
					if (typeof row.hasAttribute === 'function' && row.hasAttribute('hidden')) continue;
					if (typeof row.closest === 'function' && row.closest('[hidden]') !== null) continue;
					return row;
				}
				return null;
			} catch {
				return null;
			}
		}

		/**
		 * 一条消息行的滚动容器：列最近的 `[data-conversation-scroll]`，没有这层就
		 * 退回列的父节点（聊天自己的 `_scroll`，自身 overflow-y:auto）。与应用的
		 * `list.closest("[data-conversation-scroll]") ?? list` 是同一套选择。
		 * @param column - 会话流容器（`[data-chat-flow]`）。
		 * @returns 滚动元素；认不出来时返回 null。
		 */
		function questionScroller(column) {
			try {
				if (column === null || column === undefined) return null;
				if (typeof column.closest === 'function') {
					const outer = column.closest(`[${QUESTION_SCROLL_ATTR}]`);
					if (outer !== null && outer !== undefined) return outer;
				}
				return column.parentElement ?? null;
			} catch {
				return null;
			}
		}

		/**
		 * 当前挂载的会话号（`[data-conversation-session]`）：点弹窗是「先切会话、
		 * 再对位置」，切换要一拍才落地 —— 用它对一下挂的是不是刚打开的那个会话，
		 * 免得把上一次的会话视图对了一遍然后收工。
		 * @param column - 会话流容器。
		 * @returns 会话号字符串；没有这层属性 / 读不到时返回 null（那就跳过这道核对）。
		 */
		function mountedSessionId(column) {
			try {
				if (column === null || column === undefined || typeof column.closest !== 'function') return null;
				const host = column.closest(`[${QUESTION_SESSION_ATTR}]`);
				if (host === null || host === undefined || typeof host.getAttribute !== 'function') return null;
				const value = host.getAttribute(QUESTION_SESSION_ATTR);
				return typeof value === 'string' && value !== '' ? value : null;
			} catch {
				return null;
			}
		}

		/**
		 * 把一条消息行的顶端对到滚动口顶端下方 QUESTION_ALIGN_MARGIN 处。
		 * 已经落在容差内、或那个方向已经滚不动了（到顶 / 到底）都算 'aligned' ——
		 * 「滚不动」必须算就位，否则每一拍都会再叠一次 delta，把视口慢慢推走。
		 * @param row - 你的消息行。
		 * @param scroller - 滚动元素。
		 * @returns 'aligned'（已就位 / 滚不动 / 读不到几何）或 'moved'（这一拍写了 scrollTop）。
		 */
		function alignQuestionRow(row, scroller) {
			try {
				if (row === null || row === undefined || scroller === null || scroller === undefined) return 'aligned';
				if (typeof row.getBoundingClientRect !== 'function' || typeof scroller.getBoundingClientRect !== 'function') return 'aligned';
				const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - QUESTION_ALIGN_MARGIN;
				if (Math.abs(delta) <= QUESTION_ALIGN_TOLERANCE) return 'aligned';
				const scrollTop = typeof scroller.scrollTop === 'number' ? scroller.scrollTop : 0;
				const clientHeight = typeof scroller.clientHeight === 'number' ? scroller.clientHeight : 0;
				const scrollHeight = typeof scroller.scrollHeight === 'number' ? scroller.scrollHeight : 0;
				// delta > 0：行在目标下方，要往下滚 —— 到底了就别写了；反之到顶了也别写。
				const stuck = delta > 0 ? scrollTop + clientHeight >= scrollHeight - 1 : scrollTop <= 1;
				if (stuck) return 'aligned';
				scroller.scrollTop = scrollTop + delta;
				return 'moved';
			} catch {
				return 'aligned';
			}
		}

		/**
		 * 挑「该在哪个会话流列上做对齐」。
		 *
		 * 为什么不能直接 `document.querySelector('[data-chat-flow]')`：DSH 会在 DOM 里
		 * 同时挂出**不止一个**会话流列（实测桌面端 3 个、网页端 30 个 —— 会话壳会为
		 * 多个会话/分区保留已挂载的视图），第一个不一定是当前显示的那个。盲取第一个
		 * 就会对着别的会话滚一遍：留痕写着 aligned，用户眼前一动没动。
		 *
		 * 选择次序：挂载会话号**等于目标**的可见列 → 第一个可见列 → 第一个列。
		 * 会话号读不到（老宿主 / 结构变了）时退回原来的「取第一个」，不比现状差。
		 * @param root - 查询范围（真实环境传 document）。
		 * @param sessionId - 目标会话号；没有目标时只看可见性。
		 * @returns 选中的列；一列都没有时返回 null。
		 */
		function pickConversationColumn(root, sessionId = null) {
			try {
				if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return null;
				const columns = Array.from(root.querySelectorAll(`[${QUESTION_FLOW_ATTR}]`));
				if (columns.length === 0) return null;
				const visible = columns.filter((column) => !isHiddenElement(column));
				const pool = visible.length > 0 ? visible : columns;
				if (typeof sessionId === 'string' && sessionId !== '') {
					const hit = pool.find((column) => mountedSessionId(column) === sessionId);
					if (hit !== undefined) return hit;
				}
				return pool[0] ?? null;
			} catch {
				return null;
			}
		}

		/**
		 * 一个元素自己或祖先是不是 `hidden`（与应用的可见性判定
		 * `:not([hidden]):not([hidden] *)` 同义）。
		 * @param element - 任意元素。
		 * @returns 被藏起来时为 true。
		 */
		function isHiddenElement(element) {
			try {
				if (element === null || element === undefined) return false;
				if (typeof element.hasAttribute === 'function' && element.hasAttribute('hidden')) return true;
				if (typeof element.closest === 'function' && element.closest('[hidden]') !== null) return true;
				return false;
			} catch {
				return false;
			}
		}

		/**
		 * 把 DOM 里所有会话流列列成一份诊断清单。
		 *
		 * 存在的理由：`mountedSession` 只报「第一个列」的会话号，而实际同时挂着的列
		 * 可能有很多个。出问题时只有这份清单能回答「选中的是不是用户眼前那一列」。
		 * @param root - 查询范围（真实环境传 document）。
		 * @returns 每列 `{ session, hidden, questionRows, scrollHost }`；读不到时为空数组。
		 */
		function conversationColumnInfo(root) {
			try {
				if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return [];
				return Array.from(root.querySelectorAll(`[${QUESTION_FLOW_ATTR}]`)).slice(0, 30).map((column) => {
					let questionRows = 0;
					try {
						questionRows = typeof column.querySelectorAll === 'function' ? column.querySelectorAll(QUESTION_ROW_SELECTOR).length : 0;
					} catch {
						questionRows = -1;
					}
					let scrollHost = false;
					try {
						scrollHost = typeof column.closest === 'function' && column.closest(`[${QUESTION_SCROLL_ATTR}]`) !== null;
					} catch {
						scrollHost = false;
					}
					return { session: mountedSessionId(column), hidden: isHiddenElement(column), questionRows, scrollHost };
				});
			} catch {
				return [];
			}
		}

		const zh = {
			'nav': '任务提醒',
			'intro': '任务停止时弹一条 Windows 系统弹窗并响一声提示音：任务完成、等你操作（审批请求 / 提问 / 方案待确认，各有标题，审批可直接在通知上同意或拒绝）、出错停止。点击通知回到对应会话，并落到你这次提问的位置。首次使用请允许浏览器通知权限；下面的设置自动保存，重启后仍在。',
			'settings.notify.title': '系统弹窗',
			'toast.completed.title': '对话任务已完成',			// 「等你操作」按挂起类型分三种标题；认不出类型时退回通用标题。
			'toast.approval.title': '审批请求',
			'toast.question.title': '提问',
			'toast.plan.title': '方案待确认',
			'toast.waiting.title': '等待你的回答',
			'toast.error.title': '任务出错已停止',
			// 审批弹窗上的两个快捷裁决按钮（等于审批卡片的「允许一次 / 拒绝」）。
			'toast.approve': '同意',
			'toast.reject': '拒绝',
			'test.question': '排障测试：这是一条模拟的待答问题？',
			'test.plan': '排障测试：这是一条模拟的方案待确认',
			'test.approval': '排障测试：这是一条模拟的审批请求',
			'test.approved': '测试提醒 · 已模拟「同意」（仅测试，未改动任何会话）',
			'test.rejected': '测试提醒 · 已模拟「拒绝」（仅测试，未改动任何会话）',
			'test.error': '排障测试：模拟一条错误（如 400 Bad Request）',
			'notify.mode.title': '弹窗时机',
			'notify.mode.always': '任何情况都弹',
			'notify.mode.unfocused': '仅非前台窗口',
			// 两档各自的说明（设置页那一行两行都摆出来；见 MODE_DESC_LINE_STYLE）。
			'notify.mode.always.description': '「任何情况都弹」：任务一完成就弹，不管浏览器窗口是否在前台',
			'notify.mode.unfocused.description': '「仅非前台窗口」：切走标签页或浏览器窗口失焦（人在别的应用）时才弹',
			'notify.language.title': '通知语言',
			'notify.language.zh': '简体中文',
			'notify.language.en': 'English',
			'subagent.title': '子智能体提醒',
			'notify.sticky.title': '弹窗一直挂着',
			'notify.sticky.description': '打开后提醒不会自动消失：一直留在屏幕上，直到你点掉它。不容易错过，但需要自己动手收掉每个弹窗。',
			'notify.unsupported': '当前浏览器不支持系统弹窗，这一项不会生效（提示音不受影响）。',
			'notify.approval.unavailable': '这个环境用不了通知上的「同意 / 拒绝」按钮（{reason}）：审批提醒会退回不带按钮的普通弹窗，其余功能不受影响。',
			'notify.approval.desktop': '桌面端（DSH Desktop）注册不了 Service Worker，审批通知只能是不带按钮的普通样式；其余功能不受影响。',
			'notify.approval.insecure': '当前页面不是安全上下文（需要 https 或 http://127.0.0.1），浏览器不给注册 Service Worker，审批通知只能是不带按钮的普通样式。',
			'notify.denied': '浏览器已拒绝本站点的通知权限，请到地址栏的站点权限里改为「允许」后再试。',
			'notify.pending': '已发出权限申请：在弹出的浏览器对话框里选择「允许」后即可收到系统弹窗。',
			'notify.request': '申请通知权限',
			'settings.sound.title': '完成提示音',
			'sound.choice.title': '提示音音效',
			'sound.choice.description': '点选即按当前音量发声；浏览器重启后第一次播放有 3-5 秒延迟（音频设备冷启动）',
			'sound.choice.two-tone': '两声（经典）',
			'sound.choice.three-tone': '三声上扬',
			'sound.choice.arpeggio': '上升琶音',
			'sound.choice.triangle': '圆润三角波',
			'sound.choice.custom': '自定义',
			'sound.custom.title': '自定义音效',
			'sound.custom.empty': '选择本机音频文件（mp3 / wav / ogg / m4a 等）作为提示音',
			'sound.custom.ready': '当前文件：{name}（{size} KB）',
			'sound.custom.loading': '正在读取并解码音频文件…',
			'sound.custom.missing': '上次选的音频在本机已丢失（换浏览器或清了站点数据），请重新选择；提醒暂用第一种合成音效',
			'sound.custom.decodeFailed': '这个文件浏览器解不开（编码不支持或文件损坏）；提醒回落到第一种合成音效，请重新选择',
			'sound.custom.storeFailed': '本地存储不可用（隐私模式或空间不足），文件没能保存；提醒回落到合成音效',
			'sound.custom.tooLarge': '文件太大（上限 {max} MB），请换一个小一点的音频',
			'sound.custom.unsupported': '这个浏览器不支持 IndexedDB，无法在本地保存自定义音频；提醒继续用四种合成音效',
			'sound.custom.pick': '选择文件',
			'sound.custom.clear': '清除',
			'volume.title': '提示音音量',
			'volume.description': '提示音的整体增益，当前 {value}%；0 为静音',
			'reset.title': '恢复默认',
			'reset.description': '把上面的设置写回出厂值；自定义音效文件会保留。',
			'reset.descriptionDefault': '当前已是默认设置。',
			'reset': '恢复默认',
			// 设置页最底部的「检查更新」：一行说明 + 一个按钮。
			'update.title': '检查更新',
			'update.button': '检查更新',
			'update.apply': '更新到 v{latest}',
			'update.checkingButton': '检查中…',
			'update.updatingButton': '更新中…',
			'update.reload': '刷新页面',
			'update.idle': '当前版本 v{version}',
			'update.checking': '正在检查更新…',
			'update.latest': '当前版本 v{version}，已是最新版本',
			'update.available': '当前版本 v{version}，发现新版本 v{latest}；更新后重启 DSH 生效',
			'update.local': '当前版本 v{version}，最新 v{latest}；本地开发安装不能一键更新',
			'update.unavailable': '当前版本 v{version}，最新 v{latest}；当前组合没有插件管理服务，请手动更新',
			'update.updating': '正在更新到 v{version}…',
			'update.done': '已更新到 v{version}：重启 DSH 后生效',
			'update.failed': '检查更新失败：{reason}',
			'update.applyFailed': '更新失败：{reason}；若其实已经装完，重启 DSH 后以实际版本为准',
			'decrease': '减小',
			'increase': '增大',
		};
		const en = {
			'nav': 'Task reminder',
			'intro': 'A Windows toast and a chime whenever a task stops: task complete, the agent waiting on you (approval request / question / plan review — each with its own title, and approvals can be settled right on the toast), or an error stop. Clicking a toast returns to that conversation at your last question. Allow browser notifications when asked on first use; the settings below save automatically and survive restarts.',
			'settings.notify.title': 'System toast',
			'toast.completed.title': 'Task complete',
			// Waiting-on-you toasts get one title per pending kind; unknown kinds
			// fall back to the generic one.
			'toast.approval.title': 'Approval request',
			'toast.question.title': 'Question',
			'toast.plan.title': 'Plan review',
			'toast.waiting.title': 'Waiting for your answer',
			'toast.error.title': 'Task stopped with an error',
			// Quick-decide buttons on an approval toast (= Allow once / Reject).
			'toast.approve': 'Approve',
			'toast.reject': 'Reject',
			'test.question': 'Diagnostics test: this is a simulated pending question?',
			'test.plan': 'Diagnostics test: this is a simulated plan review',
			'test.approval': 'Diagnostics test: this is a simulated approval request',
			'test.approved': 'Test alert · simulated "Approve" (test only, nothing changed)',
			'test.rejected': 'Test alert · simulated "Reject" (test only, nothing changed)',
			'test.error': 'Diagnostics test: a simulated error (e.g. 400 Bad Request)',
			'notify.mode.title': 'Toast timing',
			'notify.mode.always': 'Always',
			'notify.mode.unfocused': 'Only when unfocused',
			// What each mode means (both lines are shown under the row's title).
			'notify.mode.always.description': '"Always": toasts as soon as a task finishes, whether or not the browser window is in the foreground',
			'notify.mode.unfocused.description': '"Only when unfocused": toasts after you switch the tab away or the browser window loses focus (you are in another app)',
			'notify.language.title': 'Notification language',
			'notify.language.zh': '简体中文',
			'notify.language.en': 'English',
			'subagent.title': 'Subagent reminders',
			'notify.sticky.title': 'Keep notifications on screen',
			'notify.sticky.description': 'Notifications stop disappearing on their own: they stay on screen until you dismiss them. Harder to miss, but you have to close each one yourself.',
			'notify.unsupported': 'This browser does not support system toasts, so this option has no effect (the chime is unaffected).',
			'notify.approval.unavailable': 'The Approve / Reject buttons on toasts are unavailable in this environment ({reason}): approval alerts fall back to the plain buttonless toast, and everything else keeps working.',
			'notify.approval.desktop': 'DSH Desktop cannot register a Service Worker, so approval alerts arrive as plain buttonless toasts; everything else keeps working.',
			'notify.approval.insecure': 'This page is not a secure context (https or http://127.0.0.1 required), so the browser refuses to register a Service Worker and approval alerts arrive as plain buttonless toasts.',
			'notify.denied': 'The browser has denied notification permission for this site; allow it in the site permissions of the address bar and try again.',
			'notify.pending': 'Permission requested: choose Allow in the browser prompt and system toasts start working.',
			'notify.request': 'Request notification permission',
			'settings.sound.title': 'Completion sound',
			'sound.choice.title': 'Chime effect',
			'sound.choice.description': 'Picking one plays it at the current volume; the first play after a browser restart can take 3-5 s (audio-device cold start)',
			'sound.choice.two-tone': 'Two-tone (classic)',
			'sound.choice.three-tone': 'Rising three-tone',
			'sound.choice.arpeggio': 'Rising arpeggio',
			'sound.choice.triangle': 'Soft triangle',
			'sound.choice.custom': 'Custom',
			'sound.custom.title': 'Custom chime',
			'sound.custom.empty': 'Pick an audio file from this machine (mp3 / wav / ogg / m4a …) as the chime',
			'sound.custom.ready': 'Current file: {name} ({size} KB)',
			'sound.custom.loading': 'Reading and decoding the audio file…',
			'sound.custom.missing': 'The audio picked earlier is gone from this browser; pick it again. Reminders use the first synthesized chime meanwhile',
			'sound.custom.decodeFailed': 'This browser cannot decode that file (unsupported codec or damaged data); reminders fall back to the first synthesized chime — please pick another file',
			'sound.custom.storeFailed': 'Local storage is unavailable (private mode or out of space), so the file was not saved; reminders fall back to a synthesized chime',
			'sound.custom.tooLarge': 'The file is too large (limit {max} MB); please pick a smaller audio file',
			'sound.custom.unsupported': 'This browser has no IndexedDB, so a custom audio file cannot be stored locally; reminders keep using the four synthesized chimes',
			'sound.custom.pick': 'Choose file',
			'sound.custom.clear': 'Clear',
			'volume.title': 'Chime volume',
			'volume.description': 'Overall gain of the chime, currently {value}%; 0 mutes it',
			'reset.title': 'Restore defaults',
			'reset.description': 'Writes the settings above back to their factory values; an uploaded custom chime file is kept.',
			'reset.descriptionDefault': 'Everything is already at its default.',
			'reset': 'Restore defaults',
			// Bottom-of-page "Check for updates": one description line + one button.
			'update.title': 'Check for updates',
			'update.button': 'Check for updates',
			'update.apply': 'Update to v{latest}',
			'update.checkingButton': 'Checking…',
			'update.updatingButton': 'Updating…',
			'update.reload': 'Reload page',
			'update.idle': 'Current version v{version}',
			'update.checking': 'Checking for updates…',
			'update.latest': 'Current version v{version}; this is the latest release',
			'update.available': 'Current version v{version}; v{latest} is available. Restart DSH after updating',
			'update.local': 'Current version v{version}; latest v{latest}. A local development install cannot self-update',
			'update.unavailable': 'Current version v{version}; latest v{latest}. This composition has no plugin manager, so update manually',
			'update.updating': 'Updating to v{version}…',
			'update.done': 'Updated to v{version}: restart DSH to load it',
			'update.failed': 'Update check failed: {reason}',
			'update.applyFailed': 'Update failed: {reason}. If it did install, restart DSH and trust the version shown',
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
		 * 归一化音效选择（音效下标）。0 与自定义档（CUSTOM_SOUND_CHOICE）都是合法
		 * 值，不能用真值判断短路。
		 * @param value - 任意来源的值。
		 * @returns [0, CUSTOM_SOUND_CHOICE] 内的整数下标。
		 */
		function resolveSoundChoice(value) {
			// 取整、夹区间、坏值兜底都由 clampInteger 一次做完（这里不再重复判一遍）。
			return clampInteger(value, 0, CUSTOM_SOUND_CHOICE, DEFAULT_SOUND_CHOICE);
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
		 * 归一化「子智能体提醒」开关：只有布尔真值算打开，坏值（本地存储旧数据 /
		 * 字符串 'true'）一律退回默认的关闭。
		 * @param value - 任意来源的值。
		 * @returns 是否连子智能体的停止一起提醒。
		 */
		function resolveDoNotifySubagent(value) {
			return value === true;
		}

		/**
		 * 归一化「弹窗一直挂着」开关：只有布尔真值算打开，坏值（本地存储旧数据 /
		 * 字符串 'true'）一律退回默认的关闭。
		 * @param value - 任意来源的值。
		 * @returns 是否让通知不自动收（5 类都生效）。
		 */
		function resolveStickyNotifications(value) {
			return value === true;
		}

		/**
		 * 归一化通知语言。坏值（本地存储旧数据 / 拼错的字符串）退回 auto，
		 * 也就是跟随 DSH 界面语言。
		 * @param value - 任意来源的值。
		 * @returns 'auto' | 'zh' | 'en'。
		 */
		function resolveNotifyLanguage(value) {
			if (value === NOTIFY_LANGUAGE_ZH || value === NOTIFY_LANGUAGE_EN) return value;
			return NOTIFY_LANGUAGE_AUTO;
		}

		/**
		 * 把 DSH 当前界面语言折算成通知语言。区域码（zh-CN / en-US）取主语言；
		 * 认不出的语言按中文处理 —— 插件的两份字典就是 zh / en，没有第三种，
		 * 而 DSH 的中文用户占多数。
		 * @param active - locale 快照里的 active（如 'zh-CN' / 'en'）。
		 * @returns 'zh' | 'en'。
		 */
		function notifyLanguageFromLocale(active) {
			const primary = typeof active === 'string' ? active.trim().toLowerCase().split('-')[0] : '';
			return primary === 'en' ? NOTIFY_LANGUAGE_EN : NOTIFY_LANGUAGE_ZH;
		}

		/**
		 * 归一化自定义音效的元数据（从本地存储 / IndexedDB 读出来的可能是坏数据）。
		 * 只留显示与排障要用的字段；文件名缺失视为「没有自定义音效」。
		 * @param value - 任意来源的值。
		 * @returns {{ name: string, size: number, type: string, at: number } | null} 合法元数据或 null。
		 */
		function normalizeCustomMeta(value) {
			if (value === null || typeof value !== 'object') return null;
			const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name : '';
			if (name === '') return null;
			const size = typeof value.size === 'number' && Number.isFinite(value.size) && value.size > 0 ? Math.round(value.size) : 0;
			const type = typeof value.type === 'string' ? value.type : '';
			const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
			return { name, size, type, at };
		}

		/** 这个浏览器能不能用 IndexedDB 存自定义音频（不能时设置页直接说清楚）。 */
		function indexedDbAvailable() {
			try {
				const factory = window.indexedDB;
				return factory !== null && factory !== undefined && typeof factory === 'object' && typeof factory.open === 'function';
			} catch {
				return false;
			}
		}

		/**
		 * 自定义音频的本地仓库（IndexedDB）。音频字节（几十 KB ~ 数 MB）不进
		 * localStorage：那里的配额是同步写、满了直接抛，而且是本站点所有插件
		 * 共用。打开一次后复用连接；每一步都容错 —— 不支持 / 隐私模式 / 配额
		 * 不足一律走失败分支（由调用方回落合成音效），绝不外抛。
		 * @returns { put, read, remove } 写入 / 读取 / 删除，都是 Promise。
		 */
		function createCustomSoundStore() {
			let opening = null;
			/**
			 * 取（并缓存）数据库连接；失败时丢掉缓存，下一次操作可以重新打开。
			 * @returns Promise<IDBDatabase>。
			 */
			function open() {
				if (!indexedDbAvailable()) return Promise.reject(new Error('indexeddb-unsupported'));
				if (opening === null) {
					opening = new Promise((resolve, reject) => {
						let request;
						try {
							request = window.indexedDB.open(CUSTOM_SOUND_DB_NAME, CUSTOM_SOUND_DB_VERSION);
						} catch (error) {
							reject(error);
							return;
						}
						request.onupgradeneeded = () => {
							try {
								const db = request.result;
								if (db.objectStoreNames.contains(CUSTOM_SOUND_STORE_NAME) === false) db.createObjectStore(CUSTOM_SOUND_STORE_NAME);
							} catch {
								// 建仓库失败留给 onerror / 后续事务报错，这里不额外抛。
							}
						};
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error ?? new Error('indexeddb-open-failed'));
						request.onblocked = () => reject(new Error('indexeddb-blocked'));
					});
					opening.catch(() => { opening = null; });
				}
				return opening;
			}
			/**
			 * 跑一次事务请求。
			 * @param mode - 'readonly' | 'readwrite'。
			 * @param run - 收到 objectStore 后发出请求并返回该请求。
			 * @returns Promise<请求结果>；任何一步失败都 reject。
			 */
			function request(mode, run) {
				return open().then((db) => new Promise((resolve, reject) => {
					let pending;
					try {
						const store = db.transaction(CUSTOM_SOUND_STORE_NAME, mode).objectStore(CUSTOM_SOUND_STORE_NAME);
						pending = run(store);
					} catch (error) {
						reject(error);
						return;
					}
					pending.onsuccess = () => resolve(pending.result);
					pending.onerror = () => reject(pending.error ?? new Error('indexeddb-request-failed'));
				}));
			}
			return {
				/**
				 * 写入（覆盖）唯一那条自定义音频记录。
				 * @param record - { name, size, type, at, blob }。
				 * @returns Promise<boolean> 是否写成功。
				 */
				put(record) {
					return request('readwrite', (store) => store.put(record, CUSTOM_SOUND_RECORD_KEY)).then(() => true).catch(() => false);
				},
				/**
				 * 读那条记录；读不出来（不支持 / 被挡）时 reject，由调用方决定怎么提示。
				 * @returns Promise<记录 | undefined>。
				 */
				read() {
					return request('readonly', (store) => store.get(CUSTOM_SOUND_RECORD_KEY));
				},
				/**
				 * 删掉那条记录。
				 * @returns Promise<boolean> 是否删成功。
				 */
				remove() {
					return request('readwrite', (store) => store.delete(CUSTOM_SOUND_RECORD_KEY)).then(() => true).catch(() => false);
				},
			};
		}

		/**
		 * 这个会话是不是子智能体会话。只认官方列表行上的 `origin === 'subagent'`
		 * ——这也是官方侧边栏判定子会话可见性的唯一字段；fork 出来的会话带
		 * `parentId` 但 origin 不是 'subagent'，不能连它一起挡掉。
		 * 行还没进列表（origin 读不到）时不当作子智能体：宁可多提醒一条，也不把
		 * 用户的真实回合静音。读列表抛错同理。
		 * @param ctx - 客户端根上下文。
		 * @param sessionId - 会话 id。
		 * @returns 是子智能体会话时为 true。
		 */
		function isSubagentSession(ctx, sessionId) {
			try {
				return ctx.sessions.list.getSnapshot().byId?.[sessionId]?.origin === 'subagent';
			} catch {
				return false;
			}
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
			/**
			 * 按内置音效表排一遍合成音（四种合成音效的播放实现）。
			 * @param choice - 内置音效下标（坏值内部归一化）。
			 * @param volume - 音量显示值（或坏值，内部归一化）。
			 * @returns { scheduled, state } 是否真的排了音、播放时的 context 状态。
			 */
			function playPreset(choice, volume) {
				try {
					const volumePercent = clampVolume(volume);
					if (volumePercent <= 0) return { scheduled: false, state: 'muted' }; // 0 = 静音：一条音都不排。
					const Ctor = window.AudioContext ?? window.webkitAudioContext;
					if (Ctor === undefined) return { scheduled: false, state: 'unsupported' };
					audio ??= new Ctor();
					// 被自动播放策略挂在 suspended 时先尝试拉活；这一下拉不动也照排，
					// 下一个用户手势恢复后这些音仍会播出来。
					if (audio.state === 'suspended') revive();
					const now = audio.currentTime;
					// 这一层只负责合成音效表：自定义档（下标越界）由 play 分流，不会走到这里。
					const spec = SOUND_CHOICES[Math.min(resolveSoundChoice(choice), SOUND_CHOICES.length - 1)];
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
			}
			/**
			 * 播一段解码好的自定义音频：走同一个 master 增益（用户音量 + 20），
			 * 首尾各 10ms 淡入淡出 —— 用户自己的音频常是硬切，不加包络会爆音。
			 * @param buffer - decode() 得到的 AudioBuffer。
			 * @param volume - 音量显示值（或坏值，内部归一化）。
			 * @returns { scheduled, state } 是否真的排了音、播放时的 context 状态。
			 */
			function playBuffer(buffer, volume) {
				try {
					const volumePercent = clampVolume(volume);
					if (volumePercent <= 0) return { scheduled: false, state: 'muted' }; // 0 = 静音：不排。
					if (buffer === null || buffer === undefined) return { scheduled: false, state: 'custom-missing' };
					const Ctor = window.AudioContext ?? window.webkitAudioContext;
					if (Ctor === undefined) return { scheduled: false, state: 'unsupported' };
					audio ??= new Ctor();
					if (audio.state === 'suspended') revive();
					if (typeof audio.createBufferSource !== 'function') return { scheduled: false, state: 'unsupported' };
					const now = audio.currentTime;
					const master = (volumePercent + VOLUME_BOOST) / 100;
					const peak = Math.max(0.0001, master);
					const duration = typeof buffer.duration === 'number' && Number.isFinite(buffer.duration) ? buffer.duration : 0;
					const source = audio.createBufferSource();
					const envelope = audio.createGain();
					source.buffer = buffer;
					envelope.gain.setValueAtTime(0.0001, now);
					envelope.gain.exponentialRampToValueAtTime(peak, now + 0.01);
					if (duration > 0.03) {
						// 尾巴 20ms 淡出：太短的音频（<30ms）不做，免得 ramp 交叉。
						envelope.gain.setValueAtTime(peak, now + duration - 0.02);
						envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
					}
					source.connect(envelope);
					envelope.connect(audio.destination);
					source.start(now);
					return { scheduled: true, state: audio.state };
				} catch {
					return { scheduled: false, state: 'failed' };
				}
			}
			/**
			 * 解码一段本地音频（Blob / File / ArrayBuffer）成 AudioBuffer。
			 * 用回调式 decodeAudioData：Safari 等实现上比 Promise 式稳；编码不支持
			 * 或数据损坏时 reject，由调用方把状态写清楚并回落合成音效。
			 * @param data - Blob / File / ArrayBuffer。
			 * @returns Promise<AudioBuffer>。
			 */
			function decode(data) {
				return (async () => {
					const input = data !== null && data !== undefined && typeof data.arrayBuffer === 'function'
						? await data.arrayBuffer()
						: data;
					const Ctor = window.AudioContext ?? window.webkitAudioContext;
					if (Ctor === undefined) throw new Error('unsupported');
					audio ??= new Ctor();
					if (typeof audio.decodeAudioData !== 'function') throw new Error('no-decoder');
					return new Promise((resolve, reject) => {
						try {
							audio.decodeAudioData(input, (decoded) => resolve(decoded), (error) => reject(error ?? new Error('decode-failed')));
						} catch (error) {
							reject(error);
						}
					});
				})();
			}
			return {
				/** 供用户手势监听调用：拉活被挂起的 AudioContext。 */
				resume: revive,
				decode,
				playBuffer,
				/**
				 * 在用户手势里预热 AudioContext：把音频设备的初始化挪到第一次
				 * 交互，完成提示音与切音效试听都能立即出声，没有首声延迟。
				 * 同时播一条 gain=0 的极短音，强制音频线程与输出设备转起来
				 * （浏览器首次播放前的设备初始化任何网页都躲不掉，只能提前付）。
				 */
				warm() {
					try {
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
				 * 按当前设置播放一遍：内置档走合成音效表，自定义档走解码好的
				 * AudioBuffer。自定义档没有可用音频时（还没解码完 / 解码失败 /
				 * 文件被清掉 / IndexedDB 读不回来）回落第一种合成音效 ——
				 * 提醒宁可换一种声音，也不能变哑。
				 * @param choice - 音效下标（或坏值，内部归一化；自定义档见 CUSTOM_SOUND_CHOICE）。
				 * @param volume - 音量显示值（或坏值，内部归一化）。
				 * @param customBuffer - 解码好的自定义音频；没有则为 null / undefined。
				 * @returns { scheduled, state } 是否真的排了音、播放时的 context 状态。
				 */
				play(choice, volume, customBuffer) {
					if (resolveSoundChoice(choice) === CUSTOM_SOUND_CHOICE) {
						if (customBuffer === null || customBuffer === undefined) {
							// 回落：文件还没解码完 / 解不开 / 被清掉时播第一种合成音效。
							return { ...playPreset(DEFAULT_SOUND_CHOICE, volume), custom: false, customFallback: true };
						}
						return { ...playBuffer(customBuffer, volume), custom: true };
					}
					return playPreset(choice, volume);
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
		 * 宿主半侧注册的「唤醒桌面窗口」路由（相对本页路径，经 dsh-app 协议
		 * 转发到宿主，与 RPC 走同一条 /api 通道）。宿主实现见 index.js。
		 *
		 * 这里**故意不带前导斜杠**（宿主侧的注册路径是 `/api/...`）：桌面壳把
		 * `dsh-app://app/*` 里非前端的相对路径按原样转发给宿主，写成绝对路径
		 * 会被当成前端路由、转发不到宿主。别「顺手」补上那个斜杠。
		 */
		const DESKTOP_ACTIVATION_ROUTE = 'api/task-reminder/window-activation';

		/**
		 * 点通知抬窗的链路留痕。requestDesktopActivation 在工厂作用域里，够不着
		 * 主 effect 内的 stats，所以单独一个 holder；state() 以 stats.lastActivation
		 * 的名字暴露（复现「点了没抬窗」时读它就知道点击走到了哪一步）。
		 * @type {{ last: null | { at: number, route: string, reason: string, status?: number, error?: string } }}
		 */
		// 跨热重载保留留痕：旧通知的点击可能由**旧实例**处理，而控制台问的是新实例。
		// 只放在模块作用域里的话，热重载一次 click/activation 就双双归零，现场证据
		// 被抹掉（这次排查就踩到了）。挂在页面级表上，点击记录与插件实例解耦。
		const diagnosticRouter = clickRouterOf();
		if (diagnosticRouter !== null) {
			if (diagnosticRouter.activationDiag === undefined) diagnosticRouter.activationDiag = { last: null, sequence: 0 };
			if (diagnosticRouter.clickDiag === undefined) diagnosticRouter.clickDiag = { last: null, count: 0 };
			if (diagnosticRouter.jumpDiag === undefined) diagnosticRouter.jumpDiag = { last: null, question: null };
		}
		const activationDiag = diagnosticRouter?.activationDiag ?? { last: null, sequence: 0 };
		const clickDiag = diagnosticRouter?.clickDiag ?? { last: null, count: 0 };
		const jumpDiag = diagnosticRouter?.jumpDiag ?? { last: null, question: null };
		/** 本实例是什么时候装载的：留痕早于它就说明那次点击不是这一份代码处理的。 */
		const instanceStartedAt = Date.now();

		/**
		 * 桌面壳（DSH Desktop / Electron）里把窗口拉回前台。
		 * 普通浏览器里 `window.focus()` 就够；桌面壳的渲染进程拉不起最小化 /
		 * 已收进托盘的窗口 —— 只有主进程的 focusPrimaryWindow() 会
		 * restore()/show()/focus()，而它只由托盘点击与「再启动一份自己」
		 * （`dsh://open` 深度链接）触发。插件在渲染进程里既没有那条 IPC 也发不出
		 * 外部协议，于是请宿主半侧代跑一次深度链接。
		 * 窗口本来就在前台时不打扰宿主；拿不到宿主 / 路由不存在 / 请求失败都
		 * 静默放弃 —— 唤不起前台也不能影响「打开对应会话」这条主路径。
		 *
		 * **点通知一律发请求**：早先这里有一句「页面自称有焦点就跳过」，
		 * 实测不可靠 —— Electron 里窗口被别的窗口挡住 / 最小化时
		 * `document.hasFocus()` 仍可能报 true，于是点击被静默跳过、窗口永远
		 * 唤不起来（2026-10-07 用户实测：点弹窗没抬窗，手动 POST 同一条路由
		 * 却立刻抬起 —— 宿主那一半是好的，断在这一句短路）。点通知本身就是
		 * 「我要跳过去」的意图，多起一个短命进程的代价可以接受；页面当时到底
		 * 有没有焦点只作为 `focused` 记进留痕，用于判断，不再用来决定发不发。
		 *
		 * 这条路以前全静默，复现「点了没抬窗」时只能猜。现在每个去路都记一笔
		 * `stats.lastActivation`（控制台 `state().stats.lastActivation` 可读）：
		 * no-desktop / no-fetch / sent / answered / failed / error，
		 * 并带上 `focused`（点击那一刻页面的自述）。
		 */
		function requestDesktopActivation() {
			const requestedAt = Date.now();
			const sequence = activationDiag.sequence = (activationDiag.sequence ?? 0) + 1;
			const requestId = `click-${requestedAt}-${sequence}`;
			let focused = null;
			const record = (reason, extra) => {
				try {
					// 晚回的旧请求不能覆盖后一次点击（每次点击自成一条留痕）。
					if (activationDiag.last !== null && (activationDiag.last.sequence ?? 0) > sequence) return;
					activationDiag.last = { at: Date.now(), requestedAt, sequence, requestId, focused, route: DESKTOP_ACTIVATION_ROUTE, reason, ...(extra ?? {}) };
				} catch {
					// 记一笔失败不影响抬窗本身。
				}
			};
			try {
				if (!('dshDesktop' in window)) { record('no-desktop'); return; }
				if (typeof window.fetch !== 'function') { record('no-fetch'); return; }
				focused = document.hidden === false
					&& typeof document.hasFocus === 'function' && document.hasFocus() === true;
				// 带上这次点击的 ID：宿主把它写进唤醒日志，页面留痕与宿主日志能对上
				// 同一次点击（两个 profile 共用一份日志，必须靠 ID 区分）。
				const request = window.fetch(DESKTOP_ACTIVATION_ROUTE, {
					method: 'POST',
					cache: 'no-store',
					headers: { 'x-task-reminder-activation-id': requestId },
				});
				record('sent');
				if (request !== null && typeof request === 'object' && typeof request.then === 'function') {
					request.then((response) => {
						record('answered', { status: response?.status ?? null });
					}, (error) => {
						record('failed', { error: String(error?.message ?? error) });
					});
				}
			} catch (error) {
				record('error', { error: String(error?.message ?? error) });
				// 宿主没接住 / 路由不存在都不影响会话跳转。
			}
		}

		/**
		 * 系统通知（Web Notification API）。支持探测、权限申请、弹出三步；
		 * 每一步都容忍失败：弹窗发不出去时提示音照旧。
		 * 权限状态每次现读（用户随时能在站点权限里改），不缓存。
		 * @returns { supported, permission, request, show }。
		 */
		function createNotifier() {
			/** 当前是否具备发通知的条件（浏览器支持且已授权）。 */
			const granted = () => typeof window.Notification === 'function'
				&& window.Notification.permission === 'granted';
			return {
				/** 浏览器有没有 Notification 构造器。 */
				get supported() {
					return typeof window.Notification === 'function';
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
				 * tag 每条独立（1.5.5 的行为）：后一条不顶掉前一条 —— 固定 tag 的
				 * 「同类型替换」会让被替换的那条在通知中心里点不动（见文件头要点 5）。
				 * `silent: true` 关掉浏览器自带的提示音——声音只由插件自己那套
				 * 负责（设置页的提示音开关与音量说了算），也避免和合成音效叠成两声。
				 * `requireInteraction` 由设置页的「弹窗一直挂着」开关决定（默认关）：
				 * 打开后横幅不自动收进系统通知中心，逼用户点横幅 —— 横幅被点才必定
				 * 送得到页面（Electron 在 Windows 上「点通知中心里的条目」不投递
				 * click，见 electron#29461）；代价是横幅不走，得自己点掉。
				 * @param title - 通知标题。
				 * @param body - 通知正文（会话名 / 问题 / 错误信息）。
				 * @param onClick - 点击通知时的回调。
				 * @param requireInteraction - 横幅是否不自动收（设置页那个开关，5 类通用）。
				 * @returns 通知对象；没发出去时返回 null。
				 */
				show(title, body, onClick, requireInteraction = false) {
					try {
						if (!granted()) return null;
						const notification = new window.Notification(title, {
							body,
							// 每条通知独立 tag（1.5.5 的行为）：后一条不顶掉前一条。
							// 回到这一版是因为「按类型固定 tag + renotify」在 Windows 上
							// 会把上一条横幅替换掉 —— 被替换掉的那条在通知中心里点不动
							// （Electron 在 Windows 上「通知中心里的条目」不投递 click，
							// electron#29461），现场表现就是「点了通知窗口抬不起来」。
							tag: `${NOTIFICATION_TAG}-${Date.now()}`,
							silent: true,
							// 由设置页的「弹窗一直挂着」开关决定（默认关），5 类通用。
							requireInteraction: requireInteraction === true,
						});
						notification.onclick = () => {
							// 先把窗口叫回来（桌面壳才需要、也才发得出去），再切会话。
							requestDesktopActivation();
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

		/**
		 * 自己那份 bundle 的 URL（注册 Service Worker 用）：启动图里认自己那一行。
		 * @returns URL，或拿不到时的 null。
		 */
		function selfBundleUrl() {
			try {
				return findSelfBundleUrl(window.__DSH_BOOT__?.entries);
			} catch {
				return null;
			}
		}

		/**
		 * 审批快捷裁决的 Service Worker 桥（页面侧，见文件头要点 11）。
		 *
		 * 带按钮的通知只能由 Service Worker 弹（`new Notification(..., {actions})`
		 * 直接抛 TypeError），所以这里把自己那份 bundle 注册成 worker（worker
		 * 半侧见文件顶部的 installNotificationClickRelay），并用它发通知；
		 * worker 把「同意 / 拒绝 / 点正文」转回来，由页面调
		 * `pendingInteraction.answer('allowed-once' | 'rejected')` 真正裁决 ——
		 * 和审批卡片自己用的是同一个方法。
		 *
		 * 任何一个环节不可用（不安全上下文、桌面壳 dsh-app:// 无法注册、拿不到
		 * bundle URL、注册失败）都只把状态记下来，`active` 保持 false，调用方
		 * 退回普通通知：不假装有按钮。
		 * @returns {{
		 *   readonly state: string,
		 *   readonly active: boolean,
		 *   onStateChange: (handler: (state: string) => void) => () => void,
		 *   onMessage: (handler: (message: object) => void) => () => void,
		 *   start: (url: string | null) => void,
		 *   show: (title: string, options: object) => boolean,
		 *   closeTag: (tag: string) => void,
		 *   dispose: () => void,
		 * }} 桥的实例。
		 */
		function createActionBridge() {
			let registration = null;
			let state = 'idle';
			let channel = null;
			let started = false;
			const stateHandlers = new Set();
			const messageHandlers = new Set();
			const setState = (next) => {
				if (next === state) return;
				state = next;
				for (const handler of [...stateHandlers]) {
					try {
						handler(state);
					} catch {
						// 状态订阅者出错不影响桥本身。
					}
				}
			};
			const accept = (message) => {
				if (message === null || typeof message !== 'object') return;
				if (message.source !== BRIDGE_SOURCE || message.type !== BRIDGE_MESSAGE_TYPE) return;
				for (const handler of [...messageHandlers]) {
					try {
						handler(message);
					} catch {
						// 一个订阅者出错不影响别的。
					}
				}
			};
			return {
				/** 当前状态：idle / registering / active / unsupported: … / failed: …。 */
				get state() {
					return state;
				},
				/** 桥是否真的可用（注册成功）。 */
				get active() {
					return state === 'active' && registration !== null;
				},
				/** 订阅状态变化（设置页如实显示用）。 */
				onStateChange(handler) {
					stateHandlers.add(handler);
					return () => stateHandlers.delete(handler);
				},
				/** 订阅 worker 转回的点击（返回退订函数）。 */
				onMessage(handler) {
					messageHandlers.add(handler);
					return () => messageHandlers.delete(handler);
				},
				/**
				 * 注册 worker 并开始收消息。拿不到 URL / 不安全上下文 / 注册失败
				 * 都只改状态，不抛。
				 * @param url - 自己那份 bundle 的 URL（selfBundleUrl()）。
				 */
				start(url) {
					if (started) return;
					started = true;
					try {
						const serviceWorker = window.navigator?.serviceWorker;
						if (serviceWorker === undefined || serviceWorker === null) {
							setState('unsupported: no service worker');
							return;
						}
						if (window.isSecureContext === false) {
							setState('unsupported: insecure context');
							return;
						}
						// 两路收信：BroadcastChannel（同源页面通用）与 worker 的 postMessage。
						try {
							if (typeof window.BroadcastChannel === 'function') {
								channel = new window.BroadcastChannel(BRIDGE_CHANNEL);
								channel.onmessage = (event) => accept(event?.data);
							}
						} catch {
							// 没有 BroadcastChannel 就只靠 postMessage。
						}
						try {
							if (typeof serviceWorker.addEventListener === 'function') {
								serviceWorker.addEventListener('message', (event) => accept(event?.data));
							}
						} catch {
							// 同上。
						}
						if (typeof url !== 'string' || url === '') {
							setState('unsupported: bundle url unknown');
							return;
						}
						setState('registering');
						Promise.resolve(serviceWorker.register(url)).then((reg) => {
							registration = reg ?? null;
							if (registration === null) {
								setState('failed: no registration');
								return;
							}
							if (registration.active !== null && registration.active !== undefined) {
								setState('active');
								return;
							}
							const worker = registration.installing ?? registration.waiting ?? null;
							if (worker === null) {
								setState('active');
								return;
							}
							const settle = () => {
								try {
									if (registration.active !== null && registration.active !== undefined) setState('active');
									else if (worker.state === 'activated') setState('active');
									else if (worker.state === 'redundant') setState('failed: worker redundant');
								} catch {
									// 状态读不到就维持原样。
								}
							};
							try {
								worker.addEventListener('statechange', settle);
							} catch {
								// 没有 statechange 就靠下面这次同步判定。
							}
							settle();
						}, (error) => {
							setState(`failed: ${error?.message ?? error}`);
						});
					} catch (error) {
						setState(`failed: ${error?.message ?? error}`);
					}
				},
				/**
				 * 用 worker 弹一条带按钮的持久通知（actions 只在这个通道上生效）。
				 * @param title - 通知标题。
				 * @param options - showNotification 的选项（body / tag / data / actions…）。
				 * @returns 是否真的交出去了。
				 */
				show(title, options) {
					if (!this.active || typeof registration.showNotification !== 'function') return false;
					try {
						const settled = registration.showNotification(title, options);
						if (settled !== null && typeof settled === 'object' && typeof settled.then === 'function') settled.catch(() => {});
						return true;
					} catch {
						return false;
					}
				},
				/**
				 * 关掉某个 tag 的通知：等待消散、或已从别处裁决时，别留下一个
				 * 点了没用的陈旧按钮。
				 * @param tag - 通知 tag。
				 */
				closeTag(tag) {
					if (registration === null || typeof registration.getNotifications !== 'function') return;
					Promise.resolve(registration.getNotifications({ tag })).then((list) => {
						for (const notification of list ?? []) {
							try {
								notification.close();
							} catch {
								// 已经关掉了。
							}
						}
					}, () => {});
				},
				/** 卸载：退订、关频道。 */
				dispose() {
					stateHandlers.clear();
					messageHandlers.clear();
					try {
						if (channel !== null) channel.close();
					} catch {
						// 已经关了。
					}
					channel = null;
					started = false;
				},
			};
		}

		//#region 检查更新（设置页底部的「检查更新」）
		/** 宿主侧「读最新版本」路由；地址两种写法见 updateRouteUrl。 */
		const UPDATE_CHECK_ROUTE = '/api/task-reminder/update-check';
		/** 宿主侧「就地升级」路由；请求体带目标版本。 */
		const UPDATE_APPLY_ROUTE = '/api/task-reminder/update';

		/**
		 * 宿主路由的地址：桌面壳（`dsh-app:`）里必须**相对**，浏览器里必须**带根**。
		 *
		 * 桌面壳把 `dsh-app://app/*` 里非前端的相对路径原样转发给宿主，写成绝对
		 * 路径会被当成前端路由（与 DESKTOP_ACTIVATION_ROUTE 同一条注意事项）；
		 * 普通浏览器反过来：页面可能停在 `/session/...` 这类子路径上，相对路径会
		 * 拼成 `/session/api/...` 而 404，所以要占住站点根。
		 * @param path - 以 `/` 开头的宿主路由。
		 * @param protocol - 测试用：当前页面的协议；缺省读 `location.protocol`。
		 * @returns 当前环境该用的地址。
		 */
		function updateRouteUrl(path, protocol) {
			try {
				const active = protocol ?? (typeof location !== 'undefined' && location !== null ? location.protocol : undefined);
				return active === 'dsh-app:' ? path.replace(/^\//, '') : path;
			} catch {
				// 读不到 location（自检桩 / worker）：按浏览器写法。
				return path;
			}
		}

		/**
		 * 「检查更新」状态机的初值。`current` 先垫这份代码自己的版本号：拿不到宿主
		 * 答复时显示的也是真实跑着的版本。不持久化 —— 每次打开设置页都该是没查过的样子。
		 */
		const UPDATE_IDLE = Object.freeze({
			// idle（还没查）/ checking / latest / available / updating / done / failed
			phase: 'idle',
			// 走到 failed 的时候是从哪一步摔的：'check'（查版本）/ 'update'（装新版）。
			// 两者的失败文案不同 —— 安装请求可能在中途丢了而包其实已经装完。
			step: 'check',
			current: PLUGIN_VERSION,
			latest: null,
			registry: null,
			// 本地开发安装的依赖声明（link: / file: …），非 null 时不往源上升级。
			local: null,
			// 宿主有没有「一键更新」的能力（要 pluginManager 服务 + 不是本地安装）。
			updatable: false,
			error: null,
			// 升级完成后的版本（done 相位显示它）。
			to: null,
		});

		/**
		 * 比两个版本号（semver 口径：数字段逐位比，带预发布段的更小，认不出的按相等）。
		 * @param left - 左侧版本。
		 * @param right - 右侧版本。
		 * @returns 负数 / 0 / 正数。
		 */
		function compareVersions(left, right) {
			const parse = (value) => {
				if (typeof value !== 'string') return null;
				const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
				if (match === null) return null;
				return {
					numbers: match[1].split('.').map((part) => Number(part)),
					prerelease: match[2] === undefined ? null : match[2].split('.'),
				};
			};
			const a = parse(left);
			const b = parse(right);
			// 认不出就不当「有新版」：宁可不提示，也不要让用户白升一次。
			if (a === null || b === null) return 0;
			const length = Math.max(a.numbers.length, b.numbers.length);
			for (let index = 0; index < length; index += 1) {
				const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
				if (difference !== 0) return difference < 0 ? -1 : 1;
			}
			if (a.prerelease === null && b.prerelease === null) return 0;
			if (a.prerelease === null) return 1;
			if (b.prerelease === null) return -1;
			const identifiers = Math.max(a.prerelease.length, b.prerelease.length);
			for (let index = 0; index < identifiers; index += 1) {
				const leftPart = a.prerelease[index];
				const rightPart = b.prerelease[index];
				if (leftPart === undefined) return -1;
				if (rightPart === undefined) return 1;
				const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
				const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
				if (leftNumber !== null && rightNumber !== null) {
					if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
					continue;
				}
				// 数字标识符小于字母标识符（semver）。
				if (leftNumber !== null) return -1;
				if (rightNumber !== null) return 1;
				if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
			}
			return 0;
		}

		/**
		 * 源上的版本是不是比当前这份新。
		 * @param candidate - 源上的版本。
		 * @param current - 当前版本。
		 * @returns 有新版时为 true。
		 */
		function isNewerVersion(candidate, current) {
			return compareVersions(candidate, current) > 0;
		}

		/**
		 * 更新状态机：一次「检查」或「更新」把状态推到下一格，别的什么都不做。
		 * 网络与宿主调用都在调用方，迁移本身是纯函数 —— 自检可以直接摆姿势验每一格。
		 * @param state - 当前状态。
		 * @param event - `{ type, result?, reason? }`。
		 * @returns 新状态。
		 */
		function updateReducer(state, event) {
			switch (event?.type) {
				case 'check-start':
					return { ...state, phase: 'checking', step: 'check', error: null };
				case 'check-result': {
					const result = event.result ?? {};
					const current = typeof result.current === 'string' && result.current !== '' ? result.current : state.current;
					const latest = typeof result.latest === 'string' && result.latest !== '' ? result.latest : null;
					const next = {
						...state,
						step: 'check',
						current,
						latest,
						registry: typeof result.registry === 'string' && result.registry !== '' ? result.registry : null,
						local: typeof result.local === 'string' && result.local !== '' ? result.local : null,
						updatable: result.updatable === true,
						error: null,
					};
					if (typeof result.error === 'string' && result.error !== '') return { ...next, phase: 'failed', error: result.error };
					if (latest === null) return { ...next, phase: 'failed', error: 'no-version' };
					return { ...next, phase: isNewerVersion(latest, current) ? 'available' : 'latest' };
				}
				case 'check-failed':
					return { ...state, phase: 'failed', step: 'check', error: typeof event.reason === 'string' ? event.reason : 'unknown' };
				case 'update-start':
					return { ...state, phase: 'updating', step: 'update', error: null };
				case 'update-result': {
					const result = event.result ?? {};
					if (result.ok !== true) {
						return { ...state, phase: 'failed', step: 'update', error: typeof result.error === 'string' && result.error !== '' ? result.error : 'update-failed' };
					}
					const to = typeof result.latest === 'string' && result.latest !== '' ? result.latest : state.latest;
					return { ...state, phase: 'done', step: 'update', to, latest: to, error: null };
				}
				case 'update-failed':
					return { ...state, phase: 'failed', step: 'update', error: typeof event.reason === 'string' ? event.reason : 'unknown' };
				default:
					return state;
			}
		}

		/**
		 * 把更新状态翻成「一行说明 + 一个按钮」。
		 * 动作三种：`check` 再查一次 / `apply` 现在就升 / `reload` 刷新页面。
		 * @param state - 更新状态。
		 * @returns `{ descKey, descParams, labelKey, labelParams, action, disabled }`。
		 */
		function updatePresentation(state) {
			const version = typeof state.current === 'string' && state.current !== '' ? state.current : PLUGIN_VERSION;
			switch (state.phase) {
				case 'checking':
					return { descKey: 'update.checking', descParams: {}, labelKey: 'update.checkingButton', labelParams: {}, action: 'check', disabled: true };
				case 'updating':
					return { descKey: 'update.updating', descParams: { version: state.latest ?? version }, labelKey: 'update.updatingButton', labelParams: {}, action: 'apply', disabled: true };
				case 'latest':
					return { descKey: 'update.latest', descParams: { version }, labelKey: 'update.button', labelParams: {}, action: 'check', disabled: false };
				case 'available': {
					// 有新版但不一定能一键升：本地开发安装（link:）与没有 pluginManager
					// 的组合都如实说明，别给一个点了没反应的按钮。
					const descKey = state.local !== null ? 'update.local' : (state.updatable ? 'update.available' : 'update.unavailable');
					return {
						descKey,
						descParams: { version, latest: state.latest ?? '' },
						labelKey: state.updatable ? 'update.apply' : 'update.button',
						labelParams: { latest: state.latest ?? '' },
						action: state.updatable ? 'apply' : 'check',
						disabled: false,
					};
				}
				case 'done':
					return { descKey: 'update.done', descParams: { version: state.to ?? state.latest ?? version }, labelKey: 'update.reload', labelParams: {}, action: 'reload', disabled: false };
				case 'failed':
					// 查版本失败与装新版失败分开说：安装请求可能在中途丢了，而包其实
					// 已经装完 —— 这时让用户「重启后以实际版本为准」，别让他以为白装。
					return {
						descKey: state.step === 'update' ? 'update.applyFailed' : 'update.failed',
						descParams: { reason: state.error ?? 'unknown' },
						labelKey: 'update.button',
						labelParams: {},
						action: 'check',
						disabled: false,
					};
				default:
					return { descKey: 'update.idle', descParams: { version }, labelKey: 'update.button', labelParams: {}, action: 'check', disabled: false };
			}
		}

		/**
		 * 把抛出来的东西折成一行短说明。
		 * @param error - 任意异常。
		 * @returns 说明字符串。
		 */
		function updateErrorText(error) {
			const text = error instanceof Error ? error.message : String(error);
			return text.length > 160 ? `${text.slice(0, 160)}…` : text;
		}
		//#endregion

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
			// 控件装不下时整行折行（音效档位多、窗口窄）：描述拿整行宽度，
			// 而不是被挤成一列单字。
			flexWrap: 'wrap',
			rowGap: '8px',
			padding: '16px 0',
			borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
		};
		const ROW_TEXT_STYLE = {
			display: 'flex',
			flexDirection: 'column',
			// 基准 240px：与控件并排时至少占这么宽，放不下就让控件换到下一行。
			flex: '1 1 240px',
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
		/**
		 * 「弹窗时机」两档的说明各占一行（档位名 + 这句话的适用场景）。
		 * 两档只看档位名分不清「前台窗口」指的是浏览器窗口还是页面，所以两行都摆出来，
		 * 切档不用换一行读。
		 */
		const MODE_DESC_LINE_STYLE = { display: 'block' };
		const ROW_CONTROL_STYLE = {
			display: 'flex',
			alignItems: 'center',
			flex: 'none',
			maxWidth: '100%',
		};
		const PILL_STYLE = {
			display: 'inline-flex',
			alignItems: 'center',
			// minHeight + 可折行：档位多（五个音效）或窗口窄时，档位自己折成
			// 两行，不会把左边的描述挤扁。
			minHeight: '36px',
			padding: '4px',
			gap: '2px',
			borderRadius: '18px',
			background: 'var(--dsw-alias-bg-layer-2)',
			flexWrap: 'wrap',
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
			whiteSpace: 'nowrap',
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
		/** 自定义音效行的控件排布：「选择文件」（+ 有文件时的「清除」）。 */
		const CUSTOM_CONTROL_STYLE = {
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			flexWrap: 'wrap',
		};

		/**
		 * 设置页里的一行：文案在左、控件在右；wide 控件（五个档位的音效选择）
		 * 用 stacked 改成「文案占满一行、控件另起一行」，否则描述会被挤成一列单字。
		 */
		function SettingRow({ rowKey, title, desc, control, stacked }) {
			const rowStyle = stacked === true ? { ...ROW_STYLE, flexDirection: 'column', alignItems: 'stretch' } : ROW_STYLE;
			const textStyle = stacked === true ? { ...ROW_TEXT_STYLE, flex: '1 1 auto', paddingRight: '0' } : ROW_TEXT_STYLE;
			const text = [React.createElement('div', { style: ROW_TITLE_STYLE, key: 'title' }, title)];
			// 自解释的行不给说明：空字符串也不渲染，免得白留一段行距。
			// desc 也可以是节点 —— 「弹窗时机」那一行就是一档一行说明（见 MODE_DESC_LINE_STYLE）。
			if (desc !== undefined && desc !== null && desc !== '') {
				text.push(React.createElement('div', { style: ROW_DESC_STYLE, key: 'desc' }, desc));
			}
			return React.createElement('div', { style: rowStyle, key: rowKey }, [
				React.createElement('div', { style: textStyle, key: 'text' }, text),
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

		/**
		 * 分段控件（二选一 / 多选一）。
		 * `vertical: true` 时档位上下排（弹窗时机两档各占一行，配着标题下面的两行
		 * 说明读，横向挤在右侧时两档的对比反而不明显）。
		 */
		function Segmented({ value, options, label, onChange, vertical }) {
			const groupStyle = vertical === true
				? { ...PILL_STYLE, flexDirection: 'column', alignItems: 'stretch' }
				: PILL_STYLE;
			return React.createElement('div', { style: groupStyle, role: 'group', 'aria-label': label }, options.map((option) => React.createElement('button', {
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
		 * @param props.subagentStore - 子智能体提醒开关 store。
		 * @param props.notifyLanguageStore - 通知语言 store（auto / zh / en）。
		 * @param props.effectiveLanguageStore - 生效语言 store（设置页那一行选中哪一档）。
		 * @param props.customMetaStore - 自定义音效元数据 store（文件名等）。
		 * @param props.customStatusStore - 自定义音效状态 store（读取中用 / 就绪 / 失败）。
		 * @param props.permissionStore - 通知权限状态 store（界面提示用）。
		 * @param props.bridgeStateStore - 审批快捷裁决桥的状态 store（界面提示用）。
		 * @param props.setNotify - 写回系统弹窗开关（含权限申请）。
		 * @param props.setNotifyMode - 写回弹窗时机。
		 * @param props.setSound - 写回提示音开关。
		 * @param props.setSoundChoice - 写回音效下标（切换即发声）。
		 * @param props.setVolume - 写回音量。
		 * @param props.setSubagent - 写回子智能体提醒开关。
		 * @param props.setNotifyLanguage - 写回通知语言。
		 * @param props.setCustomSound - 写回自定义音效（存文件 + 解码 + 试听）。
		 * @param props.clearCustomSound - 清除自定义音效。
		 * @param props.reset - 恢复默认。
		 * @param props.updateStore - 「检查更新」状态 store（相位 / 版本 / 失败原因）。
		 * @param props.checkUpdate - 检查更新（问宿主源上最新版本是多少）。
		 * @param props.applyUpdate - 立即更新到刚查到的版本。
		 * @param props.reloadPage - 刷新页面（更新完后换上新版浏览器半侧）。
		 * @param props.notifySupported - 浏览器是否支持系统通知。
		 * @param props.customSupported - 浏览器是否能用 IndexedDB 存自定义音频。
		 * @param props.t - 本地化函数。
		 * @returns 设置页元素。
		 */
		function ReminderSection(props) {
			const notify = React.useSyncExternalStore(props.notifyStore.subscribe, props.notifyStore.getSnapshot);
			const notifyMode = React.useSyncExternalStore(props.notifyModeStore.subscribe, props.notifyModeStore.getSnapshot);
			const sound = React.useSyncExternalStore(props.soundStore.subscribe, props.soundStore.getSnapshot);
			const soundChoice = React.useSyncExternalStore(props.soundChoiceStore.subscribe, props.soundChoiceStore.getSnapshot);
			const volume = React.useSyncExternalStore(props.volumeStore.subscribe, props.volumeStore.getSnapshot);
			const subagent = React.useSyncExternalStore(props.subagentStore.subscribe, props.subagentStore.getSnapshot);
			const sticky = React.useSyncExternalStore(props.stickyStore.subscribe, props.stickyStore.getSnapshot);
			const notifyLanguage = React.useSyncExternalStore(props.notifyLanguageStore.subscribe, props.notifyLanguageStore.getSnapshot);
			// 这一行显示的是**生效语言**（默认跟随界面时＝界面语言），不是配置值本身。
			const notifyLanguageEffective = React.useSyncExternalStore(props.effectiveLanguageStore.subscribe, props.effectiveLanguageStore.getSnapshot);
			const customMeta = React.useSyncExternalStore(props.customMetaStore.subscribe, props.customMetaStore.getSnapshot);
			const customStatus = React.useSyncExternalStore(props.customStatusStore.subscribe, props.customStatusStore.getSnapshot);
			const permission = React.useSyncExternalStore(props.permissionStore.subscribe, props.permissionStore.getSnapshot);
			const bridgeState = React.useSyncExternalStore(props.bridgeStateStore.subscribe, props.bridgeStateStore.getSnapshot);
			const update = React.useSyncExternalStore(props.updateStore.subscribe, props.updateStore.getSnapshot);
			const updateFace = updatePresentation(update);
			// 隐藏的文件选择框：那个按钮点它，选中文件后走 onChange（浏览器只允许
			// 用户手势直接打开文件选择框，程序不能凭空读本地文件）。
			const customFileInput = React.useRef(null);
			const t = props.t;
			const isDefault = notify === DEFAULTS.notify
				&& notifyMode === DEFAULTS.notifyMode
				&& notifyLanguage === DEFAULTS.notifyLanguage
				&& sound === DEFAULTS.sound
				&& soundChoice === DEFAULTS.soundChoice
				&& volume === DEFAULTS.volume
				&& subagent === DEFAULTS.subagent
				&& sticky === DEFAULTS.sticky;
			// 说明只有真正需要解释的行使给（音效、自定义音效、音量、恢复默认）：
			// 开关与二选一本身自解释，写一长串说明只会让页面变吵。
			const switchRow = (rowKey, titleKey, value, setValue) => React.createElement(SettingRow, {
				key: rowKey,
				rowKey,
				title: t(titleKey),
				control: React.createElement(Switch, {
					checked: value === true,
					onChange: (next) => setValue(next === true),
					label: t(titleKey),
				}),
			});
			const children = [
				React.createElement('p', { style: INTRO_STYLE, key: 'intro' }, t('intro')),
				switchRow('notify', 'settings.notify.title', notify, props.setNotify),
			];
			// 弹窗时机：开关关着时不占一行。
			if (notify === true) {
				children.push(React.createElement(SettingRow, {
					key: 'notify-mode',
					rowKey: 'notify-mode',
					title: t('notify.mode.title'),
					// 两档各带一句说明，两行都摆出来（一档一行）。
					desc: [
						React.createElement('span', { key: 'always', style: MODE_DESC_LINE_STYLE }, t('notify.mode.always.description')),
						React.createElement('span', { key: 'unfocused', style: MODE_DESC_LINE_STYLE }, t('notify.mode.unfocused.description')),
					],
					control: React.createElement(Segmented, {
						value: notifyMode,
						label: t('notify.mode.title'),
						options: NOTIFY_MODES.map((mode) => ({ id: mode.id, label: t(mode.nameKey) })),
						onChange: (next) => props.setNotifyMode(next),
						// 两档上下排：和标题下面那两行说明一一对应着读。
						vertical: true,
					}),
				}));
				// 通知语言：只影响通知文案，设置页本身永远跟随界面语言。
				// 没有「跟随界面」这一档：默认（auto）时这里显示的就是界面语言，
				// 点哪一档就是钉住哪一档。
				children.push(React.createElement(SettingRow, {
					key: 'notify-language',
					rowKey: 'notify-language',
					title: t('notify.language.title'),
					control: React.createElement(Segmented, {
						value: notifyLanguageEffective,
						label: t('notify.language.title'),
						options: NOTIFY_LANGUAGES.map((language) => ({ id: language.id, label: t(language.nameKey) })),
						onChange: (next) => props.setNotifyLanguage(next),
					}),
				}));
			}
			// 子智能体提醒：放在弹窗时机之后，因为它只是「再多提醒一些什么」。
			children.push(switchRow('subagent', 'subagent.title', subagent, props.setSubagent));
			// 「弹窗一直挂着」：非自解释（为什么要有这个开关、代价是什么），所以给一句说明。
			children.push(React.createElement(SettingRow, {
				key: 'notify-sticky',
				rowKey: 'notify-sticky',
				title: t('notify.sticky.title'),
				desc: t('notify.sticky.description'),
				control: React.createElement(Switch, {
					checked: sticky === true,
					onChange: (next) => props.setSticky(next === true),
					label: t('notify.sticky.title'),
				}),
			}));
			children.push(switchRow('sound', 'settings.sound.title', sound, props.setSound));
			children.push(React.createElement(SettingRow, {
				key: 'sound-choice',
				rowKey: 'sound-choice',
				// 分段控件加一档要拿整行宽度：这一行上下排。
				stacked: true,
				title: t('sound.choice.title'),
				desc: t('sound.choice.description'),
				control: React.createElement(Segmented, {
					value: soundChoice,
					label: t('sound.choice.title'),
					// 四种合成音效 + 第五档「自定义」（上传本机音频）。
					options: [...SOUND_CHOICES.map((choice, index) => ({ id: index, label: t(choice.nameKey) })),
						{ id: CUSTOM_SOUND_CHOICE, label: t('sound.choice.custom') }],
					onChange: (next) => props.setSoundChoice(next),
				}),
			}));
			// 自定义音效：选择 / 清除本机音频，并如实显示当前状态（读取中 / 就绪 /
			// 解不开 / 存不下 / 文件丢了）。音频本体在 IndexedDB，元数据只用于显示。
			const customKey = props.customSupported !== true
				? 'sound.custom.unsupported'
				: (CUSTOM_SOUND_STATUS_KEYS[customStatus] ?? 'sound.custom.empty');
			const customDesc = customKey === 'sound.custom.ready' && customMeta !== null
				? t(customKey, { name: customMeta.name, size: Math.max(1, Math.round(customMeta.size / 1024)) })
				: t(customKey, { max: Math.round(CUSTOM_SOUND_MAX_BYTES / (1024 * 1024)) });
			children.push(React.createElement(SettingRow, {
				key: 'sound-custom',
				rowKey: 'sound-custom',
				title: t('sound.custom.title'),
				desc: customDesc,
				control: React.createElement('div', { style: CUSTOM_CONTROL_STYLE, key: 'custom-control' }, [
					React.createElement('input', {
						key: 'custom-file',
						type: 'file',
						accept: 'audio/*',
						ref: customFileInput,
						style: { display: 'none' },
						onChange: (event) => {
							const file = event?.target?.files?.[0];
							if (file !== undefined && file !== null) props.setCustomSound(file);
						},
					}),
					React.createElement(TextButton, {
						key: 'custom-pick',
						disabled: props.customSupported !== true,
						label: t('sound.custom.pick'),
						onClick: () => {
							const input = customFileInput.current;
							if (input !== null && input !== undefined && typeof input.click === 'function') {
								input.value = ''; // 允许连续两次选同一个文件（否则 change 不再触发）
								input.click();
							}
						},
					}),
					customMeta === null ? null : React.createElement(TextButton, {
						key: 'custom-clear',
						disabled: false,
						label: t('sound.custom.clear'),
						onClick: () => props.clearCustomSound(),
					}),
				]),
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
			// 审批快捷裁决不可用时如实说明（不安全上下文 / 桌面壳无法注册 worker）：
			// 按钮没了，但提醒照常，别让用户以为开关坏了。已知的两种情况用专门的
			// 文案（桌面壳、非安全上下文），其余把桥的原始状态附在括号里。
			if (notify === true && typeof bridgeState === 'string'
				&& (bridgeState.startsWith('failed:') || bridgeState.startsWith('unsupported:'))) {
				const desktopShell = typeof location !== 'undefined' && location !== null && location.protocol === 'dsh-app:';
				const approvalHintKey = desktopShell
					? 'notify.approval.desktop'
					: (bridgeState.startsWith('unsupported: insecure')
						? 'notify.approval.insecure'
						: 'notify.approval.unavailable');
				children.push(React.createElement('p', { style: NOTICE_STYLE, key: 'approval-hint' },
					t(approvalHintKey, { reason: bridgeState })));
			}
			if (showPermissionButton) {
				children.push(React.createElement('div', { style: { padding: '0 0 16px' }, key: 'notify-request' },
					React.createElement(TextButton, {
						disabled: false,
						label: t('notify.request'),
						onClick: () => props.setNotify(true),
					})));
			}
			// 页面最底部：检查更新 / 更新（放在所有配置与提示之后，是整页的收尾）。
			// 一个按钮三种动作：再查一次 / 现在就升 / 刷新页面看新版。
			children.push(React.createElement(SettingRow, {
				key: 'update',
				rowKey: 'update',
				title: t('update.title'),
				desc: t(updateFace.descKey, updateFace.descParams),
				control: React.createElement(TextButton, {
					disabled: updateFace.disabled,
					label: t(updateFace.labelKey, updateFace.labelParams),
					onClick: () => {
						if (updateFace.action === 'apply') props.applyUpdate();
						else if (updateFace.action === 'reload') props.reloadPage();
						else props.checkUpdate();
					},
				}),
			}));
			return React.createElement('div', { style: SECTION_STYLE }, children);
		}
		//#endregion

		/**
		 * 挂载插件：字典、八个配置 + 自定义音效元数据、完成事件订阅、前台跟踪、独立设置页。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-task-reminder: dictionaries');
			const t = ctx.locale.bind(NS);

			// 八个配置 + 自定义音效元数据：值落浏览器本地持久存储，重启后仍在；
			// 不需要宿主设置命名空间（音频本体在 IndexedDB，不进 localStorage）。
			const notifyStore = createSnapshotStore(DEFAULTS.notify, { persist: { name: NOTIFY_PERSIST_KEY } });
			const notifyModeStore = createSnapshotStore(DEFAULTS.notifyMode, { persist: { name: NOTIFY_MODE_PERSIST_KEY } });
			const soundStore = createSnapshotStore(DEFAULTS.sound, { persist: { name: SOUND_PERSIST_KEY } });
			const soundChoiceStore = createSnapshotStore(DEFAULTS.soundChoice, { persist: { name: SOUND_CHOICE_PERSIST_KEY } });
			const volumeStore = createSnapshotStore(DEFAULTS.volume, { persist: { name: VOLUME_PERSIST_KEY } });
			// 子智能体提醒：默认关。初始值与写回都过一遍归一化函数；从持久层读回来的
			// 值不经过它，所以消费处一律用「=== true」判定，坏值一律当关。
			const subagentStore = createSnapshotStore(resolveDoNotifySubagent(DEFAULTS.subagent), { persist: { name: SUBAGENT_PERSIST_KEY } });
			// 「弹窗一直挂着」同上：默认关，消费处 `=== true` 判定。
			const stickyStore = createSnapshotStore(resolveStickyNotifications(DEFAULTS.sticky), { persist: { name: STICKY_PERSIST_KEY } });
			// 通知文案语言：auto（跟随 DSH 界面）/ zh / en。只作用于通知，
			// 设置页本身永远跟随界面语言（同样只有写回时归一化，读出的坏值按 auto 处理）。
			const notifyLanguageStore = createSnapshotStore(resolveNotifyLanguage(DEFAULTS.notifyLanguage), { persist: { name: NOTIFY_LANGUAGE_PERSIST_KEY } });

			/**
			 * 通知实际生效的语言：设置钉了 zh / en 就用它，否则跟随 DSH 界面语言
			 * （locale 快照的 active），读不到界面语言时按中文。
			 * @returns 'zh' | 'en'。
			 */
			const resolvedNotifyLanguage = () => {
				const pinned = notifyLanguageStore.getSnapshot();
				if (pinned === NOTIFY_LANGUAGE_ZH || pinned === NOTIFY_LANGUAGE_EN) return pinned;
				try {
					return notifyLanguageFromLocale(ctx.locale.getSnapshot()?.active);
				} catch {
					// 读不到界面语言（老宿主 / 自检桩）：按中文。
					return NOTIFY_LANGUAGE_ZH;
				}
			};

			/**
			 * 通知文案的取词函数：按「通知语言」设置解析。
			 * 只用于通知（弹窗标题 / 正文 / 测试文案）；设置页一律用上面的 t()，
			 * 所以钉住通知语言不会把设置页也换成另一种语言。
			 * @param key - 字典键。
			 * @returns 该语言下的文案；字典里缺这个键时退回界面语言。
			 */
			const toastT = (key) => {
				const value = (resolvedNotifyLanguage() === NOTIFY_LANGUAGE_EN ? en : zh)[key];
				return typeof value === 'string' ? value : t(key);
			};
			// 设置页「通知语言」那一行选中哪一档：显示的是**生效语言**（默认跟随
			// 界面时就是界面语言），所以没有「跟随界面」这一档也不会显示成空白。
			// 界面语言变了要跟着变，所以同时订阅 locale。
			const effectiveLanguageStore = createSnapshotStore(resolvedNotifyLanguage());
			ctx.effect(() => notifyLanguageStore.subscribe(() => {
				effectiveLanguageStore.set(resolvedNotifyLanguage());
			}), 'dsh-task-reminder: effective notification language (config)');
			ctx.effect(() => {
				if (typeof ctx.locale.subscribe !== 'function') return () => {};
				return ctx.locale.subscribe(() => {
					effectiveLanguageStore.set(resolvedNotifyLanguage());
				});
			}, 'dsh-task-reminder: effective notification language (locale)');
			// 自定义音效的元数据（文件名 / 大小）：只用于设置页显示，落 localStorage；
			// 音频本体（几十 KB ~ 数 MB）进 IndexedDB，见 createCustomSoundStore。
			const customMetaStore = createSnapshotStore(normalizeCustomMeta(DEFAULTS.customSound), { persist: { name: CUSTOM_SOUND_PERSIST_KEY } });
			// 自定义音效的当前状态只活在内存里，供设置页如实提示：
			// idle / loading / ready / missing / decode-failed / store-failed / too-large。
			const customStatusStore = createSnapshotStore('idle');
			// 通知权限状态只活在内存里（浏览器随时可能被用户改），供设置页提示。
			const notifier = createNotifier();
			const permissionStore = createSnapshotStore(notifier.permission());
			// 审批快捷裁决的桥（页面侧）：把自己那份 bundle 注册成 Service Worker，
			// 用它弹带「同意 / 拒绝」按钮的通知；状态如实进 store，供设置页显示。
			const actionBridge = createActionBridge();
			const bridgeStateStore = createSnapshotStore(actionBridge.state);
			// 设置页最底部「检查更新」的状态：不持久化，每次打开设置页都从「还没查」开始。
			const updateStore = createSnapshotStore(UPDATE_IDLE);
			/**
			 * 卸载标记。`ctx.timer` 的兜底定时器会随插件卸载一起取消，但**分类本身是
			 * 异步的**（RPC + 裸 `setTimeout` 重试），没有这个标记时：卸载（热重载 /
			 * 停用 / 页面换新实例）之后落地的那次分类仍会弹窗、放音 —— 在一个已经不属于
			 * 自己的实例上。所有「等异步结果再动提醒」的路径都先看它。
			 */
			let disposed = false;

			/**
			 * 调一条宿主更新路由。桌面壳里 `window.fetch` 经 dsh-app 协议转发到宿主，
			 * 浏览器里就是同源请求（cookie 默认随请求带上，和 /api 的 RPC 同一条通道）。
			 * 宿主永远回 200 + JSON；这里只把「连不上 / 不是 JSON」变成一句能显示的说明。
			 * @param path - 以 `/` 开头的宿主路由。
			 * @param body - 可选请求体（更新时带目标版本）。
			 * @returns 宿主答复对象。
			 */
			const callUpdateRoute = (path, body) => {
				if (typeof window.fetch !== 'function') {
					return Promise.reject(new Error('no-fetch'));
				}
				const options = { method: 'POST', cache: 'no-store' };
				if (body !== undefined) {
					options.headers = { 'content-type': 'application/json' };
					options.body = JSON.stringify(body);
				}
				return window.fetch(updateRouteUrl(path), options).then((response) => {
					if (response === null || response === undefined || response.ok !== true) {
						throw new Error(`http${response === null || response === undefined ? '' : ` ${String(response.status)}`}`);
					}
					return response.json();
				}).then((payload) => {
					if (payload === null || typeof payload !== 'object') throw new Error('bad-payload');
					return payload;
				});
			};
			/** 检查更新：先亮「检查中」，宿主的答复（或失败）落地再推状态。 */
			const checkUpdate = () => {
				updateStore.set(updateReducer(updateStore.getSnapshot(), { type: 'check-start' }));
				return callUpdateRoute(UPDATE_CHECK_ROUTE).then(
					(result) => updateStore.set(updateReducer(updateStore.getSnapshot(), { type: 'check-result', result })),
					(error) => updateStore.set(updateReducer(updateStore.getSnapshot(), { type: 'check-failed', reason: updateErrorText(error) })),
				);
			};
			/** 立即更新到刚查到的那个版本；成功后按钮变成「刷新页面」。 */
			const applyUpdate = () => {
				const state = updateStore.getSnapshot();
				updateStore.set(updateReducer(state, { type: 'update-start' }));
				return callUpdateRoute(UPDATE_APPLY_ROUTE, { version: state.latest }).then(
					(result) => updateStore.set(updateReducer(updateStore.getSnapshot(), { type: 'update-result', result })),
					(error) => updateStore.set(updateReducer(updateStore.getSnapshot(), { type: 'update-failed', reason: updateErrorText(error) })),
				);
			};
			/**
			 * 「刷新页面」：web 里刷新后浏览器半侧就是新版了（宿主半侧要重启 DSH）；
			 * 刷新不了就什么都不做 —— 说明里本来就写着「重启 DSH 后生效」。
			 */
			const reloadPage = () => {
				try {
					if (window.location !== undefined && typeof window.location.reload === 'function') {
						window.location.reload();
					}
				} catch {
					// 拿不到 location 就算了。
				}
			};
			// 每个还没结清的审批通知：interaction key → { sessionId, tag }。
			// 裁决 / 等待消散时按它关通知、按 key 重新解析活对象。
			const approvalToasts = new Map();
			// 每个会话还没结清的「等待类」系统通知（提问 / 方案待确认，以及退回
			// 普通样式的审批）：sessionId → 通知对象。等待消散（用户已回答 / 交互
			// 被关掉）或会话从快照里消失时收掉 —— 否则通知中心里留着一条再也没有
			// 对应等待的陈旧条目，点它什么都不发生（「有时点了不跳」的疑凶）。
			const waitingToasts = new Map();
			// 每个会话最近一次听到的 running 状态，用来识别「running → 非 running」的边沿。
			const runningSessions = new Map();
			// 一次停止只报一次、报对一次：停止边沿到达时读会话持久日志最后一条
			// turn/end 的 reason 分类（completed / max-tokens → 完成，error →
			// 错误且不出现完成弹窗，aborted / blocked / interrupted → 不报）。
			// 分类读不到时退回完成弹窗，用对账窗口兜底：5 秒内后到的
			// api-session/error 撤回完成弹窗只留错误、不重响提示音；读不到
			// 回合号的完成→完成重复边沿也退回这张窗口去重（无号边沿不能变得
			// 可重复），有回合号的完成→完成去重见 lastReportedTurn。
			// 分类时限放宽到 700ms、重试加到 3 次：turn/end 落盘不在回合边界
			// 同步 flush，取消（aborted）的 turn/end 常要再等一两拍才读得到。
			const CLASSIFY_TIMEOUT_MS = 700;
			const CLASSIFY_RETRIES = 3;
			const CLASSIFY_RETRY_MS = 120;
			const recentReports = new Map(); // sessionId → { kind, notification, at, turn, cancel }
			// 每个会话「最近一次结清的停止边沿」所属回合号：
			//   分类读得 turn/end 的 data.turn 且与这里相等 → 同一次停止（通道重复 /
			//   列表陈旧回放），确定性丢掉，不再靠 5 秒窗口 —— 桌面端通道一稀疏，
			//   5 秒窗口会把「上一轮刚停 → 新任务开始 → 5 秒内又完成」的新回合
			//   当成重复边沿整条吞掉（1.5.4 修的就是这个）。
			//   有意不报的停止（aborted / blocked / interrupted、询问豁免）也记：
			//   它们同样只该处理一次，否则重复边沿会当成一次新停止再弹一条。
			//   读不到回合号的停止（兜底路径）没有号可记，它的重复边沿仍只由
			//   5 秒窗口兜着；同一会话的回合号假定单调递增（官方按 turn+1 记账），
			//   号真重复时那次停止会被永久当成已结清——不比误双弹更坏。
			//   不做清理：判据就是这个号，清掉等于把重复弹窗放回来；每条一个数字，
			//   没有定时器也没有别的资源，会话再多的量级也可以忽略。
			const lastReportedTurn = new Map(); // sessionId → turn
			// 询问回答后的完成豁免：一次交互一次提醒 —— 回答完紧接着的那次完成
			// 不弹（用户刚在屏幕前点完）。它有 45 秒窗口，且会话再次跑起来
			// （任一通道 running 位转 true）立刻作废：回答后 Agent 接着干活的
			// 回合结束必须照常提醒（1.5.2 修的就是「豁免挂太久把完成静音」）。
			const questionGrace = new Map(); // sessionId → 豁免截止时刻（ms）
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
				// 在通知上直接裁决的次数（审批快捷按钮）。
				decisions: 0,
				// 点通知正文「打开会话」成功的次数（失败只记 lastJump，不计数）。
				jumps: 0,
				// 通知 onclick 真的跑起来的次数（用来区分「handler 没跑」与「跳转失败」）。
				clicks: 0,
				recentStops: [], // 最近 6 条 { kind, sessionId, at }
				lastEvent: null,
				lastCompletion: null,
				lastQuestion: null,
				lastError: null,
				lastSound: null,
				lastDecision: null,
				// 最后一次「点通知正文 → 打开会话」的结果（{ sessionId, via, ok, error, at }）。
				lastJump: null,
				// 最后一次通知点击（{ kind, sessionId, at }）：为 null 说明 handler 根本没跑。
				lastClick: null,
			};
			/**
			 * 写 `stats.lastJump` 的同时压一份到**页面级**留痕（`jumpDiag`，跨热重载保留）。
			 *
			 * 为什么要多这一份：热重载会整份换掉模块作用域，`stats` 归零。这次排查里
			 * 「点了没反应 → 我去补留痕 → 热重载」的顺序，恰好把最关键的现场（那次点击
			 * 的跳转结果）擦掉了，只剩一个 null。留痕必须比插件实例活得久。
			 * @param record - 这一次跳转的结果记录。
			 */
			const setLastJump = (record) => {
				stats.lastJump = record;
				try {
					jumpDiag.last = record;
				} catch {
					// 留痕失败不影响跳转本身。
				}
			};
			/** 同上：`stats.lastQuestionJump` 的页面级副本。 */
			const setLastQuestionJump = (record) => {
				stats.lastQuestionJump = record;
				try {
					jumpDiag.question = record;
				} catch {
					// 留痕失败不影响落位本身。
				}
			};
			const chime = createChime();
			// 装载即创建 AudioContext（Windows 音频设备的冷初始化要 3-5 秒，让它
			// 在页面加载时提前付掉）；此刻无用户手势，context 会被自动播放策略
			// 挂在 suspended 且不渲染，第一条 gain=0 的预热音也仅是排队。真正
			// 开始播放要等第一次用户手势 —— 届时只剩毫秒级的 resume。
			// （浏览器控制台会留一条 "AudioContext was not allowed to start" 的
			// 提示，这是自动播放策略的正常记录，不是错误。）
			chime.warm();

			const customSounds = createCustomSoundStore();
			// 解码好的自定义音频（AudioBuffer）+ 版本号：解码 / 存盘都是异步的，
			// 期间用户又选了一个文件或点了清除时，晚到的结果据此作废，不会让旧
			// 文件的解码结果盖掉新选择。
			let customBuffer = null;
			let customRevision = 0;
			/**
			 * 把一条自定义音频记录解码成播放用的 AudioBuffer。
			 * @param revision - 取用时的版本号（结果落地时据此判断是否已作废）。
			 * @param blob - 音频字节（Blob / File）。
			 * @param preview - 解码成功后是否当场按当前音量试听（用户刚选完文件时为真）。
			 */
			const adoptCustomRecord = (revision, blob, preview) => {
				if (revision === customRevision) customStatusStore.set('loading');
				void chime.decode(blob).then((buffer) => {
					if (revision !== customRevision) return; // 期间又换文件 / 清了：这次结果作废
					customBuffer = buffer;
					customStatusStore.set('ready');
					if (preview === true) chime.playBuffer(buffer, volumeStore.getSnapshot());
				}).catch(() => {
					if (revision !== customRevision) return;
					customBuffer = null;
					customStatusStore.set('decode-failed');
				});
			};
			/**
			 * 写入自定义音效：校验 → 存 IndexedDB → 记元数据 → 切到自定义档 →
			 * 解码成功即试听一次。任何一步失败都如实写状态并回落合成音效，
			 * 不静默假装成功。
			 * @param file - 文件选择框给出的 File。
			 */
			const setCustomSound = (file) => {
				if (file === null || file === undefined || typeof file !== 'object') return;
				if (!indexedDbAvailable()) {
					customStatusStore.set('unsupported');
					return;
				}
				const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0;
				if (size > CUSTOM_SOUND_MAX_BYTES) {
					customStatusStore.set('too-large');
					return;
				}
				const meta = normalizeCustomMeta({
					name: typeof file.name === 'string' && file.name !== '' ? file.name : 'audio',
					size,
					type: typeof file.type === 'string' ? file.type : '',
					at: Date.now(),
				});
				// name 上面已兜成非空（'audio'），normalizeCustomMeta 必定返回元数据；
				// 这里不再写一个永远不会成立的 null 分支。
				const revision = (customRevision += 1);
				customStatusStore.set('loading');
				void customSounds.put({ ...meta, blob: file }).then((stored) => {
					if (revision !== customRevision) return;
					if (stored !== true) {
						customStatusStore.set('store-failed');
						return;
					}
					customMetaStore.set(meta);
					soundChoiceStore.set(CUSTOM_SOUND_CHOICE); // 选完文件即切到自定义档
					adoptCustomRecord(revision, file, true);
				});
			};
			/** 清除自定义音效：删 IndexedDB 记录与元数据，并切回第一种合成音效。 */
			const clearCustomSound = () => {
				customRevision += 1;
				customBuffer = null;
				customMetaStore.set(null);
				customStatusStore.set('idle');
				if (soundChoiceStore.getSnapshot() === CUSTOM_SOUND_CHOICE) soundChoiceStore.set(DEFAULT_SOUND_CHOICE);
				void customSounds.remove();
			};

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
			/** 写回「子智能体提醒」开关（只有布尔真值算打开）。 */
			const setSubagent = (next) => subagentStore.set(resolveDoNotifySubagent(next));
			const setSticky = (next) => stickyStore.set(resolveStickyNotifications(next));
			/** 写回通知语言（坏值归一化到 auto）。 */
			const setNotifyLanguage = (next) => notifyLanguageStore.set(resolveNotifyLanguage(next));
			/** 写回提示音开关。 */
			const setSound = (next) => soundStore.set(next === true);
			/**
			 * 写回音效下标（坏值归一化到默认档），并立即按新音效与当前音量发声 ——
			 * 在设置页切换音效就是试听，不用再多点一步。切到自定义档而音频还没
			 * 解码好时，play 内部回落到第一种合成音效，不会静默无声。
			 * @param next - 目标音效下标。
			 */
			const setSoundChoice = (next) => {
				const resolved = resolveSoundChoice(next);
				soundChoiceStore.set(resolved);
				chime.play(resolved, volumeStore.getSnapshot(), customBuffer);
			};
			/** 写回音量百分比。 */
			const setVolume = (next) => volumeStore.set(clampVolume(next));
			/** 恢复默认：七个配置全部写回出厂值，权限提示同步刷新。 */
			const resetAll = () => {
				notifyStore.set(DEFAULTS.notify);
				notifyModeStore.set(DEFAULTS.notifyMode);
				notifyLanguageStore.set(DEFAULTS.notifyLanguage);
				soundStore.set(DEFAULTS.sound);
				// 自定义音效文件是用户的素材、不是配置值：恢复默认只把音效档写回
				// 第一种合成音效，文件留着（要删点「自定义音效」行的「清除」）。
				soundChoiceStore.set(DEFAULTS.soundChoice);
				volumeStore.set(DEFAULTS.volume);
				subagentStore.set(DEFAULTS.subagent);
				stickyStore.set(DEFAULTS.sticky);
				if (notifier.supported) permissionStore.set(notifier.permission());
			};

			// 在途的「回到提问位置」轮询定时器：卸载时统一取消，不让回调落地。
			const questionTimers = new Set();
			ctx.effect(() => () => {
				for (const cancel of questionTimers) cancel();
				questionTimers.clear();
			}, 'dsh-task-reminder: focus question');
			/**
			 * 点弹窗后把阅读位置对到这次提问上（见文件头要点 8）。打开会话是同步的，
			 * 但会话历史挂上来要几拍，应用的 `reading.restore()` 也可能晚于第一拍
			 * 落地，所以按固定节奏轮询：找到你的消息行就对齐，连续
			 * QUESTION_STABLE_ATTEMPTS 拍都在容差内才算坐稳，坐不稳继续（最多
			 * QUESTION_MAX_ATTEMPTS 拍）。全程只读 DOM + 写一次 scrollTop，认不出来
			 * 就静默收工 —— 打开会话这条主路径不受影响。
			 * @param sessionId - 相关会话（只进排障统计）。
			 */
			const focusLatestQuestion = (sessionId = null) => {
				let attempts = 0;
				let stable = 0;
				/** 收工并记一笔排障结果（`__dshTaskReminder.state().stats.lastQuestionJump`）。 */
				const settle = (result) => {
					setLastQuestionJump({ sessionId, result, attempts, at: Date.now() });
				};
				const schedule = () => {
					const cancel = ctx.timer.timeout(() => {
						questionTimers.delete(cancel);
						step();
					}, QUESTION_POLL_MS);
					questionTimers.add(cancel);
				};
				const step = () => {
					attempts += 1;
					// 对着「目标会话那一列」对齐（见 pickConversationColumn）：DOM 里可能
					// 同时挂着好几个会话流列，盲取第一个就可能滚错会话。
					const column = pickConversationColumn(document, sessionId);
					if (column === null) {
						if (attempts >= QUESTION_MAX_ATTEMPTS) settle('no-column');
						else schedule();
						return;
					}
					// 会话还没切过来（挂的还是上一次那个）：先不动，下一拍再看。
					const mounted = mountedSessionId(column);
					if (sessionId !== null && mounted !== null && mounted !== sessionId) {
						// 目标没挂上来：说明 `openSession` 被 DSH 自己的导航 / 恢复到原
						// 会话盖掉了（同工作区实测小概率复现：「留痕全绿、界面没动」）。
						// 每 4 拍补一次 `openSession`（幂等），别把 15 拍全用来干等。
						if (attempts % 4 === 0) {
							try {
								ctx.uiWorkspace.openSession(sessionId);
							} catch {
								// 补开失败不改变结论，继续等。
							}
						}
						if (attempts >= QUESTION_MAX_ATTEMPTS) settle('other-session');
						else schedule();
						return;
					}
					const row = findLatestQuestionRow(column);
					if (row === null) {
						if (attempts >= QUESTION_MAX_ATTEMPTS) settle('no-question');
						else schedule();
						return;
					}
					const scroller = questionScroller(column);
					if (scroller === null) {
						settle('no-scroller');
						return;
					}
					if (alignQuestionRow(row, scroller) === 'aligned') {
						stable += 1;
						if (stable >= QUESTION_STABLE_ATTEMPTS) {
							settle('aligned');
							return;
						}
					} else {
						stable = 0;
					}
					if (attempts >= QUESTION_MAX_ATTEMPTS) {
						settle('timeout');
						return;
					}
					schedule();
				};
				schedule();
			};

			/**
			 * 某个会话属于哪个工作区（读工作区快照的 items[].sessionIds）。
			 * 认不出来返回 null —— 调用方据此退回「按当前工作区直接开会话」。
			 * @param sessionId - 会话 id。
			 * @returns workspaceId 或 null。
			 */
			const workspaceIdOfSession = (sessionId) => {
				if (typeof sessionId !== 'string' || sessionId === '') return null;
				try {
					const snapshot = ctx.uiWorkspace?.workspaces?.list?.getSnapshot();
					const items = Array.isArray(snapshot?.items) ? snapshot.items : null;
					if (items === null) return null;
					const hit = items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId));
					return typeof hit?.workspaceId === 'string' && hit.workspaceId !== '' ? hit.workspaceId : null;
				} catch {
					return null;
				}
			};
			/**
			 * 当前主视图挂在哪个会话上（DSH 自己的 `mainReference`，与它的
			 * `startSession` 判当前工作区用的是同一个来源）。
			 * @returns 会话 id 或 null。
			 */
			const currentMainSessionId = () => {
				try {
					const id = ctx.uiWorkspace?.mainReference?.sessionId;
					return typeof id === 'string' && id !== '' ? id : null;
				} catch {
					return null;
				}
			};

			/**
			 * 「先切工作区、再开会话」——`openSession` 只在**当前工作区内**生效，
			 * 目标会话在别的工作区时它既不抛错也不切界面（2026-10-07 实测：真实点击
			 * 那次 `crossWorkspace:false`、`lastJump.ok:true`，而 `mainReference`
			 * 压根没动 —— 点了不跳会话就是这个）。所以这条路必须先把工作区切过去。
			 * @param id - 目标会话。
			 * @param via - 来源（page / sw / debug）。
			 * @param workspace - 目标会话所属工作区。
			 * @param mainBefore - 切之前 DSH 的当前会话（留痕用）。
			 * @param recoveredBy - 非空表示这是「首开没生效之后的补救」，写进留痕。
			 * @param after - 目标会话开完之后（核对挂载前）跑。
			 * @returns 是否已经把「切工作区」这一步发出去。
			 */
			const openWorkspaceThenSession = (id, via, workspace, mainBefore, recoveredBy, after) => {
				const base = { sessionId: id, via, crossWorkspace: true, mainSessionBefore: mainBefore, ...(recoveredBy === null ? {} : { recoveredBy }) };
				setLastJump({ ...base, ok: false, error: null, at: Date.now() });
				let opening;
				try {
					opening = ctx.uiWorkspace.openWorkspace(workspace);
				} catch (error) {
					setLastJump({ ...base, ok: false, error: String(error?.message ?? error), at: Date.now() });
					return false;
				}
				Promise.resolve(opening).then(() => {
					try {
						ctx.uiWorkspace.openSession(id);
					} catch (error) {
						setLastJump({ ...base, ok: false, error: String(error?.message ?? error), at: Date.now() });
						return;
					}
					stats.jumps += 1;
					setLastJump({ ...base, ok: true, mounted: false, mainSession: currentMainSessionId(), error: null, at: Date.now() });
					if (typeof after === 'function') after();
				}, (error) => {
					setLastJump({ ...base, ok: false, error: String(error?.message ?? error), at: Date.now() });
				});
				return true;
			};

			/**
			 * 跳转核对：确认界面真的切到目标会话了。
			 *
			 * 为什么需要：DSH 的挂载是异步的，`openSession` 之后界面还可能被 DSH
			 * 自己的导航 / 当前会话恢复到原处盖掉（同工作区实测也有小概率「留痕
			 * 全绿、界面没动」），跨工作区还要等 `openWorkspace` 落地。核对到目标
			 * 挂上来了再开始「落到提问位置」（早滚会滚错会话），还挂在别的会话上
			 * 就再开一次（幂等），一直没对上就如实留痕 `mounted:false`。
			 *
			 * 对不上时还多一手：光重开 `openSession` 治不了「目标在别的工作区」这种
			 * 情况（它静默无效），所以每 4 拍**升级**一次——认得出工作区就改走
			 * 「先切工作区、再开会话」（`openWorkspaceThenSession`），一辈子只升级一次
			 * 免得来回切。`recoveredBy: 'open-workspace-retry'` 就是这一手留下的痕。
			 * @param id - 目标会话。
			 * @param via - 来源（page / sw / debug）。
			 * @param attempt - 已经核对的拍数。
			 * @param escalated - 已经升级过一次（不再升级）。
			 */
			const verifyJumpMounted = (id, via, attempt = 0, escalated = false) => {
				const cancel = ctx.timer.timeout(() => {
					questionTimers.delete(cancel);
					const column = pickConversationColumn(document, id);
					const mounted = mountedSessionId(column);
					// `mainReference` 是比 DOM 更可靠的信号：现场见过三个会话流列
					// **共用**一个挂着 `data-conversation-session` 的外层壳 —— 列上的
					// 会话号读出来全一样，DOM 分辨不了到底显示了哪个会话。DSH 自己的
					// 当前会话判据（也是 sidebar 高亮用的那个）不会骗人。
					const main = currentMainSessionId();
					const domMatched = mounted === id;
					const mainMatched = main === id;
					if (domMatched || mainMatched) {
						const previous = stats.lastJump ?? {};
						setLastJump({
							...previous,
							sessionId: id,
							via,
							ok: true,
							mounted: true,
							verifiedBy: domMatched ? (mainMatched ? 'dom+main' : 'dom') : 'main-reference',
							mainSession: main,
							error: null,
							at: Date.now(),
						});
						focusLatestQuestion(id);
						return;
					}
					// 目标会话还没挂上来（还没切过去 / 页面上根本没有这一列）：
					// 到上限就如实留痕 mounted:false。
					if (attempt + 1 >= JUMP_VERIFY_ATTEMPTS) {
						const previous = stats.lastJump ?? {};
						setLastJump({ ...previous, sessionId: id, via, ok: false, mounted: false, mainSession: main, error: 'target session did not mount in time', at: Date.now() });
						return;
					}
					// 先试升级那一手：光重开 `openSession` 治不了「目标在别的工作区」，
					// 那种情况它静默无效。认得出目标工作区、且它不等于当前工作区，
					// 就改走「先切工作区、再开会话」（一辈子只升级一次，免得来回切）。
					const workspace = escalated ? null : workspaceIdOfSession(id);
					if (workspace !== null && workspace !== workspaceIdOfSession(main)) {
						openWorkspaceThenSession(id, via, workspace, main, 'open-workspace-retry', () => verifyJumpMounted(id, via, attempt + 1, true));
						return;
					}
					// 还挂在别的会话上：再开一次（幂等）。画面信息一点都没有时只是等，
					// 别乱开会话。
					if (mounted !== null || main !== null) {
						try {
							ctx.uiWorkspace.openSession(id);
						} catch {
							// 再开一次失败不改变结论，继续核对。
						}
					}
					verifyJumpMounted(id, via, attempt + 1, escalated);
				}, QUESTION_POLL_MS);
				questionTimers.add(cancel);
			};

			/**
			 * 点通知正文后「打开会话 + 落到这次提问」。
			 *
			 * 走页面级转发表（见 clickRouterOf）而不是被通知闭包直接调：通知对象
			 * 比插件实例活得久 —— 插件热重载 / 升级之后，系统通知中心里的旧条目
			 * 还在，旧实例的 ctx 已经 dispose，直接调 openSession 会抛错并被吞掉，
			 * 表现就是「点了弹窗不跳会话」。转发表永远指向当前实例。
			 * 每一次尝试都记进 `stats.lastJump`（这条链路以前全静默）。
			 * @param sessionId - 目标会话。
			 * @param via - 点击来源：page（普通通知）/ sw（带按钮通知经 worker 转回）。
			 * @returns 是否真的把会话打开了。
			 */
			const jumpToSession = (sessionId, via) => {
				const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
				if (id === null) return false;
				// `mainReference` 是 DSH 自己的「当前主视图会话」（sidebar 高亮、startSession
				// 判当前工作区都用它）。`openSession` 同步把它指到目标会话 —— 于是
				// **不必等 DOM** 就能当场判断这次跳转有没有生效：`mainSession` 仍是别人
				// 就说明 `openSession` 没吃下这个会话（跨工作区最典型，见下）。
				const mainBefore = currentMainSessionId();
				// 跨工作区：`openSession` 只在**当前工作区内**生效 —— 目标会话在别的
				// 工作区时它既不抛错也不切界面（2026-10-07 实测：lastJump ok:true、
				// 抬窗 204，而 mainReference 压根没动）。所以先切工作区再开会话。
				//
				// **当前工作区认不出来时也走这条路**（`currentWorkspace === null`）：
				// 认不出多半是工作区快照还没加载完 / mainReference 还是空的，而这时
				// 直接 openSession 在别的工作区上就是静默无效 —— 2026-10-07 那次真实
				// 点击正是 `crossWorkspace:false` 踩了这个坑（手动 jump 时快照已就绪，
				// 走了切工作区那条路，一跳就成）。
				const targetWorkspace = workspaceIdOfSession(id);
				const currentWorkspace = workspaceIdOfSession(mainBefore);
				if (targetWorkspace !== null && targetWorkspace !== currentWorkspace) {
					return openWorkspaceThenSession(id, via, targetWorkspace, mainBefore, null, () => {
						// 切完工作区先核对挂载，确认界面真的到目标会话上再滚（见 verifyJumpMounted）。
						verifyJumpMounted(id, via);
					});
				}
				try {
					ctx.uiWorkspace.openSession(id);
				} catch (error) {
					setLastJump({ sessionId: id, via, ok: false, crossWorkspace: false, mainSessionBefore: mainBefore, error: String(error?.message ?? error), at: Date.now() });
					return false;
				}
				stats.jumps += 1;
				// `mainSession` 紧跟着读：不等于 `id` 就是「openSession 没生效」的铁证
				// （2026-10-07 现场：lastJump ok、mounted 假绿，而界面根本没换会话）。
				const mainAfter = currentMainSessionId();
				setLastJump({ sessionId: id, via, ok: true, crossWorkspace: false, mounted: false, mainSessionBefore: mainBefore, mainSession: mainAfter, error: null, at: Date.now() });
				// 当场就知道没生效（`mainReference` 没动）＋认得出目标工作区：立刻改走
				// 「先切工作区、再开会话」，别把 5 秒轮询耗在注定无效的 openSession 上。
				if (mainAfter !== id && targetWorkspace !== null) {
					return openWorkspaceThenSession(id, via, targetWorkspace, mainBefore, 'open-workspace', () => {
						verifyJumpMounted(id, via);
					});
				}
				// 同工作区也走同一个落地轮询：`openSession` 是同步的、界面挂载是异步的，
				// 中间可能被 DSH 自己的导航/恢复到原会话盖掉（实测同工作区也有小概率
				// 「留痕全绿、界面没动」）。focusLatestQuestion 的轮询会发现「界面还挂在
				// 别的会话上」，并顺手再开一次（见那里的说明）。
				focusLatestQuestion(id);
				return true;
			};
			// 通知回调只认这张表：插件重载后旧通知也能跳到当前实例（见 clickRouterOf）。
			// 卸载时只清自己那一份 —— 热重载可能先装新实例再卸旧实例，无条件清会把新实例抹掉。
			const clickRouter = clickRouterOf();
			const ownClickHandler = (sessionId) => jumpToSession(sessionId, 'page');
			if (clickRouter !== null) clickRouter.handler = ownClickHandler;
			ctx.effect(() => () => {
				if (clickRouter !== null && clickRouter.handler === ownClickHandler) clickRouter.handler = null;
			}, 'dsh-task-reminder: notification click router');

			/**
			 * 发一条系统弹窗：点击时窗口回前台并打开对应会话。
			 * @param title - 弹窗标题（按停止原因选）。
			 * @param body - 弹窗正文（会话名 / 问题 / 错误信息）。
			 * @param sessionId - 相关会话。
			 * @param kind - 通知类型（NOTIFY_KIND_*）：只用于留痕与保活表的键，不再决定 tag
			 *   （tag 已回到「每条独立」，见 notifier.show）。
			 */
			const notify = (title, body, sessionId, kind) => {
				const suffix = typeof kind === 'string' && kind !== '' ? kind : NOTIFY_KIND_COMPLETED;
				const notification = notifier.show(title, body, () => {
					// 点击留痕：先分清「handler 到底跑没跑」。Electron 在 Windows 上
					// 「在系统通知中心里点」不投递 click 是已知问题（electron#29461），
					// lastClick 为空就说明问题不在插件这一侧。
					stats.clicks += 1;
					stats.lastClick = { kind: suffix, sessionId: typeof sessionId === 'string' ? sessionId : null, at: Date.now() };
					// 同一笔也写进**页面级**留痕（见 diagnosticRouter）：插件热重载会把
					// stats 整个换成新实例的零值，现场证据就没了 —— 而热重载恰恰是
					// 「点了没反应」最常见的伴生条件之一。
					clickDiag.count += 1;
					clickDiag.last = { ...stats.lastClick, build: PLUGIN_BUILD, count: clickDiag.count };
					toastRegistryOf()?.delete(suffix);
					// 再问页面级转发表（当前实例）；插件已经卸载、表里没人时退回本
					// 闭包的 ctx —— 后者多半也是死的，但比什么都不做多一次机会。
					const handler = clickRouterOf()?.handler ?? null;
					if (typeof handler === 'function') {
						handler(sessionId);
						return;
					}
					try {
						ctx.uiWorkspace.openSession(sessionId);
						focusLatestQuestion(sessionId); // 打开会话后落到这次提问（要点 8）
					} catch {
						// 会话打开失败也不影响弹窗本身。
					}
				}, stickyStore.getSnapshot() === true);
				if (notification !== null) {
					stats.notifications += 1;
					// 保活（见 toastRegistryOf）：同类只留最近一条，点击/卸载时释放。
					toastRegistryOf()?.set(suffix, notification);
				}
				return notification;
			};

			/** 按当前开关排一次提示音，并记进排障计数。 */
			const chimeNow = () => {
				if (soundStore.getSnapshot() !== true) return;
				const sounded = chime.play(soundChoiceStore.getSnapshot(), volumeStore.getSnapshot(), customBuffer);
				if (sounded?.scheduled === true) stats.sounds += 1;
				stats.lastSound = { ...sounded, at: Date.now() };
			};

			/**
			 * 用 worker 弹一条带「同意 / 拒绝」按钮的审批通知。桥不可用 / 权限没给
			 * 就返回 false，由调用方退回普通通知（不假装有按钮）。
			 * @param key - interaction key（测试路径用固定的测试 key）。
			 * @param sessionId - 相关会话（测试路径为 null）。
			 * @param title - 通知标题。
			 * @param body - 通知正文。
			 * @returns 是否走了带按钮的那条路。
			 */
			const showApprovalToast = (key, sessionId, title, body) => {
				if (!actionBridge.active || notifier.permission() !== 'granted') return false;
				// 桌面壳（dsh-app://）：这一版明确不让审批通知走 worker 转信那条点击链路
				// —— 桌面端「点通知把窗口拉回前台」是命脉，普通 onclick 那条路才是验证过
				// 的；worker 弹出的通知点正文要先经转信再回页面，抬窗还会被「谁该 navigate」
				// 的调度影响。这里直接退回普通通知。
				if (typeof location !== 'undefined' && location !== null && location.protocol === 'dsh-app:') return false;
				// 带按钮的通知自己占一个 tag 槽位：它的 tag 要是被别的等待顶掉，
				// 按钮就跟着消失了（这条是 Service Worker 弹的持久通知，不是普通横幅）。
				const tag = `${NOTIFICATION_TAG}-${NOTIFY_KIND_WAITING}-${key}`;
				approvalToasts.set(key, { sessionId, tag });
				const shown = actionBridge.show(title, {
					body,
					tag,
					silent: true,
					// 同上：由「弹窗一直挂着」开关决定（默认关，带按钮的审批也走它）。
					requireInteraction: stickyStore.getSnapshot() === true,
					data: { key, sessionId },
					actions: [
						{ action: 'approve', title: toastT('toast.approve') },
						{ action: 'reject', title: toastT('toast.reject') },
					],
				});
				if (shown) {
					stats.notifications += 1;
					return true;
				}
				// 交出去却失败（worker 被回收等）：账清掉，退回普通通知。
				approvalToasts.delete(key);
				return false;
			};
			/** 关掉某个审批通知（等待消散 / 已从别处裁决），并从账上删掉。 */
			const closeApprovalToast = (key) => {
				const entry = approvalToasts.get(key);
				if (entry === undefined) return;
				approvalToasts.delete(key);
				actionBridge.closeTag(entry.tag);
			};
			/** 关掉某个会话下所有还没结清的审批通知（等待消散时用）。 */
			const closeApprovalToastsOfSession = (sessionId) => {
				for (const [key, entry] of [...approvalToasts]) {
					if (entry.sessionId === sessionId) closeApprovalToast(key);
				}
			};
			/**
			 * 收掉某个会话还没结清的等待类通知（提问 / 方案待确认 / 退回普通样式的
			 * 审批）。等待消散或会话消失时调 —— 通知中心里不留「点了再也没有对应
			 * 等待」的陈旧条目。已经被点掉 / 系统收过的 close() 抛错直接吞掉。
			 * @param sessionId - 会话 id。
			 */
			const closeWaitingToast = (sessionId) => {
				const toast = waitingToasts.get(sessionId);
				if (toast === undefined) return;
				waitingToasts.delete(sessionId);
				try {
					toast.close();
				} catch {
					// 已经关掉了（用户点过 / 系统收过）。
				}
			};
			/**
			 * 按 key 重新解析**活**的审批交互对象。key 是每次页面装载重新编号的
			 * （approval:<n>），所以只能拿快照里的当前对象，不能用弹窗时抓住的那个：
			 * 等待可能已经被新的请求顶替。
			 * @param key - 通知上带的 interaction key。
			 * @returns 活对象；没有了则为 null。
			 */
			const findLiveApproval = (key) => {
				try {
					for (const value of ctx.uiSession.sessionStatus.getSnapshot().values()) {
						const interaction = value?.pendingInteraction;
						if (interaction !== null && interaction !== undefined
							&& interaction.kind === 'approval' && interaction.key === key) return interaction;
					}
				} catch {
					// 读不到快照就当没有：宁可什么都不裁决，也不要裁错。
				}
				return null;
			};
			/**
			 * 在通知上完成一次裁决：调审批卡片自己那个 `answer(...)`
			 * （'allowed-once' = 允许一次，'rejected' = 拒绝，不多放行任何东西）。
			 * 一次点击只认领一条：先从账上删掉（重复点击 / 陈旧通知直接变空操作）。
			 * @param key - interaction key。
			 * @param outcome - APPROVAL_GRANT 或 APPROVAL_REJECT。
			 * @returns 是否真的裁决了。
			 */
			const decideApproval = (key, outcome) => {
				// 一次点击只认领一条：账上没有就是已经被别处裁决过（或陈旧通知），
				// 直接当空操作 —— 绝不对同一个请求调第二次 answer。
				if (!approvalToasts.has(key)) return false;
				// 排障用的测试通知：只反馈点了哪个按钮，不裁决任何真实请求。
				if (key === TEST_APPROVAL_KEY) {
					closeApprovalToast(key);
					stats.decisions += 1;
					stats.lastDecision = { key, outcome, at: Date.now(), test: true };
					notify(toastT('toast.completed.title'),
						toastT(outcome === APPROVAL_GRANT ? 'test.approved' : 'test.rejected'), null, NOTIFY_KIND_COMPLETED);
					return true;
				}
				closeApprovalToast(key);
				const interaction = findLiveApproval(key);
				if (interaction === null || typeof interaction.answer !== 'function') return false;
				try {
					const settled = interaction.answer(outcome);
					if (settled !== null && typeof settled === 'object' && typeof settled.then === 'function') settled.catch(() => {});
				} catch {
					// answer 会拒掉「已经裁决过」的重复调用：不外抛。
					return false;
				}
				stats.decisions += 1;
				stats.lastDecision = { key, outcome, at: Date.now() };
				return true;
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
			 * 这个会话的停止该不该走提醒流程（三种停止 + 出错事件共用的第一道闸）。
			 * 只有子智能体会话且用户没打开「子智能体提醒」时才挡下：挡在整条流程
			 * 的最前面 —— 边沿表、分类、提示音、弹窗、待答集合、grace 全都不参与，
			 * 子智能体与父会话各自独立，父会话自己的完成照常提醒。
			 * @param sessionId - 会话 id。
			 * @returns true = 该提醒。
			 */
			const shouldRemindFor = (sessionId) => {
				if (subagentStore.getSnapshot() === true) return true;
				return !isSubagentSession(ctx, sessionId);
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
				// 又跑起来了 = 上一轮交互之后的「紧随完成」豁免作废。三条通道都要
				// 作废：1.5.1 只在转发事件那条通道里清，桌面端 0 条转发事件时豁免
				// 会一直挂到会话结束，把真正的回合完成静音（1.5.2 修的就是这里）。
				if (running === true) questionGrace.delete(sessionId);
				return running !== true && wasRunning;
			};

			/**
			 * 记一次「询问已回答」：开启一小段完成豁免窗口（见 QUESTION_GRACE_MS）。
			 * @param sessionId - 会话 id。
			 */
			const markQuestionSettled = (sessionId) => {
				questionGrace.set(sessionId, Date.now() + QUESTION_GRACE_MS);
			};

			/**
			 * 取用该会话的完成豁免：窗口外的（Agent 回答后又干了一会儿活）不算，
			 * 顺带把条目删掉（一次交互只豁免一次）。
			 * @param sessionId - 会话 id。
			 * @returns 这次完成是否该被豁免。
			 */
			const takeQuestionGrace = (sessionId) => {
				const deadline = questionGrace.get(sessionId);
				questionGrace.delete(sessionId);
				return typeof deadline === 'number' && Date.now() < deadline;
			};

			/**
			 * 读会话持久日志最后一条 turn/end 的原因与所属回合号。turn/end 落盘
			 * 不在回合边界同步 flush，RPC 读存储会强制 flush；读不到就重试几次，
			 * 仍读不到返回 null（调用方走兜底）。
			 * 同时取最后一条 `turn/start`：最新回合还没闭合（start 比 end 新）时，
			 * 最后一条 turn/end 属于上一个回合（停止场景常是上一个回合的
			 * completed）——此时当次读不到，交给重试等本次回合的 turn/end 落盘，
			 * 避免把取消误报成「完成」。
			 * 回合号（`turn/end` 的 data.turn）一并带出：调用方用它做「同一次停止」
			 * 的确定性去重；老日志没有号时 turn 为 null，调用方退回 5 秒窗口。
			 * @param sessionId - 会话 id。
			 * @returns `{ reason, turn }`（turn 读不到号时为 null），或 null。
			 */
			const readTurnEndReason = async (sessionId) => {
				for (let attempt = 0; ; attempt += 1) {
					if (disposed) return null; // 插件已卸载：结果无处可报，剩下几次重试直接省掉
					let classified = null;
					try {
						classified = await ctx.sessions.using(sessionId, { source: 'task-reminder' }, async (reference) => {
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
							const reason = lastEnd.data?.reason;
							if (reason === null || reason === undefined) return null;
							return { reason, turn: typeof endTurn === 'number' ? endTurn : null };
						});
					} catch {
						// retain / open 失败（会话不在册、Host 侧拒绝等）：当次读不到。
					}
					if (classified !== null && classified !== undefined) return classified;
					if (attempt >= CLASSIFY_RETRIES) return null;
					await new Promise((resolve) => { setTimeout(resolve, CLASSIFY_RETRY_MS); });
				}
			};

			/** 错误弹窗正文：网关原文优先，空则退回会话名。 */
			const errorBody = (sessionId, message) => (typeof message === 'string' && message !== '' ? message : titleOf(ctx, sessionId));

			/**
			 * 审批请求的弹窗正文：工具名 + 挂起理由。
			 * 与提问 / 方案待确认不同，宿主侧审批交互（PendingApproval）不带
			 * questions 列表，要批准的内容在 toolName / reason / displayReason 上。
			 * displayReason 是本地化展示文案（{ en, zh, ... }），按通知语言取对应
			 * 键，取不到退回 en，再退回未本地化的 reason；两者都空时返回 null，
			 * 由调用方决定兜底（会话名）——会话名只是兜底，不是审批内容本身。
			 * @param pending - 会话状态快照里的挂起交互。
			 * @returns 正文文本；无可用字段时返回 null。
			 */
			const approvalBodyText = (pending) => {
				const english = resolvedNotifyLanguage() === NOTIFY_LANGUAGE_EN;
				let reason = null;
				const display = pending.displayReason;
				if (display !== null && typeof display === 'object') {
					const localized = (english ? display.en : display.zh) ?? display.en;
					if (typeof localized === 'string' && localized !== '') reason = localized;
				}
				if (reason === null && typeof pending.reason === 'string' && pending.reason !== '') reason = pending.reason;
				const tool = typeof pending.toolName === 'string' && pending.toolName !== '' ? pending.toolName : null;
				if (tool === null) return reason;
				if (reason === null) return tool;
				return `${tool}${english ? ': ' : '：'}${reason}`;
			};

			/**
			 * 挂起交互正文的语言兜底：中文通知语言下，把宿主的英文原文换成对照文案
			 * （见 HOST_TEXT_ZH）。只替换逐字命中的宿主文案 —— 用户的提问本来就
			 * 可能是中文、也可能是模型写的任意语言，认不出就原样透传。
			 * 英文通知语言下不做任何替换（英文原文才是对的）。
			 * @param text - 挂起载荷里的问题原文。
			 * @returns 用于弹窗正文的文本。
			 */
			const localizeHostText = (text) => {
				if (resolvedNotifyLanguage() !== NOTIFY_LANGUAGE_ZH) return text;
				if (typeof text !== 'string' || text === '') return text;
				const known = HOST_TEXT_ZH[text];
				return typeof known === 'string' ? known : text;
			};

			/**
			 * 记一笔近期报告（对账窗口内有效）：后到的冲突事件据此撤回完成
			 * 弹窗或跳过重复报告，到点自动遗忘。
			 * @param sessionId - 会话 id。
			 * @param kind - 'completion' | 'error'。
			 * @param notification - 实际发出的通知（被开关挡下时为 null）。
			 * @param turn - 这次报告所属的回合号（读不到号时为 null）。
			 */
			const trackReport = (sessionId, kind, notification, turn) => {
				const entry = { kind, notification, at: Date.now(), turn: typeof turn === 'number' ? turn : null, cancel: null };
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

			/**
			 * 报一次完成：提示音 + 弹窗（均受各自开关门控），记入对账窗口。
			 * @param sessionId - 会话 id。
			 * @param source - 触发来源（event / list / status），仅用于排障。
			 * @param turn - 这次停止所属的回合号（兜底路径读不到时为 null/undefined）。
			 */
			const reportCompletion = (sessionId, source, turn) => {
				const knownTurn = typeof turn === 'number' ? turn : null;
				const prior = freshReport(sessionId);
				if (prior?.kind === 'error') return; // 本停止已按错误报过（错误优先，不区分回合号）
				// 完成→完成去重：只挡「这次读不到回合号 / 票据读不到回合号 / 两边同号」
				// 的重复。票据与本次是两个不同的回合号＝新回合，照报——桌面端通道一
				// 稀疏，上一轮的完成票据没人清，用 5 秒窗口会把 5 秒内的新回合吞掉
				// （1.5.4 修的就是这个）；同号重复边沿已由 complete() 的回合号判据
				// 挡在更前面，这里只是无号边沿的兜底。
				if (prior?.kind === 'completion' && (knownTurn === null || prior.turn === null || prior.turn === knownTurn)) {
					stats.stopDuplicates += 1;
					return;
				}
				stats.completed += 1;
				stats.lastCompletion = { sessionId, source, at: Date.now() };
				chimeNow();
				// 票据与「弹窗发不发得出去」无关：门控关掉时也要记，否则同一次停止晚到
				// 的错误会被当成一次新停止、再响一声（关掉弹窗 / 仅非前台时会双响）。
				const canNotify = shouldNotify();
				trackReport(sessionId, 'completion', canNotify ? notify(toastT('toast.completed.title'), titleOf(ctx, sessionId), sessionId, NOTIFY_KIND_COMPLETED) : null, knownTurn);
			};

			/**
			 * 报一次错误：先去重（本停止已报过错误则跳过），再按兜底网处理
			 * （完成弹窗刚发过 → 撤回它只留错误，提示音已响过不重响），
			 * 最后提示音 + 弹窗，记入对账窗口。
			 * @param sessionId - 会话 id。
			 * @param message - 错误正文（网关原文）。
			 */
			const reportError = (sessionId, message) => {
				// 对账票据只读一次：读两次的话，「读到的票据」与「据它做的决定」
				// 之间隔着一个可能刚好过期的瞬间，撤回就会被跳过。
				const prior = freshReport(sessionId);
				if (prior?.kind === 'error') return; // 本停止已按错误报过
				// 门控只决定「这条弹窗发不发」，票据一律照记：同一次停止的重复边沿与
				// 晚到的错误都靠这张表去重，关了弹窗也不能让它失效（否则会双响）。
				const canNotify = shouldNotify();
				if (prior?.kind === 'completion') {
					// 兜底网：错误后到——撤回完成弹窗只留错误；音已响过，不重响。
					if (canNotify && prior.notification !== null) prior.notification.close();
				} else {
					chimeNow();
				}
				stats.errors += 1;
				stats.lastError = { sessionId, message, at: Date.now() };
				trackReport(sessionId, 'error', canNotify ? notify(toastT('toast.error.title'), errorBody(sessionId, message), sessionId, NOTIFY_KIND_ERROR) : null);
			};

			/**
			 * 一轮对话任务结束（running → 非 running）：读会话持久日志最后一条
			 * turn/end 的 reason 决定报什么——完成 / 错误 / 不报（取消、询问
			 * 已报、崩溃孤儿回合）。读不到原因（兜底时限内）按完成报，由
			 * reportError 的对账网接手晚到的错误。询问待答期间与询问回答后
			 * 紧随的那次完成不报（一次交互一次提醒）。
			 * 分类是异步的：在途期间（completing 里有本会话的 token）到达的重复
			 * 边沿直接忽略——同一次停止只走一次分类、只报一次。
			 * 「同一次停止」的判据是回合号（1.5.4）：分类读得的 turn 与
			 * lastReportedTurn 相等就丢掉，不再靠 5 秒窗口——时间窗会把「上一轮
			 * 刚停、新任务开始、5 秒内又完成」的新回合当成重复边沿整条吞掉。
			 * @param sessionId - 会话 id。
			 * @param source - 触发来源（event / list / status），仅用于排障。
			 */
			const complete = (sessionId, source) => {
				if (!shouldRemindFor(sessionId)) return; // 子智能体（默认关）：整条流程不参与
				if (pendingQuestions.has(sessionId)) return; // 询问待答：那次停止由询问弹窗负责
				if (completing.has(sessionId)) return; // 同一次停止的分类已在途（重复边沿）
				const grace = takeQuestionGrace(sessionId);
				let settled = false;
				const token = {};
				completing.set(sessionId, token);
				const fallbackCancel = ctx.timer.timeout(() => {
					if (settled || disposed) return;
					settled = true;
					if (completing.get(sessionId) === token) completing.delete(sessionId);
					reportCompletion(sessionId, source); // 兜底：读不到原因（也就读不到回合号）→ 退回 5 秒完成→完成去重
				}, CLASSIFY_TIMEOUT_MS);
				void (async () => {
					try {
						const classified = await readTurnEndReason(sessionId);
						// 兜底已经按完成报过：这次分类的结果不再补报，也不补记回合号
						// （此刻日志可能又往前走了，补记会把下一个回合误当成已结清）。
						if (settled) return;
						settled = true;
						fallbackCancel();
						// 插件已经卸载（热重载 / 停用）：这次分类不作数，别再往一个死实例上弹窗放音。
						if (disposed) return;
						const reason = classified?.reason ?? null;
						const turn = typeof classified?.turn === 'number' ? classified.turn : null;
						if (turn !== null && lastReportedTurn.get(sessionId) === turn) {
							// 同一个回合＝同一次停止（通道重复触发 / 列表陈旧回放）：
							// 确定性丢掉，和 5 秒窗口无关。
							stats.stopDuplicates += 1;
							return;
						}
						// 这次停止边沿到此结清：报过的、按分类有意不报的（取消 / 询问已报 /
						// 崩溃孤儿 / 询问豁免）都记下回合号，重复边沿不会再弹第二条。
						if (turn !== null) lastReportedTurn.set(sessionId, turn);
						if (reason?.kind === 'error') {
							const failure = reason.error;
							reportError(sessionId, typeof failure?.message === 'string' ? failure.message : '');
							return;
						}
						// aborted（取消）/ blocked（询问已报）/ interrupted（崩溃孤儿）：不报。
						if (reason?.kind === 'aborted' || reason?.kind === 'blocked' || reason?.kind === 'interrupted') return;
						// completed / max-tokens / 读不到：按完成报（grace 期内不报）。
						if (!grace) reportCompletion(sessionId, source, turn);
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

			// 审批快捷裁决（要点 11）：注册 worker + 收它转回来的点击。
			ctx.effect(() => {
				const unsubscribeState = actionBridge.onStateChange((next) => bridgeStateStore.set(next));
				const unsubscribeMessage = actionBridge.onMessage((message) => {
					const key = typeof message.key === 'string' && message.key !== '' ? message.key : null;
					if (message.action === 'approve' || message.action === 'reject') {
						if (key !== null) decideApproval(key, message.action === 'approve' ? APPROVAL_GRANT : APPROVAL_REJECT);
						return;
					}
					// 正文点击：抬窗由 worker 做（只有它带用户手势），这里只切会话；
					// 多个标签页时只有 navigate=true 的那一个动。
					if (message.navigate !== true) return;
					const sessionId = typeof message.sessionId === 'string' && message.sessionId !== '' ? message.sessionId : null;
					if (sessionId === null) return;
					requestDesktopActivation();
					try {
						if (typeof window.focus === 'function') window.focus();
					} catch {
						// 拉不起前台也不影响打开会话。
					}
					jumpToSession(sessionId, 'sw');
				});
				actionBridge.start(selfBundleUrl());
				bridgeStateStore.set(actionBridge.state);
				return () => {
					unsubscribeState();
					unsubscribeMessage();
					actionBridge.dispose();
				};
			}, 'dsh-task-reminder: approval action bridge');

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
				// 已经不在列表里、且值已经是 false 的会话（没有待决的完成边沿）可以丢掉，
				// 免得每个见过的会话都永久留一个布尔。值为 true 的不动：列表投影可能只是
				// 暂时陈旧，删掉会把真实的完成边沿弄丢。
				for (const [id, running] of [...runningSessions]) {
					if (running === false && snapshot.byId?.[id] === undefined) runningSessions.delete(id);
				}
			}), 'dsh-task-reminder: session status list');

			// 出错停止：宿主转发事件 api-session/error(sessionId, message) ——
			// 任何让回合失败的错误（网关 HTTP 错误、服务商故障、连接失败等）。
			// 去重与「撤回完成弹窗」的对账都在 reportError 里：一次停止只报
			// 一次、错误优先。
			ctx.effect(() => ctx.remote.$on('api-session/error', (sessionId, message) => {
				// 子智能体（默认关）的出错同样不报：它不是用户手上那次对话的失败。
				if (!shouldRemindFor(sessionId)) return;
				reportError(sessionId, message);
			}), 'dsh-task-reminder: session error event');
			// 等你回答 + 第三完成通道：uiSession.sessionStatus 快照 ——
			// pendingInteraction 出现边沿就是 Agent 阻塞在等用户操作（ask_user_question /
			// plan-review）；每个 entry 的 running 位同时是完成检测的第三来源（与
			// sidebar 运行指示灯同源，fork 会话的列表投影不可靠时这条路仍可靠）。
			// 只读观测这个根级快照，绝不订阅 user-questions/request —— 那是
			// waterfall 应答链，旁观者插进去会干扰官方问答 UI 应答。子智能体
			// 会话（默认关）在整条循环最前面就跳过：不记边沿、不记待答。
			ctx.effect(() => ctx.uiSession.sessionStatus.subscribe(() => {
				const snapshot = ctx.uiSession.sessionStatus.getSnapshot();
				for (const [sessionId, status] of snapshot) {
					// 子智能体（默认关）：边沿、待答、grace 一概不碰。
					if (!shouldRemindFor(sessionId)) continue;
					// running 位也计入边沿表（三条通道共用一张表，天然去重）。
					if (noteRunning(sessionId, status?.running === true)) complete(sessionId, 'status');
					const pending = status?.pendingInteraction;

					if (pending === undefined || pending === null) {
						// 这一轮挂起消散（用户已回答 / 交互关闭）：紧随的那次完成
						// 不报——一次交互一次提醒。还没结清的审批通知也一并收掉，
						// 免得留下一个点了没用的陈旧按钮。
						if (pendingQuestions.delete(sessionId)) {
							markQuestionSettled(sessionId);
							closeApprovalToastsOfSession(sessionId);
						}
						// 等待类通知（提问 / 方案待确认 / 退回普通样式的审批）同样收掉：
						// 留着就是「点了再也没有对应等待」的陈旧条目，点它什么都不发生。
						closeWaitingToast(sessionId);
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
					// 提问 / 方案待确认：正文取首个问题原文（中文通知语言下先过一遍宿主
					// 文案对照，见 localizeHostText —— 方案待审的原文是宿主写死的英文）。
					// 审批请求（PendingApproval）
					// 不带 questions 列表，按 toolName + 理由现场拼（approvalBodyText）；
					// 都取不到才退回会话名 —— 会话名只是兜底，不是审批内容本身。
					// 拼好的正文按固定字数截断，别让系统通知拦腰切出难看的截痕。
					const rawBody = pending.kind === 'approval'
						? approvalBodyText(pending) ?? titleOf(ctx, sessionId)
						: (typeof first?.question === 'string' && first.question !== '' ? localizeHostText(first.question) : titleOf(ctx, sessionId));
					const body = rawBody.length > NOTIFY_BODY_MAX_CHARS ? `${rawBody.slice(0, NOTIFY_BODY_MAX_CHARS)}…` : rawBody;
					const title = toastT(WAIT_TITLE_KEYS[pending.kind] ?? 'toast.waiting.title');
					// 审批：通知上直接给「同意 / 拒绝」两个按钮（要点 11）。只有真审批
					// （带 answer 方法的对象）、拿到 key、worker 桥可用且权限已给时才走
					// 这条路；任何一项不满足都退回普通通知，不假装有按钮。
					const approvalKey = typeof pending.key === 'string' && pending.key !== '' ? pending.key : null;
					const quickDecide = pending.kind === 'approval' && typeof pending.answer === 'function' && approvalKey !== null;
					if (!quickDecide || !showApprovalToast(approvalKey, sessionId, title, body)) {
						const toast = notify(title, body, sessionId, NOTIFY_KIND_WAITING);
						if (toast !== null) {
							// 同一会话若还留着上一条没结清的等待通知（异常路径兜底），先收掉再记。
							const stale = waitingToasts.get(sessionId);
							if (stale !== undefined && stale !== toast) {
								try { stale.close(); } catch {}
							}
							waitingToasts.set(sessionId, toast);
						}
					}
				}
				// 快照里已经完全没有的会话（被删除 / 归档）从待答集合里清掉，
				// 之后它再挂起问题时才算新的出现边沿。
				for (const sessionId of [...pendingQuestions]) {
					if (!snapshot.has(sessionId)) {
						pendingQuestions.delete(sessionId);
						closeWaitingToast(sessionId);
					}
				}
			}), 'dsh-task-reminder: pending questions');

			// 前台跟踪：标签页被切走 / 窗口失焦时 view.focused = false。
			ctx.effect(() => {
				const sync = () => {
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
				if (typeof window.addEventListener !== 'function') return () => {};
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
					const storage = window.localStorage;
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
			// 装载即恢复自定义音效：IndexedDB 是唯一事实来源（localStorage 里的元数据
			// 只是显示缓存）—— 记录在就解码好待用；记录不在（换浏览器、清了站点数据、
			// 或者本来就没上传过）就把陈旧元数据清掉，免得设置页显示一个已经没了的
			// 文件。读不出来（隐私模式）时保留缓存并如实提示，不冒充「就绪」。
			ctx.effect(() => {
				if (!indexedDbAvailable()) return () => {};
				let cancelled = false;
				const revision = (customRevision += 1);
				const cached = customMetaStore.getSnapshot();
				if (cached !== null) customStatusStore.set('loading');
				void customSounds.read().then((record) => {
					if (cancelled || revision !== customRevision) return;
					const meta = normalizeCustomMeta(record);
					if (meta === null) {
						if (cached !== null) customMetaStore.set(null);
						customStatusStore.set('idle');
						return;
					}
					customMetaStore.set(meta);
					const blob = record?.blob;
					if (blob === null || blob === undefined) {
						customStatusStore.set('missing');
						return;
					}
					adoptCustomRecord(revision, blob, false);
				}).catch(() => {
					if (cancelled || revision !== customRevision) return;
					customStatusStore.set(cached === null ? 'idle' : 'store-failed');
				});
				return () => { cancelled = true; };
			}, 'dsh-task-reminder: custom sound restore');
			// 回收对账票据与它们的遗忘定时器、grace 标记、结清回合号（卸载时不再有
			// 延迟回调落地）。先立 `disposed`：在途的分类 / 解码回来时据此直接收手。
			ctx.effect(() => () => {
				disposed = true;
				for (const entry of recentReports.values()) {
					if (entry.cancel !== null) entry.cancel();
				}
				recentReports.clear();
				questionGrace.clear();
				completing.clear();
				lastReportedTurn.clear();
				approvalToasts.clear();
				for (const sessionId of [...waitingToasts.keys()]) closeWaitingToast(sessionId);
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
					subagentStore,
					stickyStore,
					notifyLanguageStore,
					effectiveLanguageStore,
					customMetaStore,
					customStatusStore,
					permissionStore,
					bridgeStateStore,
					setNotify,
					setNotifyMode,
					setSound,
					setSoundChoice,
					setVolume,
					setSubagent,
					setSticky,
					setNotifyLanguage,
					setCustomSound,
					clearCustomSound,
					reset: resetAll,
					updateStore,
					checkUpdate,
					applyUpdate,
					reloadPage,
					notifySupported: notifier.supported,
					customSupported: indexedDbAvailable(),
					t,
				}),
			}, ReminderSection));

			// 排障钩子：浏览器控制台执行 __dshTaskReminder.state() 可看前台状态、
			// 八个配置、通知权限与各会话 running 记录。
			const debug = {
				version: PLUGIN_VERSION,
				state: () => ({
					focused: view.focused,
					notify: notifyStore.getSnapshot(),
					notifyMode: notifyModeStore.getSnapshot(),
					sound: soundStore.getSnapshot(),
					soundChoice: soundChoiceStore.getSnapshot(),
					volume: volumeStore.getSnapshot(),
					subagent: subagentStore.getSnapshot(),
					sticky: stickyStore.getSnapshot(),
					notifyLanguage: notifyLanguageStore.getSnapshot(),
					// auto 时真正生效的通知语言（'zh' / 'en'）：看它比看设置值直观。
					notifyLanguageResolved: resolvedNotifyLanguage(),
					customSound: {
						meta: customMetaStore.getSnapshot(),
						status: customStatusStore.getSnapshot(),
						decoded: customBuffer !== null,
					},
					notificationPermission: permissionStore.getSnapshot(),
					notificationSupported: notifier.supported,
					// 设置页底部「检查更新」那一行现在是什么状态（相位 / 版本 / 失败原因）：
					// 点了按钮之后在控制台看这里，就知道那次检查到底走到哪一格。
					update: updateStore.getSnapshot(),
					// 审批快捷裁决的桥：active 才代表通知上真的有按钮。
					approvalBridge: actionBridge.state,
					// 还没结清、带按钮的审批通知（interaction key）。
					approvalToasts: [...approvalToasts.keys()],
					// 还没结清的等待类通知（提问 / 方案待确认 / 普通样式的审批）所在会话：
					// 消散即收，这里不该有常驻条目；有就说明有通知没收掉。
					waitingToasts: [...waitingToasts.keys()],
					running: [...runningSessions.entries()],
					// 每个会话已结清的停止回合号（1.5.4 的确定性去重账本）：探针看这里
					// 就知道某次完成被当成重复边沿丢掉时，挡下它的是不是同一个回合。
					lastReportedTurn: [...lastReportedTurn.entries()],
					// 点通知抬窗的链路留痕（工厂作用域的 activationDiag 在这里出口）。
					stats: { ...stats, lastActivation: activationDiag.last },
				}),
			};
			/**
			 * 当场触发一条提醒（不经过判定与门控），几种停止都能演示：
			 * `test()` / `test('completed')` 完成、`test('question')` 提问、
			 * `test('plan-review')`（也接受 `'plan'`）方案待确认、
			 * `test('approval')` 审批请求、`test('error')` 出错停止。
			 * 专供验证各条链路是否都通。
			 * @param kind - 'completed'（默认）/ 'question' / 'plan-review' / 'approval' / 'error'。
			 * @param sessionId - 可选，指定用哪个会话的名字。
			 */
			debug.test = (kind, sessionId) => {
				const requested = kind === 'plan' ? 'plan-review' : kind;
				const waits = requested === 'question' || requested === 'approval' || requested === 'plan-review';
				const resolved = waits || requested === 'error' ? requested : 'completed';
				const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ctx.sessions.list.getSnapshot().ids?.[0] ?? 'test';
				if (waits) {
					stats.questions += 1;
					stats.lastQuestion = { sessionId: id, kind: resolved, at: Date.now() };
					const title = toastT(WAIT_TITLE_KEYS[resolved] ?? 'toast.waiting.title');
					const body = toastT(resolved === 'approval' ? 'test.approval' : resolved === 'plan-review' ? 'test.plan' : 'test.question');
					// 审批测试走真实的带按钮链路（点了只反馈，不裁决任何真实请求）；
					// 桥不可用时退回普通通知 —— 与真实审批的降级路径完全一致。
					if (resolved !== 'approval' || !showApprovalToast(TEST_APPROVAL_KEY, null, title, body)) {
						notify(title, body, id, NOTIFY_KIND_WAITING);
					}
				} else if (resolved === 'error') {
					stats.errors += 1;
					stats.lastError = { sessionId: id, message: toastT('test.error'), at: Date.now() };
					notify(toastT('toast.error.title'), toastT('test.error'), id, NOTIFY_KIND_ERROR);
				} else {
					stats.completed += 1;
					stats.lastCompletion = { sessionId: id, source: 'test', at: Date.now() };
					notify(toastT('toast.completed.title'), titleOf(ctx, id), id, NOTIFY_KIND_COMPLETED);
				}
				chimeNow(); // 与正式路径共用同一处放音与记账（stats.sounds / lastSound）
			};
			/** 只放音：按当前音效与音量，供排障试听。 */
			debug.sound = () => chime.play(soundChoiceStore.getSnapshot(), volumeStore.getSnapshot(), customBuffer);
			/**
			 * 排障：不点弹窗，直接跳一次会话（和点通知正文走的是同一个
			 * `jumpToSession`）。用来把「点击有没有送达」和「跳转本身成不成」拆开：
			 * 控制台跑 `__dshTaskReminder.jump()` 会跳到最近一条提醒的会话，
			 * 结果记在 `state().stats.lastJump`（via = debug）。
			 * @param sessionId - 可选；不给就用最近一条提醒的会话。
			 * @returns 是否真的把会话打开了。
			 */
			debug.jump = (sessionId) => {
				const explicit = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
				const target = explicit ?? stats.lastCompletion?.sessionId ?? stats.lastQuestion?.sessionId ?? stats.lastError?.sessionId ?? null;
				return jumpToSession(target, 'debug');
			};
			/**
			 * 排障：不点弹窗，直接对当前打开的会话跑一次「落到这次提问」。
			 * 用来现场验证定位规则（DSH 界面改没改一眼就看得出），
			 * 结果记在 `__dshTaskReminder.state().stats.lastQuestionJump`。
			 * @param sessionId - 可选，只用于统计里标是哪个会话。
			 */
			debug.focusQuestion = (sessionId) => {
				focusLatestQuestion(typeof sessionId === 'string' && sessionId !== '' ? sessionId : null);
			};
			/**
			 * 排障：一行说全「点弹窗落到提问位置」这一环的现状 —— 上次跑到哪一步、
			 * 当前挂载的会话号、以及 DSH 那套内部 DOM 还在不在（会话流列 / 你的消息行 /
			 * 滚动口各自的条数与几何）。控制台里只需 `__dshTaskReminder.report()`，
			 * 不用手打长表达式；DSH 升级改了 DOM 时，看哪一项变成 0 / null 就知道断在哪。
			 * 这个函数本身只有新版代码才有：打出来「不是函数」＝页面还在跑旧 bundle。
			 * @returns 一行 JSON 字符串。
			 */
			debug.report = () => {
				/** 数一下选择器命中几个（读不到 DOM 时给 -1，与「有 DOM 但为 0」区分开）。 */
				const count = (selector) => {
					try {
						if (typeof document.querySelectorAll !== 'function') return -1;
						return document.querySelectorAll(selector).length;
					} catch {
						return -1;
					}
				};
				const rectOf = (element) => {
					try {
						if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return null;
						const rect = element.getBoundingClientRect();
						return { top: Math.round(rect.top), height: Math.round(rect.height) };
					} catch {
						return null;
					}
				};
				// 选中「该对齐的那一列」（见 pickConversationColumn）。DOM 里可能同时挂着
				// 多个会话流列（实测桌面端 3 个、网页端 30 个），只报第一个列会误导。
				const column = pickConversationColumn(document, null);
				const scroller = questionScroller(column);
				const row = findLatestQuestionRow(column);
				// 留痕取「实例内那份」与「页面级那份」里更新的一个：热重载会清空前者，
				// 而这两条链路（跳转 / 落位）的现场恰恰最怕被清掉（见 setLastJump）。
				const lastClick = newerRecord(stats.lastClick, clickDiag.last);
				const lastJump = newerRecord(stats.lastJump, jumpDiag.last);
				const lastQuestionJump = newerRecord(stats.lastQuestionJump, jumpDiag.question);
				const columns = conversationColumnInfo(document);
				const now = Date.now();
				const ageOf = (record) => (record === null || typeof record?.at !== 'number' ? null : now - record.at);
				return JSON.stringify({
					build: PLUGIN_BUILD,
					version: PLUGIN_VERSION,
					// 这一份实例是什么时候装载的、现在是什么时候：留痕早于 instanceStartedAt
					// 就说明那次点击是**上一份**代码（热重载前）处理的，别拿它判新代码。
					instanceStartedAt,
					now,
					lastQuestionJump,
					// 点通知正文「打开会话」那一步的留痕：这条链路以前全静默，
					// 「点了弹窗不跳会话」只能猜（page = 普通通知，sw = 带按钮通知转回）。
					// `mainSession` 是 DSH 自己的当前会话（mainReference）：判断「会话到底
					// 切没切」的可信来源；`verifiedBy` 说明是靠 DOM 还是靠 mainReference 核对的。
					lastJump,
					// 通知 onclick 有没有真的跑（null = 点击压根没送达页面；见 §6 已知限制）。
					lastClick,
					clickBeforeThisInstance: lastClick !== null && typeof lastClick.at === 'number' && lastClick.at < instanceStartedAt,
					// 距那次点击多久：几分钟前的旧记录不能拿来解释「刚才那次没反应」。
					clickAgeMs: ageOf(lastClick),
					jumpAgeMs: ageOf(lastJump),
					questionJumpAgeMs: ageOf(lastQuestionJump),
					// 点通知抬窗那条链路的留痕（与 state().stats.lastActivation 同一份）：
					// 「点了没抬窗」时先读这一项，再看下面 DSH 内部 DOM 还在不在。
					// reason=answered/204 只代表宿主已发出唤醒命令，**不代表窗口到了前台**。
					lastActivation: activationDiag.last ?? null,
					// 当前这份页面到底有没有桌面壳全局 —— 桌面壳里一定有
					// （非主框架 / 非 dsh-app 页面也会有个 protocolVersion 影子），
					// 没有就说明这一页跑在普通浏览器里，抬窗只能靠 window.focus()。
					hasDesktop: 'dshDesktop' in window,
					column: count(`[${QUESTION_FLOW_ATTR}]`),
					questionRows: count(QUESTION_ROW_SELECTOR),
					scrollHosts: count(`[${QUESTION_SCROLL_ATTR}]`),
					mountedSession: mountedSessionId(column),
					// DSH 自己的「当前主视图会话」（mainReference）：判断「会话到底切没切」
					// 的可信来源 —— 现场见过多个会话流列共用同一个外层会话壳，列上的
					// 会话号分辨不了，而 mainReference 不会骗人。
					mainSession: currentMainSessionId(),
					// 全部会话流列的清单：选中的是不是用户眼前那一列，只有这份清单答得了。
					columns,
					row: rectOf(row),
					rowTopInView: row === null || scroller === null
						? null
						: Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
					scroller: scroller === null ? null : {
						scrollTop: Math.round(scroller.scrollTop),
						clientHeight: scroller.clientHeight,
						scrollHeight: scroller.scrollHeight,
						rect: rectOf(scroller),
					},
				});
			};
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
			// 每个键都要有读者（自检或文档）；没有读者的出口会在发布前被清掉。
			diagnostics: {
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
				NOTIFY_KIND_ERROR,
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
				notifyLanguageFromLocale,
				newerRecord,
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
			},
		};
	},
	});
	// 双上下文外壳：root 在页面里是 window，在 worker 里是 self。
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
