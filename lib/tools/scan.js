/**
 * 扫描类工具：`ce_scan` / `ce_pointer_scan`
 *
 * `ce_scan` 用一个工具覆盖 CE 的完整扫描流程（首次扫描 → 再次扫描 → 查看结果 → 重置），
 * 因为这三步共享同一个有状态的 ScanSession —— 拆成三个工具反而更容易用错顺序。
 *
 * 关于「再次扫描」的默认行为（这是最容易踩的地方）：CE 的再次扫描可以「按新值精确匹配」，
 * 也可以「按变化方向筛选」（变大/变小/未变/已变）。两者都常用，所以这里按参数推断：
 * **给了 value 就按精确值匹配，没给就按未变动筛选**。工具描述里明确写了这条，
 * 免得模型以为自己没传参数时在做精确匹配。
 *
 * @module dsh-ce-tools/tools/scan
 */

import {
	analyzeAobPattern,
	assessAobBreadth,
	describeAddress,
	decodeValue,
	formatAddress,
	formatBytesCount,
	formatDuration,
	pointerPathToExpression,
	resolveRounding,
	resolveScanOption,
	resolveVariableType,
	variableTypeName,
	widthOfType
} from "../values.js";
import { makeEnvelopeTool, parseAddress, prepare } from "./shared.js";

/**
 * 挡住"宽泛到会把宿主内存撑爆"的 AOB 扫描。
 *
 * ## 真实数据
 *
 * `ce_scan {type:"aob", value:"?? ?? ??"}` 实测命中 **62,221,896** 个地址、
 * 耗时 4.8s、**宿主 heap +2956 MiB**（内核把每个命中都存进结果数组）。
 * 而工具**没有任何警告** —— 用户看到的是"扫描成功"。
 *
 * ## 为什么不能一概拒绝 `??`
 *
 * 单个 `??` 是合法且**大量使用**的：真实特征码几乎都带通配
 * （`E8 ?? ?? ?? ?? 8B` 这种很常见）。所以只拦"几乎全是通配"或"短到没有约束力"的模式，
 * 并且**留一个显式出口**：给 `allowBroadAob: true` 就照做，绝不无声地改用户的行为。
 *
 * @param {object} args 工具参数
 * @param {string} pattern AOB 模式串
 * @returns {string[]} 要追加到输出里的提示行（空数组 = 无需提示）
 */
function checkAobPattern(args, pattern) {
	const stats = analyzeAobPattern(pattern);
	const notes = [];

	// ① 奇数长度片段：内核会把落单的字符**静默当成通配符**。
	//    `DE AD B` 实际按 `DE AD ??` 扫 —— 必须说出来，否则用户以为自己在精确匹配 0x0B。
	if (stats.oddTokens.length > 0) {
		notes.push(
			`⚠️ AOB 模式里有长度为奇数的片段：${stats.oddTokens.map((t) => `"${t}"`).join("、")}。` +
				"内核按**两字符一字节**切分，落单的那个字符会被当成**通配符** —— " +
				`例如 "DE AD B" 实际按 "DE AD ??" 扫描。请补成两位（如 "0B"）或显式写 "??"。`
		);
	}

	const { broad, reason } = assessAobBreadth(stats);
	if (broad && args.allowBroadAob !== true) {
		throw new Error(
			`AOB 模式过于宽泛，已拒绝执行：${reason}。\n` +
				`（模式 "${pattern}"：共 ${stats.total} 字节，固定 ${stats.fixed}、` +
				`半字节约束 ${stats.partial}、完全通配 ${stats.wild}。）\n` +
				"这类扫描会命中上千万个地址：实测 `?? ?? ??` 命中 6200 万个、宿主内存 +2.9 GB，" +
				"有把 DSH 宿主推到 OOM 的风险。\n" +
				"请选择其一：\n" +
				"  · 加长特征码 / 增加固定字节（4 个以上固定字节基本就没问题）；\n" +
				"  · 用类型扫描代替（type: byte/dword… + value），而不是全通配 AOB；\n" +
				"  · 确实要这么扫，就显式传 allowBroadAob: true 表示你接受这个代价；\n" +
				"  · 收窄范围（writableOnly / executableOnly / includeImage 等）也能缓解，但不改变命中量级。"
		);
	}
	if (broad && args.allowBroadAob === true) {
		notes.push(
			`⚠️ 本次 AOB 模式很宽泛（${reason}），因为你显式给了 allowBroadAob: true 才继续执行 —— ` +
				"命中数可能到千万级并占用大量宿主内存。"
		);
	}
	return notes;
}

/**
 * 挡住"几乎全是通配位"的二进制（binary）扫描 —— 与全通配 AOB 同一个病。
 *
 * `binaryString: "????"` 的每一"位"都是一次落空，命中密度同样是 1，
 * 后果与 `?? ?? ??` 完全相同，所以不能只防 AOB 不防它。
 *
 * @param {object} args 工具参数
 * @param {string} bits 位串，如 `"0011????"`
 * @returns {string[]} 提示行
 */
function checkBinaryPattern(args, bits) {
	const text = String(bits).trim();
	const specified = (text.match(/[01]/g) ?? []).length;
	const total = text.length;
	// 约束位数少于 16 位（= 2 字节）时，命中密度 ≥ 1/65536，与 AOB 的判据同一量级
	if (total > 0 && specified < 16 && args.allowBroadAob !== true) {
		throw new Error(
			`binaryString "${text}" 过于宽泛，已拒绝执行：` +
				`${total} 位里只有 ${specified} 位是指定的（'0'/'1'），其余是通配。` +
				"命中密度会达到每 " +
				`${Math.pow(2, specified)} 个位置一次，在 GB 级内存上会产生千万级命中。\n` +
				"请给出更多指定位，或显式传 allowBroadAob: true 表示接受这个代价。"
		);
	}
	return specified < 16
		? [`⚠️ binaryString 只指定了 ${specified}/${total} 位，因为你显式给了 allowBroadAob: true 才继续。`]
		: [];
}

/** 把布尔参数收敛成「只在显式给出时才带上」。 */
function optional(flag, value) {
	return flag === undefined ? {} : { [value]: flag === true };
}

/**
 * 该扫描方式是否必须提供扫描值。
 *
 * CE 的「未知初值」系列（unknown/increased/decreased/changed/unchanged）不需要值，
 * 其余都需要。首次扫描时用它决定是否该直接报「缺 value」而不是让内核抛一个难懂的错。
 */
function optionNeedsValue(ce, option) {
	const noValue = new Set([
		ce.ScanOption.UnknownValue,
		ce.ScanOption.IncreasedValue,
		ce.ScanOption.DecreasedValue,
		ce.ScanOption.Changed,
		ce.ScanOption.Unchanged
	]);
	return !noValue.has(option);
}

/**
 * 构造内核需要的 ScanConfig。
 *
 * @param {object} ce 内核模块
 * @param {object} args 工具参数
 * @param {object} session 会话
 * @param {object|null} previous 上一次扫描的配置（再次扫描时填默认值）
 * @param {boolean} isNext 是否再次扫描
 * @returns {{ config: object, typeName: string }} ScanConfig 与类型名
 */
function buildScanConfig(ce, args, session, previous, isNext) {
	const typeName = args.type ?? (isNext ? session.scanTypeName ?? undefined : undefined);
	const type = resolveVariableType(ce, typeName);

	const hasValue = args.value !== undefined && args.value !== null && String(args.value) !== "";
	const hasValue2 = args.value2 !== undefined && args.value2 !== null && String(args.value2) !== "";
	const hasBinary = args.binaryString !== undefined && String(args.binaryString) !== "";

	// 再次扫描的模式推断：给了值按精确匹配，没给值按未变动筛选
	const defaultMode = isNext ? (hasValue || hasValue2 || hasBinary ? "exact" : "unchanged") : "exact";
	const scanOption = resolveScanOption(ce, args.mode ?? defaultMode);
	const rounding = resolveRounding(ce, args.rounding ?? "rounded");

	const fastScan = {};
	if (args.lastDigits !== undefined && Number.isInteger(args.lastDigits) && args.lastDigits > 0) {
		fastScan.fastScanMethod = ce.FastScanMethod.LastDigits;
		fastScan.fastScanAlignmentLastDigits = args.lastDigits;
	} else if (args.aligned === true) {
		fastScan.fastScanMethod = ce.FastScanMethod.Aligned;
	} else if (args.aligned === false) {
		fastScan.fastScanMethod = ce.FastScanMethod.NotAligned;
	}

	const config = {
		variableType: type,
		scanOption,
		roundingType: rounding,
		floatAccuracy: Number.isInteger(args.floatAccuracy) ? args.floatAccuracy : -1,
		...fastScan
	};
	if (hasValue) config.value1 = String(args.value);
	else if (isNext && previous !== null && previous.value1 !== undefined) config.value1 = previous.value1;
	if (hasValue2) config.value2 = String(args.value2);
	else if (isNext && previous !== null && previous.value2 !== undefined) config.value2 = previous.value2;
	if (args.hexadecimal === true) config.hexadecimal = true;
	else if (isNext && previous !== null && previous.hexadecimal === true) config.hexadecimal = true;
	if (args.signed !== undefined) config.signed = args.signed === true;
	else if (isNext && previous !== null && previous.signed !== undefined) config.signed = previous.signed;
	if (args.caseSensitive !== undefined) config.caseSensitive = args.caseSensitive === true;
	if (Number.isInteger(args.stringLength) && args.stringLength > 0) config.stringLength = args.stringLength;
	if (hasBinary) config.binaryString = String(args.binaryString);
	else if (isNext && previous !== null && previous.binaryString !== undefined) config.binaryString = previous.binaryString;
	if (args.is32Bit !== undefined) config.is32Bit = args.is32Bit === true;

	// 区域过滤：显式给出的才覆盖（再次扫描沿用上一次）
	for (const [key, value] of Object.entries({
		writableOnly: args.writableOnly,
		executableOnly: args.executableOnly,
		includeImage: args.includeImage,
		includeMapped: args.includeMapped,
		includePrivate: args.includePrivate,
		includeGuard: args.includeGuard
	})) {
		if (value !== undefined) config[key] = value === true;
		else if (isNext && previous !== null && previous[key] !== undefined) config[key] = previous[key];
	}
	return { config, typeName: typeName ?? variableTypeName(ce, type) };
}

/** 扫描统计 → 一行文本。 */
function statsLine(stats) {
	if (stats === null || stats === undefined) return "（无统计）";
	return (
		`扫了 ${stats.regionsScanned} 个区域 / ${formatBytesCount(stats.bytesScanned)}，` +
		`耗时 ${formatDuration(stats.elapsedMs)}，worker ${stats.workersUsed}，` +
		`快照 ${stats.hasSnapshot ? "已保留（可做“未变动/已变动”类筛选）" : "未保留（内存过大）"}`
	);
}

/**
 * 扫描覆盖 0 个区域 = 这次扫描没有意义，不能当成「命中 0 个」的成功结果。
 *
 * 最常见成因：**目标进程已经退出** —— 句柄仍然「打开」，但枚举不到任何区域，
 * 于是扫描「成功」返回 0 命中，模型会以为只是没扫到而不是目标没了。
 */
function assertScannedSomething(stats, session) {
	if (stats !== null && stats !== undefined && stats.regionsScanned === 0) {
		throw new Error(
			"扫描覆盖了 0 个内存区域：目标进程" +
			`（${session.target?.name ?? "?"} pid ${session.target?.pid ?? "?"}）` +
			"很可能已经退出，或它没有任何可扫描区域。" +
			"用 ce_session 确认状态；若已退出请重新 ce_attach。"
		);
	}
}

/** 扫描配置 → 一行人类可读描述。 */
function describeConfig(ce, config, typeName) {
	const parts = [
		`类型 ${typeName ?? variableTypeName(ce, config.variableType)}`,
		`方式 ${ce.SCAN_OPTION_NAMES?.[config.scanOption] ?? config.scanOption}`
	];
	if (config.value1 !== undefined) parts.push(`值1 ${config.value1}`);
	if (config.value2 !== undefined) parts.push(`值2 ${config.value2}`);
	if (config.binaryString !== undefined) parts.push(`位串 ${config.binaryString}`);
	parts.push(`浮点精度 ${config.floatAccuracy}`);
	const filters = [];
	if (config.writableOnly) filters.push("仅可写");
	if (config.executableOnly) filters.push("仅可执行");
	if (filters.length > 0) parts.push(filters.join("/"));
	return parts.join("，");
}

/**
 * 内存扫描。
 * @param {object} runtime 插件运行时
 */
export function createScanTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_scan",
		description:
			"在目标进程里扫描内存（对齐 Cheat Engine 的扫描语义）。用 action 走完整流程：" +
			"first=首次扫描（要 type + mode + value）；next=再次扫描（在上次结果里继续筛选）；" +
			"results=查看当前结果（分页，可同时读出每个地址的当前值）；reset=清空扫描会话；status=只看状态。" +
			"【再次扫描的模式默认值】给了 value → 按精确值匹配；没给 value → 按「未变动」筛选。" +
			"要找变化的数值时，典型用法是 next + mode: increased/decreased/changed/unchanged。" +
			"AOB 扫描：type: aob，value 写 \"DE AD BE EF ?? 90\"（? 是通配符）。" +
			"【AOB/二进制的宽泛度防护】**首次**扫描时会先评估模式的具体度，过宽则**拒绝执行**" +
			"并要求显式确认 —— 判据：一个固定字节都没有、或通配占比 ≥80%、或" +
			"「平均每 65536 字节就会命中一次」以上（例如 `?? ?? ??`、`90`、`?? 90`、`7*`）。" +
			"单个 `??` 完全合法，正常带通配的特征码（如 `E8 ?? ?? ?? ?? 8B`）不受影响。" +
			"确实要宽泛扫描就传 allowBroadAob: true（会明示代价）。" +
			"注意内核按**两字符一字节**切分 AOB，所以奇数长度片段（`DE AD B`）里的落单字符" +
			"会被当成通配符，工具会就此给出提示。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["first", "next", "results", "reset", "status"],
				description: "first / next / results / reset / status"
			},
			type: {
				type: "string",
				description: "值类型：byte/word/dword/qword/float/double/string/unicode/aob/binary/all/pointer。默认 dword。"
			},
			mode: {
				type: "string",
				description:
					"扫描方式：exact/between/greater/less/increased/increased_by/decreased/decreased_by/" +
					"changed/unchanged/increased_by_percent/decreased_by_percent/between_percent/unknown。" +
					"首次扫描默认 exact；再次扫描见工具说明。"
			},
			value: { type: "string", description: "扫描值（或 AOB 模式串）。" },
			value2: { type: "string", description: "区间/百分比方式的上界。" },
			binaryString: { type: "string", description: "type: binary 时的位串，如 \"0011????\"。" },
			hexadecimal: { type: "boolean", description: "value 按十六进制解析。" },
			signed: { type: "boolean", description: "整数按有符号比较。" },
			floatAccuracy: { type: "integer", description: "浮点小数位；-1（默认）表示从输入文本推断。" },
			rounding: { type: "string", enum: ["rounded", "extreme", "truncated"], description: "浮点比较策略，默认 rounded。" },
			stringLength: { type: "integer", description: "字符串扫描的字符数（默认由 value 推导）。" },
			caseSensitive: { type: "boolean", description: "字符串扫描是否区分大小写。" },
			aligned: { type: "boolean", description: "是否只扫对齐地址（真=按类型宽度对齐）。" },
			lastDigits: { type: "integer", description: "只扫末位为某值的地址（CE 的 Last Digits，如 4 只扫 …4）。" },
			writableOnly: { type: "boolean", description: "只扫可写内存。" },
			executableOnly: { type: "boolean", description: "只扫可执行内存。" },
			includeImage: { type: "boolean", description: "包含 MEM_IMAGE（模块映像）。" },
			includeMapped: { type: "boolean", description: "包含 MEM_MAPPED。" },
			includePrivate: { type: "boolean", description: "包含 MEM_PRIVATE（堆/栈）。" },
			includeGuard: { type: "boolean", description: "包含 PAGE_GUARD 区域。" },
			is32Bit: { type: "boolean", description: "只扫 4GB 以下地址（32 位目标）。" },
			allowBroadAob: {
				type: "boolean",
				description:
					"显式允许**过宽**的 AOB / binary 首次扫描（默认拒绝）。判据：无固定字节、" +
					"通配占比 ≥80%、或命中密度高于「每 65536 字节一次」。实测 `?? ?? ??` 会命中 6200 万个地址、" +
					"宿主内存 +2.9 GB。只在明确接受该代价时才设 true。"
			},
			offset: { type: "integer", description: "action=results 时的起始下标，默认 0。" },
			limit: { type: "integer", description: "action=results 时最多列多少个，默认 50。" },
			readValues: { type: "boolean", description: "action=results 时是否读出每个地址的当前值，默认 true。" }
		},
		timeoutMs: 300_000,
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			const action = String(args.action);

			if (action === "reset") {
				session.disposeScan();
				return {
					summary: "已清空扫描会话",
					lines: ["worker 池已释放，扫描状态已重置。下次 first 会重新开始。"],
					data: { action: "reset" }
				};
			}

			if (action === "status") {
				if (session.scan === null) {
					return { summary: "没有进行中的扫描会话", lines: ["用 action: first 开始首次扫描。"], data: { action: "status", resultCount: 0 } };
				}
				const lines = [`结果数：${session.scan.resultCount}`, `可继续筛选：${session.scan.canNextScan}`];
				if (session.scanStats !== null) lines.push(statsLine(session.scanStats));
				if (session.scanProgress !== null) {
					lines.push(
						`进度：${session.scanProgress.scanned} / ${session.scanProgress.total}（已命中 ${session.scanProgress.found}）`
					);
				}
				return {
					summary: `扫描会话有 ${session.scan.resultCount} 个结果`,
					lines,
					data: { action: "status", resultCount: session.scan.resultCount, canNextScan: session.scan.canNextScan }
				};
			}

			if (action === "results") {
				await session.requireLiveProcess();
				if (session.scan === null) {
					return { summary: "还没有扫描结果", lines: ["先执行 action: first。"], data: { action: "results", resultCount: 0 } };
				}
				const all = session.scan.getResults();
				const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
				const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50;
				const readValues = args.readValues !== false;
				const type = resolveVariableType(ce, args.type ?? session.scanTypeName);
				const width = widthOfType(ce, type, { pointerSize: session.pointerSize });
				const slice = all.slice(offset, offset + limit);
				const modules = await session.modulesCached();
				const lines = [];
				const items = [];
				for (const address of slice) {
					const label = describeAddress(address, modules);
					const labelText = label === formatAddress(address) ? "" : `  (${label})`;
					let valueText = "";
					if (readValues) {
						const buffer = await session.read(address, width);
						if (buffer.length > 0) valueText = ` = ${decodeValue(ce, buffer, type, { hexadecimal: args.hexadecimal === true })}`;
					}
					lines.push(`${formatAddress(address)}${labelText}${valueText}`);
					items.push({ address: formatAddress(address), module: label === formatAddress(address) ? undefined : label, value: valueText === "" ? undefined : valueText.slice(3) });
				}
				if (all.length > offset + slice.length) {
					lines.push(`… 还有 ${all.length - offset - slice.length} 个（用 offset 继续翻）`);
				}
				return {
					summary: `共 ${all.length} 个结果，显示第 ${offset + 1}–${offset + slice.length} 个`,
					lines,
					data: { action: "results", resultCount: all.length, offset, count: slice.length, type: variableTypeName(ce, type), items }
				};
			}

			// first / next 需要目标进程
			await session.requireLiveProcess();

			if (action === "first") {
				const { config, typeName } = buildScanConfig(ce, args, session, null, false);
				if (optionNeedsValue(ce, config.scanOption) && config.value1 === undefined && config.binaryString === undefined) {
					throw new Error(
						`首次扫描需要 value（或 type: binary 时给 binaryString）。` +
						"如果你在找「不知道初值、只知道会变化」的数值，请用 mode: unknown 做首次扫描。"
					);
				}
				// ⚠️ 只在**首次扫描**做宽泛度检查：那时要遍历整片内存，命中量无上界。
				// `next` 是在已有结果集上筛选（内核只对那批地址做比较），内存有界，
				// 拦它只会误伤正常流程。
				const patternNotes = [];
				if (typeName === "aob" && config.value1 !== undefined) {
					patternNotes.push(...checkAobPattern(args, String(config.value1)));
				} else if (typeName === "binary" && config.binaryString !== undefined) {
					patternNotes.push(...checkBinaryPattern(args, String(config.binaryString)));
				}
				const scan = await session.scanSession(ce, { fresh: true });
				const stats = scan.firstScan(config);
				assertScannedSomething(stats, session);
				session.scanConfig = config;
				session.scanTypeName = typeName;
				session.scanStats = stats;
				const lines = [
					`条件：${describeConfig(ce, config, typeName)}`,
					statsLine(stats),
					`命中：${stats.resultCount} 个地址`,
					...patternNotes,
					stats.resultCount === 0
						? "没有命中。可尝试：换类型（byte/float/double 也常是候选）、放宽到 mode: between、放开区域过滤、或确认值在目标里确实是这个数。"
						: "用 action: results 看地址；或改数值后 action: next 继续筛选。"
				];
				return {
					summary: `首次扫描命中 ${stats.resultCount} 个地址`,
					lines,
					data: {
						action: "first",
						resultCount: stats.resultCount,
						stats: {
							regionsScanned: stats.regionsScanned,
							bytesScanned: String(stats.bytesScanned),
							elapsedMs: stats.elapsedMs,
							hasSnapshot: stats.hasSnapshot,
							workersUsed: stats.workersUsed
						}
					}
				};
			}

			// action === "next"
			// 用法错误一律抛错（走 isError），而不是返回一个写着失败的成功值
			if (session.scan === null) {
				throw new Error("没有可继续筛选的扫描会话：请先用 action: first 做首次扫描。");
			}
			if (!session.scan.canNextScan) {
				throw new Error(
					`上一次扫描没有结果，无法继续筛选（当前结果数：${session.scan.resultCount}）。` +
					"可以 action: reset 后重新 first，或放宽首次扫描条件（换类型 / 用 between / 放开区域过滤）。"
				);
			}
			const { config, typeName } = buildScanConfig(ce, args, session, session.scanConfig, true);
			const stats = session.scan.nextScan(config);
			assertScannedSomething(stats, session);
			session.scanConfig = config;
			session.scanTypeName = typeName;
			session.scanStats = stats;
			const lines = [
				`条件：${describeConfig(ce, config, typeName)}`,
				statsLine(stats),
				`剩余：${stats.resultCount} 个地址`,
				stats.resultCount === 0
					? "筛光了。可能是筛选条件与目标行为不符，或该值不是这个类型 —— 用 action: reset 重来。"
					: stats.resultCount <= 10
						? "已经很少了，用 action: results 直接看；随后可以对其中一个地址 ce_read / ce_write。"
						: "继续改数值再 next，或直接 action: results 查看。"
			];
			return {
				summary: `再次扫描后剩余 ${stats.resultCount} 个地址`,
				lines,
				data: {
					action: "next",
					resultCount: stats.resultCount,
					stats: {
						regionsScanned: stats.regionsScanned,
						bytesScanned: String(stats.bytesScanned),
						elapsedMs: stats.elapsedMs,
						hasSnapshot: stats.hasSnapshot,
						workersUsed: stats.workersUsed
					}
				}
			};
		}
	});
}

/**
 * 指针扫描。
 * @param {object} runtime 插件运行时
 */
export function createPointerScanTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_pointer_scan",
		description:
			"为一个动态地址找稳定的「基址 + 多级偏移」路径（对齐 CE 的 Pointer Scan）。" +
			"这是把 ce_scan 找到的临时地址变成进程重启后依然有效地址的标准手段。" +
			"address 给目标地址（省略时取当前扫描结果的第 scanResultIndex 个，默认第 1 个）。" +
			"返回的每条路径都附带可直接喂给 ce_read/ce_write 的表达式。staticOnly: true 只保留基址落在" +
			"模块映像里的路径 —— 这类路径最稳定，优先用它。" +
			"第一次扫描要建立整张指针映射，可能耗时数秒到数十秒；同一进程再次扫描会复用映射，快很多。",
		parameters: {
			address: { type: "string", description: "要为其寻找指针路径的目标地址（表达式）。" },
			scanResultIndex: { type: "integer", description: "不给 address 时，取扫描结果的第几个，从 1 开始，默认 1。" },
			maxLevel: { type: "integer", description: "最大偏移层数，默认 5。" },
			maxOffset: { type: "integer", description: "单级偏移的最大绝对值，默认 2048。" },
			maxDifferentOffsets: { type: "integer", description: "每个存放地址允许的最大不同偏移数，0=不限。" },
			allowNegativeOffsets: { type: "boolean", description: "是否允许负偏移。" },
			staticOnly: { type: "boolean", description: "只保留基址位于模块映像（静态区）的路径。" },
			pointerSize: { type: "integer", enum: [4, 8], description: "指针宽度；默认按目标位数推断。" },
			maxResults: { type: "integer", description: "最多返回多少条路径，默认 20。" },
			rebuild: { type: "boolean", description: "强制重建指针映射（默认复用上次的）。" }
		},
		timeoutMs: 600_000,
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			session.requireSyncBackend("指针扫描");

			// 目标地址：显式 address 优先，否则取扫描结果
			let target;
			if (typeof args.address === "string" && args.address.trim() !== "") {
				target = await parseAddress(ce, session, args.address);
			} else {
				if (session.scan === null || session.scan.resultCount === 0) {
					throw new Error(
						"没有 address，且当前没有扫描结果。请给 address（例如 \"game.exe\"+1234 或 0x…），" +
						"或先用 ce_scan 得到一个地址。"
					);
				}
				const index = Number.isInteger(args.scanResultIndex) && args.scanResultIndex > 0 ? args.scanResultIndex : 1;
				// ⚠️ 必须用**收敛后**的 index 查表，不能把原值透传给内核：
				// 内核的判据是 `scanResultIndex != null ? scanResultIndex : 1`，
				// 于是 `scanResultIndex: 0` 会被它原样接收 → `results[-1]` → undefined。
				// 先归一、再取下标，两边的"第几个"才是同一个意思。
				const results = session.scan.getResults();
				if (index > results.length) {
					throw new Error(`扫描结果只有 ${results.length} 个，取不到第 ${index} 个。`);
				}
				target = results[index - 1];
			}

			const options = {
				maxLevel: Number.isInteger(args.maxLevel) && args.maxLevel > 0 ? args.maxLevel : runtime.config.pointerScanMaxLevel,
				maxOffset: Number.isInteger(args.maxOffset) && args.maxOffset > 0 ? args.maxOffset : runtime.config.pointerScanMaxOffset,
				maxResults: Number.isInteger(args.maxResults) && args.maxResults > 0 ? args.maxResults : 20
			};
			if (args.maxDifferentOffsets !== undefined) options.maxDifferentOffsets = args.maxDifferentOffsets;
			if (args.allowNegativeOffsets !== undefined) options.allowNegativeOffsets = args.allowNegativeOffsets === true;
			if (args.staticOnly !== undefined) options.staticOnly = args.staticOnly === true;
			if (args.pointerSize === 4 || args.pointerSize === 8) options.pointerSize = args.pointerSize;

			const requestedLevel = options.maxLevel;
			/**
			 * 汇总/排序的说明（有值时拼进输出，绝不静默）。
			 * @type {string|null}
			 */
			let depthNote = null;
			let paths;
			let stats;
			let usedLevel = requestedLevel;

			// 内核默认"只返回恰好达到 maxLevel 深度"的路径，而默认 maxLevel（CE 默认 5）
			// 通常比目标真实的指针层数更深，导致用户拿到的全是深层噪声，
			// 那条又浅又稳的路径反而不在结果里。
			//
			// 所以这里打开内核的 `preferShallow`：**一次扫描**汇总第 1..maxLevel 级的全部路径，
			// 由内核按「静态基址优先、层数浅优先」排序后再按 maxResults 截断。
			//
			// ⚠️ 早先这里是**跑两遍**（先普通扫描、再汇总扫描），
			// 而 `session.pointerScannerFor` 当时每调一次就 new 一个 PointerScanner，
			// 于是单次工具调用把整张指针映射（秒级~数十秒级的全量内存索引）建了**两遍**。
			// 现在扫描器按选项复用，并且这里**只扫一次**：`preferShallow` 的结果
			// 是普通结果的**超集**（普通模式收集第 maxLevel 级，汇总模式收集每一级），
			// 所以不需要先做一遍普通扫描。
			if (requestedLevel > 1) {
				const agg = session.pointerScannerFor(ce, { ...options, preferShallow: true });
				if (args.rebuild === true) agg.clearPointerMap();
				const aggregated = agg.scan(target);
				paths = aggregated;
				stats = agg.stats;
				if (aggregated.length > 0) {
					// usedLevel = 实际返回结果里的最大层数（没有 depth 字段时退回请求值）
					const depths = aggregated.map((p) => p.depth).filter((d) => typeof d === "number");
					usedLevel = depths.length > 0 ? Math.max(...depths) : requestedLevel;
					const levelCounts = Array.isArray(stats?.levelCounts) ? stats.levelCounts : [];
					// 只在"汇总确实改变了返回内容"时说明，避免每次都刷一段无信息的话
					if (usedLevel !== requestedLevel) {
						depthNote =
							`已汇总第 1–${levelCounts.length} 级的路径（每级候选 [${levelCounts.join(", ")}]），` +
							`按「层数浅优先、同层静态基址优先」排序后返回 ${paths.length} 条` +
							`（结果里最深 ${usedLevel} 级）。` +
							`默认只返回恰好达到 maxLevel 的路径，会被深层噪声淹没浅层有效路径。`;
					}
				} else {
					// 汇总模式**一条都没验证通过**时的兜底：退回普通模式再试一次。
					//
					// 为什么需要它：汇总模式把第 1..maxLevel 级的候选全部收进结果，
					// 排序后又统一按 maxResults 截断 —— 当浅层全是"值巧合"（会被内核的
					// 返回值验证丢掉）时，它们会把真正能用的深层路径挤出上限。
					// 普通模式只收第 maxLevel 级，噪声结构不同，可能正好留下可用的那条。
					//
					// 这条分支**只在汇总完全为空时**才走，而映射由同一个 PointerScanner
					// 实例持有（`pointerScannerFor` 现在按选项复用），所以不会重建映射。
					const plain = session.pointerScannerFor(ce, options);
					if (args.rebuild === true) plain.clearPointerMap();
					paths = plain.scan(target);
					stats = plain.stats ?? stats;
					const depths = paths.map((p) => p.depth).filter((d) => typeof d === "number");
					usedLevel = depths.length > 0 ? Math.max(...depths) : requestedLevel;
					if (paths.length > 0) {
						depthNote =
							`汇总模式（第 1–${requestedLevel} 级）没有一条路径通过可用性验证，` +
							`已退回「只取恰好 ${requestedLevel} 级」的模式，返回 ${paths.length} 条。`;
					}
				}
			} else {
				const scanner = session.pointerScannerFor(ce, options);
				if (args.rebuild === true) scanner.clearPointerMap();
				paths = scanner.scan(target);
				stats = scanner.stats;
			}

			const modules = await session.modulesCached();
			const moduleOf = (address) => {
				const value = BigInt(address);
				for (const module of modules) {
					const base = BigInt(module.baseAddress);
					const size = BigInt(module.size ?? 0);
					if (value >= base && value < base + size) {
						return { name: module.name, base };
					}
				}
				return null;
			};

			const lines = [];
			const items = [];
			for (const path of paths) {
				const display = ce.formatPointerPath(path, moduleOf);
				const expression = pointerPathToExpression(path);
				// 汇总模式下内核会给出 depth：层数越浅越稳，值得显式告诉使用者
				const depthText = typeof path.depth === "number" ? `  (${path.depth} 级)` : "";
				lines.push(`${display}${depthText}`);
				lines.push(`    表达式：${expression}`);
				items.push({
					base: formatAddress(path.baseAddress),
					offsets: path.offsets.map((offset) => offset),
					display,
					expression,
					// 只在汇总模式（内核填了 depth）时带上，保持默认输出形状不变
					...(typeof path.depth === "number" ? { depth: path.depth } : {})
				});
			}
			if (paths.length === 0) {
				const levelCounts = stats !== null && Array.isArray(stats.levelCounts) ? stats.levelCounts : [];
				if (levelCounts.length > 0 && levelCounts[0] === 0) {
					lines.push(
						"没有找到路径，而且**第一级就没有任何候选** —— 当前扫描范围内没有任何指针槽指向这个地址。" +
						"常见原因：这个地址是栈/寄存器里的临时值；指向它的指针位于未被扫描的段；指针宽度判断不对" +
						"（32 位目标请显式给 pointerSize: 4）。可先试去掉 staticOnly、调大 maxOffset。"
					);
				} else {
					lines.push(
						"没有找到路径。常见原因：目标地址本身不在已提交区域、maxOffset 太小、" +
						"或该地址根本不是通过指针链访问的。可以试：调大 maxOffset、去掉 staticOnly、" +
						"确认 pointerSize 与目标位数一致。"
					);
				}
			} else if (depthNote !== null) {
				lines.push(depthNote);
			}
			const targetLabel = describeAddress(target, modules);
			return {
				summary: paths.length === 0
					? `未找到指向 ${formatAddress(target)} 的指针路径`
					: `找到 ${paths.length} 条指向 ${formatAddress(target)} 的指针路径`,
				lines: [
					`目标地址：${formatAddress(target)}${targetLabel === formatAddress(target) ? "" : `  (${targetLabel})`}`,
					stats === null ? "" : `指针映射：${stats.segmentsScanned} 段 / ${formatBytesCount(stats.bytesIndexed)}，` +
						`索引 ${stats.pointerEntries} 个指针槽，每级候选 [${stats.levelCounts.join(", ")}]，耗时 ${formatDuration(stats.elapsedMs)}`,
					...lines
				].filter((line) => line !== ""),
				data: {
					target: formatAddress(target),
					pathCount: paths.length,
					requestedMaxLevel: requestedLevel,
					usedMaxLevel: usedLevel,
					depthNote: depthNote ?? undefined,
					stats: stats === null
						? undefined
						: {
							segmentsScanned: stats.segmentsScanned,
							bytesIndexed: String(stats.bytesIndexed),
							pointerEntries: stats.pointerEntries,
							levelCounts: stats.levelCounts,
							elapsedMs: stats.elapsedMs
						},
					paths: items
				}
			};
		}
	});
}
