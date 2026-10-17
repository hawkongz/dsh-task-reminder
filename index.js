/**
 * dsh-task-reminder —— 宿主半侧。
 *
 * 浏览器半侧（./client.js）独立完成全部提醒功能：完成信号走宿主事件转发，
 * 九个持久化项（八个配置 + 自定义音效元数据）落浏览器本地存储，不需要宿主设置命名空间。宿主半侧做三件事：
 * **桌面壳里把 DSH 窗口拉回前台**、**设置页底部的「检查更新」**、以及
 * **它点下去之后的就地升级**。
 *
 * 为什么唤醒必须由宿主来做：桌面端是 Electron，渲染进程的 `window.focus()` 拉不起
 * 最小化或已关进托盘的窗口 —— 只有主进程的 `focusPrimaryWindow()` 会
 * `restore()/show()/focus()`。主进程那条路只由托盘点击与「再启动一份应用」
 * （`dsh://open` 深度链接，second-instance → focusPrimaryWindow）触发；插件在
 * 渲染进程里既没有这条 IPC，也发不出外部协议（渲染进程导航到 `dsh:` 会被拦），
 * 所以由宿主进程代跑一次「再启动一份应用」：第二份拿不到单实例锁会立刻退出，
 * 第一份随即把窗口拉回前台，用户无感。**抢前台是竞速，所以有几次补发，但补发
 * 一旦确认窗口已在前台（助手退出码 0）就立刻停** —— 目的达成之后再抢，就是把
 * 已经从别处切走的用户拽回来（见 `ACTIVATION_SCHEDULE_MS`）。
 *
 * 为什么更新也必须由宿主来做：升级要跑包管理器、要写 profile 的 package.json /
 * 锁文件，这两件事只有宿主进程有能力也有资格做。渲染进程一共发三条 POST：
 *
 *   POST /api/task-reminder/window-activation → 请宿主把桌面窗口拉回前台
 *   POST /api/task-reminder/update-check  → 读源上最新版本，和本机已装的比
 *   POST /api/task-reminder/update        → 升到最新版（或请求体里指定的版本）
 *
 * 三条路由都注册在 Connection 上，和普通 RPC 共用 /api 通道的 Host/Origin 校验
 * 与浏览器 cookie 认证；桌面壳把 `dsh-app://app/*` 的其它路径原样转发给宿主。
 * 桌面壳之外（浏览器 web profile、无 web 服务器的 profile）这些路由要么注册不上、
 * 要么没人调用，都是安静失败，不影响任何提醒功能。
 *
 * 升级本身**不自己拼 pnpm 命令行**，而是调 DSH 自己的 `pluginManager` 服务
 * （`installBundle`）：它才知道本 profile 的包管理器怎么起（桌面壳把内置 pnpm
 * 的调用方式当 launcher facts 传进来）、有多个源时怎么依次重试、写盘失败怎么
 * 回滚、以及装完之后要不要重载。本插件只负责「问一句最新版是多少」和「把版本
 * 号报给用户」。
 *
 * **DSH 0.2.1 起 `installBundle` 不再原地覆盖已安装的包**（HMR 存在时直接抛
 * `already-installed`；plugin-manager/lib/index.js:1991），官方 Update 的路径是
 * 「先 removeBundle 再 installBundle」。所以这里先按老路装一次，遇到
 * `already-installed` 再走两步；两步路径若装新版失败，会尝试把 current 版本
 * 装回去，并把结果如实写进 `error`（详见 `applyUpdate`）。
 *
 * @module dsh-task-reminder
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 渲染进程请求唤醒的路径（Connection 精确 Fetch 路由必须以 /api/ 开头）。 */
const ACTIVATION_PATH = '/api/task-reminder/window-activation';

/** 「检查更新」：读 npm 源上本包的最新版本。 */
const UPDATE_CHECK_PATH = '/api/task-reminder/update-check';

/** 「立即更新」：把本包升到请求体里指定的版本（没给就现查一次最新版）。 */
const UPDATE_APPLY_PATH = '/api/task-reminder/update';

/** 本包名：更新检查与升级都用它。 */
const PACKAGE_NAME = '@hawkongz/dsh-task-reminder';

/**
 * 依次询问的 npm 源：官方源 + 国内镜像。两路并行问，都答上来就取版本更高的那个
 * —— 镜像同步有延迟时，不能把「其实已经有新版」说成「已是最新」。
 */
const REGISTRIES = Object.freeze([
	'https://registry.npmjs.org/',
	'https://registry.npmmirror.com/',
]);

/**
 * 单次源查询的**总时限**（含建连、传输与读 body；到点就 destroy/abort）。
 * `https` 的 socket `timeout` 只是空闲超时，挡不住“一直慢慢吐字节”的源，
 * 所以另外有一个真正的总 deadline（见 `readRegistryDirect`）。
 */
const REGISTRY_TIMEOUT_MS = 8000;

/** registry 元数据响应的大小上限：超过就中止（`dist-tags` 只需要很小一份）。 */
const REGISTRY_MAX_BYTES = 5 * 1024 * 1024;

/** 桌面壳自己注册的唤醒深度链接：等价于再启动一份应用。 */
const ACTIVATION_LINK = 'dsh://open';

/**
 * 现在这个宿主是不是桌面壳（DSH Desktop / Electron）起的。
 * 主判据是桌面壳给宿主设的 `ELECTRON_RUN_AS_NODE=1`（实测在该进程里读得到）；
 * 再兜一层「exe 旁边有 resources/app.asar」，防止将来该环境变量被吞掉。
 * @param environment - 宿主进程环境。
 * @param executable - `process.execPath`。
 * @returns 是桌面壳宿主时为 true。
 */
function isDesktopHost(environment = process.env, executable = process.execPath) {
	if (environment.ELECTRON_RUN_AS_NODE === '1') return true;
	try {
		return existsSync(join(dirname(executable), 'resources', 'app.asar'));
	} catch {
		return false;
	}
}

/**
 * 从 exe 路径推出进程名（不带 `.exe`）——前台助手按它枚举进程。
 *
 * **刻意不用窗口标题**：窗口标题随会话变化（`DSH — 会话名`），拿它选窗口迟早选错。
 * @param executable - `process.execPath`。
 * @returns 进程名；推不出来时返回 null。
 */
function executableProcessName(executable) {
	try {
		// 两种分隔符都认：生产上是 Windows 的 `C:\app\dsh.exe`，而同一套自检在
		// Linux 上跑时会拿 Windows 路径喂进来（POSIX 的 basename 不认反斜杠）。
		const name = basename(String(executable).replace(/\\/gu, '/')).replace(/\.exe$/i, '');
		return name === '' ? null : name.replace(/'/gu, "''");
	} catch {
		return null;
	}
}

/**
 * 强抢前台的 PowerShell 脚本（只含 ASCII，交给 `-EncodedCommand`）。
 *
 * 为什么必须自己抢：桌面壳的 `focusPrimaryWindow()` 只有
 * `if (window.isMinimized()) window.restore(); window.show(); window.focus();`
 * —— 后台进程调 `SetForegroundWindow` 被 Windows 拒绝时，系统只把任务栏按钮
 * 闪一下（§6 的平台限制）。2026-10-07 实测铁证：**点击成功那次与失败那次的宿主
 * 日志逐项一致**（5 次 spawn 全成功、`exe → exit 0`、`explorer → exit 1`、204），
 * 差别只在前台抢占被不被放行。经典绕过法：`AttachThreadInput` 先把本线程挂到
 * 当前前台窗口的输入队列上，再 `BringWindowToTop` + `SetForegroundWindow`；
 * 配 `ShowWindow(SW_RESTORE)` 处理最小化。
 *
 * 选窗口是这份脚本最容易错的一步，**实测教训**（本机 mcp 探针）：
 * 主窗口与开发者工具窗口同属一个进程、都是 owner=0 的可见顶层窗口，
 * `Process.MainWindowHandle` 拿到的是 **DevTools**（标题
 * `Developer Tools - dsh-app://app/`）——照它抢就会把 DevTools 抬到前台。
 * 所以这里自己枚举：只认**无主**、**可见或最小化**的顶层窗口，**排除 DevTools**，
 * 再取面积最大的那个；标题只用来排除，不用来选主窗口（标题随会话变）。
 *
 * 退出码即结论（进唤醒日志的 `exit.code`）：0 = 收尾时目标窗口已是前台
 * （本来就在，或刚抢到），1 = 调完了但仍不是前台，2 = 没找到可用窗口。
 * 宿主只认这个 0：它说明「窗口已经在用户眼前」，后面的补发一律撤掉。
 * 结果日志：每次启动**至少**写一行 `helper-start`；若找到了窗口并尝试抢/确认，
 * 再追加一行 `raise`（选了哪个 hwnd / 标题 / 是否最小化 / 是本来就前台还是
 * 刚抢到）；脚本异常写 `helper-error`。没找到窗口（exit 2）不会写 `raise` 行，
 * 那次只能靠宿主日志里记录的退出码复盘。退出码只有三个数，`raise` 日志补足复盘。
 * @param processName - 目标进程名（`executableProcessName` 的产物）。
 * @param logPath - 结果日志路径。
 * @returns 可直接跑的一段 PowerShell。
 */
function foregroundHelperScript(processName, logPath) {
	const escapedLog = String(logPath).replace(/'/gu, "''");
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$logPath = '${escapedLog}'`,
		// 先留一行「我起来了」：宿主那边 stdio 可能被吞，助手自己写日志是唯一可靠的
		// 「到底跑到哪一步」证据（本轮就是靠它才发现脚本一行都没跑）。
		"Add-Content -LiteralPath $logPath -Value (([ordered]@{ event = 'helper-start'; helperPid = $PID; time = (Get-Date).ToUniversalTime().ToString('o') }) | ConvertTo-Json -Compress) -Encoding UTF8",
		'try {',
		'Add-Type -Namespace DshRaise -Name Native -MemberDefinition @\'',
		'[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
		'public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
		'[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
		'[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
		'[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);',
		'[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
		'[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
		'[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);',
		'[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);',
		'[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
		'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
		'[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
		'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
		'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
		'[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);',
		'[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
		'public static string Title(IntPtr h) { var text = new System.Text.StringBuilder(512); GetWindowTextW(h, text, text.Capacity); return text.ToString(); }',
		// 选窗口：无主 + （可见或最小化）+ 非 DevTools + 有标题优先，再比面积。
		'public static IntPtr Pick(uint pid) {',
		'  IntPtr best = IntPtr.Zero; int bestArea = -1; bool bestTitled = false;',
		'  EnumWindows((h, l) => {',
		'    uint owner; GetWindowThreadProcessId(h, out owner);',
		'    if (owner != pid) return true;',
		'    if (GetWindow(h, 4) != IntPtr.Zero) return true;',
		'    if (!IsWindowVisible(h) && !IsIconic(h)) return true;',
		'    string title = Title(h);',
		'    if (title.StartsWith("Developer Tools")) return true;',
		'    RECT rect; GetWindowRect(h, out rect);',
		'    int area = (rect.Right - rect.Left) * (rect.Bottom - rect.Top);',
		'    bool titled = title.Length > 0;',
		'    if (best == IntPtr.Zero || (titled && !bestTitled) || (titled == bestTitled && area > bestArea)) { best = h; bestArea = area; bestTitled = titled; }',
		'    return true;',
		'  }, IntPtr.Zero);',
		'  return best;',
		'}',
		"'@",
		`$processName = '${processName}'`,
		'$handle = [IntPtr]::Zero',
		'foreach ($candidate in @(Get-Process | Where-Object { try { $_.ProcessName -eq $processName } catch { $false } } | ForEach-Object { $_.Id })) {',
		'  $picked = [DshRaise.Native]::Pick([uint32]$candidate)',
		'  if ($picked -ne [IntPtr]::Zero) { $handle = $picked; break }',
		'}',
		'if ($handle -eq [IntPtr]::Zero) { exit 2 }',
		// 已经在前台就别再抢。AttachThreadInput + SetForegroundWindow 是**硬抢**：
		// 窗口已经抬起来、用户随后切去别的应用时再来一次，就是把人拽回来
		// （2026-10-07 现场日志：46 次点击的助手那一发**全部 exit 0**，说明到达时
		// 窗口多半已经在前台，上一版却照抢不误）。最小化的窗口不算「已在前台」，
		// 该 restore 还得 restore，所以这里连 IsIconic 一起看。
		'$already = (([DshRaise.Native]::IsIconic($handle) -eq $false) -and ([DshRaise.Native]::GetForegroundWindow() -eq $handle))',
		'if (-not $already) {',
		'[DshRaise.Native]::ShowWindow($handle, 9) | Out-Null',
		'$foreground = [DshRaise.Native]::GetForegroundWindow()',
		'$foregroundThread = [DshRaise.Native]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)',
		'$currentThread = [DshRaise.Native]::GetCurrentThreadId()',
		'[DshRaise.Native]::AttachThreadInput($currentThread, $foregroundThread, $true) | Out-Null',
		'[DshRaise.Native]::BringWindowToTop($handle) | Out-Null',
		'[DshRaise.Native]::SetForegroundWindow($handle) | Out-Null',
		'[DshRaise.Native]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null',
		'}',
		'$raised = ([DshRaise.Native]::GetForegroundWindow() -eq $handle)',
		// 用 ConvertTo-Json 生成，别手拼引号（手拼过一次，多出一个 `"` 让整行不是合法 JSON）。
		'$payload = [ordered]@{ event = "raise"; time = (Get-Date).ToUniversalTime().ToString("o"); hwnd = [int64]$handle; title = [DshRaise.Native]::Title($handle); minimized = [DshRaise.Native]::IsIconic($handle); foreground = $raised; alreadyForeground = $already; helperPid = $PID }',
		'Add-Content -LiteralPath $logPath -Value ($payload | ConvertTo-Json -Compress) -Encoding UTF8',
		'if ($raised) { exit 0 } else { exit 1 }',
		'} catch {',
		'$failure = [ordered]@{ event = "helper-error"; message = $_.Exception.Message; helperPid = $PID }',
		'Add-Content -LiteralPath $logPath -Value ($failure | ConvertTo-Json -Compress) -Encoding UTF8',
		'exit 3',
		'}',
	].join('\r\n');
}

/**
 * 把助手脚本编成 `-EncodedCommand` 要的 base64（UTF-16LE）——
 * 这样不必和 cmd / PowerShell 的引号规则搏斗（本仓库踩过 `\"` 那个坑）。
 * @param script - PowerShell 源码。
 * @returns base64 字符串。
 */
function encodePowerShellCommand(script) {
	return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * 组装「唤醒桌面窗口」的命令行候选（按尝试次序轮换）。
 *
 * 三条路都在发「把窗口弄到前台」这一个信号，只是手段不同：
 * - **直起 exe**（`{exe} dsh://open`）：不依赖 `dsh:` 协议注册状态，最直接；
 *   第二份拿不到单实例锁即退，第一份走 `second-instance → focusPrimaryWindow()`。
 * - **PowerShell 强抢前台**：绕开 Windows 的前台锁（见 `foregroundHelperScript`）。
 *   实测「同一次点击、日志逐项一致、窗口却时好时坏」之后，这条是唯一能确定
 *   生效的手段；代价是起一个 PowerShell（首次 Add-Type 编译几百毫秒）。
 * - **经 explorer 走协议**（`explorer.exe dsh://open`）：启动方是外壳进程，
 *   Windows 对这条链通常更愿意放行。
 *
 * 次序把便宜、幂等的放前面、强抢的紧随其后：第一次点击最可能输给前台锁，
 * 700ms 那一发就该轮到它。任一条失败都不影响另外两条。
 *
 * 结果按 (platform, 是否桌面壳宿主, exe) 缓存：助手的 `-EncodedCommand` 是
 * 12KB+ 的 base64，每次点击都重新拼脚本 + UTF-16 编码纯属浪费（实测一次
 * 0.036ms，不是热点但没必要）；缓存条目数上限很小。**macOS 也走同一判据**：
 * 非桌面宿主（普通 web profile）不该去 `open dsh://open`。
 * @param platform - `process.platform`。
 * @param environment - 宿主进程环境。
 * @param executable - `process.execPath`。
 * @returns 候选命令数组（冻结，可安全共享）；当前平台没有可用路径时为空数组。
 */
function activationCommands(platform, environment = process.env, executable = process.execPath) {
	const desktopHost = isDesktopHost(environment, executable);
	const cacheKey = `${String(platform)}\u0000${desktopHost ? '1' : '0'}\u0000${String(environment?.ELECTRON_RUN_AS_NODE ?? '')}\u0000${String(executable)}`;
	const cached = activationCommandsCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const commands = buildActivationCommands(platform, desktopHost, executable);
	if (activationCommandsCache.size >= ACTIVATION_COMMANDS_CACHE_LIMIT) activationCommandsCache.clear();
	activationCommandsCache.set(cacheKey, commands);
	return commands;
}

/** 唤醒命令表的缓存（生产只会有一个 exe；自检会喂几个不同路径）。 */
const ACTIVATION_COMMANDS_CACHE_LIMIT = 64;
const activationCommandsCache = new Map();

/**
 * `activationCommands` 的无缓存实现（只给缓存函数用）。
 * @param platform - `process.platform`。
 * @param desktopHost - `isDesktopHost` 的结论。
 * @param executable - `process.execPath`。
 * @returns 冻结的候选命令数组。
 */
function buildActivationCommands(platform, desktopHost, executable) {
	if (platform === 'win32') {
		if (!desktopHost) return Object.freeze([]);
		const commands = [{ kind: 'app-link', file: executable, args: Object.freeze([ACTIVATION_LINK]) }];
		const processName = executableProcessName(executable);
		if (processName !== null) {
			commands.push({
				kind: 'foreground-helper',
				file: 'powershell.exe',
				args: Object.freeze([
					'-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
					'-EncodedCommand', encodePowerShellCommand(foregroundHelperScript(processName, foregroundRaiseLogPath())),
				]),
			});
		}
		commands.push({ kind: 'shell-link', file: 'explorer.exe', args: Object.freeze([ACTIVATION_LINK]) });
		for (const command of commands) Object.freeze(command);
		return Object.freeze(commands);
	}
	// 和 win32 一样先判桌面壳：普通浏览器 / 非桌面宿主上没有可唤醒的桌面应用。
	if (platform === 'darwin' && desktopHost) {
		return Object.freeze([{ kind: 'open-url', file: 'open', args: Object.freeze([ACTIVATION_LINK]) }]);
	}
	return Object.freeze([]);
}

/**
 * 新进程的环境：必须去掉 `ELECTRON_RUN_AS_NODE`。
 * 留着它会让新起的应用以 Node 模式运行，拿不到单实例锁也唤不醒窗口。
 * @param environment - 宿主进程环境。
 * @returns 可传给 spawn 的环境副本。
 */
function activationEnvironment(environment = process.env) {
	const result = { ...environment };
	delete result.ELECTRON_RUN_AS_NODE;
	return result;
}

/**
 * 每次尝试的时刻（ms，相对点击那一刻）。Windows 前台抢占是竞速：实测
 * 「spawn 成功（204）但窗口没抬起来」复现过多次，而且**第一次点击**最容易输
 * （2026-10-07 用户实测：点弹窗第一下没抬起来，后续点击都抬起来了），所以首发
 * 之外还要补发，把「谁先赶到单实例锁 / 谁拿得到前台权限」的运气摊薄。
 *
 * **补发是有条件、有上限的**（1.6.2 修的那个 bug）：`%USERPROFILE%\.dsh\
 * task-reminder-activation.log` 里 46 次点击的现场日志显示，700ms 那一发
 * 的助手**每次都把窗口置成了前台**，后面的 1400 / 2400 / 4000ms 三发却照旧
 * 无条件执行 —— 每次点击都白抢三次前台，用户那边就是「已经切到别的应用，
 * 又被拽回来，而且很频繁」。现在改成**成功就停**：助手报「已在前台」
 * （exit 0）时立刻撤掉剩下的定时器（不是只让回调空跑）；助手动手前也会先看
 * 一眼是不是已经在前台。
 *
 * 第三发（explorer）的触发条件是「助手 exit 非 0」**或**「到 2200ms 助手还没
 * 退出」——后者是保守取舍（保证窗口总能被抬起来），代价是极慢的机器上可能
 * 在助手成功前多抢一次；正常机（历史日志实测 helper-start→raise ≈300ms）在
 * 2200ms 前就 settled 了。
 */
const ACTIVATION_SCHEDULE_MS = Object.freeze([0, 700, 2200]);

/** 前台助手的最长存活时间：超过就 kill（PowerShell 卡死不能一直占着宿主的事件循环）。 */
const HELPER_KILL_TIMEOUT_MS = 10_000;

/** 唤醒日志里最多收集多少字符的 helper stdout/stderr（超出直接丢，先判长度再 String）。 */
const OUTPUT_CAPTURE_LIMIT = 4000;

/** 唤醒日志：两个 profile 共用 JSONL 文件，靠 profile / hostPid / requestId 区分。 */
function activationLogPath(userHome = homedir()) {
	return join(userHome, '.dsh', 'task-reminder-activation.log');
}

/**
 * 前台助手的结果日志：每次抢窗追加一行（选中哪个 hwnd / 标题 / 是否最小化 / 抢到没有）。
 * 退出码只有 0/1/2，复盘「到底抢的哪个窗口」不够用，所以另开一份。
 */
function foregroundRaiseLogPath(userHome = homedir()) {
	return join(userHome, '.dsh', 'task-reminder-raise.log');
}

/**
 * 只记录唤醒链路，不记 cookie / token / 会话正文。写日志失败不能改变路由契约。
 * options 里的文件操作仅供离线测试注入；生产写入用户目录，不碰 app.asar。
 */
function createActivationRecorder(context = {}, options = {}) {
	const file = options.file ?? activationLogPath();
	const append = options.append ?? appendFileSync;
	const mkdir = options.mkdir ?? mkdirSync;
	const now = options.now ?? (() => new Date().toISOString());
	return (entry) => {
		try {
			mkdir(dirname(file), { recursive: true });
			append(file, `${JSON.stringify({ ...context, ...entry, time: now(), hostPid: process.pid })}\n`, 'utf8');
		} catch (error) {
			try { options.onError?.(error); } catch { /* 诊断失败不影响唤醒。 */ }
		}
	};
}

/** 日志/诊断桩也可能抛错，不能让它改变首发结果与后续补发。 */
function recordActivation(record, entry) {
	try { record?.(entry); } catch { /* 诊断失败不影响唤醒。 */ }
}

/**
 * 再启动一份应用，触发第一份的 second-instance → focusPrimaryWindow()。
 * 宿主半侧观测不到主进程最终有没有 focus 成功，所以补发是**条件性**的：
 * 唯一看得见的达成信号是前台助手的退出码 0（脚本收尾时目标窗口已在前台），
 * 拿到它就把剩下的补发定时器真正 clear 掉 —— 目的已达还继续抢，只会把用户
 * 从别的应用里拽回来。失败（平台不支持、spawn 抛错）返回 `issued:false`，
 * 调用方据此回 501；补发排在后台，不受首发结果影响。
 *
 * 返回 `{ issued, cancel }`（H2）：定时器登记在本函数内部，`cancel()` 幂等，
 * 由路由注册处塞进 `connectionCtx.effect` 的生命周期（卸载即撤掉），
 * settle 时也走同一条清理路径。`options.registerCancel` / `unregisterCancel`
 * 让调用方把这把 cancel 收进自己的集合（自检也用它验证卸载行为）。
 * @param platform - `process.platform`。
 * @param options - 可注入的桩（自检用）：{ spawn, schedule, clearSchedule,
 *   environment, executable, killTimeoutMs, registerCancel, unregisterCancel }。
 * @returns `{ issued: boolean, cancel: () => void }`。
 */
function launchDesktopWindow(platform, options = {}) {
	const commands = activationCommands(platform, options.environment, options.executable);
	const record = options.record;
	if (commands.length === 0) {
		recordActivation(record, { event: 'unsupported', platform, desktopHost: isDesktopHost(options.environment, options.executable) });
		return { issued: false, cancel: () => {} };
	}
	const spawnProcess = options.spawn ?? spawn;
	const schedule = options.schedule ?? setTimeout;
	const clearSchedule = options.clearSchedule ?? clearTimeout;
	const killTimeoutMs = typeof options.killTimeoutMs === 'number' ? options.killTimeoutMs : HELPER_KILL_TIMEOUT_MS;
	// 环境只拷贝一次：一次点击最多 3 次 spawn，没必要每次尝试都复制整份 process.env（H18）。
	const spawnEnvironment = activationEnvironment(options.environment);
	const attemptTimers = new Set();
	const watchdogs = new Set();
	const children = new Set();
	let settled = false;
	let cancelled = false;
	let finished = false;
	let remainingAttempts = ACTIVATION_SCHEDULE_MS.length;

	const clearTimerSet = (set, clear) => {
		for (const handle of set) {
			try { clear(handle); } catch { /* 清定时器失败不影响收尾。 */ }
		}
		set.clear();
	};
	/** 由下面赋值；声明在 finish 之前，避免极端配置下 finish 先于赋值被调用（TDZ）。 */
	let cancel;
	/** 作废所有补发并把自己从调用方的生命周期集合里摘掉（幂等）。 */
	const finish = () => {
		if (finished) return;
		finished = true;
		clearTimerSet(attemptTimers, clearSchedule);
		try { options.unregisterCancel?.(cancel); } catch { /* 诊断失败不影响唤醒。 */ }
	};
	/** 卸载 / 宿主关闭时撤掉未发的补发，并杀掉还在跑的子进程（幂等）。 */
	cancel = () => {
		if (cancelled) return;
		cancelled = true;
		recordActivation(record, { event: 'cancelled' });
		clearTimerSet(attemptTimers, clearSchedule);
		for (const child of children) {
			try { child.kill?.(); } catch { /* 子进程可能已经退出。 */ }
		}
		children.clear();
		clearTimerSet(watchdogs, clearTimeout);
		finish();
	};
	/** 「目的达成」闸门：一置上，还没发出去的补发全部作废（定时器被 clear，不是空跑）。 */
	const settle = (reason) => {
		if (settled || cancelled) return;
		settled = true;
		recordActivation(record, { event: 'settled', reason });
		finish();
	};
	const cleanupChild = (child, watchdog) => {
		children.delete(child);
		if (watchdog !== undefined) {
			watchdogs.delete(watchdog);
			try { clearTimeout(watchdog); } catch { /* 已经触发过。 */ }
		}
	};
	/** 发一次（按次序轮换启动方式）；子进程 error 必须有监听者（否则冒泡成未捕获异常）。 */
	const attempt = (index) => {
		if (settled || cancelled) return false;
		const command = commands[index % commands.length];
		// 助手是**控制台程序**：`detached: true` 会让它在没有控制台时立刻退 0
		// （2026-10-07 实测：宿主原来那套 `detached + stdio:'ignore'` 下
		// `powershell.exe` 133ms 就退出、脚本一行没跑、raise 日志一个字没写；
		// 改成不 detach 立刻正常。exe / explorer 不是控制台程序，维持原样。）
		// 同时把它的 stdio 接上管道：出错时 PowerShell 会往 stderr 说话，
		// 之前 `stdio:'ignore'` 把这些线索全吞了，白查一轮。
		const isHelper = command.kind === 'foreground-helper';
		const detail = {
			attempt: index + 1,
			delayMs: ACTIVATION_SCHEDULE_MS[index],
			kind: command.kind ?? 'unknown',
			file: command.file,
			// 助手的 `-EncodedCommand` 是一大坨 base64：日志里只留长度，别把文件撑肥。
			args: command.args.map((arg) => (typeof arg === 'string' && arg.length > 80 ? `<${arg.length} chars>` : arg)),
		};
		recordActivation(record, { ...detail, event: 'attempt' });
		let child;
		try {
			child = spawnProcess(command.file, command.args, {
				detached: !isHelper,
				stdio: isHelper ? ['ignore', 'pipe', 'pipe'] : 'ignore',
				windowsHide: true,
				env: spawnEnvironment,
			});
		} catch (error) {
			recordActivation(record, { ...detail, event: 'spawn-throw', error: messageOf(error) });
			remainingAttempts -= 1;
			if (remainingAttempts <= 0) finish();
			return false;
		}
		children.add(child);
		let output = '';
		if (isHelper && child.stdout !== undefined && child.stdout !== null && typeof child.stdout.on === 'function') {
			// H3：先判长度再 String()，满了之后不再给每个 chunk 做字符串转换。
			const collect = (chunk) => {
				if (output.length >= OUTPUT_CAPTURE_LIMIT) return;
				output += String(chunk).slice(0, OUTPUT_CAPTURE_LIMIT - output.length);
			};
			child.stdout.on('data', collect);
			child.stderr?.on?.('data', collect);
		}
		let watchdog;
		if (isHelper) {
			// 看门狗用真实 setTimeout（不进补发注入桩，避免测试/生命周期把两者混在一起），
			// 并且 unref：它只负责 kill 卡死的助手，不负责把宿主拖住。
			watchdog = setTimeout(() => {
				watchdogs.delete(watchdog);
				recordActivation(record, { ...detail, event: 'kill-timeout' });
				try { child.kill?.(); } catch { /* 已经退出。 */ }
			}, killTimeoutMs);
			watchdog?.unref?.();
			watchdogs.add(watchdog);
		}
		child.on('spawn', () => recordActivation(record, { ...detail, event: 'spawn', childPid: child.pid ?? null }));
		const destroyPipes = () => {
			try { child.stdout?.destroy?.(); } catch { /* 流可能已经关了。 */ }
			try { child.stderr?.destroy?.(); } catch { /* 流可能已经关了。 */ }
		};
		// H3：PowerShell 的 stdout/stderr 是管道；子进程结束后必须 destroy，
		// 否则 unref 过的 child 仍会被管道句柄挂住（实测父进程会等到子进程退出）。
		child.on('close', destroyPipes);
		child.on('error', (error) => {
			cleanupChild(child, watchdog);
			recordActivation(record, { ...detail, event: 'spawn-error', error: messageOf(error) });
		});
		child.on('exit', (code, signal) => {
			cleanupChild(child, watchdog);
			destroyPipes();
			// stderr 开头那段 `#< CLIXML` + `<Objs>…</Objs>` 只是 PowerShell 的
			// 「正在准备模块」进度噪音；只摘掉那个 XML 块，别把后面真正的报错一起删了。
			const text = output
				.replace(/#< CLIXML/gu, '')
				.replace(/<Objs[\s\S]*?<\/Objs>/gu, ' ')
				.trim();
			recordActivation(record, { ...detail, event: 'exit', code, signal, ...(text === '' ? {} : { output: text.slice(0, 500) }) });
			// 助手的退出码 0 = 收尾时目标窗口已经是前台（`foregroundHelperScript`）。
			// 这是宿主唯一看得见的「窗口已经在用户眼前」信号 —— 拿到就撤掉剩下的
			// 补发，别再反复抢前台。exe / explorer 的退出码没有这个含义，不认。
			if (isHelper && code === 0) settle('foreground');
		});
		recordActivation(record, { ...detail, event: 'issued', childPid: child.pid ?? null });
		try { child.unref(); } catch { /* unref 失败不影响唤醒。 */ }
		remainingAttempts -= 1;
		if (remainingAttempts <= 0) finish();
		return true;
	};
	let issued = false;
	for (const [index, delay] of ACTIVATION_SCHEDULE_MS.entries()) {
		if (index === 0) {
			issued = attempt(index);
			continue;
		}
		const handle = schedule(() => {
			attemptTimers.delete(handle);
			attempt(index);
		}, delay);
		handle?.unref?.();
		attemptTimers.add(handle);
	}
	const cancelHandle = cancel;
	try { options.registerCancel?.(cancelHandle); } catch { /* 诊断失败不影响唤醒。 */ }
	return { issued, cancel: cancelHandle };
}

/**
 * 本模块旁边那份 package.json 里的版本号 —— 也就是**磁盘上已经装好的**版本。
 * 升级成功后这里立刻变新，而进程里跑着的代码要重启才换，所以「已装版本」和
 * 「运行版本」在更新完成后会短暂不一致，这是正常的（设置页也照实说）。
 * @returns 版本字符串；读不到时为 null。
 */
function installedVersion() {
	try {
		const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
		return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null;
	} catch {
		return null;
	}
}

/**
 * 拆一个版本号：`1.6.0` / `v1.6.0` / `1.7.0-beta.1` 都认，带构建元数据（`+x`）也认。
 * @param value - 任意版本字符串。
 * @returns `{ numbers, prerelease }`；认不出时返回 null。
 */
function parseVersion(value) {
	if (typeof value !== 'string') return null;
	const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
	if (match === null) return null;
	return {
		numbers: match[1].split('.').map((part) => Number(part)),
		prerelease: match[2] === undefined ? null : match[2].split('.'),
	};
}

/**
 * 比两个预发布段（semver 规则：数字段按数值比、字母段按字典序，数字段小于字母段，
 * 前缀相同则短的那个更小）。
 * @param left - 左侧标识符数组。
 * @param right - 右侧标识符数组。
 * @returns -1 / 0 / 1。
 */
function comparePrerelease(left, right) {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (a === undefined) return -1;
		if (b === undefined) return 1;
		const aNumber = /^\d+$/.test(a) ? Number(a) : null;
		const bNumber = /^\d+$/.test(b) ? Number(b) : null;
		if (aNumber !== null && bNumber !== null) {
			if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1;
			continue;
		}
		if (aNumber !== null) return -1;
		if (bNumber !== null) return 1;
		if (a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

/**
 * 比两个版本号。认不出的版本按「相等」处理 —— 宁可少报一次「有新版」，
 * 也不要因为读到脏数据就让用户点一次没必要的升级。
 * @param left - 左侧版本。
 * @param right - 右侧版本。
 * @returns 负数 / 0 / 正数。
 */
function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (a === null || b === null) return 0;
	const length = Math.max(a.numbers.length, b.numbers.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	// 同号：带预发布段的更小（1.7.0-beta < 1.7.0）。
	if (a.prerelease === null && b.prerelease === null) return 0;
	if (a.prerelease === null) return 1;
	if (b.prerelease === null) return -1;
	return comparePrerelease(a.prerelease, b.prerelease);
}

/** 缩写元数据的 Accept：只要 dist-tags / versions，不要整份 README。 */
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json';

/** registry 元数据 URL（作用域包名要编码）。两条传输共用，避免各拼一份（H12）。 */
function registryUrl(registry) {
	return `${registry}${encodeURIComponent(PACKAGE_NAME)}`;
}

/**
 * 从 registry 答复里取 `dist-tags.latest`；不可读就抛错。
 * 两条传输共用这一份校验（H12），消息保持一致。
 * @param body - JSON.parse 出来的 registry 元数据。
 * @param registry - 源地址（只用于错误说明）。
 * @returns 版本字符串。
 */
function latestOf(body, registry) {
	const latest = body?.['dist-tags']?.latest;
	if (typeof latest !== 'string' || parseVersion(latest) === null) {
		throw new Error(`${registry} 没有给出可读的版本号`);
	}
	return latest;
}

/**
 * 把「外部 abort（另一条传输先答上来）」和「总超时」合成一个 signal。
 * @param timeoutMs - 总时限。
 * @param external - 外部取消信号（可为 undefined）。
 * @returns AbortSignal。
 */
function combinedAbortSignal(timeoutMs, external) {
	if (external === undefined || external === null) return AbortSignal.timeout(timeoutMs);
	if (typeof AbortSignal.any === 'function') return AbortSignal.any([AbortSignal.timeout(timeoutMs), external]);
	// 老 Node（<20.3）没有 AbortSignal.any：手写一个等价合并。
	const controller = new AbortController();
	const abort = (reason) => controller.abort(reason);
	if (external.aborted) abort(external.reason);
	else external.addEventListener('abort', () => abort(external.reason), { once: true });
	const timer = setTimeout(() => abort(new Error(`timeout ${String(timeoutMs)}ms`)), timeoutMs);
	timer.unref?.();
	controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
	return controller.signal;
}

/**
 * 读 registry 响应 body，带大小上限（H4）：`dist-tags` 只需要很小一份元数据，
 * 不能让一个坏的/恶意的源把整份 README 灌进宿主内存。
 * @param response - fetch 的 Response。
 * @param label - 错误说明里用的源地址。
 * @param limit - 字节上限。
 * @returns UTF-8 文本。
 */
async function readCappedBody(response, label, limit = REGISTRY_MAX_BYTES) {
	const declared = Number(response.headers?.get?.('content-length'));
	if (Number.isFinite(declared) && declared > limit) {
		throw new Error(`${label} 答复过大（${String(declared)} > ${String(limit)} 字节）`);
	}
	const body = response.body;
	if (body === null || body === undefined || typeof body.getReader !== 'function') {
		const text = await response.text();
		if (text.length > limit) throw new Error(`${label} 答复过大（超过 ${String(limit)} 字节）`);
		return text;
	}
	const reader = body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				try { await reader.cancel(); } catch { /* 已经关了。 */ }
				throw new Error(`${label} 答复过大（超过 ${String(limit)} 字节）`);
			}
			chunks.push(value);
		}
	} finally {
		try { reader.releaseLock?.(); } catch { /* 已经释放。 */ }
	}
	return Buffer.concat(chunks).toString('utf8');
}

/** 环境代理变量名（Node 24 的 fetch 在 NODE_USE_ENV_PROXY=1 时按它们走代理）。 */
const PROXY_ENV_NAMES = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']);

/**
 * 这次检查要不要再走一遍「环境代理」这条路。
 *
 * 为什么不是「配了代理就走」：Node 24 的 `fetch` 会按 `HTTPS_PROXY` 连代理，而
 * 代理没开的时候（本机 Clash 关了、公司代理断线）它直接 ECONNREFUSED，**直连
 * 反而是通的**。所以直连永远是主路，代理只是「宿主自己开着这套开关」时并行的
 * 备选路；两条一起问，谁先答用谁。
 * @param environment - 环境变量表。
 * @returns 环境代理这条路可用时为 true。
 */
function envProxyConfigured(environment = process.env) {
	const enabled = environment?.NODE_USE_ENV_PROXY;
	// Node 只在 NODE_USE_ENV_PROXY 打开时才让 fetch 认这些变量；没打开时再加一条
	// 「代理路」只会和直连发同一个请求，白白多一次往返。
	if (enabled !== true && String(enabled).toLowerCase() !== '1' && String(enabled).toLowerCase() !== 'true') return false;
	return PROXY_ENV_NAMES.some((name) => {
		const value = environment?.[name];
		return typeof value === 'string' && value.trim() !== '';
	});
}

/**
 * 直连源读元数据：`node:https` + `agent: false`，**绕开装在全局 agent 上的环境代理**。
 *
 * 为什么必须显式写 `agent: false`：Node 24 的 `NODE_USE_ENV_PROXY=1` 不只是让
 * `fetch` 走代理，`https.request` 也走（代理挂在全局 agent 上），所以「用 https
 * 就是直连」并不成立 —— 实测代理没开时默认写法照样 ECONNREFUSED 127.0.0.1:7897，
 * 而 `agent: false`（每次新建默认 agent）直接连源、拿到 200。
 *
 * H4：这里是**总 deadline**（setTimeout + destroy），不是只看 socket 空闲；
 * 响应超过 `REGISTRY_MAX_BYTES` 立即中止。外部 `signal` 用于「另一条传输先答上来」
 * 时取消这条（H15）。
 * @param registry - 源地址（带结尾斜杠）。
 * @param signal - 外部取消信号（可选）。
 * @param timeoutMs - 总时限（自检可注入小值）。
 * @returns `{ registry, latest }`。
 */
function readRegistryDirect(registry, signal, timeoutMs = REGISTRY_TIMEOUT_MS) {
	const url = registryUrl(registry);
	return new Promise((resolve, reject) => {
		let settled = false;
		let request;
		let deadline;
		let onAbort;
		const cleanup = () => {
			clearTimeout(deadline);
			deadline = undefined;
			if (onAbort !== undefined) {
				try { signal?.removeEventListener?.('abort', onAbort); } catch { /* 已经移除。 */ }
				onAbort = undefined;
			}
		};
		const succeed = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			try { request?.destroy(); } catch { /* 已经结束。 */ }
			reject(error);
		};
		const onResponse = (response) => {
			const status = response.statusCode ?? 0;
			if (status !== 200) {
				response.resume?.();
				fail(new Error(`${registry} 返回 HTTP ${String(status)}`));
				return;
			}
			let text = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => {
				if (settled) return;
				if (text.length + chunk.length > REGISTRY_MAX_BYTES) {
					fail(new Error(`${registry} 答复过大（超过 ${String(REGISTRY_MAX_BYTES)} 字节）`));
					return;
				}
				text += chunk;
			});
			response.on('error', (error) => fail(error));
			response.on('end', () => {
				if (settled) return;
				let body;
				try {
					body = JSON.parse(text);
				} catch (error) {
					fail(new Error(`${registry} 的答复不是 JSON：${messageOf(error)}`));
					return;
				}
				try {
					succeed({ registry, latest: latestOf(body, registry) });
				} catch (error) {
					fail(error);
				}
			});
		};
		try {
			request = httpsGet(url, { agent: false, headers: { accept: REGISTRY_ACCEPT }, timeout: timeoutMs }, onResponse);
		} catch (error) {
			fail(error);
			return;
		}
		deadline = setTimeout(() => fail(new Error(`${registry} 请求超时（${String(timeoutMs)}ms 总时限）`)), timeoutMs);
		deadline.unref?.();
		request.on('timeout', () => fail(new Error(`${registry} 请求超时（${String(timeoutMs)}ms 空闲）`)));
		request.on('error', (error) => fail(error));
		if (signal !== undefined && signal !== null) {
			onAbort = () => fail(new Error(`${registry} 请求已取消`));
			if (signal.aborted === true) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

/**
 * 走环境代理读元数据（全局 `fetch`；`NODE_USE_ENV_PROXY=1` 时它按环境代理连）。
 * H4：总时限 + 响应大小上限；外部 `signal` 用于胜者出现后取消败者（H15）。
 * @param registry - 源地址（带结尾斜杠）。
 * @param signal - 外部取消信号（可选）。
 * @param timeoutMs - 总时限（自检可注入小值）。
 * @returns `{ registry, latest }`。
 */
async function readRegistryProxied(registry, signal, timeoutMs = REGISTRY_TIMEOUT_MS) {
	if (typeof fetch !== 'function') throw new Error('当前运行环境没有 fetch');
	const response = await fetch(registryUrl(registry), {
		signal: combinedAbortSignal(timeoutMs, signal),
		headers: { accept: REGISTRY_ACCEPT },
	});
	if (response.ok !== true) throw new Error(`${registry} 返回 HTTP ${String(response.status)}`);
	const text = await readCappedBody(response, registry);
	let body;
	try {
		body = JSON.parse(text);
	} catch (error) {
		throw new Error(`${registry} 的答复不是 JSON：${messageOf(error)}`);
	}
	return { registry, latest: latestOf(body, registry) };
}

/**
 * 这次检查可用的传输方式：直连永远是主路；宿主自己开着环境代理时再加一条代理路。
 * 两条是**并行**问的（谁先给出答案用谁的），所以代理开着但没连上、代理关着但
 * 环境变量还留着，都不会把「有新版」变成「连不上」。
 * @param environment - 环境变量表（默认 `process.env`）。
 * @returns 传输函数数组（每个收源地址与可选取消信号，返 `{ registry, latest }`）。
 */
function updateTransports(environment = process.env) {
	const transports = [readRegistryDirect];
	if (envProxyConfigured(environment)) transports.push(readRegistryProxied);
	return transports;
}

/**
 * 问一个源：本包 `dist-tags.latest` 是多少。同一源的几条传输并行跑，先答的算数。
 * 胜者出现后 abort 败者（H15）：代理开着时两条路都在跑，先答上来之后没必要让
 * 另一条继续占连接/代理流量。
 * @param registry - 源地址（带结尾斜杠）。
 * @param transports - 传输方式（默认 `updateTransports()`）。
 * @returns `{ registry, latest }`。
 */
async function readRegistry(registry, transports = updateTransports()) {
	const controller = new AbortController();
	const probes = transports.map((transport) => Promise.resolve().then(() => transport(registry, controller.signal)));
	try {
		const answer = await Promise.any(probes);
		controller.abort();
		return answer;
	} catch (error) {
		controller.abort();
		// Promise.any 折成 AggregateError：把每条路自己的原因拼出来（含 undici 的
		// cause，否则只剩一句没用的 “fetch failed”）。
		const reasons = (Array.isArray(error?.errors) ? error.errors : [error]).map((item) => messageOf(item)).filter((item) => item !== '');
		throw new Error(`${registry} 请求失败：${reasons.join('；')}`);
	}
}

/**
 * 问所有源（并行），取版本最高的那个答案。
 * 全部失败时抛出**第一个**失败源的说明（用户看到的是一条具体原因，不是空话）。
 * @param options - 可注入的传输方式与环境（自检用；生产走默认值）。
 * @returns `{ registry, latest }`。
 */
async function readLatestVersion(options = {}) {
	const transports = options.transports ?? updateTransports(options.environment);
	const probes = REGISTRIES.map((registry) => readRegistry(registry, transports));
	const settled = await Promise.allSettled(probes);
	const answers = [];
	let firstFailure = null;
	for (const entry of settled) {
		if (entry.status === 'fulfilled') answers.push(entry.value);
		else if (firstFailure === null) firstFailure = entry.reason;
	}
	if (answers.length === 0) throw firstFailure ?? new Error('所有源都没答复');
	answers.sort((left, right) => compareVersions(right.latest, left.latest));
	return answers[0];
}

/**
 * 当前 profile 的位置信息（`profileContext` 只有 profile 的位置与启动清单）。
 * @param ctx - 宿主插件上下文。
 * @returns `{ dir }`；拿不到时 dir 为 null。
 */
function profileDirOf(ctx) {
	try {
		const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
		return typeof profile?.dir === 'string' && profile.dir !== '' ? profile.dir : null;
	} catch {
		return null;
	}
}

/**
 * 本包是不是「本地开发安装」（`link:` / `file:` 等）。是的话不该往源上升级 ——
 * 那会把开发中的工作目录换成 npm 上的发布版，用户多半不想要。
 * @param dir - profile 目录。
 * @returns 依赖声明字符串；不是本地安装时返回 null。
 */
function localInstallSpec(dir) {
	if (dir === null) return null;
	try {
		const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		const spec = manifest?.dependencies?.[PACKAGE_NAME];
		if (typeof spec !== 'string') return null;
		return /^(link|file|workspace|portal):/.test(spec) ? spec : null;
	} catch {
		return null;
	}
}

/**
 * 「检查更新」的一份答复。渲染进程不认识这里的字段就会当失败，所以字段名是契约，
 * 两边一起改（client.js 的 UPDATE_* 注释里写着同一份契约）。
 * @param ctx - 宿主插件上下文。
 * @param options - 可注入的传输方式与环境（自检用）。
 * @returns 答复对象（路由层的 `respond()` 保证永远 200 + JSON；直接调用遇到
 *   `ctx.get` 抛错等情况仍可能 reject，自检按需 try/catch）。
 */
async function checkUpdate(ctx, options = {}) {
	const current = installedVersion();
	const local = localInstallSpec(profileDirOf(ctx));
	const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined;
	const base = {
		current,
		latest: null,
		registry: null,
		outdated: false,
		local,
		// 本地开发安装不往源上升级；宿主没挂上 pluginManager（精简组合）时也没有升级能力。
		updatable: local === null && manager !== undefined && typeof manager.installBundle === 'function',
		error: null,
	};
	try {
		const found = await readLatestVersion(options);
		const outdated = current !== null && compareVersions(found.latest, current) > 0;
		return { ...base, latest: found.latest, registry: found.registry, outdated, ok: true };
	} catch (error) {
		return { ...base, ok: false, error: messageOf(error) };
	}
}

/**
 * 读一次请求体（渲染进程会把「我要升到哪个版本」放进来）。读不动就当没给。
 * @param request - Fetch 请求。
 * @returns 解析出的对象（失败时是空对象）。
 */
async function requestBody(request) {
	try {
		if (request === null || request === undefined || typeof request.text !== 'function') return {};
		const text = await request.text();
		if (typeof text !== 'string' || text.trim() === '') return {};
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * 把错误折成一行能读的说明。**必须带上 `cause`**：undici（Node 的 fetch）抛出来
 * 的永远是一句 “fetch failed”，真正的原因（ECONNREFUSED / ENOTFOUND / 证书）
 * 都在 `error.cause` 里 —— 不带它的话用户只能看到一句没用的英文。
 * @param error - 任意抛出来的东西。
 * @returns 说明字符串（最多 300 字）。
 */
function messageOf(error) {
	const text = error instanceof Error ? error.message : String(error);
	const cause = error?.cause;
	let detail = '';
	if (cause !== undefined && cause !== null) {
		const code = typeof cause.code === 'string' ? cause.code : '';
		const description = cause instanceof Error ? cause.message : String(cause);
		// H17：cause 的 message 里已经带 code（undici 常见形态：
		// “connect ECONNREFUSED 127.0.0.1:7897” + code）时不要再拼一遍。
		detail = (code !== '' && !description.includes(code) ? `${code} ${description}` : description).trim();
		if (detail !== '' && text.includes(detail)) detail = '';
	}
	const combined = detail === '' ? text : `${text}（${detail}）`;
	return combined.length > 300 ? `${combined.slice(0, 300)}…` : combined;
}

/**
 * plugin-manager 认作「已经落盘/已生效」的 application 取值：
 * - `applied`：有 HMR，新版本已落盘且会由 HMR 接管；
 * - `restart-required`：无 HMR，新版本已落盘，重启 DSH 后生效。
 * 其余（`failed` / `cancelled` / 缺失）一律不算成功（H11）。
 */
const SUCCESSFUL_APPLICATIONS = Object.freeze(['applied', 'restart-required']);

/**
 * 从 `installBundle` / `removeBundle` 的结果里取「失败原因」；成功返回 null。
 *
 * 顺序与宿主一致：`error.diagnostic`（真实报错）优先于 `error.code`（可本地化
 * 错误码）；`cancelled` 是宿主**回滚后**的取消，不能当成功；`exitCode` 只在
 * 它是 number 且非 0 时判失败（H11：缺字段不再误报“退出码 undefined”）。
 * @param result - plugin-manager 的返回对象。
 * @returns 失败说明字符串；成功时为 null。
 */
function installationFailureReason(result) {
	if (result === null || result === undefined) return '宿主没有返回安装结果';
	const error = result.error;
	if (error !== undefined && error !== null) {
		if (typeof error.diagnostic === 'string' && error.diagnostic !== '') return error.diagnostic;
		if (typeof error.code === 'string' && error.code !== '') return error.code;
		return '安装失败';
	}
	if (result.application === 'cancelled') return '安装被取消（DSH 已回滚本次安装）';
	const exitCode = result.packageResult?.exitCode;
	if (typeof exitCode === 'number' && exitCode !== 0) return `包管理器退出码 ${String(exitCode)}`;
	if (!SUCCESSFUL_APPLICATIONS.includes(result.application)) {
		return `安装未完成（application=${String(result.application)}）`;
	}
	return null;
}

/** 取宿主给出的管理错误码（如 `already-installed` / `incompatible-version`）。 */
function managementCodeOf(result) {
	return typeof result?.error?.code === 'string' ? result.error.code : '';
}

/** 结果里的包管理器输出（截尾 2000 字符，透传给设置页做失败详情）。 */
function packageOutputOf(result) {
	return typeof result?.packageResult?.output === 'string' ? result.packageResult.output.slice(-2000) : null;
}

/**
 * H1 兜底：两步升级里新版本装失败后，把 current 版本装回去（或至少说清楚下一步）。
 * @param manager - pluginManager 服务。
 * @param currentVersion - 升级前磁盘上的版本（可能为 null）。
 * @param requestId - 回滚安装的 requestId。
 * @returns 一句可操作的中文说明（失败路径也返回字符串，不抛）。
 */
async function rollbackInstall(manager, currentVersion, requestId) {
	if (currentVersion === null) {
		return `读不到升级前的版本，无法自动回滚；请手动重新安装 ${PACKAGE_NAME}`;
	}
	try {
		const result = await manager.installBundle(`${PACKAGE_NAME}@${currentVersion}`, { requestId });
		const reason = installationFailureReason(result);
		if (reason === null) return `已装回 v${currentVersion}，重启 DSH 后以实际版本为准`;
		return `自动装回 v${currentVersion} 也失败（${reason}）；请手动重新安装 ${PACKAGE_NAME}`;
	} catch (error) {
		return `自动装回 v${currentVersion} 也失败（${messageOf(error)}）；请手动重新安装 ${PACKAGE_NAME}`;
	}
}

/**
 * 「立即更新」：交给 DSH 自己的 pluginManager 去装。
 *
 * **两条路径（H1）**：
 * 1. 老路径：`installBundle(@latest)` 一次。DSH ≤0.2.0 能原地覆盖已安装的包。
 * 2. 新宿主（DSH 0.2.1 起）：上面那步会返回 `already-installed`（HMR 存在时
 *    plugin-manager 拒绝覆盖已安装依赖，见其 lib/index.js:1991），于是改走官方
 *    Update 的等价两步：`removeBundle(PACKAGE_NAME)` → `installBundle(@latest)`。
 *    第二步失败时尝试把 `current` 版本装回，返回“已卸载但装回成功/失败”的说明。
 *
 * 成功条件显式化（H11）：只认 `application` 为 `applied` / `restart-required`；
 * `cancelled` 与缺失字段都不算成功。返回对象仍是既有契约字段
 * `{ ok, current, latest, application, error, output }`，client 不需要改。
 * @param ctx - 宿主插件上下文。
 * @param request - Fetch 请求（请求体里可带 `{ version }`）。
 * @param options - 可注入的传输方式与环境（自检用）。
 * @returns 答复对象（路由层 `respond()` 保证 200 + JSON）。
 */
async function applyUpdate(ctx, request, options = {}) {
	const current = installedVersion();
	const local = localInstallSpec(profileDirOf(ctx));
	if (local !== null) return { ok: false, current, latest: null, application: null, error: `本地开发安装（${local}），请用 git / 包管理器自行更新` };
	const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined;
	if (manager === undefined || typeof manager.installBundle !== 'function') {
		return { ok: false, current, latest: null, application: null, error: '当前 DSH 组合没有提供插件管理服务（pluginManager）' };
	}
	const body = await requestBody(request);
	let target = typeof body.version === 'string' && parseVersion(body.version) !== null ? body.version : null;
	if (target === null) {
		try {
			target = (await readLatestVersion(options)).latest;
		} catch (error) {
			return { ok: false, current, latest: null, application: null, error: messageOf(error) };
		}
	}
	if (current !== null && compareVersions(target, current) <= 0) {
		return { ok: true, current, latest: current, application: 'already-current', error: null };
	}
	const requestIdBase = `task-reminder-update-${String(Date.now())}`;
	let first;
	try {
		first = await manager.installBundle(`${PACKAGE_NAME}@${target}`, { requestId: `${requestIdBase}-install` });
	} catch (error) {
		// 个别宿主可能以 reject 而不是 {error:{code}} 的形式报 already-installed；
		// 只要能看出来，就照样走两步升级，而不是直接把异常丢给用户。
		if (!/already-installed/u.test(messageOf(error))) {
			return { ok: false, current, latest: null, application: null, error: messageOf(error) };
		}
		first = { application: 'failed', error: { code: 'already-installed' } };
	}
	const firstReason = installationFailureReason(first);
	if (firstReason === null) {
		return { ok: true, current, latest: installedVersion() ?? target, application: first.application, error: null, output: packageOutputOf(first) };
	}
	if (managementCodeOf(first) !== 'already-installed') {
		return { ok: false, current, latest: null, application: first.application ?? null, error: firstReason, output: packageOutputOf(first) };
	}
	// —— 以下只处理 DSH 0.2.1+（HMR 拒绝覆盖已安装包）的两步升级 ——
	if (typeof manager.removeBundle !== 'function') {
		return {
			ok: false,
			current,
			latest: null,
			application: first.application ?? null,
			error: `当前 DSH 的 pluginManager 不支持原地升级（already-installed），也没有 removeBundle；请手动卸载后重新安装 ${PACKAGE_NAME}`,
			output: packageOutputOf(first),
		};
	}
	let removal;
	try {
		removal = await manager.removeBundle(PACKAGE_NAME);
	} catch (error) {
		return {
			ok: false,
			current,
			latest: null,
			application: first.application ?? null,
			error: `卸载旧版本失败：${messageOf(error)}；插件可能仍是旧版本，请重启 DSH 后再试`,
			output: packageOutputOf(first),
		};
	}
	const removalReason = installationFailureReason(removal);
	if (removalReason !== null) {
		return {
			ok: false,
			current,
			latest: null,
			application: removal?.application ?? null,
			error: `卸载旧版本失败：${removalReason}；插件可能仍是旧版本，请重启 DSH 后再试`,
			output: packageOutputOf(first),
		};
	}
	let second;
	try {
		second = await manager.installBundle(`${PACKAGE_NAME}@${target}`, { requestId: `${requestIdBase}-two-step` });
	} catch (error) {
		const rollbackMessage = await rollbackInstall(manager, current, `${requestIdBase}-rollback`);
		return {
			ok: false,
			current,
			latest: null,
			application: null,
			error: `已卸载旧版本，但安装 v${target} 抛错（${messageOf(error)}）；${rollbackMessage}`,
			output: null,
		};
	}
	const secondReason = installationFailureReason(second);
	if (secondReason !== null) {
		const rollbackMessage = await rollbackInstall(manager, current, `${requestIdBase}-rollback`);
		return {
			ok: false,
			current,
			latest: null,
			application: second.application ?? null,
			error: `已卸载旧版本，但安装 v${target} 失败（${secondReason}）；${rollbackMessage}`,
			output: packageOutputOf(second),
		};
	}
	return { ok: true, current, latest: installedVersion() ?? target, application: second.application, error: null, output: packageOutputOf(second) };
}

/**
 * 一条 JSON 答复（自己拼而不是用 `Response.json`：两条更新路由对渲染进程的承诺
 * 是「永远 200 + JSON」，状态码与 content-type 都写死在这里，不随运行时版本变）。
 * @param payload - 任意可序列化对象。
 * @returns Fetch 响应。
 */
function jsonResponse(payload) {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

/**
 * 跑一个处理器，并把任何意外折成 JSON 答复 —— 两条更新路由对渲染进程的承诺是
 * 「永远 200 + JSON」，不能有一条路径回 500 或半截 HTML。
 * @param handler - 返回答复对象的异步函数。
 * @returns Fetch 响应。
 */
async function respond(handler) {
	try {
		return jsonResponse(await handler());
	} catch (error) {
		return jsonResponse({ ok: false, error: messageOf(error) });
	}
}

/** 本次进程内给「没带诊断 ID 的客户端」编号（旧通知 / 旧客户端的兼容路径）。 */
let activationRequestSequence = 0;

/**
 * 注册宿主侧的三条路由。桌面壳之外注册不上或没人调用，都是安静失败。
 *
 * 两条健壮性约束（H2/H10）：
 * - 三条路由各自 effect / 各自 try/catch：一条注册失败（例如重复装载时
 *   `registerFetchRoute` 对同路径抛错）不会把另外两条一起拖掉；
 * - 唤醒路由把 `launchDesktopWindow` 返回的 `cancel` 收进自己的 effect：
 *   插件卸载时把未发的补发定时器与在跑的子进程一并撤掉。
 *
 * @param ctx - 宿主插件上下文。
 * @param options - 可注入的桩（自检用）：`activationRecorder` 换掉写文件的实现，
 *   让离线自检既不碰用户目录、也看得见每次唤醒记了什么；`platform` / `transports`
 *   让同一套自检在任何操作系统上都能跑（Windows 唤醒链路与源查询都用桩，
 *   生产不传这些键，一律取 `process.platform` 与默认传输表）。
 *   `spawn` / `schedule` / `clearSchedule` / `killTimeoutMs` / `environment` /
 *   `executable` 同理只给自检用；生产是 cordis 插件 config，正常不会出现这些键。
 */
function apply(ctx, options = {}) {
	// 生产写入 %USERPROFILE%\.dsh\... ；自检注入内存实现。
	const makeRecorder = typeof options.activationRecorder === 'function'
		? options.activationRecorder
		: (context, logCtx) => createActivationRecorder(context, {
			onError: (error) => {
				try { logCtx?.logger?.('task-reminder')?.warn?.('activation log unavailable', error); } catch { /* 诊断失败不影响唤醒。 */ }
			},
		});
	// 宿主半侧额外行为绝不能让插件装载失败：整段包一层。
	try {
		ctx.inject(['connection'], (connectionCtx) => {
			/** 日志失败绝不能反过来搞坏路由注册。 */
			let warn = () => {};
			try {
				const logger = connectionCtx.logger?.('task-reminder');
				warn = (message, error) => {
					try { logger?.warn?.(message, error); } catch { /* 日志服务自己异常也不影响路由。 */ }
				};
			} catch { /* 拿不到 logger 也继续注册。 */ }
			let registry;
			try {
				registry = connectionCtx.connection?.fetch;
			} catch (error) {
				warn('connection.fetch unavailable', error);
				return;
			}
			// 老版本 / 精简组合里没有 Fetch 路由表：那就没有这条路可走。
			if (registry === undefined || typeof registry.register !== 'function') return;
			/** 一条路由一个 effect + 一个 try：单条失败不拖累另外两条（H10）。 */
			const registerRoute = (label, effectBody) => {
				try {
					return connectionCtx.effect(effectBody, label);
				} catch (error) {
					warn(`${label} unavailable`, error);
					return undefined;
				}
			};
			registerRoute('task-reminder: desktop window activation route', () => {
				// H2：本次插件实例挂载以来所有还在进行的唤醒，它们的 cancel 都收在这里；
				// effect 的 disposer 被调用时逐个 cancel（清定时器 / kill 子进程）。
				const pendingLaunches = new Set();
				const registerCancel = (cancel) => { pendingLaunches.add(cancel); };
				const unregisterCancel = (cancel) => { pendingLaunches.delete(cancel); };
				const disposeRoute = registry.register({
					path: ACTIVATION_PATH,
					methods: ['POST'],
					requestBody: 'buffered',
					fetch: (request) => {
						// 客户端可带诊断 ID；兼容旧通知/旧客户端，不要求请求体或新字段。
						const suppliedId = request?.headers?.get?.('x-task-reminder-activation-id');
						const requestId = typeof suppliedId === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(suppliedId)
							? suppliedId : `host-${Date.now()}-${++activationRequestSequence}`;
						// `options.platform` 只在自检里给（值就是 'win32' / 'darwin'）：CI 跑在
						// Linux 上，没有它这一整条 Windows 唤醒链路就永远测不到。
						const platform = options.platform ?? process.platform;
						const record = makeRecorder({ requestId, profile: profileDirOf(ctx), platform }, connectionCtx);
						record({ event: 'request', path: ACTIVATION_PATH });
						const launch = launchDesktopWindow(platform, {
							record,
							// 自检可以注入桩，避免真去起进程（生产这些键都是 undefined）。
							spawn: options.spawn,
							schedule: options.schedule,
							clearSchedule: options.clearSchedule,
							killTimeoutMs: options.killTimeoutMs,
							environment: options.environment,
							executable: options.executable,
							registerCancel,
							unregisterCancel,
						});
						const status = launch.issued ? 204 : 501;
						record({ event: 'response', status });
						// 204 仅代表首发已交给 spawn；不是窗口进入前台的确认。
						return new Response(null, { status });
					},
				});
				return () => {
					for (const cancel of [...pendingLaunches]) {
						try { cancel(); } catch { /* 已经收尾。 */ }
					}
					pendingLaunches.clear();
					try { disposeRoute?.(); } catch { /* 已经反注册。 */ }
				};
			});
			// 「检查更新」与「立即更新」：都不改提醒行为，失败也不抛给宿主。
			registerRoute('task-reminder: update check route', () => registry.register({
				path: UPDATE_CHECK_PATH,
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: () => respond(() => checkUpdate(ctx, options)),
			}));
			registerRoute('task-reminder: update apply route', () => registry.register({
				path: UPDATE_APPLY_PATH,
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: (request) => respond(() => applyUpdate(ctx, request, options)),
			}));
		});
	} catch (error) {
		try {
			ctx.logger?.('task-reminder')?.warn?.('host-side routes unavailable', error);
		} catch { /* 日志服务本身异常也不能让插件装载失败。 */ }
	}
}

/**
 * 纯函数与常量出口：Node 自检（test/verify-host.mjs）直接校验，不参与运行时行为。
 * 每个键都要有读者；没有读者的出口会在发布前被清掉。
 */
const diagnostics = {
	ACTIVATION_PATH,
	ACTIVATION_SCHEDULE_MS,
	UPDATE_CHECK_PATH,
	UPDATE_APPLY_PATH,
	PACKAGE_NAME,
	REGISTRIES,
	activationLogPath,
	activationCommands,
	createActivationRecorder,
	encodePowerShellCommand,
	executableProcessName,
	foregroundHelperScript,
	foregroundRaiseLogPath,
	applyUpdate,
	checkUpdate,
	compareVersions,
	envProxyConfigured,
	installedVersion,
	launchDesktopWindow,
	messageOf,
	parseVersion,
	readRegistryDirect,
	readRegistryProxied,
	updateTransports,
};

export {
	apply,
	diagnostics,
};
