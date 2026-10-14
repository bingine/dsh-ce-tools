/**
 * 工具公共层：统一输出信封、出口收敛、参数解析与内核/会话取得。
 *
 * 三条约定都以官方《工具编写参考》（`reference/cookbook/adding-a-tool`）为准：
 *
 * ## 1. 出口必须收敛成「一个规范 JSON 值」
 *
 * 注册表会对 `execute` 的返回值做 **lossless-JSON 规范化**并严格校验：
 * 多一个未在 `output.schema` 里声明的键、可选字段填 `null`、或者出现 **`bigint`**
 * （JSON 序列化不了）都会让整次调用失败。而内存工具天然到处是 bigint（地址、大小、
 * 快照字节数）。所以每个工具都经 `makeEnvelopeTool` 返回，出口处用 `toJsonSafe`
 * 把 bigint/Buffer/Map 统一转成字符串或纯对象，只保留已声明的键。
 *
 * ## 2. 失败必须**抛异常**，不能用返回值里的标志位表示
 *
 * 官方原文：**「抛出异常或返回无效值意味着 `isError`」**、**「基础设施故障请抛异常。
 * 成功的领域结果即使表示不理想的状态，也应写入规范值」**。
 *
 * 本插件第一版用 `{ ok: false, ... }` 表示失败，方向是错的：那样这次调用在
 * harness 眼里是**成功**的 —— UI 卡片显示成功、`tools/result` 观测到成功、
 * PTC 里 `await tools.ce_write(...)` 正常 resolve 而不是 reject。
 * 失败必须抛出去，才能走 `isError` 这条正规通路。
 *
 * ## 3. 不做 UI 卡片投影
 *
 * 内置 Web Client **不消费** `presentCall` / `presentResult`，而官方要求这些投影
 * 必须是 `args`（加 result）的纯函数、且服务于既有卡片类型（`card` 标签的联合）。
 * 本插件没有这类需求，于是交给默认的通用卡片，不自造一套看起来像卡片、其实
 * 没人消费的形状（第一版 14 处 `presentationMeta` 就是这么来的，已移除）。
 *
 * @module dsh-cheat-engine/tools/shared
 */

import { ENVELOPE_SCHEMA, fallbackDefineTool, toJsonSafe } from "../toolkit.js";
import { sessionKeyOf } from "../session.js";
import {
	describeAddress,
	formatAddress,
	resolveAddressInput
} from "../values.js";

/**
 * 所有工具共用的输出信封。
 *
/**
 * `ENVELOPE_SCHEMA` 与 `toJsonSafe` **不在本文件定义**，而是从 `../toolkit.js` re-export。
 *
 * 为什么：它们属于「工具信封的通用契约」，与具体工具无关。早先这里与
 * `lib/toolkit.js` **各写了一份**，而且两份**已经分叉**
 * （这里会过滤数组里的 `undefined`、Map 键强制字符串、未知类型兜底；
 * toolkit 那份没有）—— 同一件事两套语义，是踩过的那类坑。
 *
 * 现在实现只在 `toolkit.js` 一处，本文件只做 re-export，保证两个入口语义一致。
 * 这里保留 re-export 是为了不破坏既有 import 路径（本文件的使用者按原样调用即可）。
 */
export { ENVELOPE_SCHEMA, toJsonSafe } from "../toolkit.js";

/**
 * 构造一个统一的工具定义。
 *
 * @param {object} spec 工具描述
 * @param {string} spec.name 工具名
 * @param {string} spec.description 面向模型的说明
 * @param {object} spec.parameters DSL 参数表
 * @param {(args: object, exec: object) => Promise<object>|object} spec.run
 *        成功时返回 `{ summary, lines?, data? }`；失败时**直接抛错**（见文件顶部第 2 条）
 * @param {number} [spec.timeoutMs] 声明式超时（注册表不强制）
 * @returns {object} 可直接交给 ctx.tools.register 的定义
 */
export function makeEnvelopeTool(spec) {
	return fallbackDefineTool({
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
		output: {
			schema: ENVELOPE_SCHEMA,
			render: (_args, value) => {
				const body = Array.isArray(value.lines) && value.lines.length > 0 ? value.lines.join("\n") : "";
				return [{ type: "text", text: body === "" ? value.summary : `${value.summary}\n${body}` }];
			}
		},
		// 内存操作共享目标进程与扫描状态，并行执行会互相踩；一律串行
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const context = exec ?? {};
			// 遵守 exec.signal：调用方已经取消时不要开工。
			// 扫描/指针扫描是同步的原生循环，中途无法抢占式中断（见 README 的能力边界），
			// 但「已经取消了还照样开一次几十秒的扫描」是纯粹的浪费，必须拦住。
			if (context.signal !== undefined && context.signal !== null && context.signal.aborted === true) {
				throw new Error(`${spec.name} 在开始前就被调用方取消（exec.signal 已 abort）。`);
			}
			// 这里**不捕获**异常：抛出即 isError，这是注册表规定的失败通路。
			const result = await spec.run(args, context);
			const lines = Array.isArray(result.lines) ? result.lines.map((line) => String(line)) : [];
			const data = result.data === undefined ? undefined : toJsonSafe(result.data);
			return {
				summary: String(result.summary ?? ""),
				...(lines.length > 0 ? { lines } : {}),
				...(data !== undefined ? { data } : {})
			};
		}
	});
}

/**
 * 取内核 + 本会话状态。
 *
 * @param {object} runtime 插件运行时（见 lib/index.js）
 * @param {object} exec 工具执行上下文
 * @returns {{ ce: object, session: object, kernelInfo: object }}
 */
export function prepare(runtime, exec) {
	const kernelInfo = runtime.loadKernel();
	const ce = kernelInfo.ce;
	const session = runtime.sessions.get(sessionKeyOf(exec));
	return { ce, session, kernelInfo };
}

/** 写操作的总开关；关掉时直接拒绝，避免「以为写进去了」。 */
export function requireWriteEnabled(runtime) {
	if (runtime.config.allowWrite === false) {
		throw new Error(
			"写入类操作已被插件配置关闭（allowWrite: false）。" +
			"如需修改目标进程内存，请在插件行的 config 里设置 allowWrite: true。"
		);
	}
}

/** Lua 脚本的总开关。 */
export function requireLuaEnabled(runtime) {
	if (runtime.config.allowLua === false) {
		throw new Error("Lua 脚本已被插件配置关闭（allowLua: false）。如需使用 ce_lua，请设置 allowLua: true。");
	}
}

/**
 * 解析一个地址参数（支持 `0x…`、十进制、模块相对、解引用链）。
 *
 * @param {object} ce 内核模块
 * @param {object} session 会话
 * @param {string|number} input 地址输入
 * @param {{ hexadecimal?: boolean }} [options]
 * @returns {Promise<bigint>} 解析出的地址
 */
export async function parseAddress(ce, session, input, options = {}) {
	const ctx = await session.evalContext();
	return resolveAddressInput(ce, input, ctx, options);
}

/** 展示地址：优先「模块+偏移」，否则 `0x…`。 */
export async function labelAddress(session, address) {
	const modules = await session.modulesCached();
	return describeAddress(address, modules);
}

/** 规范化后的表达式（供报错信息展示）。 */