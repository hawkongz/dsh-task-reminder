/**
 * dsh-task-reminder 宿主半侧的 Node 自检。
 *
 * 宿主半侧只做三件事：桌面壳唤醒、**读源上的最新版本**、**把包升到新版**。
 * 前一件的真实触发只有桌面壳里点通知那一下（`dsh://open` 重新拉起一份应用），
 * 在 Node 里没法真跑；后两件却必须真跑过 —— 判断「有没有新版」的版本比较、
 * 「本地开发安装不能升」的识别、「宿主没挂 pluginManager」的降级、以及失败时
 * 是不是如实报错，全是纯逻辑加可替换的 I/O。
 *
 * 做法：直接 import index.js 的 diagnostics 出口，用桩 ctx / 桩 fetch /
 * 桩 pluginManager 驱动 checkUpdate 与 applyUpdate；再 stub 一遍 Connection
 * 的 Fetch 路由表，确认三条路由都注册上了、检查路由真的回 JSON。
 *
 * 用法：node test/verify-host.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnostics, apply } from '../index.js';

const {
	ACTIVATION_PATH,
	ACTIVATION_SCHEDULE_MS,
	PACKAGE_NAME,
	REGISTRIES,
	UPDATE_APPLY_PATH,
	UPDATE_CHECK_PATH,
	activationLogPath,
	activationCommands,
	applyUpdate,
	checkUpdate,
	compareVersions,
	createActivationRecorder,
	encodePowerShellCommand,
	envProxyConfigured,
	executableProcessName,
	foregroundHelperScript,
	foregroundRaiseLogPath,
	installedVersion,
	launchDesktopWindow,
	messageOf,
	parseVersion,
	readRegistryDirect,
	readRegistryProxied,
	updateTransports,
} = diagnostics;

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const failures = [];
const check = (name, ok, detail) => {
	if (ok) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures.push(name);
	console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

// ---------------------------------------------------------------------------
// 桩：fetch / profile 目录 / pluginManager
// ---------------------------------------------------------------------------

/** 上一次 fetch 的入参，供断言「问的是哪个源、请求的是哪个路径」。 */
let fetchCalls = [];
/** 源地址 → 答复：版本字符串给答案，`{ error }` 表示这个源挂了。测试每个用例前重设。 */
let registryAnswers = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
	const target = String(url);
	fetchCalls.push({ url: target, options });
	const match = REGISTRIES.find((registry) => target.startsWith(registry));
	const answer = match === undefined ? undefined : registryAnswers[match];
	if (answer === undefined) return Promise.reject(new Error(`stub: no answer for ${target}`));
	if (typeof answer === 'object' && answer !== null) return Promise.reject(new Error(answer.error));
	return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ 'dist-tags': { latest: answer } }) });
};

/** 一个临时 profile 目录（写不写 link: 依赖由用例决定）。 */
const makeProfileDir = (spec) => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-task-reminder-host-'));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), JSON.stringify({
		name: 'dsh-profile-test',
		private: true,
		...(spec === undefined ? {} : { dependencies: { [PACKAGE_NAME]: spec } }),
	}, null, 2));
	return dir;
};

/** 桩宿主 ctx：只有 profileContext 与 pluginManager 两个服务。 */
const makeCtx = (options = {}) => ({
	get: (name) => {
		if (name === 'pluginManager') return options.manager;
		if (name === 'profileContext') return options.dir === undefined ? undefined : { dir: options.dir };
		return undefined;
	},
});

/** 记录安装调用的 pluginManager 桩。 */
const makeManager = (result) => {
	const calls = [];
	return {
		calls,
		installBundle: (spec, installOptions) => {
			calls.push({ spec, installOptions });
			if (typeof result === 'function') return result(spec, installOptions);
			return Promise.resolve(result);
		},
	};
};

/**
 * 自检里只用「走 fetch 的那条传输」：全局 fetch 被 stub 住，测试完全离线。
 * 生产默认的传输表是 `updateTransports()` —— 直连（`node:https` + `agent: false`，
 * 绕开装在全局 agent 上的环境代理）永远问，`NODE_USE_ENV_PROXY=1` 且真的配了代理时
 * 再并行加一条代理路。直连那条传输在这里用「连一个没人监听的本地端口必须失败」验，
 * 真机行为另有探针记录：本机 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=127.0.0.1:7897`
 * 但代理没开时，`fetch` 与默认 `https.request` 都 ECONNREFUSED，而 `agent: false`
 * 的直连从 registry.npmjs.org 取到了 `dist-tags.latest`。
 */
const STUB_TRANSPORTS = { transports: [readRegistryProxied] };

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

console.log('版本比较');
check('installedVersion 读的就是本包 package.json 的版本', installedVersion() === packageVersion, `${installedVersion()} vs ${packageVersion}`);
check('parseVersion 认 v 前缀 / 预发布 / 构建元数据，认不出的给 null', parseVersion('v1.6.0') !== null && parseVersion('1.7.0-beta.1') !== null
	&& parseVersion('1.6.0+build.5') !== null && parseVersion('latest') === null && parseVersion(undefined) === null && parseVersion(42) === null);
check('版本比较：递增 / 逐位补齐 / 预发布小于正式版', compareVersions('1.6.0', '1.5.5') > 0 && compareVersions('1.5.5', '1.5.5') === 0
	&& compareVersions('1.5.4', '1.5.5') < 0 && compareVersions('1.6', '1.6.0') === 0 && compareVersions('1.10.0', '1.9.9') > 0
	&& compareVersions('1.7.0-beta.1', '1.6.0') > 0 && compareVersions('1.7.0', '1.7.0-beta.2') > 0
	&& compareVersions('1.7.0-beta.2', '1.7.0-beta.10') < 0 && compareVersions('v1.6.0', '1.6.0') === 0);
check('认不出的版本按相等处理（宁可不说有新版）', compareVersions('', '1.0.0') === 0 && compareVersions(undefined, '1.0.0') === 0 && compareVersions(null, '1.0.0') === 0);

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

console.log('');
console.log('检查更新');
const cleanDir = makeProfileDir('^1.4.6');
const linkDir = makeProfileDir('link:C:/work/dsh-task-reminder');

registryAnswers = { 'https://registry.npmjs.org/': packageVersion, 'https://registry.npmmirror.com/': packageVersion };
fetchCalls = [];
const current = await checkUpdate(makeCtx({ dir: cleanDir, manager: makeManager({}) }), STUB_TRANSPORTS);
check('已是最新：outdated=false，并报出是哪个源答的', current.ok === true && current.outdated === false && current.latest === packageVersion
	&& current.registry === 'https://registry.npmjs.org/' && current.updatable === true && current.error === null, JSON.stringify(current));
check('问源只问包的元数据路径（作用域包名要转义）', fetchCalls.length === 2 && fetchCalls.every((call) => call.url.endsWith(encodeURIComponent(PACKAGE_NAME))), JSON.stringify(fetchCalls.map((call) => call.url)));

registryAnswers = { 'https://registry.npmjs.org/': '1.0.0', 'https://registry.npmmirror.com/': '9.9.9' };
const newer = await checkUpdate(makeCtx({ dir: cleanDir, manager: makeManager({}) }), STUB_TRANSPORTS);
check('两个源都答上来时取版本更高的那个（镜像同步慢不会把有新版说成已最新）', newer.outdated === true && newer.latest === '9.9.9' && newer.registry === 'https://registry.npmmirror.com/', JSON.stringify(newer));

registryAnswers = { 'https://registry.npmjs.org/': { error: 'network down' }, 'https://registry.npmmirror.com/': packageVersion };
const fallback = await checkUpdate(makeCtx({ dir: cleanDir, manager: makeManager({}) }), STUB_TRANSPORTS);
check('一个源挂了照样用另一个源的答案', fallback.ok === true && fallback.latest === packageVersion, JSON.stringify(fallback));

registryAnswers = { 'https://registry.npmjs.org/': { error: 'network down' }, 'https://registry.npmmirror.com/': { error: 'also down' } };
const offline = await checkUpdate(makeCtx({ dir: cleanDir, manager: makeManager({}) }), STUB_TRANSPORTS);
check('全部源都不可用时如实报失败（不当成已是最新），并带上真实原因', offline.ok === false && offline.latest === null
	&& typeof offline.error === 'string' && offline.error.includes('network down') && offline.error.includes('请求失败'), JSON.stringify(offline));

registryAnswers = { 'https://registry.npmjs.org/': packageVersion };
const noManager = await checkUpdate(makeCtx({ dir: cleanDir }), STUB_TRANSPORTS);
check('宿主没挂 pluginManager 时不给一键更新（updatable=false）', noManager.ok === true && noManager.updatable === false, JSON.stringify(noManager));

const linked = await checkUpdate(makeCtx({ dir: linkDir, manager: makeManager({}) }), STUB_TRANSPORTS);
check('本地开发安装（link:）认出来并挡住一键更新', linked.local === 'link:C:/work/dsh-task-reminder' && linked.updatable === false, JSON.stringify(linked));

const noProfile = await checkUpdate(makeCtx({}), STUB_TRANSPORTS);
check('拿不到 profile 目录也能查（只是不知道该不该本地挡住）', noProfile.ok === true && noProfile.local === null, JSON.stringify(noProfile));

// ---------------------------------------------------------------------------
// 传输方式：直连永远在，环境代理只是备选路
// ---------------------------------------------------------------------------

console.log('');
console.log('传输方式');
check('环境代理只在「宿主真的开着这套开关」时才算一条路', envProxyConfigured({}) === false
	&& envProxyConfigured({ HTTPS_PROXY: 'http://127.0.0.1:7897/', NODE_USE_ENV_PROXY: '1' }) === true
	&& envProxyConfigured({ HTTPS_PROXY: 'http://127.0.0.1:7897/' }) === false
	&& envProxyConfigured({ NODE_USE_ENV_PROXY: '1' }) === false
	&& envProxyConfigured({ NODE_USE_ENV_PROXY: '1', https_proxy: 'http://127.0.0.1:7897/' }) === true
	&& envProxyConfigured({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: '   ' }) === false
	&& envProxyConfigured({ NODE_USE_ENV_PROXY: '0', HTTPS_PROXY: 'http://127.0.0.1:7897/' }) === false,
	JSON.stringify({ on: envProxyConfigured(process.env), noFlag: envProxyConfigured({ HTTPS_PROXY: 'x' }) }));
check('传输表：直连永远在，代理只按开关加一条', (() => {
	const plain = updateTransports({});
	const proxied = updateTransports({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:7897/' });
	return plain.length === 1 && plain[0] === readRegistryDirect
		&& proxied.length === 2 && proxied[0] === readRegistryDirect && proxied[1] === readRegistryProxied;
})());
check('直连传输自己发 HTTPS，不经 fetch、也不经环境代理（真连一个没人监听的端口）', await (async () => {
	try {
		await readRegistryDirect('https://127.0.0.1:1/');
		return false;
	} catch (error) {
		return /ECONNREFUSED|EACCES|ECONNRESET|socket hang up|请求超时/.test(String(error?.message ?? error));
	}
})(), '直连传输没有按预期失败');
check('错误说明带上 cause（undici 只会说一句 fetch failed）', (() => {
	const error = new TypeError('fetch failed');
	error.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7897'), { code: 'ECONNREFUSED' });
	const text = messageOf(error);
	return text.includes('fetch failed') && text.includes('ECONNREFUSED') && text.includes('127.0.0.1:7897');
})(), messageOf(Object.assign(new TypeError('fetch failed'), { cause: new Error('x') })));

// ---------------------------------------------------------------------------
// 立即更新
// ---------------------------------------------------------------------------

console.log('');
console.log('立即更新');
const manager = makeManager(() => Promise.resolve({ packageResult: { exitCode: 0, output: 'Progress: resolved 1, reused 1' }, application: 'restart-required', changed: true }));
const body = (value) => ({ text: () => Promise.resolve(JSON.stringify(value)) });
const upgraded = await applyUpdate(makeCtx({ dir: cleanDir, manager }), body({ version: '1.7.0' }), STUB_TRANSPORTS);
check('更新：把版本原样交给 pluginManager.installBundle（带 requestId）', manager.calls.length === 1
	&& manager.calls[0].spec === `${PACKAGE_NAME}@1.7.0` && typeof manager.calls[0].installOptions.requestId === 'string', JSON.stringify(manager.calls));
check('更新成功：ok，application 记的是宿主的答复（已装的包是 restart-required）', upgraded.ok === true && upgraded.application === 'restart-required' && upgraded.latest === installedVersion(), JSON.stringify(upgraded));

const noBody = makeManager({ packageResult: { exitCode: 0 }, application: 'restart-required' });
registryAnswers = { 'https://registry.npmjs.org/': '1.8.0' };
const withoutBody = await applyUpdate(makeCtx({ dir: cleanDir, manager: noBody }), null, STUB_TRANSPORTS);
check('请求体没带版本就现查一次最新版（不信客户端缓存）', noBody.calls[0]?.spec === `${PACKAGE_NAME}@1.8.0`, JSON.stringify(noBody.calls));
check('请求体读不动也不炸（当没给处理）', (await applyUpdate(makeCtx({ dir: cleanDir, manager: noBody }), { text: () => Promise.reject(new Error('boom')) }, STUB_TRANSPORTS)).ok === true);

const olderRequest = makeManager({ packageResult: { exitCode: 0 } });
const already = await applyUpdate(makeCtx({ dir: cleanDir, manager: olderRequest }), body({ version: '1.0.0' }), STUB_TRANSPORTS);
check('要升的版本不比现在新就不动包管理器', already.ok === true && already.application === 'already-current' && olderRequest.calls.length === 0, JSON.stringify(already));

const failedManager = makeManager({ application: 'failed', error: { code: 'incompatible-version' }, packageResult: { exitCode: 1, output: 'ERR_PNPM' } });
const failed = await applyUpdate(makeCtx({ dir: cleanDir, manager: failedManager }), body({ version: '1.9.0' }), STUB_TRANSPORTS);
check('安装失败：ok=false，错误码与包管理器输出都带回来', failed.ok === false && failed.error === 'incompatible-version' && failed.output.includes('ERR_PNPM'), JSON.stringify(failed));

const throwingManager = makeManager(() => Promise.reject(new Error('profile lock timeout')));
const thrown = await applyUpdate(makeCtx({ dir: cleanDir, manager: throwingManager }), body({ version: '1.9.0' }), STUB_TRANSPORTS);
check('包管理器抛错也折成一句说明，不把异常抛给路由', thrown.ok === false && thrown.error.includes('profile lock timeout'), JSON.stringify(thrown));

const linkedApply = makeManager({ packageResult: { exitCode: 0 } });
const refused = await applyUpdate(makeCtx({ dir: linkDir, manager: linkedApply }), body({ version: '1.9.0' }), STUB_TRANSPORTS);
check('本地开发安装拒绝一键更新，并说清原因', refused.ok === false && refused.error.includes('本地开发安装') && linkedApply.calls.length === 0, JSON.stringify(refused));

const noManagerApply = await applyUpdate(makeCtx({ dir: cleanDir }), body({ version: '1.9.0' }), STUB_TRANSPORTS);
check('没有 pluginManager 时拒绝并说清原因', noManagerApply.ok === false && noManagerApply.error.includes('pluginManager'), JSON.stringify(noManagerApply));

// ---------------------------------------------------------------------------
// 桌面壳唤醒：首发 + 四次补发，两种启动方式轮换。实测「spawn 成功（页面留痕
// answered/204）但窗口没抬起来」反复出现，而且**第一次点击最容易输**
// （2026-10-07：点弹窗第一下没抬起来、后续点击都抬起来；同一天又实测到
// 「成功的与失败的宿主日志逐项一致」—— 5 次 spawn 全成功、退出码相同、204，
// 窗口却时好时坏 → 差别只在前台抢占被不被 Windows 放行，于是补上强抢前台那条）。
// 三条路轮换：直起 exe（second-instance）/ PowerShell 强抢前台 / explorer 走协议；
// 代价是每次唤醒多起几个撞锁即退的短命进程。
// ---------------------------------------------------------------------------

console.log('');
console.log('桌面壳唤醒');
const spawnCalls = [];
const scheduled = [];
const stubChild = { on: (event, handler) => { if (event === 'error') stubChild.errorHandler = handler; }, unref: () => {} };
const stubSpawn = (file, args, options) => {
	spawnCalls.push({ file, args, options });
	return stubChild;
};
const fakeSchedule = (fn, delay) => {
	scheduled.push({ fn, delay });
	return scheduled.length;
};
const desktopEnv = { ELECTRON_RUN_AS_NODE: '1' };

check('从 exe 路径推进程名（前台助手按它找窗口，不用会变的窗口标题）',
	executableProcessName('C:\\App Dir\\DeepSeek Harness.exe') === 'DeepSeek Harness'
	&& executableProcessName('C:\\node\\node.exe') === 'node'
	&& executableProcessName("C:\\x\\it's.exe") === "it''s",
	JSON.stringify([executableProcessName('C:\\App Dir\\DeepSeek Harness.exe'), executableProcessName('C:\\node\\node.exe')]));

// 强抢前台的助手脚本：枚举窗口自己挑（**不能用 `MainWindowHandle`** —— 实测本机
// 它给的是 DevTools 窗口）、AttachThreadInput + BringWindowToTop +
// SetForegroundWindow + ShowWindow(SW_RESTORE)，结果做成退出码 + 一份 raise 日志。
const helperScript = foregroundHelperScript('DeepSeek Harness', 'C:/Users/x/.dsh/task-reminder-raise.log');
const helperCommands = activationCommands('win32', desktopEnv, 'C:\\App Dir\\DeepSeek Harness.exe');
check('助手脚本包含绕前台锁的三件套与恢复最小化，且退出码区分「抢到了 / 没抢到 / 没窗口」',
	helperScript.includes('AttachThreadInput') && helperScript.includes('BringWindowToTop')
	&& helperScript.includes('SetForegroundWindow') && helperScript.includes('ShowWindow($handle, 9)')
	&& helperScript.includes("$processName = 'DeepSeek Harness'")
	&& helperScript.includes('exit 2') && helperScript.includes('exit 0') && helperScript.includes('exit 1'),
	helperScript.split('\r\n').slice(0, 3).join(' | '));
check('助手自己枚举顶层窗口挑目标：排除 DevTools、只认无主窗口（不靠会变的窗口标题选主窗口）',
	helperScript.includes('EnumWindows') && helperScript.includes('Developer Tools')
	&& helperScript.includes('GetWindow(h, 4)') && helperScript.includes('IsIconic'),
	helperScript.split('\r\n').filter((line) => line.includes('Developer Tools')).join(' | '));
check('助手把「我起来了 / 选了哪个窗口 / 抢到没有 / 报什么错」都写进 raise 日志',
	helperScript.includes("$logPath = 'C:/Users/x/.dsh/task-reminder-raise.log'")
	&& helperScript.includes("event = 'helper-start'") && helperScript.includes('event = "helper-error"')
	&& helperScript.includes('ConvertTo-Json -Compress') && helperScript.includes('[ordered]@{')
	&& helperScript.includes('foreground = $raised') && helperScript.includes('title = [DshRaise.Native]::Title($handle)')
	&& helperScript.includes('} catch {'),
	helperScript.split('\r\n').filter((line) => line.includes('Add-Content')).join(' | '));
check('raise 日志路径：%USERPROFILE%\\.dsh\\task-reminder-raise.log',
	foregroundRaiseLogPath('C:/Users/x') === join('C:/Users/x', '.dsh', 'task-reminder-raise.log'), foregroundRaiseLogPath('C:/Users/x'));
check('三种启动方式轮换：直起 exe → PowerShell 强抢前台 → explorer 走协议',
	JSON.stringify(helperCommands.map((command) => command.kind)) === JSON.stringify(['app-link', 'foreground-helper', 'shell-link'])
	&& helperCommands[0].file === 'C:\\App Dir\\DeepSeek Harness.exe' && helperCommands[0].args[0] === 'dsh://open'
	&& helperCommands[1].file === 'powershell.exe' && helperCommands[2].file === 'explorer.exe',
	JSON.stringify(helperCommands.map((command) => command.kind)));
check('助手那一发：-ExecutionPolicy Bypass / -WindowStyle Hidden / 脚本用 base64 传（不跟引号规则搏斗）',
	helperCommands[1].args.includes('-ExecutionPolicy') && helperCommands[1].args.includes('Bypass')
	&& helperCommands[1].args.includes('-WindowStyle') && helperCommands[1].args.includes('Hidden')
	&& (() => {
		const index = helperCommands[1].args.indexOf('-EncodedCommand');
		const decoded = Buffer.from(helperCommands[1].args[index + 1], 'base64').toString('utf16le');
		return index >= 0 && decoded.includes('AttachThreadInput') && decoded.includes('$processName = \'DeepSeek Harness\'')
			&& decoded.includes('task-reminder-raise.log');
	})(), JSON.stringify(helperCommands[1].args.slice(0, 8)));
check('encodePowerShellCommand 就是 UTF-16LE 的 base64（-EncodedCommand 的格式）',
	Buffer.from(encodePowerShellCommand('exit 0'), 'base64').toString('utf16le') === 'exit 0');

const winIssued = launchDesktopWindow('win32', { spawn: stubSpawn, schedule: fakeSchedule, environment: desktopEnv });
check('桌面壳（win32）：首发一次、返回已发出', winIssued === true && spawnCalls.length === 1 && spawnCalls[0].args[0] === 'dsh://open', JSON.stringify(spawnCalls));
check('首发之外补发四次（第一次点击最容易输，尾巴拉到 4 秒）', scheduled.length === ACTIVATION_SCHEDULE_MS.length - 1, JSON.stringify(scheduled.map((entry) => entry.delay)));
check('补发时刻按常量表排（0 / 700 / 1400 / 2400 / 4000ms）', scheduled.every((entry, index) => entry.delay === ACTIVATION_SCHEDULE_MS[index + 1]), JSON.stringify(scheduled.map((entry) => entry.delay)));
scheduled.forEach((entry) => entry.fn());
check('补发真的会再起进程（短命：撞单实例锁即退）', spawnCalls.length === ACTIVATION_SCHEDULE_MS.length, String(spawnCalls.length));
check('三条路按 0/700/1400/2400/4000ms 轮换（强抢前台在第二次尝试就上）',
	spawnCalls[0].file !== 'explorer.exe' && spawnCalls[0].args[0] === 'dsh://open'
	&& spawnCalls[1].file === 'powershell.exe'
	&& spawnCalls[2].file === 'explorer.exe' && spawnCalls[2].args[0] === 'dsh://open'
	&& spawnCalls[3].file === spawnCalls[0].file && spawnCalls[4].file === 'powershell.exe',
	JSON.stringify(spawnCalls.map((entry) => entry.file)));
check('子进程 error 有监听（不冒泡成未捕获异常）', typeof stubChild.errorHandler === 'function', String(typeof stubChild.errorHandler));
// 实测教训（2026-10-07）：助手 `powershell.exe` 是**控制台程序**，跟着 exe/explorer
// 一起 `detached: true` 时它拿不到控制台、133ms 就退 0，脚本一行没跑（raise 日志
// 一个字没写）；`stdio: 'ignore'` 又把 PowerShell 的报错全吞了，白查一轮。
check('助手不 detach、并且用管道收它的输出（exe / explorer 维持原来的 detached + ignore）',
	spawnCalls[0].options.detached === true && spawnCalls[0].options.stdio === 'ignore'
	&& spawnCalls[1].options.detached === false
	&& Array.isArray(spawnCalls[1].options.stdio) && spawnCalls[1].options.stdio[2] === 'pipe',
	JSON.stringify(spawnCalls.map((entry) => ({ file: entry.file, detached: entry.options?.detached, stdio: entry.options?.stdio }))));

// 助手往 stderr 说的话要进唤醒日志；PowerShell 那段 CLIXML 进度噪音要摘掉，
// 但**不能连带把后面真正的报错删掉**。
const pipedChild = {
	pid: 777,
	stdout: { on: (event, handler) => { if (event === 'data') pipedChild.onStdout = handler; } },
	stderr: { on: (event, handler) => { if (event === 'data') pipedChild.onStderr = handler; } },
	on: (event, handler) => { if (event === 'exit') pipedChild.onExit = handler; },
	unref: () => {},
};
const helperTrace = [];
const scheduleBeforeHelper = scheduled.length;
launchDesktopWindow('win32', {
	spawn: (file) => (file === 'powershell.exe' ? pipedChild : stubChild),
	schedule: fakeSchedule,
	environment: desktopEnv,
	executable: 'C:/App/dsh.exe',
	record: (entry) => helperTrace.push(entry),
});
scheduled[scheduleBeforeHelper].fn(); // 只补发第二次尝试（助手那一发）
pipedChild.onStdout?.('#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0" /></Objs>\r\n');
pipedChild.onStderr?.("Add-Type : Cannot add type. The type name 'DshRaise.Native' already exists.\r\n");
pipedChild.onExit?.(3, null);
const helperExit = helperTrace.find((entry) => entry.event === 'exit');
check('助手 stderr 进唤醒日志：CLIXML 进度噪音被摘掉、真正的报错留住',
	helperExit !== undefined && helperExit.code === 3
	&& String(helperExit.output).includes('Cannot add type')
	&& !String(helperExit.output).includes('CLIXML') && !String(helperExit.output).includes('<Objs'),
	JSON.stringify(helperExit));

const darwinCalls = [];
const darwinScheduled = [];
launchDesktopWindow('darwin', {
	spawn: (file, args) => { darwinCalls.push({ file, args }); return stubChild; },
	schedule: (fn, delay) => { darwinScheduled.push(delay); return 1; },
	environment: desktopEnv,
});
check('macOS 走 open dsh://open，同样首发 + 补发', darwinCalls.length === 1 && darwinCalls[0].file === 'open' && darwinScheduled.length === ACTIVATION_SCHEDULE_MS.length - 1, JSON.stringify({ calls: darwinCalls, scheduled: darwinScheduled }));

const linuxCalls = [];
const linuxIssued = launchDesktopWindow('linux', { spawn: (file, args) => { linuxCalls.push({ file, args }); return stubChild; }, schedule: () => 1, environment: desktopEnv });
check('不支持的平台：不起进程、返回 false（路由据此回 501）', linuxIssued === false && linuxCalls.length === 0, JSON.stringify(linuxCalls));

const throwingCalls = [];
const throwingIssued = launchDesktopWindow('win32', {
	spawn: () => { throwingCalls.push(1); throw new Error('spawn failed'); },
	schedule: () => 1,
	environment: desktopEnv,
});
check('spawn 抛错：返回 false，但补发照排（竞速不因一次失败放弃）', throwingIssued === false && throwingCalls.length === 1, `${throwingIssued} / ${throwingCalls.length}`);

const notDesktopSpawnCalls = [];
const notDesktopIssued = launchDesktopWindow('win32', {
	spawn: (file, args) => { notDesktopSpawnCalls.push({ file, args }); return stubChild; },
	schedule: fakeSchedule,
	environment: {},
});
check('不是桌面壳宿主：不起进程、返回 false（普通浏览器不走这条路）', notDesktopIssued === false && notDesktopSpawnCalls.length === 0, JSON.stringify(notDesktopSpawnCalls));

// ---------------------------------------------------------------------------
// 唤醒日志：宿主半侧原先完全不留痕 —— 「点了弹窗没抬窗」时，页面只能说
// 「请求发出去了、宿主答了 204」，至于宿主起了几次进程、用的哪条命令、
// spawn 成功还是失败，全都无从查起。这段把每次唤醒写成一行 JSONL。
// ---------------------------------------------------------------------------

console.log('');
console.log('唤醒日志');

check('日志路径：%USERPROFILE%\\.dsh\\task-reminder-activation.log（两个 profile 共用一份）',
	activationLogPath('C:/Users/x') === join('C:/Users/x', '.dsh', 'task-reminder-activation.log'), activationLogPath('C:/Users/x'));

const logWrites = [];
const testRecorder = createActivationRecorder(
	{ requestId: 'click-1-1', profile: 'C:/Users/x/.dsh/profiles/desktop', platform: 'win32' },
	{
		file: 'C:/Users/x/.dsh/task-reminder-activation.log',
		append: (file, text) => logWrites.push({ file, text }),
		mkdir: () => {},
		now: () => '2026-10-07T08:00:00.000Z',
	},
);
testRecorder({ event: 'attempt', attempt: 1, delayMs: 0, file: 'C:/app/dsh.exe', args: ['dsh://open'] });
const loggedLine = JSON.parse(logWrites[0].text.trim());
check('唤醒日志：一行一条 JSONL，带 requestId / profile / 事件 / 命令 / 时间 / 宿主 PID',
	logWrites.length === 1 && logWrites[0].file.endsWith('task-reminder-activation.log')
	&& loggedLine.requestId === 'click-1-1' && loggedLine.profile.endsWith('profiles/desktop')
	&& loggedLine.event === 'attempt' && loggedLine.attempt === 1 && loggedLine.file === 'C:/app/dsh.exe'
	&& loggedLine.time === '2026-10-07T08:00:00.000Z' && loggedLine.hostPid === process.pid,
	JSON.stringify({ writes: logWrites.length, line: loggedLine }));
check('唤醒日志：只记唤醒链路，不带 cookie / token / 会话正文',
	!/cookie|token|authorization|session/i.test(logWrites[0].text), logWrites[0].text.trim());
const logErrors = [];
const failingRecorder = createActivationRecorder({ requestId: 'r' }, {
	file: 'C:/nope/x.log',
	append: () => { throw new Error('EACCES'); },
	mkdir: () => {},
	onError: (error) => logErrors.push(String(error?.message ?? error)),
});
check('唤醒日志写不进去也不炸（记一笔 onError 就继续，不改变路由契约）', (() => {
	failingRecorder({ event: 'request' });
	return logErrors.length === 1 && logErrors[0].includes('EACCES');
})(), JSON.stringify(logErrors));

// 唤醒链路每一步都留痕：第几次尝试、用的哪条命令、spawn 成功/失败/退出。
const tracedLog = [];
const tracedHandlers = {};
const tracedChild = { pid: 4321, on: (event, handler) => { (tracedHandlers[event] ??= []).push(handler); }, unref: () => {} };
const tracedSpawned = [];
launchDesktopWindow('win32', {
	spawn: (file, args) => { tracedSpawned.push({ file, args }); return tracedChild; },
	schedule: fakeSchedule,
	environment: desktopEnv,
	record: (entry) => tracedLog.push(entry),
});
check('唤醒留痕：首发记 attempt + issued（带第几次、延迟、命令与子进程 PID）',
	tracedLog.some((entry) => entry.event === 'attempt' && entry.attempt === 1 && entry.delayMs === 0 && entry.args?.[0] === 'dsh://open')
	&& tracedLog.some((entry) => entry.event === 'issued' && entry.childPid === 4321),
	JSON.stringify(tracedLog));
tracedHandlers.spawn?.[0]?.();
tracedHandlers.exit?.[0]?.(0, null);
check('唤醒留痕：子进程 spawn / exit 也记下来（能区分「没起来」与「起来又退出」）',
	tracedLog.some((entry) => entry.event === 'spawn') && tracedLog.some((entry) => entry.event === 'exit' && entry.code === 0),
	JSON.stringify(tracedLog.map((entry) => entry.event)));
const failedTrace = [];
launchDesktopWindow('win32', {
	spawn: (file, args, options) => {
		const child = { pid: undefined, on: (event, handler) => { if (event === 'error') handler(new Error('ENOENT')); }, unref: () => {} };
		void args; void options;
		return child;
	},
	schedule: fakeSchedule,
	environment: desktopEnv,
	record: (entry) => failedTrace.push(entry),
});
check('唤醒留痕：spawn 报错记 spawn-error（带原因），不是静默失败',
	failedTrace.some((entry) => entry.event === 'spawn-error' && String(entry.error).includes('ENOENT')),
	JSON.stringify(failedTrace.map((entry) => entry.event)));
const throwTrace = [];
launchDesktopWindow('win32', {
	spawn: () => { throw new Error('spawn failed'); },
	schedule: fakeSchedule,
	environment: desktopEnv,
	record: (entry) => throwTrace.push(entry),
});
check('唤醒留痕：spawn 抛错记 spawn-throw', throwTrace.some((entry) => entry.event === 'spawn-throw' && String(entry.error).includes('spawn failed')),
	JSON.stringify(throwTrace.map((entry) => entry.event)));
const unsupportedTrace = [];
// 显式给 environment/executable：自检本身可能就跑在桌面壳宿主里
// （ELECTRON_RUN_AS_NODE=1），不写死就测不出「非桌面壳」这一侧。
launchDesktopWindow('linux', { schedule: fakeSchedule, environment: {}, executable: 'C:/node/node.exe', record: (entry) => unsupportedTrace.push(entry) });
check('唤醒留痕：平台不支持也记一笔 unsupported（并带上桌面壳判据），便于解释 501',
	unsupportedTrace.length === 1 && unsupportedTrace[0].event === 'unsupported' && unsupportedTrace[0].desktopHost === false,
	JSON.stringify(unsupportedTrace));
check('唤醒留痕：record 自己抛错也不影响首发结果（诊断不能反过来搞坏唤醒）', (() => {
	const calls = [];
	const issued = launchDesktopWindow('win32', {
		spawn: (file, args) => { calls.push({ file, args }); return stubChild; },
		schedule: fakeSchedule,
		environment: desktopEnv,
		record: () => { throw new Error('log exploded'); },
	});
	return issued === true && calls.length === 1;
})(), '日志抛错时首发结果被改坏');

// ---------------------------------------------------------------------------
// 路由注册（Connection 的 Fetch 路由表）
// ---------------------------------------------------------------------------

console.log('');
console.log('路由注册');
const routes = [];
const effects = [];
apply({
	inject: (names, callback) => {
		if (JSON.stringify(names) !== JSON.stringify(['connection'])) throw new Error(`unexpected inject: ${JSON.stringify(names)}`);
		callback({
			connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
			effect: (fn, label) => {
				const disposer = fn();
				effects.push({ label, disposer });
				return disposer;
			},
		});
	},
});
check('三条宿主路由都注册上了（唤醒 / 检查更新 / 立即更新）', routes.length === 3
	&& routes[0].path === ACTIVATION_PATH && routes[1].path === UPDATE_CHECK_PATH && routes[2].path === UPDATE_APPLY_PATH, JSON.stringify(routes.map((route) => route.path)));
check('三条路由都只收 POST、都按 buffered 读请求体', routes.every((route) => JSON.stringify(route.methods) === JSON.stringify(['POST']) && route.requestBody === 'buffered'));
check('检查更新路由真的回 JSON（宿主永远 200，失败写在 error 里）', await (async () => {
	registryAnswers = { 'https://registry.npmjs.org/': '9.9.9' };
	const response = await routes[1].fetch(new Request('http://127.0.0.1/api/task-reminder/update-check', { method: 'POST' }));
	if (response.status !== 200 || response.headers.get('content-type')?.startsWith('application/json') !== true) return false;
	const payload = await response.json();
	return payload.latest === '9.9.9' && payload.outdated === true;
})(), '检查路由没有按契约回 JSON');

// 唤醒路由：契约是 204（已发出）/ 501（当前组合没有可用的启动方式）；每次调用
// 都要把整条链路写进日志 —— 这是「点了没抬窗」唯一能事后复盘的地方。
const activationEntries = [];
const activationSpawnCalls = [];
const registerActivationRoutes = (applyOptions) => {
	const collected = [];
	apply({
		inject: (names, callback) => callback({
			connection: { fetch: { register: (route) => { collected.push(route); return () => {}; } } },
			effect: (fn) => fn(),
			logger: () => ({ warn: () => {} }),
		}),
		get: (name) => (name === 'profileContext' ? { dir: 'C:/Users/x/.dsh/profiles/desktop' } : undefined),
	}, {
		activationRecorder: (context) => (entry) => activationEntries.push({ ...context, ...entry }),
		spawn: (file, args, spawnOptions) => { activationSpawnCalls.push({ file, args, spawnOptions }); return stubChild; },
		schedule: fakeSchedule,
		...applyOptions,
	});
	return collected;
};
/** 从一批注册里挑出唤醒路由（顺序：唤醒 / 检查更新 / 立即更新）。 */
const activationRouteOf = (list) => list.find((route) => route.path === ACTIVATION_PATH);
const desktopActivationRoute = activationRouteOf(registerActivationRoutes({ environment: desktopEnv, executable: 'C:/app/dsh.exe' }));
const notDesktopActivationRoute = activationRouteOf(registerActivationRoutes({ environment: {}, executable: 'C:/node/node.exe' }));
const postActivation = (route, headers) => route.fetch(new Request('http://127.0.0.1/api/task-reminder/window-activation', { method: 'POST', headers }));
const desktopActivation = await postActivation(desktopActivationRoute, { 'x-task-reminder-activation-id': 'click-42-1' });
check('唤醒路由（桌面壳）：回 204，且只起一次首发进程（补发排在定时器里）',
	desktopActivation.status === 204 && activationSpawnCalls.length === 1
	&& activationSpawnCalls[0].args[0] === 'dsh://open' && activationSpawnCalls[0].file === 'C:/app/dsh.exe',
	JSON.stringify({ status: desktopActivation.status, calls: activationSpawnCalls.map((call) => call.file) }));
check('唤醒路由：子进程环境去掉 ELECTRON_RUN_AS_NODE（留着就进不了单实例分支）',
	activationSpawnCalls[0].spawnOptions.env.ELECTRON_RUN_AS_NODE === undefined,
	JSON.stringify(activationSpawnCalls[0].spawnOptions.env));
check('唤醒路由：整条链路写进日志（request → attempt → issued → response，带客户端点击 ID 与 profile）',
	activationEntries[0]?.event === 'request' && activationEntries[0]?.requestId === 'click-42-1'
	&& String(activationEntries[0]?.profile).endsWith('profiles/desktop')
	&& activationEntries.some((entry) => entry.event === 'attempt' && entry.attempt === 1 && entry.file === 'C:/app/dsh.exe')
	&& activationEntries.some((entry) => entry.event === 'issued')
	&& activationEntries.at(-1)?.event === 'response' && activationEntries.at(-1)?.status === 204,
	JSON.stringify(activationEntries));
const noIdActivation = await postActivation(desktopActivationRoute, undefined);
check('唤醒路由：客户端没带 ID（旧通知）时宿主自己编号，日志照样能对上这一次',
	noIdActivation.status === 204 && activationEntries.some((entry) => entry.event === 'request' && /^host-\d+-\d+$/.test(String(entry.requestId))),
	JSON.stringify(activationEntries.filter((entry) => entry.event === 'request').map((entry) => entry.requestId)));
const notDesktopActivation = await postActivation(notDesktopActivationRoute, undefined);
check('唤醒路由（不是桌面壳宿主）：回 501、不起进程，日志记 unsupported',
	notDesktopActivation.status === 501 && activationEntries.some((entry) => entry.event === 'unsupported' && entry.desktopHost === false)
	&& activationEntries.at(-1)?.status === 501,
	JSON.stringify({ status: notDesktopActivation.status, last: activationEntries.at(-1) }));
check('没有 connection 服务时安静跳过（不影响插件装载）', (() => {
	try {
		apply({ inject: (names, callback) => callback({ effect: () => {} }) });
		return true;
	} catch {
		return false;
	}
})(), '缺 connection 服务时 apply 抛了错');
check('路由表注册抛错也被吞掉（桌面壳之外的组合照样能装载）', (() => {
	try {
		apply({ inject: (names, callback) => callback({ connection: { fetch: { register: () => { throw new Error('boom'); } } }, effect: () => {} }) });
		return true;
	} catch {
		return false;
	}
})(), '注册抛错时 apply 没兜住');
const throwingRoutes = [];
apply({
	inject: (names, callback) => callback({
		connection: { fetch: { register: (route) => { throwingRoutes.push(route); return () => {}; } } },
		effect: (fn) => fn(),
	}),
	get: () => { throw new Error('service registry exploded'); },
});
check('处理器自己抛错也回 200 + JSON（对渲染进程的契约不破）', await (async () => {
	const response = await throwingRoutes[1].fetch(new Request('http://127.0.0.1/api/task-reminder/update-check', { method: 'POST' }));
	if (response.status !== 200) return false;
	const payload = await response.json();
	return payload.ok === false && payload.error.includes('exploded');
})(), '处理器抛错时路由没有按契约回 JSON');

globalThis.fetch = realFetch;
rmSync(cleanDir, { recursive: true, force: true });
rmSync(linkDir, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
	console.error(`verify-host: ${failures.length} 项失败`);
	process.exit(1);
}
console.log('verify-host: 全部通过');
