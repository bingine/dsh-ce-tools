/**
 * `.CT` 载入路径的地址语义 —— 端到端钉住「.CT 里**每个裸数字**都是十六进制」。
 *
 * ## 这个文件为什么被重写（上一版是**假测试**）
 *
 * 上一版**没有 import `lib/tools/table.js`**，而是在测试里又抄了一份
 * `normalizeCtAddresses`（553B vs 真品 357B，连 try/catch 都不等价），
 * 直接调内核 `loadCheatTable`。审查做了反向验证：**把 `table.js` 的修复整个拿掉，
 * 那个文件仍然 8 pass / 0 fail** —— 它测的是自己抄的那份副本，
 * 对产品代码的回归**零覆盖**。
 *
 * 现在这一版：
 *   1. 走 `test/helpers/harness.mjs` 的 `callTool('ce_cheat_table', {action:'load'})`
 *      —— 真正经过插件注册的工具、参数校验、`run()` 与渲染；
 *   2. 用 **`CheatTestWindow.exe` 当 oracle**（它把自己每个变量的真实地址与值
 *      打印在窗口里），断言**解析出的地址**与**读出的值**，而不是"没抛错"；
 *   3. 地址语义的实现已**下沉到内核**（`parseCheatEntry` → `normalizeCtAddress`），
 *      插件侧那份"正则改写 XML"已删除 —— 因此本文件同时是那条下沉的回归测试。
 *
 * ## oracle 的哪些值可以拿来断言
 *
 * `CheatTestWindow.exe` 有一部分字段**每帧都在变**（g_hp / g_gold / g_posX…），
 * 拿它们断言会偶发失败。这里只用**恒定**的那几个：
 *   · `&g_pStats = 模块基址+0x9000`，其内容是 `&g_stats = 模块基址+0x9010`；
 *   · `g_stats.hp = 777`（+0x9010）、`.mp = 333`（+0x9014）、
 *     `.gold = 9999`（+0x9018）、`.y = 34.5`（+0x9020，float）。
 *
 * 运行：node --test test/ct-address-semantics.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { callTool, createHarness } from "./helpers/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ORACLE = path.join(ROOT, "CheatTestWindow.exe");

/** oracle 里恒定的值与它们的偏移（见文件头说明）。 */
const OFF = { pStats: 0x9000n, stats: 0x9010n };
const VAL = { hp: "777", mp: "333", gold: "9999", y: "34.5" };

let harness = null;
let oracle = null;
let tempDir = "";
/** oracle 主模块基址（`CheatTestWindow.exe+0`） */
let base = 0n;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 模块基址 + 偏移 的绝对地址（十六进制文本）。 */
const at = (offset) => "0x" + (base + BigInt(offset)).toString(16);

/**
 * 起 oracle 并等它把内存布局准备好（`tool-contracts` 用的是内核自带夹具，
 * 但那个夹具的数据在 VirtualAlloc 的匿名区里，**没有模块相对地址可测**，
 * 所以这里必须用带真实模块的靶子）。
 */
before(async () => {
	if (!fs.existsSync(ORACLE)) {
		throw new Error(`没有测试靶子 ${ORACLE} —— 它是 .CT 地址语义的 oracle，不能跳过。`);
	}
	oracle = spawn(ORACLE, [], { cwd: ROOT, stdio: "ignore" });
	harness = createHarness({ backend: "self" });
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-ct-address-"));

	const deadline = Date.now() + 30_000;
	let lastError = new Error("尚未尝试");
	while (Date.now() < deadline) {
		try {
			await callTool(harness, "ce_attach", { pid: oracle.pid });
			const modules = await callTool(harness, "ce_modules", { filter: "CheatTestWindow" });
			const main = modules.data.modules.find((m) => /^CheatTestWindow\.exe$/i.test(m.name));
			assert.ok(main !== undefined, "oracle 里应当有 CheatTestWindow.exe 主模块");
			base = BigInt(main.base);
			// 哨兵：`&g_pStats` 处存放的应当是 `&g_stats`。
			const probe = await callTool(harness, "ce_read", { address: at(OFF.pStats), type: "qword" });
			const got = BigInt(probe.data.values[0].value);
			if (got === base + OFF.stats) {
				return;
			}
			lastError = new Error(`哨兵不符：${got.toString(16)} ≠ ${(base + OFF.stats).toString(16)}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(500);
	}
	throw new Error(`oracle（pid ${oracle.pid}）在 30s 内没就绪：${lastError.message}`);
});

after(async () => {
	if (harness !== null) await harness.dispose();
	if (oracle !== null && oracle.exitCode === null) {
		try {
			oracle.kill();
		} catch {
			/* 已经退出 */
		}
	}
	if (tempDir !== "" && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

let fileSeq = 0;

/** 造一份 .CT（`entries` 是 `<CheatEntry>` 片段数组），返回文件路径。 */
function writeCt(entries, { symbols = "", comment = "", version = 46 } = {}) {
	const file = path.join(tempDir, `table-${++fileSeq}.CT`);
	const xml =
		'<?xml version="1.0" encoding="utf-8"?>\n' +
		`<CheatTable CheatEngineTableVersion="${version}">\n` +
		comment +
		(symbols === "" ? "" : `  <UserdefinedSymbols>\n${symbols}  </UserdefinedSymbols>\n`) +
		"  <CheatEntries>\n" +
		entries.join("\n") +
		"\n  </CheatEntries>\n" +
		"</CheatTable>\n";
	fs.writeFileSync(file, xml, "utf8");
	return file;
}

/** 直接写任意文本成 .CT 文件（用于畸形/边界输入），返回文件路径。 */
function writeRaw(content) {
	const file = path.join(tempDir, `raw-${++fileSeq}.CT`);
	fs.writeFileSync(file, content, "utf8");
	return file;
}

/** 一条 CheatEntry 片段。 */
function entry({ id, description, address, type = "4 Bytes", children = "" }) {
	return (
		"    <CheatEntry>\n" +
		`      <ID>${id}</ID>\n` +
		`      <Description>${description}</Description>\n` +
		`      <VariableType>${type}</VariableType>\n` +
		`      <Address>${address}</Address>\n` +
		children +
		"    </CheatEntry>"
	);
}

/** 载入一份 .CT 并取 `list` 的结果。 */
async function load(xmlFile) {
	await callTool(harness, "ce_cheat_table", { action: "load", path: xmlFile });
	return callTool(harness, "ce_cheat_table", { action: "list" });
}

/** 在 list 结果里按条目名找一行（子条目名带缩进，所以 trim 后比较）。 */
function rowOf(listed, description) {
	const row = listed.data.records.find((record) => record.description.trim() === description);
	assert.ok(row !== undefined, `list 里应当有 "${description}"：\n${listed.text}`);
	return row;
}

/**
 * 一行的错误信息（没有错误时是 null）。
 *
 * ⚠️ `data.records[].error` 在"没有错误"时是 **undefined 而不是 null**：
 * 工具出口的 `toJsonSafe` 会把 `null` 当成"没有这个字段"丢掉
 * （`lib/toolkit.js:69`），这是既有约定，不是本测试的假设。
 */
const errorOf = (row) => row.error ?? null;

/* ================================================================== *
 * A：`.CT` 的地址语义（每个裸数字都是十六进制）
 * ================================================================== */

test("A：模块相对 + 多个 `+` 项、指针链里的算术都按十六进制", async () => {
	// 审查实测出的两个后门：
	//   `"CheatTestWindow.exe"+9000+10`  —— 第二个 `+10` 以前不规范化 → 基址+0x900A
	//   `["CheatTestWindow.exe"+9000]+10` —— `]` 后面的 `+10` 同理 → 基址+0x901A
	// CE 的语义（`symbolhandler.pas:5268` 逐 token `val('$'+token)`）两者都是 +0x10。
	const file = writeCt([
		entry({ id: 1, description: "多级加项", address: '"CheatTestWindow.exe"+9000+10' }),
		entry({
			id: 2,
			description: "指针链里的算术",
			address: '["CheatTestWindow.exe"+9000]+10',
			type: "Float"
		})
	]);
	const listed = await load(file);

	const add = rowOf(listed, "多级加项");
	assert.equal(add.address, at(OFF.stats), "应解析到 模块基址+0x9010");
	assert.equal(errorOf(add), null);
	assert.equal(add.value, VAL.hp, "基址+0x9010 是 g_stats.hp = 777");
	// 十进制 10 会落在 基址+0x900A（两个数字相邻）—— 明确排除
	assert.notEqual(add.address, at(0x900an), "不能把第二个 +10 当十进制");

	const chain = rowOf(listed, "指针链里的算术");
	assert.equal(chain.address, at(0x9020n), "解引用后 +0x10 ⇒ 基址+0x9020");
	assert.equal(errorOf(chain), null);
	assert.equal(chain.value, VAL.y, "基址+0x9020 是 g_stats.y = 34.5");
	assert.notEqual(chain.address, at(0x901an), "`]+10` 也不能当十进制");
});

test("A：引号包裹 / 数字实体 / 整条裸数字 都按十六进制（三类洞）", async () => {
	// 这三条正是"在插件里正则改写 XML"那条错层次修法漏掉/弄坏的形态：
	//   · `"00401000"`   —— 整条被一对引号包住（旧正则产出 0x61e68）
	//   · `&#48;0401000` —— 数字实体（旧预处理不认实体，内核的 parseXml 认）
	//   · `00401000`     —— 整条裸数字
	const file = writeCt([
		entry({ id: 1, description: "引号包裹", address: '"00401000"' }),
		entry({ id: 2, description: "数字实体", address: "&#48;0401000" }),
		entry({ id: 3, description: "整条裸数字", address: "00401000" })
	]);
	const listed = await load(file);

	for (const description of ["引号包裹", "数字实体", "整条裸数字"]) {
		const row = rowOf(listed, description);
		assert.equal(row.address, "0x401000", `${description} 必须解析成 0x401000`);
		assert.equal(errorOf(row), null);
	}
	// 十进制会得到 0x61e68（401000 的十进制），必须排除
	assert.notEqual(rowOf(listed, "整条裸数字").address, "0x61e68");
});

test("A：纯算术里的每个数字都是十六进制（`1000+1000` / `10*2`）", async () => {
	// `1000+1000` 若按十进制会得到 2000（0x7d0），按 .CT 语义是 0x1000+0x1000 = 0x2000；
	// `10*2` 十进制是 20（0x14），.CT 语义是 0x10*0x2 = 0x20。
	const file = writeCt([
		entry({ id: 1, description: "纯加法", address: "1000+1000" }),
		entry({ id: 2, description: "纯乘法", address: "10*2" })
	]);
	const listed = await load(file);

	assert.equal(rowOf(listed, "纯加法").address, "0x2000");
	assert.notEqual(rowOf(listed, "纯加法").address, "0x7d0", "不能按十进制 2000");
	assert.equal(rowOf(listed, "纯乘法").address, "0x20");
	assert.notEqual(rowOf(listed, "纯乘法").address, "0x14", "不能按十进制 20");
});

test("A：注释与 CDATA 不会破坏解析（旧的正则预处理会把 XML 改坏）", async () => {
	// ⚠️ 这是审查实测最恶劣的一个洞：注释里出现一个**没闭合的 `<Address>`**
	// 时，`(<Address>)([\s\S]*?)(</Address>)` 会跨过注释结尾一直吃到真正条目的
	// `</Address>`，把 `-->` 转义成 `--&gt;` ⇒ 注释永不闭合 ⇒ 后面的条目全被吞，
	// 工具却报「解析不出任何 CheatEntry…它不像是一个 .CT」（把文件改坏后怪文件）。
	//
	// 语义下沉到内核 `parseCheatEntry` 之后，拿到的是**已解码的 `<Address>` 文本**，
	// 注释/CDATA 由 XML 解析器处理，不存在"两层对文本的定义不一致"。
	const file = writeCt(
		[
			entry({
				id: 1,
				description: "<![CDATA[\"注释后的条目\"]]>",
				address: '"CheatTestWindow.exe"+9018'
			})
		],
		{ comment: "  <!-- 旧表片段：<Address>game.exe+1000 到此为止 -->\n" }
	);
	const listed = await load(file);

	const row = rowOf(listed, "注释后的条目");
	assert.equal(row.address, at(0x9018n), "注释里的 <Address> 不该影响真条目的解析");
	assert.equal(row.value, VAL.gold, "基址+0x9018 是 g_stats.gold = 9999");
});

/* ================================================================== *
 * B：子条目的相对地址（`+18`）—— 以前完全没实现，且静默给错值
 * ================================================================== */

test("B：子条目 `+18` 以父条目为基准（不是绝对地址 0x12）", async () => {
	// 实测：父 `"CheatTestWindow.exe"+9000`、子 `+18` 时，`list` 显示子项 0x12
	// （十进制 18 当作绝对地址）、**error 为空**。CE 的语义是"父+0x18"：
	//   `MemoryRecordUnit.pas:2833-2841`（parseAddressString）
	//   `MemoryRecordUnit.pas:3650-3661`（getBaseAddress）
	const file = writeCt([
		entry({
			id: 1,
			description: "父条目",
			address: '"CheatTestWindow.exe"+9000',
			children:
				"      <CheatEntries>\n" +
				entry({ id: 2, description: "子项 +18", address: "+18" }) +
				"\n      </CheatEntries>\n"
		})
	]);
	const listed = await load(file);

	const parent = rowOf(listed, "父条目");
	assert.equal(parent.address, at(OFF.pStats));
	const child = rowOf(listed, "子项 +18");
	assert.equal(child.address, at(0x9018n), "子项必须是 父+0x18（0x12 是十进制 18 的绝对地址）");
	assert.notEqual(child.address, "0x12", "绝不能退化成绝对地址 0x12");
	assert.equal(errorOf(child), null);
	assert.equal(child.value, VAL.gold, "父+0x18 处是 g_stats.gold = 9999");
});

test("B：子条目 `+8` 也走相对语义（这条以前什么也测不出 —— 两种进制同值）", async () => {
	// ⚠️ `+8` 在十进制与十六进制下**值相同**，所以任何只比较"偏移数值"的断言
	// 都抓不到"相对地址没实现"这个 bug（上一版假测试就是这么写的）。
	// 唯一能抓住它的断言是**解析出的绝对地址**：必须是 父+8，而不是绝对的 0x8。
	const file = writeCt([
		entry({
			id: 1,
			description: "父条目",
			address: '"CheatTestWindow.exe"+9000',
			children:
				"      <CheatEntries>\n" +
				entry({ id: 2, description: "子项 +8", address: "+8" }) +
				"\n      </CheatEntries>\n"
		})
	]);
	const listed = await load(file);

	const child = rowOf(listed, "子项 +8");
	assert.equal(child.address, at(0x9008n), "子项必须是 父+8");
	assert.notEqual(child.address, "0x8", "绝不能被当成绝对地址 8");
});

test("B：父条目地址解析失败时，子项如实报错（不静默给一个假地址）", async () => {
	const file = writeCt([
		entry({
			id: 1,
			description: "坏父条目",
			address: '"不存在的模块.exe"+9000',
			children:
				"      <CheatEntries>\n" +
				entry({ id: 2, description: "子项 +18", address: "+18" }) +
				"\n      </CheatEntries>\n"
		})
	]);
	const listed = await load(file);

	const child = rowOf(listed, "子项 +18");
	assert.equal(child.address, "", "父条目解析不出来时子项也不能给出地址");
	assert.match(String(child.error), /相对地址|父条目/, `必须说明原因：${child.error}`);
});

/* ================================================================== *
 * C：`<UserdefinedSymbols>` 必须真的注册、且 save 不丢
 * ================================================================== */

test("C：载入的符号真的注册（条目能引用、别的工具也能解析）", async () => {
	// CE 的格式是**子元素**（`OpenSave.pas:1300-1302` 写出 / `:630-637` 读入），
	// 不是属性。符号地址同样是 .CT 语义（`symbolhandler.pas:3714` `val('$'+...)`）。
	const symbols =
		"    <SymbolEntry><Name>pStats</Name><Address>\"CheatTestWindow.exe\"+9000</Address></SymbolEntry>\n" +
		"    <SymbolEntry><Name>gStats</Name><Address>pStats+10</Address></SymbolEntry>\n";
	const file = writeCt(
		[
			entry({ id: 1, description: "用符号当基址", address: "gStats" }),
			entry({ id: 2, description: "符号+偏移", address: "gStats+4" }),
			entry({ id: 3, description: "大小写不敏感", address: "gstats" })
		],
		{ symbols }
	);
	const listed = await load(file);

	assert.equal(rowOf(listed, "用符号当基址").address, at(OFF.stats), "gStats 应解析到 基址+0x9010");
	assert.equal(rowOf(listed, "用符号当基址").value, VAL.hp);
	// 符号自己引用了另一个符号 + 十六进制偏移（`pStats+10` ⇒ +0x10）
	assert.equal(rowOf(listed, "符号+偏移").value, VAL.mp, "gStats+4 处是 g_stats.mp = 333");
	assert.equal(rowOf(listed, "大小写不敏感").address, at(OFF.stats), "符号查找不区分大小写");

	// 载入报告里要如实说明注册情况
	const reload = await callTool(harness, "ce_cheat_table", { action: "load", path: file });
	assert.equal(reload.data.symbols, 2);
	assert.deepEqual(reload.data.unresolvedSymbols, []);

	// 而且**别的工具**也能解析到它们（符号同时进了会话的符号表）：
	// `ce_read gStats+4` 就是 g_stats.mp = 333。
	const read = await callTool(harness, "ce_read", { address: "gStats+4", type: "dword" });
	assert.equal(read.data.values[0].value, VAL.mp, `ce_read 也应认得载入的符号：\n${read.text}`);
	const readDirect = await callTool(harness, "ce_read", { address: "pStats", type: "qword" });
	assert.equal(BigInt(readDirect.data.values[0].value), base + OFF.stats, "符号指向 &g_stats");
});

test("C：未定义的符号仍然如实报错（注册不能变成「什么都认」）", async () => {
	const file = writeCt([entry({ id: 1, description: "未定义符号", address: "myStat+8" })]);
	const listed = await load(file);
	const row = rowOf(listed, "未定义符号");
	assert.equal(row.address, "");
	assert.match(String(row.error), /未知的符号或模块/);
});

test("C：save 保留 `<UserdefinedSymbols>`（不再静默丢数据）", async () => {
	const symbols =
		"    <SymbolEntry><Name>pStats</Name><Address>\"CheatTestWindow.exe\"+9000</Address></SymbolEntry>\n" +
		"    <SymbolEntry><Name>gStats</Name><Address>pStats+10</Address></SymbolEntry>\n";
	const file = writeCt([entry({ id: 1, description: "用符号当基址", address: "gStats" })], { symbols });
	await load(file);

	const outPath = path.join(tempDir, "symbols-out.CT");
	await callTool(harness, "ce_cheat_table", { action: "save", path: outPath });
	const xml = fs.readFileSync(outPath, "utf8");

	assert.match(xml, /<UserdefinedSymbols>/, `符号段必须写回去：\n${xml}`);
	// 原文保留（模块相对形式不能换算成绝对地址，否则对方重启后失效）
	assert.match(xml, /<Name>pStats<\/Name>/, "符号名必须保留");
	assert.match(xml, /<Address>"CheatTestWindow\.exe"\+9000<\/Address>/, "符号地址原文必须保留");
	assert.match(xml, /<Name>gStats<\/Name>/);
	assert.match(xml, /<Address>pStats\+10<\/Address>/);
	// 大小写重复项不能各写一份（内核符号表里同名符号有原名与小写名两份）
	assert.equal((xml.match(/<Name>pStats<\/Name>/g) ?? []).length, 1, "符号不能重复写出");
	assert.doesNotMatch(xml, /<SymbolEntry Name=/, "要用 CE 认的子元素形式，而不是属性形式");

	// 写出去的表再读回来，符号仍然可用（往返不丢）
	const back = await load(outPath);
	assert.equal(rowOf(back, "用符号当基址").address, at(OFF.stats), "往返后符号仍应解析到 基址+0x9010");
});

/* ================================================================== *
 * D：`0x10+20` 与 `$10+20` 必须给出同一个地址（用户输入的 add 路径）
 * ================================================================== */

test("D：`0x10+20` 与 `$10+20` 经 add 解析出**同一个地址**（0x24）", async () => {
	// `normalizeModuleOffsets` 的 IDENT 曾经能从数字字面量中间开始匹配（`0x10` 里的 `x10`）：
	//     `0x10+20` → `x10+0x20` → 0x30
	//     `$10+20`  → 不变       → 0x24
	// 同一件事两种写法、两个地址，而且都不报错。现在实现与 `values.js` 里
	// "前面不是标识符，20 仍是十进制"的注释一致了。
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [
			{ description: "带前缀字面量", address: "0x10+20", type: "dword" },
			{ description: "美元前缀字面量", address: "$10+20", type: "dword" }
		]
	});
	const listed = await callTool(harness, "ce_cheat_table", { action: "list" });

	assert.equal(rowOf(listed, "带前缀字面量").address, "0x24");
	assert.equal(rowOf(listed, "美元前缀字面量").address, "0x24");
	assert.notEqual(rowOf(listed, "带前缀字面量").address, "0x30", "0x10+0x20 是读错语义的结果");
});

/* ================================================================== *
 * 写出的 .CT 必须是 CE 的形态（否则「用 CE 打开」等于坏表）
 * ================================================================== */

test("save：地址不带外层引号、按 CE 的裸十六进制写法，且往返地址逐位相同", async () => {
	// 审查留下的待核实项，查证结论：**是我们的 bug**。
	//   · CE 写地址是原样的（`MemoryRecordUnit.pas:1764`），只有描述带引号（`:1818`）；
	//   · CE 生成地址也不带引号（`symbolhandler.pas:5045`）；
	//   · CE 的 tokenize 遇引号只切换 inQuote、不产生分隔符（`:3125-3154`），
	//     所以 `"CheatTestWindow.exe+0x9018"` 是**一个** token ⇒ 解析失败。
	//   · 另外 CE 只在**整条**表达式是 `0x…` 时才认前缀（`:5228`），
	//     表达式中间的 `0x` 会解析失败 ⇒ 写出时必须用裸十六进制。
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [{ description: "写出格式", address: '"CheatTestWindow.exe"+9018', type: "dword" }]
	});
	const outPath = path.join(tempDir, "format-out.CT");
	await callTool(harness, "ce_cheat_table", { action: "save", path: outPath });
	const xml = fs.readFileSync(outPath, "utf8");

	assert.match(xml, /<Address>"CheatTestWindow\.exe"\+9018<\/Address>/, `地址应是 CE 的写法：\n${xml}`);
	assert.doesNotMatch(xml, /<Address>""/, "不能给地址再包一层引号");
	assert.doesNotMatch(xml, /<Address>[^<]*0x/, "表达式中间不能出现 0x 前缀（CE 解析不了）");

	// 往返：写出去再读回来，解析出的地址必须逐位相同
	const back = await load(outPath);
	assert.equal(rowOf(back, "写出格式").address, at(0x9018n), "往返后地址不变");
	assert.equal(rowOf(back, "写出格式").value, VAL.gold);
});

/* ================================================================== *
 * B1：数字 token 前后的**空白**（CE 对每个 token 都 trim）
 * ================================================================== */

test("B1：数字 token 前后的空白不能改变语义（CE 的 tokenize 会 trim 每个 token）", async () => {
	// 查证 `ce-src/Cheat Engine/symbolhandler.pas`：
	//   :3142 `t:=trim(copy(s, last, i-last));` / :3169 末段同样 trim
	// 早先本移植的 `mapCtTokens` **不 trim**，于是 ` 9018` 不匹配 `/^[0-9a-f]+$/`
	// 就原样保留 ⇒ 内核词法器按**十进制**读 ⇒ `base+0x233A`，而且 error 为空。
	const file = writeCt([
		entry({ id: 1, description: "空白-无", address: '"CheatTestWindow.exe"+9018' }),
		entry({ id: 2, description: "空白-加号前", address: '"CheatTestWindow.exe" +9018' }),
		entry({ id: 3, description: "空白-加号后", address: '"CheatTestWindow.exe"+ 9018' }),
		entry({ id: 4, description: "空白-两边", address: '"CheatTestWindow.exe" + 9018' }),
		entry({
			id: 5,
			description: "空白-指针链",
			address: '["CheatTestWindow.exe"+9000] + 10',
			type: "Float"
		})
	]);
	const listed = await load(file);

	for (const description of ["空白-无", "空白-加号前", "空白-加号后", "空白-两边"]) {
		const row = rowOf(listed, description);
		assert.equal(row.address, at(0x9018n), `${description} 应解析到 模块基址+0x9018`);
		assert.equal(errorOf(row), null);
		assert.equal(row.value, VAL.gold, "基址+0x9018 是 g_stats.gold = 9999");
	}
	// 十进制 9018 = 0x233a：这正是"没 trim"时的错误结果
	assert.notEqual(rowOf(listed, "空白-两边").address, at(0x233an), "不能按十进制读 9018");

	const chain = rowOf(listed, "空白-指针链");
	assert.equal(chain.address, at(0x9020n), "`] + 10` 里的 10 也是十六进制");
	assert.equal(chain.value, VAL.y, "基址+0x9020 是 g_stats.y = 34.5");

	// 同一条文本：`add`（用户手输）与 `load`（.CT 语义）必须给**同一个地址**
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [{ description: "ADD-带空白", address: '"CheatTestWindow.exe" + 9018', type: "dword" }]
	});
	const listed2 = await callTool(harness, "ce_cheat_table", { action: "list", limit: 100 });
	assert.equal(
		rowOf(listed2, "ADD-带空白").address,
		rowOf(listed, "空白-两边").address,
		"同一条带空白的模块相对地址，add 与 load 必须一致"
	);

	// 写出侧：token 带空白时也必须把内部的 `0x` 去掉，否则 CE 解析不了我们写的表
	// （这是同一个根因的另一半：`ctAddressForFile` 的 token 也带空白）
	const outPath = path.join(tempDir, "spaced-out.CT");
	await callTool(harness, "ce_cheat_table", { action: "save", path: outPath });
	const xml = fs.readFileSync(outPath, "utf8");
	assert.match(xml, /<Address>"CheatTestWindow\.exe" \+ 9018<\/Address>/, `带空白的地址也要写成 CE 的形态：\n${xml}`);
	assert.doesNotMatch(xml, /<Address>[^<]*0x/, "表达式中间不能出现 0x（CE 只在整条是 0x… 时才认前缀）");
});

/* ================================================================== *
 * B2 / E：`add` → `save` → `load` 的地址往返（内部十进制 vs .CT 十六进制）
 * ================================================================== */

test("B2/E：add → save → load 地址逐位不变（含 0d20 / 0b101 / 1000 这些裸数字形态）", async () => {
	// ## 为什么必须测这条
	//
	// 产品**内部**表达式里裸数字是**十进制**（内核 `addr/expression.ts:152-162`），
	// 而 `.CT` **文件**里裸数字是**十六进制**。`ctAddressForFile` 早先只换带
	// `0x`/`$`/`0d`/`0b` 前缀的 token，裸十进制**原样写出** ⇒ 语义漂移：
	//   add `1000+1000`（内部 0x7d0）→ `<Address>1000+1000</Address>` → load 得 0x2000
	//   add `0x400000+20`（内部 0x400014）→ `<Address>400000+20</Address>` → load 得 0x400020
	// 既有的往返不变量测试**只喂已规范化形态**（每个数字都带 `0x`），所以从没覆盖
	// 这条**真实**路径 —— 这一条就是补那个缺口。
	//
	// 另外这几条也是**反向验证**用的锚点：把 `add` 的地址规范化从
	// `toAddressExpression` 换回裸的 `normalizeModuleOffsets`，`0d20` 会从 0x14
	// 变成 0xd20、`1000` 会从 0x3e8 变成 0x1000 —— 本用例会立刻变红。
	await load(writeCt([entry({ id: 1, description: "占位", address: "0x1234" })]));

	const cases = [
		{ description: "RT-裸数字", address: "1000", expect: "0x3e8", file: "3e8" },
		{ description: "RT-纯算术", address: "1000+1000", expect: "0x7d0", file: "3e8+3e8" },
		{ description: "RT-0x加十进制", address: "0x400000+20", expect: "0x400014", file: "400000+14" },
		{ description: "RT-0x加十进制2", address: "0x10+20", expect: "0x24", file: "10+14" },
		{ description: "RT-0d 字面量", address: "0d20", expect: "0x14", file: "14" },
		{ description: "RT-0b 字面量", address: "0b101", expect: "0x5", file: "5" },
		{ description: "RT-裸十六进制字面量", address: "ff+20", expect: "0x11f", file: "ff+20" },
		{ description: "RT-模块相对", address: '"CheatTestWindow.exe"+9018', expect: at(0x9018n), file: '"CheatTestWindow.exe"+9018' },
		{
			description: "RT-带空白模块相对",
			address: '"CheatTestWindow.exe" + 9018',
			expect: at(0x9018n),
			file: '"CheatTestWindow.exe" + 9018'
		}
	];
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: cases.map((item) => ({ description: item.description, address: item.address, type: "dword" }))
	});
	const before = await callTool(harness, "ce_cheat_table", { action: "list", limit: 100 });
	for (const item of cases) {
		assert.equal(rowOf(before, item.description).address, item.expect, `add「${item.address}」`);
	}

	const outPath = path.join(tempDir, "roundtrip-address.CT");
	await callTool(harness, "ce_cheat_table", { action: "save", path: outPath });
	const xml = fs.readFileSync(outPath, "utf8");

	// 写出的 `<Address>` 必须是 CE 认的形态：不带外层引号、表达式中间没有 `0x`
	assert.doesNotMatch(xml, /<Address>""/, "不能给地址再包一层引号");
	assert.doesNotMatch(xml, /<Address>[^<]*0x/, `表达式中间不能出现 0x：\n${xml}`);
	// 逐条核对写出的文本（CE 的裸十六进制写法）
	for (const item of cases) {
		assert.ok(
			xml.includes(`<Address>${item.file}</Address>`),
			`「${item.description}」应写成 <Address>${item.file}</Address>：\n${xml}`
		);
	}

	// 往返：load 回来地址必须**逐位相同**（静默改地址就是这个用例要挡的）
	const after = await load(outPath);
	for (const item of cases) {
		assert.equal(
			rowOf(after, item.description).address,
			rowOf(before, item.description).address,
			`往返后「${item.description}」的地址必须不变`
		);
	}
	// 排除"按十进制读回来"的错误结果（1000 → 0x1000 是漏掉 B2 修复时的表现）
	assert.notEqual(rowOf(after, "RT-裸数字").address, "0x1000");
	assert.notEqual(rowOf(after, "RT-纯算术").address, "0x2000");
	assert.notEqual(rowOf(after, "RT-0x加十进制").address, "0x400020");
});

test("B3：`ff+20` 在 add 与 load 两条路上给出同一个地址（CE：0xff+0x20）", async () => {
	// 根因：`normalizeModuleOffsets` 把 `ff` 当"标识符 + 偏移"改写成 `ff+0x20`，
	// 而内核词法器把字母开头的 `ff` 当 **ident** ⇒ `add` 报「未知的符号或模块 "ff"」；
	// 而 `load` 走 `normalizeCtAddress` 得到 `0xff+0x20` = 0x11f。**两条路不一致。**
	//
	// CE 的规则（查证 `symbolhandler.pas:5264-5275`）：对每个 token **先**
	// `val('$'+tokens[i]),v64,j`，只有失败（j>0）才 `getmodulebyname`。
	// 所以纯 `[0-9a-f]` 的 token 在 CE 眼里**就是数字**（模块名优先是相反的说法）。
	await load(writeCt([entry({ id: 1, description: "LOAD-ff", address: "ff+20" })]));
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [{ description: "ADD-ff", address: "ff+20", type: "dword" }]
	});
	const listed = await callTool(harness, "ce_cheat_table", { action: "list", limit: 100 });

	const added = rowOf(listed, "ADD-ff");
	const loaded = rowOf(listed, "LOAD-ff");
	assert.equal(errorOf(added), null, `add 不该报「未知的符号或模块 ff」：${added.error}`);
	assert.equal(added.address, "0x11f", "ff+20 = 0xff + 0x20（CE 的 val('$'+token) 语义）");
	assert.equal(loaded.address, "0x11f", "load 侧也是 0x11f");
	assert.equal(added.address, loaded.address, "两条路必须一致");

	// 已有的十进制约定不能被这条修复破坏
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [
			{ description: "B3-0x10+20", address: "0x10+20", type: "dword" },
			{ description: "B3-1000+1000", address: "1000+1000", type: "dword" }
		]
	});
	const listed2 = await callTool(harness, "ce_cheat_table", { action: "list", limit: 100 });
	assert.equal(rowOf(listed2, "B3-0x10+20").address, "0x24", "显式 0x 字面量开头时，20 仍是十进制");
	assert.equal(rowOf(listed2, "B3-1000+1000").address, "0x7d0", "裸十进制加法仍是十进制");
});

/* ================================================================== *
 * B3 残留：裸十六进制字面量出现在**中间**（判据必须位置无关）
 * ================================================================== */

test("B3 残留：裸十六进制字面量出现在**中间**时，add 与 load 也必须给出同一个地址", async () => {
	// ## 残留 bug（本次修复）
	//
	// 上一轮的判据只看**第一个操作数**是不是裸十六进制字面量，所以 `ff+20` 修好了，
	// 而同一个 token 落在**中间**时仍走标识符路径：
	//   · `add 1000+ff`  → 内核收到 `1000+ff` ⇒ 报「未知的符号或模块 "ff"`
	//   · `load <Address>1000+ff</Address>` → `normalizeCtAddress` 得 `0x1000+0xff` = 0x10ff
	// 同一段文本两条路不一致。CE 的判定是**逐 token** 的
	// （`symbolhandler.pas:5264-5275`：先 `val('$'+token)`、失败才 `getmodulebyname`），
	// 与 token 排在第几个位置无关，所以两条路都该是 0x10ff。
	//
	// ⚠️ 本用例是这次修复的**反向验证锚点**：把 `hasBareHexLiteral` 换回
	// 「只看第一个操作数」的判据，下面 `ADD-残留-*` 那几行会立刻变成
	// 「未知的符号或模块 "ff"」、地址变空 ⇒ 本用例变红。
	const cases = [
		{ description: "残留-1000+ff", address: "1000+ff", expect: "0x10ff" },
		{ description: "残留-10+ff", address: "10+ff", expect: "0x10f" },
		{ description: "残留-1000+ff+20", address: "1000+ff+20", expect: "0x111f" },
		// 模块名 + 偏移 + 裸字面量：模块名整体保留，末尾的 `ff` 当数字
		{ description: "残留-模块名后加裸字面量", address: "CheatTestWindow.exe+10+ff", expect: at(0x10fn) }
	];
	await load(
		writeCt(
			cases.map((item, index) =>
				entry({ id: index + 1, description: `LOAD-${item.description}`, address: item.address })
			)
		)
	);
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: cases.map((item) => ({
			description: `ADD-${item.description}`,
			address: item.address,
			type: "dword"
		}))
	});
	const listed = await callTool(harness, "ce_cheat_table", { action: "list", limit: 100 });

	for (const item of cases) {
		const added = rowOf(listed, `ADD-${item.description}`);
		const loaded = rowOf(listed, `LOAD-${item.description}`);
		assert.equal(errorOf(added), null, `add「${item.address}」不该报「未知的符号或模块 ff」：${added.error}`);
		assert.equal(errorOf(loaded), null, `load「${item.address}」不该报错：${loaded.error}`);
		assert.equal(added.address, item.expect, `add「${item.address}」必须按 CE 的十六进制语义`);
		assert.equal(loaded.address, item.expect, `load「${item.address}」必须按 .CT 的十六进制语义`);
		assert.equal(added.address, loaded.address, `「${item.address}」两条路必须给出同一个地址`);
	}
	// "整条按十六进制"是**全有或全无**：`1000` 也必须一起按十六进制读。
	// 0x4e7 = 0x3e8（1000 的**十进制**）+ 0xff —— 这是"只把 ff 当十六进制"的
	// 半吊子实现的产物，必须排除。
	assert.notEqual(rowOf(listed, "ADD-残留-1000+ff").address, "0x4e7", "1000 也必须按十六进制读");
});

test("B3 残留：整条切到十六进制语义只改**文本**，解析出的地址与读到的值不变", async () => {
	// 判据变成位置无关之后，`[...]+8+1C` 里的 `1C`（含 a-f 的裸字面量）也会把整条
	// 切成"按 CE 十六进制语义"：文本上 `8` → `0x8`、`1C` → `0x1c`。
	// **值必须逐位不变**：8 ≡ 0x8，而 `1C` 本来就含 `c`、内核词法器早就按十六进制读它。
	// 这里用 oracle 的指针链把它钉成"两条路解析出同一个地址、读到同一个值"：
	//   · 裸形态   `[CheatTestWindow.exe+9000]+8+1C`（会被规范化）
	//   · 显式形态 `[CheatTestWindow.exe+0x9000]+0x8+0x1c`（没有裸字面量，原样透传）
	// 两者都应是 基址 + 0x9010 + 0x8 + 0x1c = 基址 + 0x9034（实测那处是 1234）。
	const file = writeCt([
		entry({ id: 1, description: "裸形态", address: "[CheatTestWindow.exe+9000]+8+1C" }),
		entry({ id: 2, description: "显式形态", address: "[CheatTestWindow.exe+0x9000]+0x8+0x1c" })
	]);
	const listed = await load(file);
	const bare = rowOf(listed, "裸形态");
	const explicit = rowOf(listed, "显式形态");

	assert.equal(errorOf(bare), null, `裸形态不该报错：${bare.error}`);
	assert.equal(errorOf(explicit), null, `显式形态不该报错：${explicit.error}`);
	assert.equal(bare.address, at(0x9034n), "8 与 1C 都按十六进制：0x9010 + 0x8 + 0x1c");
	assert.equal(explicit.address, bare.address, "规范化前后必须解析到同一个地址");
	assert.equal(bare.value, explicit.value, "规范化前后必须读到同一个值");

	// 同一条文本在 add（用户手输）上也必须一致（同一个地址、同一个值）
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [{ description: "ADD-裸形态", address: "[CheatTestWindow.exe+9000]+8+1C", type: "dword" }]
	});
	const listed2 = await callTool(harness, "ce_cheat_table", { action: "list", limit: 100 });
	const added = rowOf(listed2, "ADD-裸形态");
	assert.equal(errorOf(added), null, `add 不该报错：${added.error}`);
	assert.equal(added.address, at(0x9034n), "add 也必须给出 基址+0x9034");
	assert.equal(added.value, bare.value, "add 与 load 读到的值也必须相同");
});

test("B3 残留：名字本身像十六进制的**模块名**仍然按模块名查找（不能被拆成字面量）", async () => {
	// `dead.dll` / `ff.exe` 是**模块名**，不是"字面量 dead/ff + 后缀"（`.` 是标识符字符）。
	// 目标进程里没有这两个模块，所以正确的表现是"找不到这个模块"的错误，
	// 而不是算出某个数字（`0xdead + …`）或悄悄给出一个地址。
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [
			{ description: "像hex的模块名-dead", address: "dead.dll+20", type: "dword" },
			{ description: "像hex的模块名-ff", address: "ff.exe+10", type: "dword" }
		]
	});
	const listed = await callTool(harness, "ce_cheat_table", { action: "list", limit: 100 });

	for (const [description, needle] of [
		["像hex的模块名-dead", "dead.dll"],
		["像hex的模块名-ff", "ff.exe"]
	]) {
		const row = rowOf(listed, description);
		assert.notEqual(errorOf(row), null, `${description} 应当因为"没有这个模块"而报错`);
		assert.ok(
			String(errorOf(row)).includes(needle),
			`${description} 的错误里必须点名模块名 ${needle}（说明它被当成了模块名）：${row.error}`
		);
		assert.equal(row.address, "", `${description} 不该被算成一个地址`);
	}
});

/* ================================================================== *
 * B4 / B6：save 不能静默改写版本号、不能丢表级元数据
 * ================================================================== */

test("B4：save 写回载入的表版本（45），不写死 46 —— CE 打开才不弹「有更新版本」", async () => {
	// `ce-src/Cheat Engine/OpenSave.pas:24` `const _CurrentTableVersion=45;`
	// `:1218` CE 自己写出时用的就是它；`:401-402` CE 打开"版本比它新"的表会
	// `showmessage(rsOSThereIsANewerVersion…)`。早先本移植硬编码 46，于是
	// 「用 CE 7.51 打开我们写出的任何 .CT 都会弹对话框」，还把别人表的版本号改高。
	const file = writeCt([entry({ id: 1, description: "版本", address: "0x1234" })], { version: 45 });
	const loaded = await callTool(harness, "ce_cheat_table", { action: "load", path: file });
	assert.equal(loaded.data.version, 45, "load 要如实报告载入的版本");

	const outPath = path.join(tempDir, "version-out.CT");
	const saved = await callTool(harness, "ce_cheat_table", { action: "save", path: outPath });
	assert.equal(saved.data.version, 45, "save 要写回载入的版本");
	const xml = fs.readFileSync(outPath, "utf8");
	assert.match(xml, /CheatEngineTableVersion="45"/, `必须原样写回 45：\n${xml}`);
	assert.doesNotMatch(xml, /CheatEngineTableVersion="46"/, "不能把 45 悄悄改成 46");

	// 再读一次：版本仍然是 45（往返稳定）
	const again = await callTool(harness, "ce_cheat_table", { action: "load", path: outPath });
	assert.equal(again.data.version, 45);
});

test("B6：save 保留原表注释与根级元数据（不再静默丢用户数据）", async () => {
	// 两处**静默丢数据**：
	//   1. 插件 `save` 无条件传自己那句注释 ⇒ 原表注释被替换
	//      （实测：load 报「注释：这是原表的注释，务必保留」，save 之后搜不到了）；
	//   2. `writeCheatTable` 只写 `<Comment>`/`<UserdefinedSymbols>`/`<CheatEntries>`
	//      ⇒ 根级 `<Structures>` / `<LuaScript>` / `<Forms>` / `<Files>` /
	//      `<CheatCodes>` / `<Comments>` 与根级其它属性一个都不剩。
	const input = writeRaw(
		'<?xml version="1.0" encoding="utf-8"?>\n' +
			'<CheatTable CheatEngineTableVersion="45" CustomRootAttr="保留我">\n' +
			"  <Comment>这是原表的注释，务必保留</Comment>\n" +
			"  <Comments>表级注释（另一个元素）</Comments>\n" +
			'  <Structures><Structure Name="MyStruct"><Element Type="dword" Offset="0" Name="a"/></Structure></Structures>\n' +
			'  <LuaScript>print("hello from lua")</LuaScript>\n' +
			"  <CheatEntries>\n" +
			entry({ id: 1, description: "根元数据", address: "0x1234" }) +
			"\n  </CheatEntries>\n" +
			'  <Forms><Form Name="f1"/></Forms>\n' +
			'  <Files><File Name="payload.bin"/></Files>\n' +
			"  <CheatCodes><CodeEntry>00401000</CodeEntry></CheatCodes>\n" +
			"</CheatTable>\n"
	);
	const loaded = await callTool(harness, "ce_cheat_table", { action: "load", path: input });
	assert.match(loaded.text, /这是原表的注释，务必保留/, "load 应报告原注释");

	const outPath = path.join(tempDir, "meta-out.CT");
	await callTool(harness, "ce_cheat_table", { action: "save", path: outPath });
	const xml = fs.readFileSync(outPath, "utf8");

	assert.match(xml, /<Comment>这是原表的注释，务必保留<\/Comment>/, `原注释必须逐字保留：\n${xml}`);
	assert.doesNotMatch(
		xml,
		/由 DSH cheat-engine 导出/,
		"原表已有注释时不能再用插件自己那句覆盖它"
	);
	for (const needle of [
		'CheatEngineTableVersion="45"',
		'CustomRootAttr="保留我"',
		"<Comments>",
		"表级注释（另一个元素）",
		"<Structures>",
		"MyStruct",
		"<LuaScript>",
		"hello from lua",
		"<Forms>",
		"<Files>",
		"<CheatCodes>"
	]) {
		assert.ok(xml.includes(needle), `根级内容必须保留：${needle}\n${xml}`);
	}
	// 相对位置也保持（原来在 CheatEntries 之后的仍在之后）
	assert.ok(xml.indexOf("<CheatEntries>") < xml.indexOf("<Forms>"), `<Forms> 应仍在 CheatEntries 之后：\n${xml}`);

	// 再走一圈：不会越写越多，元数据仍然在
	const back = await load(outPath);
	assert.equal(rowOf(back, "根元数据").address, "0x1234");
	const outPath2 = path.join(tempDir, "meta-out2.CT");
	await callTool(harness, "ce_cheat_table", { action: "save", path: outPath2 });
	const xml2 = fs.readFileSync(outPath2, "utf8");
	assert.equal((xml2.match(/<CheatEntries>/g) ?? []).length, 1, "不能重复写出 CheatEntries");
	assert.equal((xml2.match(/<Structures>/g) ?? []).length, 1, "不能重复写出 Structures");
	assert.match(xml2, /<Comment>这是原表的注释，务必保留<\/Comment>/);
});

/* ================================================================== *
 * B8：合法空表 vs 「根本不是 .CT」必须给不同的说法
 * ================================================================== */

test("B8：合法空表与「不是 .CT」分开报错，空表要 force 才能载入", async () => {
	const emptyTable = writeRaw(
		'<?xml version="1.0" encoding="utf-8"?>\n<CheatTable CheatEngineTableVersion="45"><CheatEntries>\n</CheatEntries></CheatTable>\n'
	);
	const selfClosing = writeRaw('<?xml version="1.0"?>\n<CheatTable CheatEngineTableVersion="45"/>\n');
	const emptyFile = writeRaw("");
	const garbage = writeRaw("not xml at all \u0000\u0001");

	// 合法但空：文案必须说清"它是合法 .CT，只是没有条目"，并要求显式 force
	for (const file of [emptyTable, selfClosing]) {
		await assert.rejects(
			() => callTool(harness, "ce_cheat_table", { action: "load", path: file }),
			(error) => {
				assert.match(error.message, /合法但没有任何 CheatEntry/, `空表要有专门的文案：${error.message}`);
				assert.doesNotMatch(error.message, /不像是一个 \.CT/, "合法空表不能与「非 XML」共用一个说法");
				assert.match(error.message, /force: true/, "要告诉调用方怎么显式载入");
				return true;
			}
		);
	}

	// 显式确认后可以载入（并且真的是 0 条）
	const forced = await callTool(harness, "ce_cheat_table", { action: "load", path: emptyTable, force: true });
	assert.equal(forced.data.count, 0);
	assert.match(forced.text, /条目：0 条/);

	// 根本不是 .CT：保持原来那句（不许被"空表"的说法顶掉）
	for (const file of [emptyFile, garbage]) {
		await assert.rejects(
			() => callTool(harness, "ce_cheat_table", { action: "load", path: file }),
			(error) => {
				assert.match(error.message, /不像是一个 \.CT/, `非 .CT 要有原来的文案：${error.message}`);
				assert.doesNotMatch(error.message, /合法但没有任何 CheatEntry/, "非 .CT 不能说成「合法空表」");
				return true;
			}
		);
	}
});

/* ================================================================== *
 * B9：`load` 是纯文件操作 —— 未附加进程也必须能用
 * ================================================================== */

test("B9：未附加进程也能 load / list / save（渲染降级，不解析不读值）", async () => {
	const solo = createHarness({ backend: "self" });
	try {
		const file = writeCt([
			entry({ id: 1, description: "绝对地址", address: "0x1234" }),
			entry({ id: 2, description: "模块相对", address: '"CheatTestWindow.exe"+9018' }),
			entry({
				id: 3,
				description: "指针链",
				address: "0x1000",
				children: "      <Offsets><Offset>10</Offset></Offsets>\n"
			})
		]);

		// ⚠️ 这里**没有** ce_attach：早先 load 会调 session.modulesCached()，
		// 直接抛「还没有附加到任何进程。请先调用 ce_attach…」。
		const loaded = await callTool(solo, "ce_cheat_table", { action: "load", path: file });
		assert.equal(loaded.data.count, 3);
		assert.equal(loaded.data.resolved, false, "未附加时 resolved 必须是 false（如实）");
		assert.match(loaded.text, /没有附加到任何进程/, "要如实说明「只列表达式、不读值」");
		assert.match(loaded.text, /0x1234/, "地址表达式仍要显示出来");
		assert.match(loaded.text, /CheatTestWindow\.exe/, "模块相对表达式也要显示");

		// list 同样能用：降级后**不能**因为指针链没有进程而崩
		// （`list.snapshot()` 会对每条 resolve()，偏移链在没有进程时必然抛错）
		const listed = await callTool(solo, "ce_cheat_table", { action: "list" });
		assert.equal(listed.data.count, 3);
		assert.equal(listed.data.resolved, false);
		assert.equal(listed.data.records[0].address, "0x1234", "降级时给出表达式原文");
		assert.equal(listed.data.records[0].value ?? null, null, "没有进程就不该有值");

		// save 也是纯文件操作，同样要能用
		const outPath = path.join(tempDir, "no-process-out.CT");
		const saved = await callTool(solo, "ce_cheat_table", { action: "save", path: outPath });
		assert.equal(saved.data.count, 3);
		const xml = fs.readFileSync(outPath, "utf8");
		assert.match(xml, /<Address>1234<\/Address>/, `未附加时也要写出 CE 的裸十六进制形态：\n${xml}`);
		assert.match(xml, /<Offset>10<\/Offset>/);
	} finally {
		await solo.dispose();
	}
});
