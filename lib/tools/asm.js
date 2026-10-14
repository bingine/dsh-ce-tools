/**
 * 反汇编 / 汇编 / AutoAssembler 工具：
 * `ce_disassemble` / `ce_assemble` / `ce_auto_assemble`
 *
 * ## 必须记住的一件事：汇编后端不会自动初始化
 *
 * capstone-wasm / keystone-wasm 需要异步装载 WASM。内核**不会**替你初始化，
 * 直接调用 `disassemble` / `assemble` / `AutoAssembler.*` 会抛
 * `AsmBackendError('…尚未初始化…')`。所以这里每个入口都先 `await runtime.ensureAsm(ce)`。
 *
 * ## AutoAssembler 的错误是「相位化」的
 *
 * 内核失败时抛 `AutoAssemblerError`，带 `phase`（parse/scan/assemble/write）与
 * `lineNumber`/`line`。这类信息对模型修脚本非常关键，所以这里**不**让它退化成一句
 * 通用错误，而是把相位、行号、原行都摊在结果里。
 *
 * @module dsh-cheat-engine/tools/asm
 */

import {
	describeAddress,
	formatAddress,
	formatBytesHex,
	verifyBytesWritten
} from "../values.js";
import { makeEnvelopeTool, parseAddress, prepare, requireWriteEnabled } from "./shared.js";

/** x86 单条指令最长 15 字节；读这么多就够 count 条反汇编。 */
const X86_MAX_INSTRUCTION = 15;

/**
 * 解析架构：显式参数 > 插件配置 > 目标位数推断。
 *
 * @param {object} ce 内核模块
 * @param {object} session 会话
 * @param {string|number|undefined} requested 调用方给的 arch/bitness
 * @param {object} runtime 插件运行时
 * @returns {string} 规范化架构名
 */
function resolveArch(ce, session, requested, runtime) {
	const input = requested ?? runtime.config.arch ?? undefined;
	if (input !== undefined && input !== null && String(input) !== "") {
		return ce.normalizeArchitecture(String(input));
	}
	return ce.archFromBitness(session.bitness);
}

/** 内核的 AutoAssemblerError → 结构化失败信息。 */
function describeAutoAssemblerError(error) {
	const parts = [];
	const phase = error && error.phase ? String(error.phase) : "";
	const phaseText = {
		parse: "解析脚本",
		scan: "aobscan 扫描",
		assemble: "汇编",
		write: "写内存"
	}[phase] ?? phase;
	if (phaseText !== "") parts.push(`阶段：${phaseText}`);
	if (error && error.lineNumber !== undefined && error.lineNumber !== null) parts.push(`行号：${error.lineNumber}`);
	if (error && error.line) parts.push(`原行：${error.line}`);
	parts.push(`原因：${error && error.message ? error.message : String(error)}`);
	return parts;
}

/**
 * 反汇编。
 * @param {object} runtime 插件运行时
 */
export function createDisassembleTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_disassemble",
		description:
			"反汇编目标进程在某个地址处的机器码，返回地址 / 机器码 / 助记符与操作数。" +
			"用于看清一段代码在做什么、确认 AOB 特征码的唯一性、或为代码注入找准切入点。" +
			"跳转与调用的目标地址会一并给出。架构默认按目标位数推断（64 位目标用 x64）。",
		parameters: {
			address: { type: "string", required: true, description: "起始地址或 CE 地址表达式（如 game.exe+1234）。" },
			count: { type: "integer", description: "反汇编多少条指令，默认 10（上限 200）。" },
			arch: { type: "string", enum: ["x86", "x64", "arm", "thumb", "arm64"], description: "指令集架构；默认按目标位数推断。" }
		},
		timeoutMs: 60_000,
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			await session.requireLiveProcess();
			await runtime.ensureAsm(ce);
			const arch = resolveArch(ce, session, args.arch, runtime);
			const address = await parseAddress(ce, session, args.address);
			const count = Number.isInteger(args.count) && args.count > 0 ? Math.min(args.count, 200) : 10;
			const info = ce.architectureInfo(arch);
			// 定长指令集（ARM）按固定宽度读；x86 变长，按最长指令估
			const bytesPerInstruction = info.fixedSize && info.instructionSize > 0 ? info.instructionSize : X86_MAX_INSTRUCTION;
			const want = Math.min(count * bytesPerInstruction, 4096);
			const buffer = await session.read(address, want);
			if (buffer.length === 0) {
				throw new Error(`无法在 ${formatAddress(address)} 读取内存（未提交？不可读？地址算错了？）`);
			}
			let instructions;
			try {
				instructions = ce.disassemble(buffer, address, count, { arch });
			} catch (error) {
				throw new Error(`反汇编失败（架构 ${arch}）：${error && error.message ? error.message : String(error)}`);
			}
			const modules = await session.modulesCached();
			const lines = instructions.map((insn) => {
				const text = ce.formatDisassembled(insn, {
					addressWidth: info.addressWidth,
					showAddress: true,
					showBytes: true
				});
				const target = typeof ce.branchTarget === "function" ? ce.branchTarget(insn) : null;
				if (target === null) return text;
				const label = describeAddress(target, modules);
				return `${text}    -> ${formatAddress(target)}${label === formatAddress(target) ? "" : ` (${label})`}`;
			});
			const label = describeAddress(address, modules);
			return {
				summary: `在 ${formatAddress(address)}${label === formatAddress(address) ? "" : ` (${label})`} 反汇编出 ${instructions.length} 条指令（${arch}）`,
				lines,
				data: {
					address: formatAddress(address),
					module: label === formatAddress(address) ? undefined : label,
					arch,
					count: instructions.length,
					bytesRead: buffer.length,
					instructions: instructions.map((insn) => ({
						address: formatAddress(insn.address),
						bytes: formatBytesHex(Buffer.concat(insn.bytes)),
						text: ce.instructionText(insn)
					}))
				}
			};
		}
	});
}

/**
 * 把一段机器码反汇编成可展示的文本行，供汇编类工具做「立即数进制」核对。
 *
 * 失败时安静返回空数组：反汇编只是附加的核对信息，不该因为架构/引擎的边角问题
 * 把一次本来成功的汇编变成失败。
 *
 * @param {object} ce 内核模块
 * @param {Buffer} bytes 机器码
 * @param {bigint} address 这段代码所在的地址
 * @param {string} arch 架构
 * @param {number} [max] 最多展示多少条
 * @returns {string[]} 文本行
 */
function disassembleForEcho(ce, bytes, address, arch, max = 16) {
	if (!Buffer.isBuffer(bytes) || bytes.length === 0) return [];
	try {
		const instructions = ce.disassemble(bytes, address, max, { arch });
		return instructions.map((insn) => `${formatAddress(insn.address)}  ${ce.instructionText(insn)}`);
	} catch {
		return [];
	}
}

/**
 * 汇编（可选：直接写入目标进程）。
 * @param {object} runtime 插件运行时
 */
export function createAssembleTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_assemble",
		description:
			"把汇编代码汇编成机器码，并可选地直接写入目标进程（write: true）。" +
			"source 里可以写多行指令（如 \"mov eax,1\\nret\"）。address 是这段代码将放置的地址，" +
			"它决定相对跳转的编码，所以改写已有代码时必须给真实地址。" +
			"写入时会先读原字节，写完回读校验，并把原字节一并返回（便于还原）。" +
			"【立即数进制】裸数字按**十进制**解析（`mov eax, 1337` 是十进制 1337）；" +
			"要写十六进制必须加 `0x` 前缀或 `h` 后缀（`mov eax, 0x11223344` / `mov eax, 11223344h`）。" +
			"这与 CE 帮助文档一致，但和「AA 里什么都当十六进制看」的直觉相反 —— 写错会静默产生错误字节，" +
			"所以写完务必看回读的字节或用 ce_disassemble 核对。" +
			"更复杂的场景（分配内存、AOB 扫描、代码注入、[ENABLE]/[DISABLE]）请用 ce_auto_assemble。",
		parameters: {
			source: { type: "string", required: true, description: "汇编源码，多行用 \\n 分隔。" },
			address: { type: "string", description: "代码将放置的地址（影响相对跳转编码），默认 0。" },
			arch: { type: "string", enum: ["x86", "x64", "arm", "thumb", "arm64"], description: "指令集架构；默认按目标位数推断。" },
			syntax: {
				type: "string",
				enum: ["intel", "att", "nasm", "masm", "gas"],
				description: "x86 汇编语法，默认 intel。"
			},
			write: { type: "boolean", description: "为 true 时把汇编结果写入地址。需要已附加目标进程且 allowWrite 未关闭。" }
		},
		timeoutMs: 60_000,
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			await runtime.ensureAsm(ce);
			const source = String(args.source ?? "");
			if (source.trim() === "") throw new Error("source 为空");
			const arch = resolveArch(ce, session, args.arch, runtime);
			const base = typeof args.address === "string" && args.address.trim() !== ""
				? await parseAddress(ce, session, args.address)
				: 0n;
			const options = { address: base, arch };
			if (args.syntax !== undefined) options.syntax = String(args.syntax);

			let result;
			try {
				result = ce.assemble(source, options);
			} catch (error) {
				const extra = error && error.lineNumber !== undefined ? `（第 ${error.lineNumber} 行）` : "";
				throw new Error(
					`汇编失败${extra}：${error && error.message ? error.message : String(error)}` +
					(error && error.line ? `\n出错的行：${error.line}` : "")
				);
			}

			const lines = [
				`架构：${arch}${base === 0n ? "（未给 address，按 0 计算，相对寻址结果仅供参考）" : `  基址：${formatAddress(base)}`}`,
				`结果：${formatBytesHex(result.bytes)}  （${result.bytes.length} 字节）`
			];
			if (Array.isArray(result.lines) && result.lines.length > 0) {
				lines.push("逐行：");
				for (const line of result.lines) {
					if (line.empty) continue;
					lines.push(`  ${formatBytesHex(line.bytes).padEnd(24)} ${line.source}`);
				}
			}

			// 把汇编结果**反汇编回来**展示。
			//
			// 这是唯一能一眼看出「立即数进制理解错了」的办法：指令里的裸数字按十进制解析，
			// 所以 `mov eax, 11223344` 编出来的是 0x00AB4130（11223344 十进制）而不是 0x11223344，
			// 二者都不会报错。只有看到反汇编里的立即数，写的人才能发现自己想的是十六进制。
			const disassembly = disassembleForEcho(ce, result.bytes, base, arch);
			if (disassembly.length > 0) {
				lines.push("反汇编（核对立即数：裸数字=十进制，0x…/…h=十六进制）：");
				for (const insn of disassembly) lines.push(`  ${insn}`);
			}

			if (args.write !== true) {
				return {
					summary: `汇编得到 ${result.bytes.length} 字节（未写入，write: true 可写入）`,
					lines,
					data: {
						bytes: formatBytesHex(result.bytes),
						byteCount: result.bytes.length,
						arch,
						address: formatAddress(base),
						wrote: false
					}
				};
			}

			requireWriteEnabled(runtime);
			await session.requireLiveProcess();
			const before = await session.read(base, result.bytes.length);
			const written = await session.write(base, result.bytes);
			const after = await session.read(base, result.bytes.length);
			const verified = verifyBytesWritten(result.bytes, after);
			lines.push(`写入：${formatAddress(base)}  ${written} 字节`);
			lines.push(`原字节：${formatBytesHex(before)}`);
			lines.push(`回读：${formatBytesHex(after)}`);
			if (!verified) {
				// 写不进去就是失败 → 抛错（isError），不要返回一个写着失败的成功值
				throw new Error(
					`汇编成功但写入未生效 @ ${formatAddress(base)}\n` +
					`  期望写入：${formatBytesHex(result.bytes)}\n` +
					`  写入前：${formatBytesHex(before)}\n` +
					`  回读后：${formatBytesHex(after)}\n` +
					`  上一行是根据 address 计算相对跳转的结果；若 address 不是代码真实所在地址，跳转会错。`
				);
			}
			lines.push("校验：通过。");
			return {
				summary: `已汇编并写入 ${result.bytes.length} 字节 @ ${formatAddress(base)}`,
				lines,
				data: {
					bytes: formatBytesHex(result.bytes),
					byteCount: result.bytes.length,
					arch,
					address: formatAddress(base),
					wrote: true,
					verified: true,
					before: formatBytesHex(before),
					after: formatBytesHex(after)
				}
			};
		}
	});
}

/**
 * AutoAssembler 脚本。
 * @param {object} runtime 插件运行时
 */
export function createAutoAssembleTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_auto_assemble",
		description:
			"执行 Cheat Engine 的 AutoAssembler 脚本 —— 这是 CE 最强大的能力：" +
			"AOBSCAN/AOBSCANMODULE 定位代码、ALLOC 分配内存、LABEL/CREATETHREAD/DEFINE 组织代码、" +
			"以及最核心的代码注入（在目标地址写跳转、把原指令搬到分配的内存里再跳回去）。" +
			"脚本用 [ENABLE] / [DISABLE] 分段：enable 执行 ENABLE 段，disable 执行 DISABLE 段并还原。" +
			"内核会记录 [ENABLE] 期间改动的原字节，因此 disable 能精确还原（restoreMode 默认 original）。" +
			"action: check 只做语法检查与汇编预演，不写任何内存 —— 改脚本时先用它验证。" +
			"【立即数进制】指令里的裸数字按**十进制**解析，十六进制要加 `0x` 前缀或 `h` 后缀" +
			"（`mov eax, 0x11223344`）；而 `db/dw/dd/dq` 数据指令里的裸数字按 CE 习惯当**十六进制**" +
			"（`db 89 01` = 两个字节 89 01）。两者规则不同，写脚本时容易混。" +
			"注意：createthread 不会被真正执行（Node 里没有 CreateRemoteThread），只会被校验并报告。" +
			"脚本里出现的符号（alloc/registersymbol/aobscan 的名字）可在其他工具中用地址表达式引用。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["enable", "disable", "check"],
				description: "enable=执行 ENABLE 段；disable=执行 DISABLE 段并还原；check=只预演不写内存。"
			},
			script: { type: "string", required: true, description: "AutoAssembler 脚本原文。" },
			arch: { type: "string", enum: ["x86", "x64", "arm", "thumb", "arm64"], description: "指令集架构；默认按目标位数推断。" },
			restoreMode: {
				type: "string",
				enum: ["original", "script"],
				description: "disable 的还原策略：original（默认，用记录的原字节精确还原）或 script（完全听 DISABLE 段）。"
			}
		},
		timeoutMs: 300_000,
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			const action = String(args.action);
			await runtime.ensureAsm(ce);

			if (action === "check") {
				// 语法检查不碰目标内存，因此不要求已附加进程
				const assembler = new ce.AutoAssembler({
					process: session.process ?? undefined,
					arch: resolveArch(ce, session, args.arch, runtime)
				});
				let result;
				try {
					result = assembler.autoAssemble(String(args.script), { syntaxCheckOnly: true });
				} catch (error) {
					// check 恰恰是最常失败的一步，所以这里也必须给出相位/行号，
					// 而不是退化成一句通用错误（否则模型很难知道该改哪一行）。
					// 失败即抛错 —— 走 isError 正规通路，不返回「成功但写着失败」的值。
					const detail = describeAutoAssemblerError(error);
					throw new Error(`脚本检查未通过：${detail.join("\n  ")}`);
				} finally {
					assembler.cleanup();
				}
				return {
					summary: `语法检查通过（将写入 ${result.bytesWritten} 字节，未实际写入）`,
					lines: summarizeAutoAssemble(ce, result, session),
					data: autoAssembleData(result)
				};
			}

			requireWriteEnabled(runtime);
			await session.requireLiveProcess();
			const options = {};
			if (args.restoreMode !== undefined) options.restoreMode = String(args.restoreMode);
			const assembler = session.autoAssemblerFor(ce, options);

			let result;
			try {
				result = assembler.autoAssemble(String(args.script), { enable: action === "enable" });
			} catch (error) {
				const detail = describeAutoAssemblerError(error);
				throw new Error(`AutoAssembler 执行失败（${action}）：${detail.join("\n  ")}`);
			}

			// 记录 alloc，便于在会话状态里如实报告
			if (Array.isArray(result.allocations)) session.allocations = [...result.allocations];
			const lines = summarizeAutoAssemble(ce, result, session);
			// ⚠️ `dealloc` 释放的内存**不体现在"还原 N 处 / N 字节"里**（那是代码字节），
			// 所以只报那一句会让人以为"什么都没释放"。实际释放了就必须明说一句。
			const freed = Array.isArray(result.deallocated) ? result.deallocated : [];
			const freedText = freed.length === 0
				? ""
				: `；已释放 alloc 的内存 ${freed.length} 块（${freed
					.map((block) => `${block.name} @ ${formatAddress(block.address)} ${block.size} 字节`)
					.join("、")}）`;
			return {
				summary:
					action === "enable"
						? `ENABLE 已执行：写入 ${result.entries.length} 处 / ${result.bytesWritten} 字节`
						: `DISABLE 已执行：还原 ${result.entries.length} 处 / ${result.bytesWritten} 字节${freedText}`,
				lines,
				data: { ...autoAssembleData(result), action }
			};
		}
	});
}

/** AutoAssembleResult → 面向模型的文本行。 */
function summarizeAutoAssemble(ce, result, session) {
	const lines = [];
	if (result.sections.enableLine !== null || result.sections.disableLine !== null) {
		lines.push(
			`段位置：ENABLE 第 ${result.sections.enableLine ?? "-"} 行，DISABLE 第 ${result.sections.disableLine ?? "-"} 行`
		);
	}
	lines.push(
		`写入：${result.entries.length} 处，共 ${result.bytesWritten} 字节` +
		(result.syntaxCheckOnly ? "（语法检查模式，未真正写入）" : "")
	);
	const written = result.entries.slice(0, 20);
	for (const entry of written) {
		lines.push(
			`  ${formatAddress(entry.address)}  ${formatBytesHex(entry.bytes).slice(0, 48)}` +
			`${entry.restoredFromOriginal ? "  (由记录的原字节还原)" : ""}   行 ${entry.lineNumber}: ${String(entry.line).trim().slice(0, 60)}`
		);
	}
	if (result.entries.length > written.length) lines.push(`  … 还有 ${result.entries.length - written.length} 处`);

	// 把前几处写入的字节反汇编回来，用于核对立即数进制
	// （指令里的裸数字是十进制，`mov eax, 11223344` 编出来是 0x00AB4130 —— 不看不出来）
	const echoArch = ce.archFromBitness(session.bitness);
	const echoed = [];
	for (const entry of result.entries.slice(0, 5)) {
		for (const insn of disassembleForEcho(ce, entry.bytes, entry.address, echoArch, 4)) echoed.push(`  ${insn}`);
	}
	if (echoed.length > 0) {
		lines.push("反汇编（核对立即数：裸数字=十进制，0x…/…h=十六进制）：");
		lines.push(...echoed);
	}

	if (Array.isArray(result.aobScans) && result.aobScans.length > 0) {
		lines.push("AOB 扫描：");
		for (const scan of result.aobScans) {
			lines.push(
				`  ${scan.name} → ${formatAddress(scan.address)}  命中 ${scan.matches.length} 处（范围 ${scan.scope}）` +
				(scan.matches.length > 1 ? `  全部：${scan.matches.slice(0, 8).map((a) => formatAddress(a)).join(", ")}${scan.matches.length > 8 ? " …" : ""}` : "")
			);
		}
	}
	if (Array.isArray(result.allocations) && result.allocations.length > 0) {
		lines.push("分配：");
		for (const alloc of result.allocations) {
			lines.push(
				`  ${alloc.name} @ ${formatAddress(alloc.address)}  ${alloc.size} 字节  保护 ${alloc.protection}` +
				`${alloc.global ? "  (globalalloc)" : ""}`
			);
		}
	}
	// 本次真的执行了 dealloc/realloc 的块：必须单独说一句，
	// 否则用户只看到「还原 0 处 / 0 字节」，无从判断内存有没有还回去。
	if (Array.isArray(result.deallocated) && result.deallocated.length > 0) {
		lines.push(`已释放：${result.deallocated.length} 块（dealloc 已把内存还给系统，对应符号也已消失）`);
		for (const block of result.deallocated) {
			lines.push(`  ${block.name} @ ${formatAddress(block.address)}  ${block.size} 字节`);
		}
	}
	const symbols = result.symbols instanceof Map ? [...result.symbols.entries()] : [];
	if (symbols.length > 0) {
		lines.push("符号（可在地址表达式里直接用名字）：");
		for (const [name, address] of symbols.slice(0, 30)) lines.push(`  ${name} = ${formatAddress(address)}`);
		if (symbols.length > 30) lines.push(`  … 还有 ${symbols.length - 30} 个`);
	}
	if (Array.isArray(result.registeredSymbols) && result.registeredSymbols.length > 0) {
		lines.push(`跨脚本注册的符号：${result.registeredSymbols.join(", ")}`);
	}
	if (Array.isArray(result.createThreads) && result.createThreads.length > 0) {
		lines.push(
			`注意：脚本里有 createthread（${result.createThreads.map((a) => formatAddress(a)).join(", ")}），` +
			"本移植不会真正创建远程线程（Node 无 CreateRemoteThread），只做了校验。"
		);
	}
	if (Array.isArray(result.warnings) && result.warnings.length > 0) {
		lines.push("警告：");
		for (const warning of result.warnings.slice(0, 20)) lines.push(`  ${warning}`);
	}
	return lines;
}

/** AutoAssembleResult → JSON 安全的数据。 */
function autoAssembleData(result) {
	return {
		enable: result.enable === true,
		syntaxCheckOnly: result.syntaxCheckOnly === true,
		bytesWritten: result.bytesWritten,
		entryCount: result.entries.length,
		allocations: (result.allocations ?? []).map((alloc) => ({
			name: alloc.name,
			address: formatAddress(alloc.address),
			size: alloc.size,
			global: alloc.global === true
		})),
		// 本次 dealloc/realloc 真正释放掉的块（供调用方确认内存已归还）
		deallocated: (result.deallocated ?? []).map((block) => ({
			name: block.name,
			address: formatAddress(block.address),
			size: block.size
		})),
		aobScans: (result.aobScans ?? []).map((scan) => ({
			name: scan.name,
			address: formatAddress(scan.address),
			matchCount: scan.matches.length,
			scope: scan.scope
		})),
		registeredSymbols: result.registeredSymbols ?? [],
		createThreads: (result.createThreads ?? []).map((address) => formatAddress(address)),
		warnings: result.warnings ?? [],
		sections: result.sections
	};
}
