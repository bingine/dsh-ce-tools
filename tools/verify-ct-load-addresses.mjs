/**
 * 验证 `.CT` 载入路径的地址语义（**内核层**，不再有插件侧的正则预处理）。
 *
 * ## 背景
 *
 * 0.1.7 上，用户实测发现 `.CT` 载入时裸数字被当十进制。当时的修法是在插件里
 * **用正则改写 `<Address>` 元素的 XML 文本**（`lib/tools/table.js` 的
 * `normalizeCtAddresses`）。审查证明那是**错层次**的修法，并实测出三个洞：
 *   · `"00401000"`（整条被一对引号包住）→ 0x61e68；
 *   · `&#48;0401000`（数字实体）→ 0x61e68（正则不认实体，内核的 parseXml 认）；
 *   · 注释里出现没闭合的 `<Address>` 时，正则跨过注释结尾、把 `-->` 转义掉
 *     ⇒ 注释永不闭合、条目全被吞，工具却报「它不像是一个 .CT」。
 *
 * 现在语义**下沉到内核解析处**（`parseCheatEntry` → `normalizeCtAddress`），
 * 拿到的是**已解码**的 `<Address>` 文本，三类洞一次消失。插件侧的正则已删除。
 *
 * ## 这个脚本验证什么
 *
 *   1. **文本层**（不需要目标进程）：每个形态该规范化成什么；
 *   2. **值层**（需要目标进程）：用 `CheatTestWindow.exe` 当 oracle，
 *      断言解析出的地址与读出的值。oracle 没在跑时会跳过这一节并说明。
 *
 * 用法：
 *   node tools/verify-ct-load-addresses.mjs
 *   （值层要先起靶子：`Start-Process .\CheatTestWindow.exe`）
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ce = require("../node-cheat-engine/dist/cjs/index.js");

/** 期望的**规范化后表达式**（不是最终数值）。 */
const CASES = [
	{ address: '"cmd.exe"+1000', want: '"cmd.exe"+0x1000', label: "模块相对 + 裸偏移（用户报的用例 1）" },
	{ address: "00401000", want: "0x401000", label: "整条是裸数字（用户报的用例 2）" },
	{ address: '"cmd.exe"+0x1000', want: '"cmd.exe"+0x1000', label: "显式 0x（用户报的用例 3）" },
	{ address: '"cmd.exe"+1A2B3C', want: '"cmd.exe"+0x1a2b3c', label: "含 a-f 的偏移" },
	{ address: "+18", want: "+0x18", label: "子项相对地址" },
	{ address: "game.exe+1000+10", want: "game.exe+0x1000+0x10", label: "多个 + 项" },
	{ address: "1000+1000", want: "0x1000+0x1000", label: "纯算术" },
	{ address: "10*2", want: "0x10*0x2", label: "纯乘法" },
	{ address: '["a.exe"+9000]+10', want: '["a.exe"+0x9000]+0x10', label: "指针链里的算术" },
	{ address: "0x1234", want: "0x1234", label: "已显式（不应改动）" }
];

let pass = 0;
let fail = 0;

const mk = (address, extra = "") => `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"t"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>${address}</Address>${extra}
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;

console.log("=== 文本层：内核 parseCheatEntry 规范化后的地址表达式 ===");
console.log("");
for (const c of CASES) {
	const got = ce.loadCheatTable(mk(c.address), null).list.all()[0].address;
	const ok = got === c.want;
	if (ok) pass += 1;
	else fail += 1;
	console.log(`  ${ok ? "✅" : "❌"} ${c.address.padEnd(24)} → ${got}`);
	if (!ok) console.log(`      期望 ${c.want}　（${c.label}）`);
}

console.log("");
console.log("=== 三类洞（旧的正则预处理弄坏/漏掉的形态）===");
const holes = [
	['"00401000"', "整条被一对引号包住", "0x401000"],
	["&#48;0401000", "数字实体（正则不认、内核 parseXml 认）", "0x401000"]
];
for (const [address, label, want] of holes) {
	const got = ce.loadCheatTable(mk(address), null).list.all()[0].address;
	const ok = got === want;
	if (ok) pass += 1;
	else fail += 1;
	console.log(`  ${ok ? "✅" : "❌"} ${label}：<Address>${address}</Address> → ${got}`);
}

// 注释里出现**没闭合的** `<Address>`：旧正则会把 `-->` 转义掉、把条目全吞掉
const commented = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <!-- 旧片段：<Address>game.exe+1000 到此为止 -->
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"注释后的条目"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"CheatTestWindow.exe"+9018</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;
const parsedComment = ce.loadCheatTable(commented, null).parsed;
const commentOk = parsedComment.records.length === 1;
if (commentOk) pass += 1;
else fail += 1;
console.log(`  ${commentOk ? "✅" : "❌"} 注释里的 <Address> 不影响解析（条目数 ${parsedComment.records.length}）`);

console.log("");
console.log("=== 符号段（载入即注册 / save 保留）===");
const withSymbols = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <UserdefinedSymbols>
    <SymbolEntry><Name>myStat</Name><Address>0x1234</Address></SymbolEntry>
    <SymbolEntry><Name>other</Name><Address>myStat+10</Address></SymbolEntry>
  </UserdefinedSymbols>
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"引用符号"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>myStat+8</Address>
    </CheatEntry>
  </CheatEntries>
</CheatTable>`;
const { list: symList } = ce.loadCheatTable(withSymbols, null);
const resolved = symList.get(0).resolve().address;
const symOk = resolved === 0x123cn;
if (symOk) pass += 1;
else fail += 1;
console.log(`  ${symOk ? "✅" : "❌"} 条目里的 myStat+8 解析成 ${resolved === null ? "null" : "0x" + resolved.toString(16)}（期望 0x123c）`);
const saved = ce.saveCheatTable(symList, { includeLastState: false });
const savedOk = saved.includes("<Name>myStat</Name>") && saved.includes("<Address>myStat+10</Address>");
if (savedOk) pass += 1;
else fail += 1;
console.log(`  ${savedOk ? "✅" : "❌"} save 保留 <UserdefinedSymbols>（原文形态）`);

console.log("");
console.log("=== 值层（oracle：CheatTestWindow.exe，未运行则跳过）===");
const koffi = require("../node-cheat-engine/node_modules/koffi");
const user32 = koffi.load("user32.dll");
const FindWindowW = user32.func("void *FindWindowW(char16_t *cls, char16_t *title)");
const GetWindowTextW = user32.func("int GetWindowTextW(void *hwnd, char16_t *buf, int max)");
const hwnd = FindWindowW("CheatTestWndClass", null);
const windowText = (handle) => {
	const buf = koffi.alloc("char16_t", 8192);
	const n = GetWindowTextW(handle, buf, 8192);
	return n <= 0 ? "" : koffi.decode(buf, "char16_t", n).toString();
};
if (hwnd === null || hwnd === undefined) {
	console.log("  （跳过：没找到 CheatTestWndClass 窗口 —— 先运行 .\\CheatTestWindow.exe）");
} else {
	const title = windowText(hwnd);
	const pid = Number(/PID:\s*(\d+)/.exec(title)?.[1] ?? 0);
	const proc = ce.Process.open(pid);
	const base = proc.modules().find((m) => /^CheatTestWindow\.exe$/i.test(m.name)).baseAddress;
	const values = [
		['"CheatTestWindow.exe"+9000+10', "4 Bytes", 777, "多个 + 项"],
		['["CheatTestWindow.exe"+9000]+10', "Float", 34.5, "指针链（解引用 +0x10 后是 g_stats.y）"]
	];
	for (const [address, type, want, label] of values) {
		const { list } = ce.loadCheatTable(mk(address).replace("<VariableType>4 Bytes</VariableType>", `<VariableType>${type}</VariableType>`), proc);
		const rec = list.get(0);
		const got = rec.resolve().address;
		const expectAddr = base + (type === "Float" ? 0x9020n : 0x9010n);
		const ok = got === expectAddr && rec.read() === String(want);
		if (ok) pass += 1;
		else fail += 1;
		console.log(
			`  ${ok ? "✅" : "❌"} ${label}：${address} → ${got === null ? "null" : "0x" + got.toString(16)}` +
				`（期望 0x${expectAddr.toString(16)}），值 = ${rec.read()}（期望 ${want}）`
		);
	}
	proc.close();
}

console.log("");
console.log(`=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
