/**
 * CE Lua 脚本工具：`ce_lua`
 *
 * 内核把 Cheat Engine 的 Lua API 实现在 wasmoon（真实 Lua 5.4）上，并用原生 C 闭包
 * 保住 64 位整数精度。这是本插件里最通用的一个入口：当某个能力没有被单独做成工具
 * （或者需要把多步操作写成一个原子脚本）时，用它直接调 CE 的 Lua 函数。
 *
 * 两个必须提醒用户的点：
 * - **死循环会把宿主进程卡住**。Lua 在宿主主线程上跑，没有可靠的抢占式中断手段，
 *   所以工具描述里明确要求脚本别写无限循环。`sleep()` 的上限由 maxSleepMs 控制。
 * - **输出要去 `capturedOutput` 取**。Lua 的 `print` 不会流到工具返回值里，
 *   必须在执行后主动读出来（本工具已经做了）。
 *
 * @module dsh-cheat-engine/tools/lua
 */

import { makeEnvelopeTool, prepare, requireLuaEnabled } from "./shared.js";
import { stringifyLuaValue } from "../values.js";

/**
 * CE Lua 脚本。
 * @param {object} runtime 插件运行时
 */
export function createLuaTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_lua",
		description:
			"执行 Cheat Engine 的 Lua 脚本（Lua 5.4 + CE 的 Lua API）。当内置工具覆盖不到时用它，" +
			"例如 readInteger/writeInteger/readBytes/getAddress/getAddressSafe/readPointer/" +
			"getModuleBase/registerSymbol/sleep 等 CE 函数；也可以用 action: api " +
			"先列出当前可用的全部 API 名字再决定怎么写。" +
			"脚本里的 print 输出会被收集并一并返回。必须已 ce_attach 目标进程（脚本里的 " +
			"readInteger 等都是对目标进程操作）。" +
			"【内存与补丁】allocateMemory/deAlloc 在目标进程里分配/释放内存（不会自动释放，" +
			"用完必须 deAlloc）；getMemoryProtection/setMemoryProtection/fullAccess/getRegionSize/" +
			"enumRegions 查改页保护与区域；assemble/assembleBytes 汇编（前者写内存、后者只编码），" +
			"disassemble/disassembleBytes 反汇编。" +
			"【重要】不要在脚本里写无限循环或长时间 sleep —— Lua 跑在宿主主线程上，卡住会让整个 " +
			"HARNESS 无响应；需要等待请用小步 sleep 并尽快返回。",
		parameters: {
			action: {
				type: "string",
				enum: ["run", "api"],
				description: "run（默认）= 执行 code；api = 只列出可用的 CE Lua API 函数名，不执行脚本。"
			},
			code: { type: "string", description: "Lua 代码。action: run 时必填。" },
			echoOutput: { type: "boolean", description: "是否返回 print 的输出，默认 true。" }
		},
		timeoutMs: 120_000,
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			requireLuaEnabled(runtime);
			const action = typeof args.action === "string" ? args.action : "run";

			// Lua 里也能调 assemble/autoAssemble，所以先把汇编后端备好，
			// 免得脚本执行到一半才因为 WASM 未初始化而失败
			await runtime.ensureAsm(ce);
			await session.requireLiveProcess();
			const engine = await session.luaEngine(ce);

			if (action === "api") {
				const names = engine.apiFunctionNames();
				return {
					summary: `当前可用 ${names.length} 个 CE Lua API 函数`,
					lines: names.length === 0
						? ["没有注册到任何 API 函数 —— 可能是 Lua state 未初始化成功。"]
						: chunk(names, 6).map((row) => row.join("  ")),
					data: { action: "api", count: names.length, functions: names }
				};
			}

			const code = String(args.code ?? "");
			if (code.trim() === "") throw new Error("code 为空。action: run 需要提供 Lua 代码。");

			engine.clearOutput();
			let returned;
			let failed = null;
			try {
				returned = await engine.doStringAll(code);
			} catch (error) {
				failed = error;
			}
			const output = args.echoOutput === false ? [] : [...engine.capturedOutput];

			if (failed !== null) {
				const luaMessage = failed && failed.luaMessage ? String(failed.luaMessage) : "";
				const lines = [];
				if (luaMessage !== "") lines.push(`Lua 报错：${luaMessage}`);
				lines.push(`原因：${failed && failed.message ? failed.message : String(failed)}`);
				if (output.length > 0) {
					lines.push("出错前的输出：");
					for (const line of output.slice(-20)) lines.push(`  ${line}`);
				}
				lines.push(
					"排查建议：用 action: api 确认你调的函数确实存在（本移植只实现了 CE Lua API 的子集），" +
					"并确认函数参数个数与类型正确。"
				);
				// 脚本报错 = 这次调用失败 → 抛错（走 isError），保留完整可读诊断
				throw new Error(lines.join("\n  "));
			}

			const lines = [];
			if (output.length > 0) {
				lines.push(`输出（${output.length} 行）：`);
				for (const line of output.slice(0, 200)) lines.push(`  ${line}`);
				if (output.length > 200) lines.push(`  … 还有 ${output.length - 200} 行`);
			}
			const values = Array.isArray(returned) ? returned : [];
			if (values.length === 0) {
				lines.push("返回值：无");
			} else if (values.length === 1) {
				lines.push(`返回值：${stringifyLuaValue(values[0])}`);
			} else {
				lines.push(`返回值（${values.length} 个）：`);
				values.forEach((value, index) => lines.push(`  [${index + 1}] ${stringifyLuaValue(value)}`));
			}
			const summary = values.length === 0
				? `Lua 执行完成（无返回值${output.length > 0 ? `，${output.length} 行输出` : ""}）`
				: `Lua 执行完成，返回 ${stringifyLuaValue(values[0])}`;
			return {
				summary: summary.length > 300 ? `${summary.slice(0, 300)}…` : summary,
				lines,
				data: {
					action: "run",
					failed: false,
					outputLines: output.length,
					returns: values.map((value) => stringifyLuaValue(value))
				}
			};
		}
	});
}

/** 把数组切成每行 width 个，便于紧凑展示函数名列表。 */
function chunk(items, width) {
	const rows = [];
	for (let i = 0; i < items.length; i += width) rows.push(items.slice(i, i + width).map((name) => name.padEnd(24)));
	return rows;
}
