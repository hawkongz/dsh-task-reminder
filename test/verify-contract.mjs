/**
 * dsh-task-reminder 的**跨半侧契约**自检。
 *
 * 为什么需要它：`client.js`（浏览器半侧）与 `index.js`（宿主半侧）各自硬编码了
 * 同一份契约 —— 包名、三条路由（唤醒 / 检查更新 / 立即更新）、版本号，以及
 * 「检查更新 / 立即更新」答复里的字段名。两半各自的 `verify-*.mjs` 谁都 import
 * 不了另一半，只能证明「自己没改自己」：一次改名可以在两侧都全绿地漂移，直到
 * 运行期才表现为「点弹窗不抬窗」或「检查更新 404」。
 *
 * 本文件把两半放进同一个进程对拍两件事：
 *   1. **常量**：包名、三条路由（含宿主带根 / 桌面壳相对的斜杠约定）、版本号；
 *   2. **载荷**：宿主 `checkUpdate` / `applyUpdate` 的真实答复喂进渲染侧
 *      `updateReducer`，断言两边对同一份字段契约的理解一致。传输层用桩注入，
 *      全程不联网。
 *
 * 用法：node test/verify-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostics as host } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 取出浏览器半侧的 diagnostics：只给一个极简的 window.__ModuleLoader__ 桩。
// 工厂体里除了声明什么都没有，所以 React / store / primitives 三个模块
// 给空桩即可（真正用它们的是 apply()，本文件不装载插件）。
// ---------------------------------------------------------------------------

let definition;
const windowStub = { __ModuleLoader__: { load: (loaded) => { definition = loaded; } } };
new Function('window', 'document', readFileSync(join(here, '..', 'client.js'), 'utf8'))(windowStub, {});
if (definition === undefined) throw new Error('verify-contract: client.js did not call window.__ModuleLoader__.load');
const { diagnostics: page } = definition.factory(() => ({}));

// ---------------------------------------------------------------------------
// 断言骨架（与另两份自检同形）
// ---------------------------------------------------------------------------

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
// 一、常量契约
// ---------------------------------------------------------------------------

console.log('');
console.log('常量契约');
check('包名两半一致，且就是 package.json 的 name',
	page.PLUGIN_PACKAGE_NAME === host.PACKAGE_NAME && host.PACKAGE_NAME === packageJson.name,
	`client=${page.PLUGIN_PACKAGE_NAME} host=${host.PACKAGE_NAME} package=${packageJson.name}`);
check('版本号两半一致，且与 package.json / 磁盘上的版本一致',
	page.PLUGIN_VERSION === packageJson.version && host.installedVersion() === packageJson.version,
	`client=${page.PLUGIN_VERSION} host=${host.installedVersion()} package=${packageJson.version}`);
check('三条路由的宿主侧路径都以 /api/ 开头（Connection 精确 Fetch 路由的前提）',
	[host.ACTIVATION_PATH, host.UPDATE_CHECK_PATH, host.UPDATE_APPLY_PATH].every((path) => path.startsWith('/api/')),
	JSON.stringify([host.ACTIVATION_PATH, host.UPDATE_CHECK_PATH, host.UPDATE_APPLY_PATH]));
check('唤醒路由：桌面壳侧就是宿主路径去掉前导斜杠（写成绝对路径会被 dsh-app 当前端路由丢掉）',
	host.ACTIVATION_PATH === `/${page.DESKTOP_ACTIVATION_ROUTE}` && page.DESKTOP_ACTIVATION_ROUTE.startsWith('api/'),
	`host=${host.ACTIVATION_PATH} page=${page.DESKTOP_ACTIVATION_ROUTE}`);
check('检查更新路由两半一致',
	host.UPDATE_CHECK_PATH === page.UPDATE_CHECK_ROUTE,
	`host=${host.UPDATE_CHECK_PATH} page=${page.UPDATE_CHECK_ROUTE}`);
check('立即更新路由两半一致',
	host.UPDATE_APPLY_PATH === page.UPDATE_APPLY_ROUTE,
	`host=${host.UPDATE_APPLY_PATH} page=${page.UPDATE_APPLY_ROUTE}`);

// ---------------------------------------------------------------------------
// 二、载荷契约：宿主答复 → 渲染侧 reducer
// ---------------------------------------------------------------------------

/** 宿主 ctx 桩：给 pluginManager、不给 profileContext（照旧不当成本地安装）。 */
const pluginManager = { installBundle: () => Promise.resolve({ application: 'restart-required', packageResult: { exitCode: 0, output: 'ok' } }) };
const ctxStub = { get: (name) => (name === 'pluginManager' ? pluginManager : undefined) };
/** 传输桩：离线给出一个版本号，不碰网络。 */
const answering = (latest) => [(registry) => Promise.resolve({ registry, latest })];
const failing = [() => Promise.reject(new Error('offline'))];
/** 假请求：请求体里带目标版本。 */
const requestWith = (body) => ({ text: () => Promise.resolve(JSON.stringify(body)) });

console.log('');
console.log('载荷契约（宿主答复 → 渲染侧 reducer）');

// 检查更新：发现新版。
const found = await host.checkUpdate(ctxStub, { transports: answering('9.9.9') });
const available = page.updateReducer(page.UPDATE_IDLE, { type: 'check-result', result: found });
check('宿主报出新版 → 渲染侧落到 available，且带上原样最新版',
	available.phase === 'available' && available.latest === '9.9.9' && available.current === packageJson.version,
	JSON.stringify(available));
check('宿主报「有 pluginManager」→ 渲染侧据此允许一键更新',
	found.updatable === true && available.updatable === true,
	JSON.stringify({ host: found.updatable, page: available.updatable }));
check('宿主报「不是本地安装」→ 渲染侧不再显示本地安装文案',
	found.local === null && available.local === null,
	JSON.stringify({ host: found.local, page: available.local }));

// 检查更新：已是最新。
const current = await host.checkUpdate(ctxStub, { transports: answering(packageJson.version) });
const latestState = page.updateReducer(page.UPDATE_IDLE, { type: 'check-result', result: current });
check('宿主报「已是最新」→ 渲染侧落到 latest，不误报有新版',
	latestState.phase === 'latest' && current.outdated === false,
	JSON.stringify(latestState));

// 检查更新：全部源失败。
const broken = await host.checkUpdate(ctxStub, { transports: failing });
const failedCheck = page.updateReducer(page.UPDATE_IDLE, { type: 'check-result', result: broken });
check('宿主全部源失败 → 渲染侧落到 failed，并把宿主的原因原样显示',
	failedCheck.phase === 'failed' && failedCheck.step === 'check' && failedCheck.error === broken.error && broken.error !== null,
	JSON.stringify({ host: broken, page: failedCheck }));

// 立即更新：装成功（宿主答 restart-required）。
const applied = await host.applyUpdate(ctxStub, requestWith({ version: '9.9.9' }), { transports: answering('9.9.9') });
const done = page.updateReducer(available, { type: 'update-result', result: applied });
check('宿主装完答 restart-required → 渲染侧落到 done，并显示宿主报回的版本',
	applied.ok === true && applied.application === 'restart-required' && done.phase === 'done' && done.to === applied.latest,
	JSON.stringify({ host: applied, page: done }));

// 立即更新：安装失败（带错误码与包管理器输出）。
const failingManager = {
	installBundle: () => Promise.resolve({ application: 'restart-required', error: { code: 'incompatible-version' }, packageResult: { exitCode: 1, output: 'ERR_PNPM' } }),
};
const managerCtx = { get: (name) => (name === 'pluginManager' ? failingManager : undefined) };
const refused = await host.applyUpdate(managerCtx, requestWith({ version: '9.9.9' }), { transports: answering('9.9.9') });
const failedApply = page.updateReducer(available, { type: 'update-result', result: refused });
check('宿主装失败 → 渲染侧落到 failed 且 step 是 update（文案与「查版本失败」分开）',
	refused.ok === false && failedApply.phase === 'failed' && failedApply.step === 'update' && failedApply.error === refused.error,
	JSON.stringify({ host: refused, page: failedApply }));
check('宿主把包管理器输出一并带回（渲染侧只透传，不改契约）',
	typeof refused.output === 'string' && refused.output.includes('ERR_PNPM'),
	JSON.stringify(refused.output));

// 立即更新：没有 pluginManager 的组合（宿主拒绝，渲染侧如实显示）。
const noManager = await host.applyUpdate({ get: () => undefined }, requestWith({ version: '9.9.9' }), { transports: answering('9.9.9') });
const noManagerState = page.updateReducer(available, { type: 'update-result', result: noManager });
check('宿主没有 pluginManager → 渲染侧落到 failed 并留着宿主的说明',
	noManager.ok === false && noManagerState.phase === 'failed' && noManagerState.error === noManager.error,
	JSON.stringify({ host: noManager.error, page: noManagerState.error }));

// 立即更新：请求体读不动（旧客户端 / 中途丢包）也不改变契约。
const junk = await host.applyUpdate(ctxStub, { text: () => Promise.reject(new Error('broken body')) }, { transports: answering('9.9.9') });
check('请求体读不动也按「没给版本」处理（现查一次），不把异常抛给路由',
	junk.ok === true && junk.latest !== null,
	JSON.stringify(junk));

// ---------------------------------------------------------------------------
// 三、版本比较：两半各有一份实现（宿主 `parseVersion` + `comparePrerelease`，
// 渲染侧内联了一份），放进同一个进程用同一张表对拍 —— 不重构代码，只锁行为。
// ---------------------------------------------------------------------------

console.log('');
console.log('版本比较对拍');
/** 只看符号：数字段逐位、预发布小于正式版、构建元数据、认不出的值，判定必须一致。 */
const VERSION_PAIRS = [
	['1.6.1', '1.6.0'],
	['1.6.0', '1.6.0'],
	['1.5.5', '1.6.0'],
	['1.10.0', '1.9.9'],
	['1.6', '1.6.0'],
	['v1.6.0', '1.6.0'],
	['1.6.0+build.5', '1.6.0'],
	['1.7.0-beta.1', '1.7.0'],
	['1.7.0', '1.7.0-beta.1'],
	['1.7.0-beta.2', '1.7.0-beta.1'],
	['1.7.0-rc.1', '1.7.0-beta.9'],
	['1.7.0-beta', '1.7.0-beta.1'],
	['latest', '1.6.0'],
	['', '1.6.0'],
];
const signOf = (value) => (value < 0 ? -1 : value > 0 ? 1 : 0);
const disagreements = VERSION_PAIRS
	.map(([left, right]) => ({ left, right, host: signOf(host.compareVersions(left, right)), page: signOf(page.compareVersions(left, right)) }))
	.filter((row) => row.host !== row.page);
check('两半的版本比较对同一张表给出同样的结论（数字段 / 预发布 / 构建元数据 / 认不出的值）',
	disagreements.length === 0, JSON.stringify(disagreements));
check('两半都认不出时都按「相等」处理（宁可少报一次有新版，也不让用户白升）',
	page.compareVersions('latest', '1.6.0') === 0 && host.compareVersions('latest', '1.6.0') === 0
	&& page.compareVersions('', '1.6.0') === 0 && host.compareVersions('', '1.6.0') === 0);
check('渲染侧 isNewerVersion 只在严格更高时说有新版（预发布 < 正式版）',
	page.isNewerVersion('1.7.0', '1.6.0') === true && page.isNewerVersion('1.6.0', '1.6.0') === false
	&& page.isNewerVersion('1.7.0-beta.1', '1.7.0') === false && page.isNewerVersion('1.7.0', '1.7.0-beta.1') === true);

console.log('');
if (failures.length > 0) {
	console.error(`verify-contract: ${failures.length} 项失败`);
	process.exit(1);
}
console.log('verify-contract: 全部通过');
