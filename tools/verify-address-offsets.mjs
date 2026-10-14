/**
 * 验证「模块相对地址里裸数字偏移按十六进制解析」的修复。
 *
 * ## 背景（实测踩到的真 bug）
 *
 * `CheatTestWindow.exe+9030` 期望读 `模块基址 + 0x9030`（那里是 `g_level = 7`），
 * 实际读到 `模块基址 + 0x2346` —— 因为内核表达式引擎把**裸数字按十进制**解析
 * （9030 十进制 = 0x2346），而 CE 的用户习惯与**内核自己的文档示例**
 * （`"game.exe"+1234`）都把模块偏移当十六进制。
 *
 * 这类错误**静默给出错误的内存值**，比报错危险。
 */
import assert from "node:assert/strict";
import { toAddressExpression } from "../lib/values.js";

const cases = [
	// [输入, 期望规范化结果, 说明]
	["CheatTestWindow.exe+9030", "CheatTestWindow.exe+0x9030", "裸数字偏移 → 十六进制（本次修复的 bug）"],
	["CheatTestWindow.exe+0x9030", "CheatTestWindow.exe+0x9030", "已带前缀：不动"],
	["game.exe+1234", "game.exe+0x1234", "内核文档里的示例写法"],
	["game.exe+1a3f", "game.exe+0x1a3f", "含 a-f：本来就是十六进制，值不变"],
	["my-mod.dll+1f", "my-mod.dll+0x1f", "连字符模块名"],
	['"notepad.exe"+1234', '"notepad.exe"+0x1234', "带引号的模块名"],
	['"带空格的模块名.exe"+10', '"带空格的模块名.exe"+0x10', "引号里有非 ASCII"],
	["[[game.exe+10]+8]", "[[game.exe+0x10]+8]", "解引用链里的模块偏移也要规范化"],
	["game.exe+10+8", "game.exe+0x10+8", "只规范紧跟模块名的那个偏移"],
	["game.exe-10", "game.exe-0x10", "负偏移同样处理"],

	// 不该被改动的：
	["0x2346", "0x2346", "纯十六进制字面量"],
	["100", "0x64", "纯数字：插件层按十进制（与扫描数值一致）"],
	["9030", "0x2346", "纯数字按十进制 —— 只有**模块偏移**才当十六进制"],
	["[0x1000]+8", "[0x1000]+8", "前面是方括号 → 不是模块偏移"],
	["0x10+20", "0x10+20", "**字面量后面的算术**：`x10` 不是标识符（后行断言挡住），20 仍是十进制"],
	["$ff+20", "$ff+20", "`$ff` 是显式十六进制字面量：整条不动（20 仍是十进制 ⇒ 0x24）"],

	// 裸十六进制字面量开头：CE 的 `val('$'+token)`（symbolhandler.pas:5268）**先于**
	// 模块/符号查找，所以 `ff` 就是数字 0xff，`ff+20` = 0xff + 0x20 = **0x11f**。
	// 这也让 `add`（用户手输）与 `load`（.CT）对同一段文本给出**同一个地址**。
	["ff+20", "0xff+0x20", "裸十六进制字面量开头 ⇒ 整条按 CE 语义（0x11f）"],
	["ff + 20", "0xff + 0x20", "同上，带空白"],
	["[ff]+8", "[0xff]+0x8", "解引用里的裸十六进制字面量"],
	// ⚠️ 模块名不能被切开：`ff.exe` 是**一个**标识符
	["ff.exe+10", "ff.exe+0x10", "`ff.exe` 是模块名，不是字面量 ff + .exe"],
	["dead.dll+10", "dead.dll+0x10", "同理（`dead` 后面跟着 `.`，不是裸 token 的边界）"]
];

/**
 * 关于 `0x10+20`（这条**曾经**是"已知边界"，现在是修好的 bug）
 *
 * 旧实现里 IDENT 能从数字字面量**中间**开始匹配（`0x10` 里的 `x10`），于是
 *     `0x10+20` → `x10+0x20` → **0x30**
 *     `$10+20`  → 不变       → **0x24**
 * 同一件算术两种写法给出不同地址，而且都不报错。
 * 现在标识符不能紧跟在数字/`$` 后面，两者都是 0x24 —— 与本文件上面的注释、
 * 以及 `lib/values.js` 里"前面不是标识符，20 仍是十进制"一致。
 * 回归用例：`test/unit.test.mjs`（文本层）与 `test/ct-address-semantics.test.mjs`（值层）。
 */

let failed = 0;
for (const [input, want, note] of cases) {
	let got;
	try {
		got = toAddressExpression(input);
	} catch (error) {
		got = `THROW: ${error.message.slice(0, 50)}`;
	}
	const ok = got === want;
	if (!ok) failed += 1;
	console.log(`  ${ok ? "✅" : "❌"} ${input.padEnd(30)} → ${got}`);
	if (!ok) console.log(`       期望 ${want}　（${note}）`);
}

console.log("");
if (failed === 0) {
	console.log("  ✅ 全部符合预期");
	process.exit(0);
}
console.log(`  ❌ ${failed} 例不符`);
process.exit(1);
