/**
 * dsh-task-reminder —— 宿主半侧。
 *
 * 浏览器半侧（./client.js）独立完成全部提醒功能：完成信号走宿主事件转发，
 * 五个配置项落浏览器本地存储，不需要宿主设置命名空间。宿主半侧只多做一件事：
 * **桌面壳里把 DSH 窗口拉回前台**。
 *
 * 为什么必须由宿主来做：桌面端是 Electron，渲染进程的 `window.focus()` 拉不起
 * 最小化或已关进托盘的窗口 —— 只有主进程的 `focusPrimaryWindow()` 会
 * `restore()/show()/focus()`。主进程那条路只由托盘点击与「再启动一份应用」
 * （`dsh://open` 深度链接，second-instance → focusPrimaryWindow）触发；插件在
 * 渲染进程里既没有这条 IPC，也发不出外部协议（渲染进程导航到 `dsh:` 会被拦），
 * 所以由宿主进程代跑一次「再启动一份应用」：第二份拿不到单实例锁会立刻退出，
 * 第一份随即把窗口拉回前台，用户无感。
 *
 * 渲染进程怎么请求这件事：`api/task-reminder/window-activation` 是注册在
 * Connection 上的精确 Fetch 路由，和普通 RPC 共用 /api 通道的 Host/Origin 校验
 * 与浏览器 cookie 认证；桌面壳把 `dsh-app://app/*` 的其它路径原样转发给宿主。
 * 桌面壳之外（浏览器 web profile、无 web 服务器的 profile）这条路由要么注册不上、
 * 要么没人调用，都是安静失败，不影响任何提醒功能。
 *
 * @module dsh-task-reminder
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

/** 渲染进程请求唤醒的路径（Connection 精确 Fetch 路由必须以 /api/ 开头）。 */
const ACTIVATION_PATH = '/api/task-reminder/window-activation';

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
 * 组装「唤醒桌面窗口」的命令行。
 * @param platform - `process.platform`。
 * @param environment - 宿主进程环境。
 * @param executable - `process.execPath`。
 * @returns `{ file, args }`；当前平台没有可用路径时返回 null。
 */
function activationCommand(platform, environment = process.env, executable = process.execPath) {
	if (platform === 'win32') {
		// 桌面壳用 `ELECTRON_RUN_AS_NODE=1` 起宿主，execPath 就是应用 exe 本体：
		// 直接再启动一份最稳，不依赖 `dsh:` 协议在注册表里的注册状态。
		if (!isDesktopHost(environment, executable)) return null;
		return { file: executable, args: [ACTIVATION_LINK] };
	}
	if (platform === 'darwin') return { file: 'open', args: [ACTIVATION_LINK] };
	return null;
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
 * 再启动一份应用，触发第一份的 second-instance → focusPrimaryWindow()。
 * 失败（平台不支持、spawn 抛错）返回 false，调用方据此回 501。
 * @param platform - `process.platform`。
 * @returns 命令是否成功发出。
 */
function launchDesktopWindow(platform) {
	const command = activationCommand(platform);
	if (command === null) return false;
	try {
		const child = spawn(command.file, command.args, {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
			env: activationEnvironment(),
		});
		// 一次启动失败不该冒泡成未捕获异常（子进程错误事件必须有监听者）。
		child.on('error', () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/**
 * 注册唤醒路由。桌面壳之外注册不上或没人调用，都是安静失败。
 * @param ctx - 宿主插件上下文。
 */
function apply(ctx) {
	// 宿主半侧额外行为绝不能让插件装载失败：整段包一层。
	try {
		ctx.inject(['connection'], (connectionCtx) => {
			try {
				const registry = connectionCtx.connection?.fetch;
				// 老版本 / 精简组合里没有 Fetch 路由表：那就没有这条路可走。
				if (registry === undefined || typeof registry.register !== 'function') return;
				connectionCtx.effect(() => registry.register({
					path: ACTIVATION_PATH,
					methods: ['POST'],
					requestBody: 'buffered',
					fetch: () => {
						const launched = launchDesktopWindow(process.platform);
						return new Response(null, { status: launched ? 204 : 501 });
					},
				}), 'task-reminder: desktop window activation route');
			} catch (error) {
				connectionCtx.logger?.('task-reminder')?.warn?.('desktop window activation route unavailable', error);
			}
		});
	} catch (error) {
		ctx.logger?.('task-reminder')?.warn?.('desktop window activation unavailable', error);
	}
}

export { apply };
