/**
 * .CT 地址表工具：`ce_cheat_table`
 *
 * 存在的意义是**与 Cheat Engine 本体互通**：在 DSH 里扫出来的地址、整理好的指针路径，
 * 可以导出成标准 `.CT` XML，直接用 CE 打开继续手动调试；反过来也能读 CE 存的表。
 * 内核的 .CT 读写严格对齐 CE 的元素与属性名，并保留未知元素，做到「读进来再写出去不丢信息」。
 *
 * @module dsh-cheat-engine/tools/table
 */

import fs from "node:fs";
import path from "node:path";
import {
	describeAddress,
	formatAddress,
	resolveVariableType,
	toAddressExpression,
	variableTypeName
} from "../values.js";
import { makeEnvelopeTool, prepare } from "./shared.js";

/**
 * 把条目/记录里的地址表达式规范化（模块相对偏移按十六进制）。
 *
 * ## 为什么地址表必须显式走这一步（实测的高危 bug）
 *
 * 内核表达式引擎把**裸数字按十进制**解析，而 CE 的用户习惯（以及本项目
 * `values.js` 里 `normalizeModuleOffsets` 的注释记录的实测 bug）把 `+` 后面的
 * 数字当**十六进制偏移**。两者冲突的后果是**静默读错地址**：
 *
 *   同一个 `cmd.exe+1000`
 *     · `ce_read`（走 `resolveAddressInput`）→ 读到 基址 + 0x1000 ✅
 *     · 地址表（早先直接透传）→ 读到 基址 + 0x3E8（1000 当十进制）❌
 *
 * 两条路给出**不一致**的结果、而且错的那个**不报错** —— 这比报错危险得多。
 *
 * ## 只管 `add`（用户手输）；`.CT` 载入走内核
 *
 * 这里用的是 `toAddressExpression`：**裸数字按十进制**（与 CE 的扫描数值框一致），
 * 这是面对用户手输时刻意保留的约定。而**从 .CT 文件读进来**的地址是另一套语义 ——
 * `.CT` 是 CE 自己的格式，里面**每一个裸数字都是十六进制**，那条路已经下沉进内核
 * 的 `parseCheatEntry`（`normalizeCtAddress`）。
 *
 * ⚠️ 0.1.7 曾经在 `load` 分支里用**正则改写 XML 文本**来补这个语义，那是错层次的修法，
 * 实测有三个洞：不认数字实体（`&#48;0401000` 漏过）、正则跨过注释边界把良构 XML
 * 改坏（注释永不闭合、条目全被吞）、与内核的 XML 解析器不是同一套"文本"定义。
 * 现在两套语义各自待在自己该在的层：**用户手输**在插件层，**文件格式**在内核层。
 *
 * @param {string} address 原始地址表达式
 * @returns {string} 偏移已规范化的表达式
 */
function normalizeEntryAddress(address) {
	const text = String(address ?? "").trim();
	if (text === "") return "";
	try {
		return toAddressExpression(text);
	} catch {
		// 规范化是"锦上添花"，不该因为一个怪表达式就让整次 add 失败；
		// 真解析不了会在求值时报错，那里的提示更贴近用户输入。
		return text;
	}
}

/**
 * 会话工作目录（相对路径的基准）。
 *
 * 工具说明写的是「相对路径基于当前工作目录」，而**进程 cwd 不是它**：
 * 插件跑在 DSH 宿主进程里，它的 cwd 是 DSH 的启动目录
 * （实测为 `C:\Users\<用户>\.dsh\profiles\desktop\`），与用户当前会话的工作区
 * 完全是两回事 —— 传 `ce-smoke-test.CT` 会把文件悄悄写到那里去。
 *
 * 真实基准来自 exec 上下文：`exec.agent.session.header.cwd`
 * （DSH 里所有文件类工具解析相对路径用的就是它，见 fs 工具的 session-cwd）。
 * 取不到（例如 PTC 子调用 / 无 agent）时退回进程 cwd —— 行为与旧版一致。
 *
 * @param {object} exec 工具执行上下文
 * @returns {string} 绝对路径基准目录
 */
function sessionWorkdir(exec) {
	const cwd = exec?.agent?.session?.header?.cwd
		?? exec?.agent?.session?.cwd
		?? exec?.cwd;
	if (typeof cwd === "string" && cwd.trim() !== "") return cwd;
	return process.cwd();
}

/** 把用户给的相对路径解析成绝对路径（相对**会话工作目录**，退化时用进程 cwd）。 */
function resolvePath(input, exec) {
	const text = String(input ?? "").trim();
	if (text === "") throw new Error("需要 path（.CT 文件路径）");
	return path.resolve(sessionWorkdir(exec), text);
}

/** 取地址表（不存在则创建，不要求已附加进程）。 */
function listOf(session, ce) {
	return session.addressListFor(ce);
}

/**
 * 目标进程是否可用。
 *
 * `ce_cheat_table` 的 `load` / `save` 是**纯文件操作**，`list` / `add` 也不需要真的碰目标，
 * 而 `session.modulesCached()` 会在未附加进程时抛「还没有附加到任何进程…」——
 * 早先 `load` 因此**在未附加时直接失败**（`lib/tools/table.js` 里调 modules 只是为了
 * 给每行渲染一个「模块+偏移」标签而已）。所以这些路径一律走这里：没有目标就降级。
 *
 * @param {object} session 会话
 * @returns {boolean}
 */
function hasLiveProcess(session) {
	const proc = session.process;
	return proc !== null && proc !== undefined && proc.isOpen !== false;
}

/** 取模块列表；没有目标进程时返回空数组（渲染降级，不抛错）。 */
async function modulesOrEmpty(session) {
	if (!hasLiveProcess(session)) return [];
	return await session.modulesCached();
}

/**
 * 没有目标进程时的**降级渲染**：直接列出条目表达式，不求值、不读值。
 *
 * ⚠️ 这里**不能**用 `list.snapshot()`：它对每条记录调 `resolve()`，而偏移链在没有
 * 进程时必然失败（内核明确抛「应用偏移链需要已打开的目标进程」）—— 一个指针条目
 * 就会让整次 `load` / `list` 炸掉。降级后给出的是"表达式原文"，正是这种情况下
 * 唯一能如实给出的信息。
 *
 * @param {object} list 内核 AddressList
 * @returns {Array<object>} 与 `toRow` 同形、可直接交给 `renderRow` 的行
 */
function degradedRows(list) {
	const out = [];
	const walk = (records, depth) => {
		for (const r of records) {
			out.push({
				id: r.id,
				description: "  ".repeat(depth) + String(r.description ?? ""),
				address: null,
				addressText: String(r.address ?? ""),
				label: "",
				value: null,
				error: null,
				frozen: r.frozen === true,
				active: r.active !== false,
				comment: typeof r.comment === "string" ? r.comment : "",
				type: r.variableType
			});
			if (Array.isArray(r.children) && r.children.length > 0) walk(r.children, depth + 1);
		}
	};
	walk(list.toData(), 0);
	return out;
}

/**
 * 把一条记录统一成渲染结构。
 *
 * 地址表有两个来源，形状不同，第一版把它们当成一种东西用，结果 `load` 直接崩：
 * - `AddressList.add()` 返回 `MemoryRecord`（地址走 `resolvedAddress` 取值器）；
 * - `AddressList.snapshot()` 返回普通行（地址走 `address` + `addressText`）。
 */
function toRow(source, modules) {
	const isRecord = "resolvedAddress" in source;
	const address = isRecord ? source.resolvedAddress : source.address;
	const rawAddress = isRecord ? source.address : source.addressText;
	const addressText = address === null || address === undefined
		? String(rawAddress ?? "")
		: formatAddress(address);
	const label = address === null || address === undefined ? "" : describeAddress(address, modules);
	const rawValue = source.value;
	return {
		id: source.id,
		description: source.description,
		addressText,
		label,
		value: rawValue === undefined || rawValue === null ? null : String(rawValue),
		error: source.error === undefined || source.error === null ? null : String(source.error),
		frozen: source.frozen === true,
		active: source.active !== false,
		// ⚠️ 备注也必须读出来。`add` 走的是 `AddressList.add()` 返回的 MemoryRecord
		// （有 `.comment`），而 `list` 走的是 `snapshot()` 的行 —— 两条路的形状不同，
		// 早先 snapshot 根本没有 comment 字段，于是备注在会话内也看不见。
		comment: typeof source.comment === "string" ? source.comment : ""
	};
}

/** 把统一后的记录渲染成一行文本。 */
function renderRow(row) {
	const labelText = row.label !== "" && row.label !== row.addressText ? `  (${row.label})` : "";
	const valueText = row.error !== null ? `  <${row.error}>` : row.value !== null && row.value !== "" ? `  = ${row.value}` : "";
	const flags = [row.frozen ? "冻结" : "", row.active ? "" : "停用"].filter((flag) => flag !== "").join("/");
	// 备注跟在最后，用 `//` 前缀 —— 与"条目名"区分开，一眼能看出是注释而不是名字的一部分
	const commentText = row.comment !== "" ? `  // ${row.comment}` : "";
	return (
		`#${String(row.id).padStart(3)}  ${String(row.description).padEnd(28)} ` +
		`${row.addressText}${labelText}${valueText}${flags === "" ? "" : `  [${flags}]`}${commentText}`
	);
}

/** 便捷：记录 → 文本行。 */
function recordLine(record, modules) {
	return renderRow(toRow(record, modules));
}

/**
 * 地址表工具。
 * @param {object} runtime 插件运行时
 */
export function createCheatTableTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_cheat_table",
		description:
			"管理 Cheat Engine 的 .CT 地址表，用于与 CE 本体互通。" +
			"action: add = 手动添加条目；add_scan = 把当前扫描结果的前若干个地址批量添加为条目；" +
			"list = 列出条目并解析地址/读出当前值；remove = 按 id 删除；" +
			"load = 从 .CT 文件载入（替换内存中的表）；save = 写出 .CT 文件（可用 CE 直接打开）。" +
			"条目的 address 支持与 ce_read 相同的地址表达式，offsets 用于「基址+多级偏移」形式" +
			"（例：address 给模块基址表达式，offsets 给 [0x10, 0x2C] —— 与 CE 的指针写法一致）。" +
			"【comment / frozen 的持久化】两者都会写进 .CT 并能读回、在 list 里可见：" +
			"frozen 写成 CE 自己的 <LastState Activated=\"1\"/>（与 CE 完全一致）；" +
			"comment 写成条目级的 <Comment>（**CE 的 TMemoryRecord 没有备注字段**，" +
			"所以不存在与 CE 同名的元素可选；CE 的读端按固定名字 FindNode，" +
			"不认识的多余子元素会被忽略，因此不会破坏互通 —— 代价是 CE 里看不到这条备注，" +
			"且在 CE 中重新保存一次会丢掉它）。" +
			"【表级元数据的往返】save 会**原样保留**载入的表版本、表级注释、根级其它属性" +
			"（如 CustomRootAttr）以及根级未建模元素（<Structures> / <LuaScript> / <Forms> / " +
			"<Files> / <CheatCodes> / <Comments> …）；未载入过的新表写 CE 的当前版本 45。" +
			"【load 不需要已附加进程】它是纯文件操作；未附加时只列地址表达式、不解析不读值。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["add", "add_scan", "list", "remove", "load", "save"],
				description: "add / add_scan / list / remove / load / save"
			},
			entries: {
				type: "array",
				description: "action: add 时要添加的条目。",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						description: { type: "string", required: true, description: "条目名（会显示在 CE 里）。" },
						address: { type: "string", required: true, description: "地址或地址表达式。" },
						type: { type: "string", description: "值类型，默认 dword。" },
						offsets: { type: "array", description: "多级偏移（十进制数组）。", items: { type: "integer" } },
						size: {
							type: "integer",
							description:
								"字节长度：AOB（字节数组）/ 字符串这类**变长类型必须有**，" +
								"否则读不出内容（定长数值类型可省略，内核按类型宽度取）。"
						},
						hexadecimal: { type: "boolean", description: "CE 里按十六进制显示。" },
						frozen: { type: "boolean", description: "标记为冻结（本插件不会后台持续写入，仅标记）。" },
						comment: { type: "string", description: "备注。" }
					}
				}
			},
			path: { type: "string", description: "action: load/save 的 .CT 文件路径（**相对路径基于当前会话的工作目录**；无 agent 上下文时退回进程 cwd）。" },
			force: {
				type: "boolean",
				description:
					"action: load 时，允许载入一张**合法但零条目**的空 .CT" +
					"（`<CheatTable><CheatEntries/></CheatTable>` 或 `<CheatTable/>`）。" +
					"默认拒绝 —— 载入空表会把当前的表换成空的。注意这与「文件根本不是 .CT」是两回事，" +
					"后者永远拒绝（那种情况会如实说明）。"
			},
			id: { type: "integer", description: "action: remove 时要删除的条目 id（**与 action: list 输出里显示的 `# N` 完全一致**）。" },
			limit: { type: "integer", description: "action: list 最多列多少条，默认 100。" },
			count: { type: "integer", description: "action: add_scan 时最多加多少个扫描结果，默认 20。" },
			descriptionPrefix: { type: "string", description: "action: add_scan 的条目名前缀，默认 \"scan\"。" },
			includeLastState: { type: "boolean", description: "action: save 是否写入 <LastState>（便于 CE 打开即显示值），默认 true。" }
		},
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			const action = String(args.action);

			if (action === "add") {
				if (!Array.isArray(args.entries) || args.entries.length === 0) {
					throw new Error("action: add 需要 entries 数组。");
				}
				const list = listOf(session, ce);
				const added = [];
				for (const entry of args.entries) {
					const type = resolveVariableType(ce, entry.type);
					const data = {
						description: String(entry.description ?? "entry"),
						// ⚠️ 必须规范化模块偏移，否则 `game.exe+1000` 会被当成十进制 1000
						// （与 ce_read 的结果不一致，且静默出错）。见 normalizeEntryAddress。
						address: normalizeEntryAddress(entry.address),
						variableType: type
					};
					if (Array.isArray(entry.offsets) && entry.offsets.length > 0) data.offsets = entry.offsets.map((n) => Number(n));
					// AOB / 字符串这类变长类型必须有显式长度，否则内核读不出内容
					if (entry.size !== undefined) data.stringLength = Number(entry.size);
					if (entry.hexadecimal !== undefined) data.hexadecimal = entry.hexadecimal === true;
					if (entry.frozen !== undefined) data.frozen = entry.frozen === true;
					if (entry.comment !== undefined) data.comment = String(entry.comment);
					const record = list.add(data);
					added.push(record);
				}
				const modules = await modulesOrEmpty(session);
				return {
					summary: `已添加 ${added.length} 条记录（表中共 ${list.count} 条）`,
					lines: added.map((record) => recordLine(record, modules)),
					data: { action, count: list.count, added: added.length, ids: added.map((record) => record.id) }
				};
			}

			if (action === "add_scan") {
				// 先查目标存活，再查扫描结果：目标已退出时"没有扫描结果"是次要信息，
				// 真正该告诉用户的是"目标没了，请重新 attach"。
				await session.requireLiveProcess();
				if (session.scan === null || session.scan.resultCount === 0) {
					throw new Error("当前没有扫描结果。请先 ce_scan action: first。");
				}
				const count = Number.isInteger(args.count) && args.count > 0 ? args.count : 20;
				const typeName = typeof args.type === "string" && args.type !== "" ? args.type : session.scanTypeName;
				const type = resolveVariableType(ce, typeName);
				const prefix = typeof args.descriptionPrefix === "string" && args.descriptionPrefix !== "" ? args.descriptionPrefix : "scan";
				const addresses = session.scan.getResults().slice(0, count);
				const list = listOf(session, ce);
				const records = [];
				for (const [index, address] of addresses.entries()) {
					records.push(
						list.add({
							description: `${prefix} ${index + 1}`,
							address: formatAddress(address),
							variableType: type
						})
					);
				}
				const modules = await session.modulesCached();
				return {
					summary: `已把前 ${records.length} 个扫描结果加入地址表（表中共 ${list.count} 条）`,
					lines: records.map((record) => recordLine(record, modules)),
					data: { action, count: list.count, added: records.length, type: variableTypeName(ce, type) }
				};
			}

			if (action === "list") {
				const list = listOf(session, ce);
				const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 100;
				const live = hasLiveProcess(session);
				const modules = await modulesOrEmpty(session);
				const snapshot = live
					? list.snapshot().slice(0, limit)
					: degradedRows(list).slice(0, limit);
				const lines = snapshot.map((row) => renderRow(live ? toRow(row, modules) : row));
				if (!live) {
					lines.push(
						"⚠️ 当前没有附加到任何进程：这里只列出**地址表达式**，不解析地址、不读值。" +
							"用 ce_attach 附加目标后再 list 才能看到解析出的地址与当前值。"
					);
				}
				if (list.count === 0) lines.push("表是空的。可用 add 手动添加，或先扫描再 add_scan。");
				if (list.count > snapshot.length) lines.push(`… 还有 ${list.count - snapshot.length} 条未显示`);
				return {
					summary: `地址表共 ${list.count} 条记录，显示 ${snapshot.length} 条`,
					lines,
					data: {
						action,
						count: list.count,
						shown: snapshot.length,
						resolved: live,
						records: snapshot.map((row) => {
							// ⚠️ 这里的 `row` 是**内核快照行**（含 `address`/`addressText`/`type`），
							// 而 `toRow` 只是渲染用的整形（它没有 `address` 字段）——
							// 所以字段一律从 `row` 取，别从 `toRow` 的结果取。
							return {
								id: row.id,
								description: row.description,
								address: row.address === null || row.address === undefined
									? row.addressText
									: formatAddress(row.address),
								type: variableTypeName(ce, row.type),
								value: row.value,
								error: row.error,
								// ⚠️ 这两个字段以前**没被输出**，于是 `add` 的输出行显示 `[冻结]`、
								// 而 `list` 的记录里 `frozen` 是 `undefined` —— 同一功能两处表现不一致。
								frozen: row.frozen === true,
								active: row.active !== false,
								comment: typeof row.comment === "string" && row.comment !== "" ? row.comment : null
							};
						})
					}
				};
			}

			if (action === "remove") {
				if (!Number.isInteger(args.id)) throw new Error("action: remove 需要整数 id。可在 action: list 的输出里看到 id。");
				const list = listOf(session, ce);
				// ⚠️ 必须按 **id** 删除，不能把数字当数组下标。
				//
				// 内核的 `AddressList.remove(number)` 语义是「数组下标」（0 基），
				// 而 `add()` 生成的 `id` 是**从 1 开始**的。早先这里直接透传 args.id，
				// 于是「list 显示 `#1`，remove 却要传 `id: 0`」——差一位，
				// 而一次误操作就会**删错条目**（删掉相邻那条，用户还不知情）。
				// 内核为此新增了语义明确的 `removeById`。
				const removed = typeof list.removeById === "function"
					? list.removeById(args.id)
					: (() => {
						// 兜底：按 id 查出来再按对象删，与 removeById 等价
						const rec = typeof list.getById === "function" ? list.getById(args.id) : undefined;
						return rec === undefined ? false : list.remove(rec);
					})();
				if (!removed) {
					const valid = list
						.snapshot()
						.slice(0, 20)
						.map((row) => row.id)
						.join(", ");
					throw new Error(
						`没有 id 为 ${args.id} 的记录（当前表里有 ${list.count} 条）。` +
						`有效 id 示例：${valid === "" ? "（表是空的）" : valid}。用 action: list 查看。`
					);
				}
				return {
					summary: `已删除 #${args.id}（剩余 ${list.count} 条）`,
					lines: [],
					data: { action, count: list.count, removedId: args.id }
				};
			}

			if (action === "load") {
				const file = resolvePath(args.path, exec);
				if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
				const xml = fs.readFileSync(file, "utf8");
				const force = args.force === true;
				// ⚠️ `load` 是**纯文件操作**：没有附加进程时也必须能用。
				// 早先这里无条件 `await session.modulesCached()`（只为给每行渲染一个
				// 「模块+偏移」标签），而它在未附加时会抛「还没有附加到任何进程…」
				// ⇒ 未附加时 load 直接失败，哪怕表里全是不需要进程的绝对地址。
				const live = hasLiveProcess(session);
				// ⚠️ 这里必须**只解析、先别替换**会话里的表。
				//
				// 早先是直接 `session.addressList = list`，而 `loadCheatTable` 对
				// 「不是 .CT 的文件」（package.json / 空文件 / 二进制垃圾 / 半截 XML）
				// 会**静默**返回一张 0 条记录的空表 —— 于是敲错一个路径就把用户
				// 攒了一整张表的内容冲掉了，而且工具还报告「已载入 …：0 条记录」，
				// 看起来像正常结果。实测过这四种文件，全部如此。
				//
				// ⚠️ 判据必须区分**两种**"0 条记录"（早先把它们写成了同一句话，
				// 对一张合法空表也报"它不像是一个 .CT"，那是不实报错）：
				//   · 合法但零条目 —— `<CheatTable><CheatEntries/></CheatTable>`（或
				//     `<CheatTable/>`）：是 .CT，只是没有条目；给明确文案，
				//     并要求调用方显式 `force: true` 才真的替换当前表；
				//   · 根本不是 .CT —— 空文件 / 非 XML / 二进制垃圾：保持原来那句。
				// 判据用内核的 `rootName`（解析出的根元素名），不是在 XML 文本上打正则。
				//
				// ⚠️ 地址语义（`.CT` 里**每个裸数字都是十六进制**）**不再**由本插件处理：
				// 它已下沉到内核的 `parseCheatEntry`（`normalizeCtAddress`），
				// 拿到的就是**已解码**的 `<Address>` 文本 —— 因此引号包裹、数字实体
				// （`&#48;0401000`）、注释/CDATA 这三类以前被"正则改写 XML"弄坏的形态
				// 一次全好。这里原样把 xml 交给内核即可，**不要**再在 XML 文本上做替换
				// （那会因为两套"文本"定义不一致而静默改坏良构 XML）。
				const { list, parsed } = ce.loadCheatTable(xml, live ? session.process : null);
				if (parsed.records.length === 0) {
					if (parsed.rootName !== "CheatTable") {
						throw new Error(
							`${path.basename(file)} 里解析不出任何 CheatEntry —— 它不像是一个 .CT 地址表。` +
								"（空文件、非 XML、二进制内容都会走到这里。）" +
								"为了不静默清空你当前的表，本次 load 已放弃。"
						);
					}
					if (!force) {
						throw new Error(
							`${path.basename(file)} 是一张**合法但没有任何 CheatEntry** 的 .CT（空表）。` +
								"它不是坏文件，所以不再和「非 XML / 二进制内容」共用一个说法；" +
								"但载入它会把当前的表换成空的，因此默认拒绝。" +
								"若确实要载入这张空表，请传 force: true。"
						);
					}
				}
				session.addressList = list;
				// 把载入的用户自定义符号也接进**会话**的符号表，这样 `ce_read myStat+8`
				// 之类的调用也能解析到它们（内核那边只保证表**内部**的条目能引用）。
				// 符号地址由内核在 loadCheatTable 里按 .CT 语义解析；解析不了的
				// （引用了不存在的模块）不会出现在 list.symbols 里。
				session.setTableSymbols(list.symbols);
				const modules = await modulesOrEmpty(session);
				// ⚠️ 符号表里同一个符号有**两份**（原名 + 小写名，见内核 `registerSymbol`），
				// 所以这里的计数与"是否解析成功"都必须**按小写名去重**，
				// 否则「2 个符号」会被报成 4 个（本项目踩过一次类似的计数坑）。
				// `symbolSources` 是内核 0.2.1 新增的（保存原文用），对旧内核做兜底。
				const sources = list.symbolSources ?? new Map();
				const byLower = new Map();
				for (const name of list.symbols.keys()) {
					if (!byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), name);
				}
				for (const name of sources.keys()) {
					if (!byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), name);
				}
				const symbolNames = [...byLower.values()];
				const registered = new Set([...list.symbols.keys()].map((name) => name.toLowerCase()));
				const unresolved = symbolNames.filter((name) => !registered.has(name.toLowerCase()));
				const lines = [
					`版本：${parsed.version}`,
					`注释：${parsed.comment === "" ? "（无）" : parsed.comment}`,
					`条目：${parsed.records.length} 条`,
					`自定义符号：${symbolNames.length} 个（已注册 ${symbolNames.length - unresolved.length} 个` +
						`${unresolved.length > 0 ? `，未能解析 ${unresolved.length} 个：${unresolved.join(", ")}` : ""}）`
				];
				if (!live) {
					lines.push(
						"⚠️ 当前没有附加到任何进程：下面只列出**地址表达式**，不解析地址、不读值。" +
							"用 ce_attach 附加目标后再 list 即可看到真实地址与值。"
					);
				} else if (parsed.records.length === 0) {
					lines.push("（这是一张合法的空表：没有任何 CheatEntry。）");
				}
				lines.push(
					...(live
						? list.snapshot().slice(0, 30).map((row) => renderRow(toRow(row, modules)))
						: degradedRows(list).slice(0, 30).map((row) => renderRow(row)))
				);
				if (parsed.records.length > 30) lines.push(`… 还有 ${parsed.records.length - 30} 条未显示`);
				return {
					summary: `已载入 ${path.basename(file)}：${parsed.records.length} 条记录`,
					lines,
					data: {
						action,
						count: list.count,
						version: parsed.version,
						path: file,
						symbols: symbolNames.length,
						unresolvedSymbols: unresolved,
						resolved: live
					}
				};
			}

			// action === "save"
			const list = listOf(session, ce);
			if (list.count === 0) throw new Error("地址表是空的，没有可保存的内容。先用 add / add_scan 添加条目。");
			const file = resolvePath(args.path, exec);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			// ⚠️ 表级注释**不能覆盖用户表里原有的注释**。
			//
			// 早先这里无条件传 `comment: '由 DSH cheat-engine 导出（目标 …）'`，
			// 于是 load 一张带注释的表、save 一次，原注释就被插件这句替换掉 ——
			// 实测：load 报「注释：这是原表的注释，务必保留」，save 之后搜不到了。
			// 现在：原表有注释就**逐字保留**；只有原本没有注释时才用插件这句。
			const existingComment = typeof list.comment === "string" && list.comment !== "" ? list.comment : "";
			const targetBrief = session.target === null || session.target === undefined
				? "未知"
				: `${session.target.name} pid ${session.target.pid}`;
			const xml = ce.saveCheatTable(list, {
				includeLastState: args.includeLastState !== false,
				// ⚠️ 写回**载入的版本号**（`ce-src/Cheat Engine/OpenSave.pas:24`
				// `const _CurrentTableVersion=45;`，`:1218` CE 自己写出时用的就是它）。
				// 早先这里既不传 version、内核又默认写 46 ⇒ 45 的表 save 一次变 46，
				// 而 CE 打开"版本比它新"的表会弹「有更新版本」对话框（`:401-402`）。
				version: list.version,
				comment: existingComment !== "" ? existingComment : `由 DSH cheat-engine 导出（目标 ${targetBrief}）`
			});
			fs.writeFileSync(file, xml, "utf8");
			return {
				summary: `已写出 ${list.count} 条记录到 ${file}`,
				lines: [
					`文件：${file}`,
					`大小：${Buffer.byteLength(xml, "utf8")} 字节`,
					`表版本：${list.version}`,
					"可以直接用 Cheat Engine 打开这张表。"
				],
				data: {
					action,
					count: list.count,
					path: file,
					bytes: Buffer.byteLength(xml, "utf8"),
					version: list.version
				}
			};
		}
	});
}
