/**
 * 内存读写工具：`ce_read` / `ce_write`
 *
 * 两条设计原则：
 *
 * 1. **读要能一次拿到多份**。逆向时经常「读这个地址，也读它前后 16 个 dword」，
 *    所以 `count` + `stride` 是原生支持的，而不是让模型发 16 次调用。
 * 2. **写必须回读校验**。CE 的写会临时改只读页的保护再写回（内核已实现），
 *    但「写进去了」和「目标又改回去了」是两件事。所以写完立刻读回比对并把结果
 *    如实报告，而不是默认成功。
 *
 * @module dsh-cheat-engine/tools/memory
 */

import {
	decodeValue,
	describeAddress,
	encodeValue,
	describeValueTruncation,
	formatAddress,
	formatBytesHex,
	parseAobBytes,
	resolveVariableType,
	variableTypeName,
	verifyBytesWritten,
	widthOfType
} from "../values.js";
import { makeEnvelopeTool, parseAddress, prepare, requireWriteEnabled } from "./shared.js";
import { normalizeRetryOptions, withWriteRetry } from "../retry.js";
import { enrichPermissionError } from "../elevation.js";

/**
 * 一次读请求的描述。
 * @typedef {{ address: bigint, expression: string }} ReadTarget
 */

/**
 * 解析「要读哪些地址」：要么一个起始地址 + count/stride，要么一串显式地址。
 *
 * @param {object} ce 内核模块
 * @param {object} session 会话
 * @param {object} args 工具参数
 * @param {number} width 单值宽度
 * @returns {Promise<bigint[]>} 地址列表
 */
async function resolveReadTargets(ce, session, args, width) {
	if (Array.isArray(args.addresses) && args.addresses.length > 0) {
		const out = [];
		for (const item of args.addresses) {
			out.push(await parseAddress(ce, session, item, { hexadecimal: args.hexadecimalAddresses === true }));
		}
		return out;
	}
	const start = await parseAddress(ce, session, args.address, { hexadecimal: args.hexadecimalAddresses === true });
	const count = Number.isInteger(args.count) && args.count > 0 ? Math.min(args.count, 512) : 1;
	const stride = Number.isInteger(args.stride) && args.stride !== 0 ? args.stride : width;
	const out = [];
	for (let i = 0; i < count; i += 1) out.push(start + BigInt(i * stride));
	return out;
}

/**
 * 读取内存。
 * @param {object} runtime 插件运行时
 */
export function createReadTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_read",
		description:
			"从目标进程内存读取值。address 支持：0x 十六进制、十进制、CE 地址表达式" +
			"（\"notepad.exe\"+1234、[[game.exe+10]+8] —— 方括号按 CE 语义读取指针）。" +
			"一次读多个连续值用 count + stride（stride 默认等于类型宽度）；读一批不连续的地址用 addresses。" +
			"type 默认 dword。string/unicode/aob 这类变长类型要自己给 size。",
		parameters: {
			address: { type: "string", description: "起始地址或 CE 地址表达式。与 addresses 二选一。" },
			addresses: {
				type: "array",
				description: "要分别读取的多个地址（地址表达式字符串数组）。给了它就忽略 address/count/stride。",
				items: { type: "string" }
			},
			type: {
				type: "string",
				description:
					"值类型：byte/word/dword/qword/float/double/string/unicode/aob/pointer。默认 dword。"
			},
			size: { type: "integer", description: "变长类型的字节数（string/unicode/aob）。" },
			count: { type: "integer", description: "读几个值，默认 1（上限 512）。" },
			stride: { type: "integer", description: "相邻值的字节间隔，默认等于类型宽度。" },
			hexadecimal: { type: "boolean", description: "整数按十六进制展示。" },
			signed: { type: "boolean", description: "整数按有符号展示。" },
			hexadecimalAddresses: {
				type: "boolean",
				description: "把纯十进制数字形式的 address 当作十六进制解释（CE 地址框的习惯）。"
			}
		},
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			await session.requireLiveProcess();
			if ((args.address === undefined || args.address === "") && !Array.isArray(args.addresses)) {
				throw new Error("需要 address 或 addresses 之一。");
			}
			const type = resolveVariableType(ce, args.type);
			const width = widthOfType(ce, type, {
				size: args.size,
				pointerSize: session.pointerSize
			});
			const cap = Number.isInteger(runtime.config.maxReadBytes) && runtime.config.maxReadBytes > 0
				? runtime.config.maxReadBytes
				: 4096;
			if (width > cap) {
				throw new Error(`单次读取宽度 ${width} 字节超过上限 ${cap}（可用 maxReadBytes 提高，或调小 size）。`);
			}
			const targets = await resolveReadTargets(ce, session, args, width);
			const modules = await session.modulesCached();

			const lines = [];
			const values = [];
			let unreadable = 0;
			for (const address of targets) {
				const buffer = await session.read(address, width);
				if (buffer.length === 0) {
					unreadable += 1;
					lines.push(`${formatAddress(address)}  <读取失败：0 字节，可能未提交或不可读>`);
					// 用 readable 而不是 ok：这里描述的是「这一条读不到」这个领域事实，
					// 与「整次调用是否失败」无关（后者由是否抛错表达）
					values.push({ address: formatAddress(address), readable: false });
					continue;
				}
				const text = decodeValue(ce, buffer, type, {
					hexadecimal: args.hexadecimal === true,
					signed: args.signed === true
				});
				const label = describeAddress(address, modules);
				const labelText = label === formatAddress(address) ? "" : `  (${label})`;
				lines.push(
					`${formatAddress(address)}${labelText} = ${text}` +
					`    [${buffer.length} B: ${formatBytesHex(buffer.subarray(0, 32))}${buffer.length > 32 ? " …" : ""}]`
				);
				values.push({
					address: formatAddress(address),
					module: label === formatAddress(address) ? undefined : label,
					value: text,
					bytes: formatBytesHex(buffer),
					short: buffer.length < width
				});
			}
			// 一个地址都读不到 = 这次读取失败，不能当成「读到 0 处」的成功结果。
			//
			// 有两种成因，**必须区分**，否则会给出误导性的结论：
			//   1. 目标进程确实退出了（句柄还「打开」着，但每次读都返回 0 字节）；
			//   2. 进程活着，但给的地址无效（未提交、被保护、或指针解引用算出的地址不对）。
			// 早先这里一律断言"进程很可能已经退出" —— 实测进程活得好好的、
			// 只是 `[[ptr]]` 解出的地址没提交，用户因此被误导去重新 attach。
			if (values.length > 0 && unreadable === values.length) {
				const pid = session.target?.pid ?? "?";
				const name = session.target?.name ?? "?";
				// ⚠️ `session.process.isOpen` **不能**用来判断目标是否活着：
				// Windows 上进程退出后句柄依然有效，isOpen 一直是 true，
				// 于是这里会给出**误导性**结论「目标仍在运行，问题在地址本身」。
				// 必须直接问内核（WaitForSingleObject 问句柄的 signaled 状态）。
				const alive = await session.isTargetAlive();
				if (alive === false) {
					throw new Error(
						`全部 ${unreadable} 个地址都读不到（0 字节），且目标进程（${name} pid ${pid}）` +
							"**已经退出** —— 句柄已失效。用 ce_session 确认状态；" +
							"请用 ce_processes 重新找到目标再 ce_attach。"
					);
				}
				if (alive === undefined && !(session.process !== null && session.process.isOpen === true)) {
					throw new Error(
						`全部 ${unreadable} 个地址都读不到（0 字节），且目标进程（${name} pid ${pid}）` +
							"的句柄已失效 —— 它很可能已经退出。用 ce_session 确认状态；" +
							"若已退出请重新 ce_attach。"
					);
				}
				throw new Error(
					`全部 ${unreadable} 个地址都读不到（0 字节），但目标进程（${name} pid ${pid}）**仍在运行**。\n` +
						"所以问题出在**地址本身**，不是进程退出。常见原因：\n" +
						"  1. 这些地址没有被提交（`ce_regions` 看该地址落在哪个区域）；\n" +
						"  2. 地址表达式解引用链算错了 —— 注意 CE 语义：`[addr]` 读的是 addr 处的\n" +
						"     **8 字节指针**，`[[ptr]]` 返回的是 ptr 所指地址处的一整个 qword\n" +
						"     （而不是 4 字节的某个字段）。要取字段请写 `[[ptr]+0x8]` 这样的形式。\n" +
						"  3. 地址来自已被释放/重新随机化的分配（重启进程后旧地址就失效了）。"
				);
			}
			return {
				summary: `读取 ${values.length} 处（${variableTypeName(ce, type)}，每处 ${width} 字节）` +
					(unreadable > 0 ? `，其中 ${unreadable} 处读不到` : ""),
				lines,
				data: { count: values.length, unreadable, type: variableTypeName(ce, type), width, values }
			};
		}
	});
}

/**
 * 写入内存。
 * @param {object} runtime 插件运行时
 */
export function createWriteTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_write",
		description:
			"向目标进程内存写入值，写完**立刻回读校验**并如实报告结果。address 支持与 ce_read 相同的" +
			"地址表达式。value 按 type 解析（默认十进制；hexadecimal: true 或 0x 前缀按十六进制）。" +
			"要给字符串/字节数组可以直接用 type: string/unicode/aob，或用 bytes 传十六进制串。" +
			"只读页会由内核临时改保护后写入。" +
			"**写入失败或回读校验不一致会自动重试**（游戏每帧把值改回去是常态），" +
			"用 retry / retryDelayMs 控制次数与间隔。" +
			"【超范围会截断并明确提示】和 Cheat Engine 一样，值超出类型位宽时按位宽截断写入" +
			"（`byte ← 999` 写成 0xE7、`byte ← 256` 写成 0x00），此时输出里会写明「已按位宽截断」" +
			"并在 data.truncation 里给出原值与实际字节 —— 截断本身不是错误，但不会静默发生。",
		parameters: {
			address: { type: "string", required: true, description: "目标地址或 CE 地址表达式。" },
			value: { type: "string", description: "要写入的值。与 bytes 二选一。" },
			bytes: { type: "string", description: "要写入的原始字节（十六进制串，如 \"90 90 90\"）。与 value 二选一。" },
			type: { type: "string", description: "值类型，默认 dword。给 bytes 时忽略。" },
			hexadecimal: { type: "boolean", description: "value 按十六进制解析。" },
			signed: { type: "boolean", description: "value 按有符号解析。" },
			size: { type: "integer", description: "变长类型（string/unicode）的字节长度上限。" },
			retry: {
				type: "integer",
				description:
					"回读校验不一致（或遇到可重试的 Win32 错误）时的**额外重试次数**，默认 2，上限 20。" +
					"设 0 表示只写一次。目标每帧把值改回去时就靠它命中空隙。"
			},
			retryDelayMs: {
				type: "integer",
				description: "重试间隔基准（毫秒），默认 120，上限 5000。第 n 次重试实际等待 n×该值。"
			},
			hexadecimalAddresses: { type: "boolean", description: "把纯数字 address 当十六进制解释。" }
		},
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			requireWriteEnabled(runtime);
			await session.requireLiveProcess();
			if (args.value === undefined && args.bytes === undefined) {
				throw new Error("需要 value 或 bytes 之一。");
			}
			const address = await parseAddress(ce, session, args.address, {
				hexadecimal: args.hexadecimalAddresses === true
			});

			let payload;
			let typeLabel;
			/** 超范围截断的提示（null = 没有截断）。保留 CE 的截断行为，只如实说明。 */
			let truncation = null;
			if (args.bytes !== undefined) {
				payload = parseAobBytes(args.bytes);
				typeLabel = "bytes";
			} else {
				const type = resolveVariableType(ce, args.type);
				typeLabel = variableTypeName(ce, type);
				const encodeOptions = {
					hexadecimal: args.hexadecimal === true,
					signed: args.signed === true,
					pointerSize: session.pointerSize,
					size: args.size
				};
				// ⚠️ 必须在**编码之前**算：编码是纯截断，算完就看不出原值了。
				truncation = describeValueTruncation(ce, type, args.value, encodeOptions);
				payload = encodeValue(ce, type, args.value, encodeOptions);
			}
			if (payload.length === 0) throw new Error("要写入的字节为空。");

			// 写入前先取原字节，便于报告「改了什么」以及在需要时还原。
			// 这次读取只做一次：重试时以「首次的原字节」为基准才看得出目标一直在改什么。
			const before = await session.read(address, payload.length);
			const { retry, retryDelayMs } = normalizeRetryOptions(args);

			// 「写 → 回读校验」作为一个可重试的整体。
			// 为什么把校验放进重试范围：往运行中的程序写内存，最常见的失败不是
			// 写系统调用报错，而是**写进去了、目标下一帧又改回去**（写入调用完全成功）。
			const { result, attempts, retries, exhausted } = await (async () => {
				try {
					return await withWriteRetry({
						retry,
						retryDelayMs,
						async attempt(attemptIndex) {
							let written;
							try {
								written = await session.write(address, payload);
							} catch (error) {
								// 未映射地址 / 不可写页 / 权限不足都会在这里抛。
								// 权限类错误会被补上「提权或用内核驱动」的排查方向；
								// withWriteRetry 判定它不可重试，会立刻抛出（重试不会让权限变大）。
								throw enrichPermissionError(error, {
									target: session.target,
									action: `ce_write 第 ${attemptIndex + 1} 次尝试`
								});
							}
							const readBack = await session.read(address, payload.length);
							return {
								ok: verifyBytesWritten(payload, readBack),
								attempt: attemptIndex + 1,
								written,
								after: readBack
							};
						},
						describeRetry: (index, total, wait, last) =>
							last instanceof Error
								? `第 ${index}/${total} 次写入失败（${String(last.message).split("\n")[0]}），等待 ${wait}ms 后重试`
								: `第 ${index}/${total} 次写入后回读不一致（目标很可能把值改回去了），等待 ${wait}ms 后重试`
					});
				} catch (error) {
					// 走到这里 = 所有尝试都以「写系统调用失败」告终。
					// 内核只给错误码（如 998 ERROR_NOACCESS），模型看不出下一步该做什么，
					// 所以补上排查方向；权限类错误已在 attempt 内被增强过，不再重复包装。
					if (error !== null && error !== undefined && error.permissionDenied === true) throw error;
					const reason = error && error.message ? String(error.message) : String(error);
					throw new Error(
						`写入 ${formatAddress(address)} 失败：${reason}。` +
						"常见原因：地址算错或未映射、该页不可写、目标进程已退出。" +
						"可用 ce_regions 的 near 参数确认这个地址落在哪个区域。"
					);
				}
			})();

			const written = result.written;
			const after = result.after;
			const modules = await session.modulesCached();
			const label = describeAddress(address, modules);
			const prefix = `${formatAddress(address)}${label === formatAddress(address) ? "" : `  (${label})`}`;

			// 重试历史要如实展示：模型据此判断「值到底稳不稳」
			const retryLines = retries.map((record) => `  重试 ${record.attempt}：${record.message}（等待 ${record.waitedMs}ms）`);

			// 注意：走到这里说明**要么校验通过，要么重试耗尽**。
			// 耗尽时 withWriteRetry 把最后一次结果交回来（exhausted = true），而不是抛错 ——
			// 因为「写成功但值被改回去」是目标程序的行为，不是这次调用的故障。
			if (!result.ok || exhausted === true) {
				throw new Error(
					`写入未生效：${prefix}\n` +
					`  期望写入：${formatBytesHex(payload)}（${payload.length} 字节，内核报告写入 ${written} 字节）\n` +
					`  写入前：${formatBytesHex(before)}\n` +
					`  回读后：${formatBytesHex(after)}\n` +
					(retryLines.length > 0 ? `${retryLines.join("\n")}\n` : "") +
					`  已尝试 ${attempts} 次（含重试 ${retries.length} 次）仍未保持。\n` +
					(truncation !== null
						? `  注意：你给的值超范围已按位宽截断 —— 实际期望的字节是 ${formatBytesHex(payload)}。\n`
						: "") +
					"  常见原因：目标进程每帧重算这个值（游戏逻辑写回）、页不可写、或地址其实指向别处。\n" +
					"  可试：把 retry / retryDelayMs 调大；改用 ce_auto_assemble 做代码注入（改逻辑而不是改数据）；" +
					"或用 ce_pointer_scan 换一个不被重算的地址。"
				);
			}

			return {
				summary:
					`已写入并校验通过：${payload.length} 字节 @ ${formatAddress(address)}` +
					(truncation !== null ? "（⚠️ 值超范围已按位宽截断）" : "") +
					(attempts > 1 ? `（第 ${attempts} 次尝试成功）` : ""),
				lines: [
					`地址：${prefix}`,
					`写入：${payload.length} 字节  ${formatBytesHex(payload)}  （内核报告写入 ${written} 字节）`,
					`原值：${formatBytesHex(before)}`,
					`现值：${formatBytesHex(after)}`,
					`校验：通过 —— 回读字节与写入内容一致。`,
					// ⚠️ 超范围提示必须放在这里：不提示的话，`byte ← 999` 也是"校验通过"，
					// 而实际写入的是 0xE7 —— 用户会以为自己写进去的是 999。
					...(truncation !== null
						? [
							`⚠️ 数值超范围：${truncation.message}`,
							"（行为与 Cheat Engine 一致，故不改成报错；但请确认这是你要的结果。）"
						]
						: []),
					...(retryLines.length > 0 ? [`重试历史（共 ${retries.length} 次）：`, ...retryLines] : [])
				],
				data: {
					address: formatAddress(address),
					module: label === formatAddress(address) ? undefined : label,
					type: typeLabel,
					bytes: formatBytesHex(payload),
					byteCount: payload.length,
					reportedWritten: written,
					verified: true,
					attempts,
					retryCount: retries.length,
					retries,
					before: formatBytesHex(before),
					after: formatBytesHex(after),
					// 结构化地暴露出去，调用方不必去解析那句提示
					truncated: truncation !== null,
					truncation: truncation === null
						? undefined
						: {
							bits: truncation.bits,
							original: truncation.original,
							effectiveHex: truncation.effectiveHex,
							effectiveDecimal: truncation.effectiveDecimal
						}
				}
			};
		}
	});
}
