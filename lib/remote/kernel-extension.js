/**
 * 内核驱动动作的**助手扩展**：把 `kernelAction` 提供给通用提权助手。
 *
 * ## 为什么需要这个文件（这是一次真实倒退的修复）
 *
 * `kernelAction`（安装/加载/卸载 DBK64 内核驱动）原本**硬编码在**
 * `lib/remote/helper.js` 的 `dispatch()` switch 里。那时助手是本插件自己的，
 * 所以能用。
 *
 * 后来提权能力被抽成独立插件 `dsh-get-admin`，cheat-engine 改成消费它 ——
 * 于是助手进程跑的是 **get-admin 的通用 helper.js**，里面只有内存类方法，
 * **没有** `kernelAction`。结果是：
 *
 *   用户点一次 UAC → 助手起来了 → `kernelRpc("kernelAction")` 落到 default 分支 →
 *   抛 `helper 不支持的方法：kernelAction` → 报"启动提权助手失败"，而提权其实成功了。
 *
 * 也就是**把原本能用的路径换成了不能用的**。get-admin 为此设计了扩展机制
 * （见其 `lib/helper.js`：`create({ ce, require, kernelPath }) → { methods }`），
 * 本文件就是填这个坑：领域知识留在 cheat-engine，通用插件不必知道内核驱动。
 *
 * ## 契约
 *
 * 导出 `create(context)`，返回 `{ methods: { kernelAction(params) } }`。
 * `create` 是**同步**调用的（助手启动时），所以 `kernelDriver` 用懒加载 + 缓存，
 * 避免把 async 引入 dispatch。
 *
 * @module dsh-cheat-engine/remote/kernel-extension
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 懒加载 `kernel-driver.js`（可能很大，且助手启动时不一定需要）。 */
let kernelDriverModule = null;
function kernelDriver() {
	if (kernelDriverModule === null) kernelDriverModule = require("../kernel-driver.js");
	return kernelDriverModule;
}

/**
 * 内核驱动动作的白名单。
 *
 * 助手是**管理员进程**，绝不能被当成任意函数调用通道 —— 所以只放行这三个动作。
 */
const ALLOWED_ACTIONS = Object.freeze(["install", "load", "unload"]);

/**
 * 助手扩展工厂。
 *
 * @param {{ ce?: object, require?: Function, kernelPath?: string }} _context
 *   get-admin 传入的上下文。本扩展只用到内核驱动（通过相对路径 require），
 *   所以不依赖 `ce` / `kernelPath`；保留参数是为了符合扩展契约。
 * @returns {{ methods: { kernelAction: (params: object) => { result: object } } }}
 */
export function create(_context) {
	return {
		methods: {
			/**
			 * 执行一个内核驱动动作。
			 *
			 * @param {{ action?: string, driverPath?: string }} params
			 * @returns {{ result: { ok: boolean, log: string[], result: unknown, error: string|null } }}
			 */
			kernelAction(params) {
				// 白名单：助手是管理员进程，不能变成任意调用通道
				const action = String(params?.action ?? "");
				if (!ALLOWED_ACTIONS.includes(action)) {
					throw new Error(`kernelAction 不允许的动作：${action}`);
				}
				const kd = kernelDriver();
				try {
					let result;
					if (action === "install") result = kd.installDriver({ driverPath: params.driverPath });
					else if (action === "load") result = kd.loadDriver();
					else result = kd.unloadDriver();
					return { result: { ok: true, log: Array.isArray(result?.log) ? result.log : [], result, error: null } };
				} catch (error) {
					// **失败也当正常返回值**（而不是 throw）：
					// RPC 的错误通道只传 `error.message`，而内核动作的失败恰恰需要
					// 带上"走到哪一步了"（`error.log`）。所以把 { ok:false, log, error }
					// 作为 result 回传，让调用方拿到完整信息。
					// 这一条与 `remote/helper.js` 里的内建实现保持一致 ——
					// 两处语义必须相同，否则回退/共享两条路径的行为会分叉。
					return {
						result: {
							ok: false,
							log: Array.isArray(error && error.log) ? error.log : [],
							result: null,
							error: error && error.message ? String(error.message) : String(error)
						}
					};
				}
			}
		}
	};
}
