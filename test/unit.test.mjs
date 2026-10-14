/**
 * 单元测试：纯函数层（值与地址编解码）、工具定义适配层、以及插件的注册形状。
 *
 * 这一层刻意**不依赖 node-cheat-engine 内核**：枚举用最小假体注入，这样即使内核缺失
 * 或换版本，这些用例依然能跑，并且失败点会精确指向纯逻辑而不是环境。
 * 真实的内核联通性由 `e2e.test.mjs` 覆盖。
 *
 * 运行：node --test test/unit.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	analyzeAobPattern,
	assessAobBreadth,
	decodeValue,
	describeAddress,
	describeProtection,
	describeRegionType,
	describeValueTruncation,
	encodeValue,
	formatBytesCount,
	findModule,
	formatAddress,
	isVariableLengthType,
	parseAobBytes,
	parseInteger,
	pointerPathToExpression,
	resolveRounding,
	resolveScanOption,
	resolveVariableType,
	stringifyLuaValue,
	toAddressExpression,
	variableTypeName,
	verifyBytesWritten,
	widthOfType
} from "../lib/values.js";
import { fallbackDefineTool, pickDeclared, validateSchemaValue, withDefaults } from "../lib/toolkit.js";
import {
	askToElevate,
	enrichPermissionError,
	isPermissionDenied,
	permissionDeniedAdvice
} from "../lib/elevation.js";
import { createHarness } from "./helpers/harness.mjs";

/** 最小的内核枚举假体（数值与 CE 源码一一对应）。 */
const ce = {
	VariableType: {
		Byte: 0, Word: 1, DWord: 2, QWord: 3, Single: 4, Double: 5, String: 6, UnicodeString: 7,
		ByteArray: 8, Binary: 9, All: 10, AutoAssembler: 11, Pointer: 12, Custom: 13, Grouped: 14,
		ByteArrays: 15, CodePageString: 16
	},
	ScanOption: {
		UnknownValue: 0, ExactValue: 1, ValueBetween: 2, BiggerThan: 3, SmallerThan: 4,
		IncreasedValue: 5, IncreasedValueBy: 6, DecreasedValue: 7, DecreasedValueBy: 8, Changed: 9,
		Unchanged: 10, IncreasedValueByPercentage: 11, DecreasedValueByPercentage: 12,
		ValueBetweenPercentage: 13
	},
	RoundingType: { Rounded: 0, ExtremeRounded: 1, Truncated: 2 },
	FastScanMethod: { NotAligned: 0, Aligned: 1, LastDigits: 2 },
	VARIABLE_TYPE_NAMES: {
		0: "byte", 1: "word", 2: "dword", 3: "qword", 4: "float", 5: "double", 6: "string",
		7: "unicode", 8: "aob", 9: "binary", 10: "all", 11: "autoassembler", 12: "pointer",
		13: "custom", 14: "grouped", 15: "aobs", 16: "codepagestring"
	}
};

/* ───────────────────────────── 数值解析 ───────────────────────────── */

test("parseInteger 支持十进制/十六进制/前缀/负数", () => {
	assert.equal(parseInteger("255"), 255n);
	assert.equal(parseInteger("0xFF"), 255n);
	assert.equal(parseInteger("$FF"), 255n);
	assert.equal(parseInteger("FF", { hexadecimal: true }), 255n);
	assert.equal(parseInteger("0d255"), 255n);
	assert.equal(parseInteger("0b1111"), 15n);
	assert.equal(parseInteger("-5"), -5n);
	assert.equal(parseInteger(42), 42n);
	assert.equal(parseInteger("0xffffffffffffffff"), 18446744073709551615n);
});

test("parseInteger 拒绝非法输入并给出可操作的提示", () => {
	assert.throws(() => parseInteger("zz"), /无法把/);
	assert.throws(() => parseInteger(""), /为空/);
	// 十进制的 "12a" 不合格，但按十六进制就合格 —— 错误信息要提到这一点
	assert.throws(() => parseInteger("12a"), /hexadecimal: true/);
});

/* ───────────────────────────── 地址规范化 ───────────────────────────── */

test("toAddressExpression：裸数字按十进制，0x/$/含 a-f 按十六进制", () => {
	assert.equal(toAddressExpression(4242), "0x1092");
	assert.equal(toAddressExpression("4242"), "0x1092");
	assert.equal(toAddressExpression("0x4242"), "0x4242");
	assert.equal(toAddressExpression("$4242"), "0x4242");
	assert.equal(toAddressExpression("4242", { hexadecimal: true }), "0x4242");
	assert.equal(toAddressExpression("DEAD"), "0xdead");
	assert.equal(toAddressExpression("0d1000"), "0x3e8");
	assert.equal(toAddressExpression(0n), "0x0");
});

test("toAddressExpression：模块偏移的裸数字按**十六进制**（实测踩过的真 bug）", () => {
	// 内核表达式引擎把**裸数字按十进制**解析（`9030` → 0x2346），
	// 但 CE 的用户习惯、以及内核自己的文档示例（`"game.exe"+1234`）
	// 都把模块偏移当**十六进制**。两者冲突会**静默读错地址**。
	//
	// 实测场景：`CheatTestWindow.exe+9030` 本该读 `+0x9030`（g_level = 7），
	// 却读到了 `+0x2346`。所以插件层在交给内核之前把偏移规范成 `0x…`。
	assert.equal(toAddressExpression("game.exe+1234"), "game.exe+0x1234");
	assert.equal(toAddressExpression('"game.exe"+1234'), '"game.exe"+0x1234');
	// 已带前缀不动；含 a-f 的本来就是十六进制，只补前缀（值不变）
	assert.equal(toAddressExpression("game.exe+0x1234"), "game.exe+0x1234");
	assert.equal(toAddressExpression("game.exe+1a3f"), "game.exe+0x1a3f");
	// 解引用链里的模块偏移同样要规范化
	assert.equal(toAddressExpression("[[game.exe+10]+8]"), "[[game.exe+0x10]+8]");
	// 纯数字（非模块偏移）仍按十进制 —— 与 CE 的扫描数值一致
	assert.equal(toAddressExpression("9030"), "0x2346");
	// ⚠️ 末尾的 `1C` 是"含 a-f 的裸十六进制字面量"，所以整条按 CE 的十六进制语义规范化：
	//    `8` → `0x8`、`1C` → `0x1c`。**值不变**（8 ≡ 0x8，而 `1C` 本来就含 `c`、
	//    内核词法器早就按十六进制读它）—— 只是**文本形态**变了。值层面的等价
	//    （规范化前后解析出**同一个地址**）由 `test/ct-address-semantics.test.mjs`
	//    走真实内核钉住；本文件刻意不依赖内核（见文件头），所以这里只钉文本形态。
	assert.equal(toAddressExpression("[[0x1000]+8]+1C"), "[[0x1000]+0x8]+0x1c");
});

test("toAddressExpression：`0x10+20` 与 `$10+20` 必须是**同一个地址**（0x24）", () => {
	// ⚠️ 这条以前是**静默不一致**：`normalizeModuleOffsets` 的 IDENT 能从数字字面量
	// **中间**开始匹配（`0x10` 里的 `x10`），于是
	//     `0x10+20` → `x10+0x20` → 0x10 + 0x20 = **0x30**
	//     `$10+20`  → 不变       → 0x10 + 20（十进制）= **0x24**
	// 同一件算术两种写法给出不同地址，而且都不报错。
	// 现在标识符不能紧跟在数字/`$` 后面（后行断言），两者一致 ——
	// 也与 `values.js` 里那条"前面不是标识符，20 仍是十进制"的注释一致了。
	const withPrefix = toAddressExpression("0x10+20");
	const withDollar = toAddressExpression("$10+20");
	assert.equal(withPrefix, "0x10+20", "字面量后面的算术不该被当成模块偏移");
	assert.equal(withDollar, "$10+20");
	// 值层面的一致性（两者都该是 0x24）由 `ct-address-semantics.test.mjs` 端到端钉住 ——
	// 本文件刻意不依赖真内核（见文件头），所以这里只断言文本形态。
	// `$ff+20` 里的 `ff` 不是标识符（`$` 是后行断言的阻挡字符之一），所以整条不动；
	// 而**裸** `ff+20` 是另一回事：CE 会把它当数字（见下面那条用例）。
	assert.equal(toAddressExpression("$ff+20"), "$ff+20");
	// 而**真正**紧跟模块名的偏移仍然要规范化（只规范紧跟模块名的那个）
	assert.equal(toAddressExpression("game.exe+10+20"), "game.exe+0x10+20");
});

test("toAddressExpression：裸十六进制字面量**在任意位置**都按 CE 的 val('$'+token) 语义", () => {
	// ## 查证（`ce-src/Cheat Engine/symbolhandler.pas`）
	//
	// `getAddressFromName` 在 `:5264-5268` 对**每个 token** 做
	//     `val('$'+tokens[i], v64, j); if j>0 then ... getmodulebyname(...)`
	// 也就是**先**当十六进制数、解析不了才查模块/符号（`:5271-5275`）。
	// 所以纯 `[0-9a-f]` 的 token 在 CE 眼里**就是数字**：
	//     `ff+20` = 0xff + 0x20 = **0x11f**
	// 而不是"未知的符号或模块 ff"。（审计给的说法是"先查模块/符号、再当数字"，
	// 查源码后恰好相反；这里按源码实现。）
	//
	// ⚠️ 这段判定是**逐 token** 的（`:5264` 的 `for i:=0 to length(tokens)-1`），
	// 与 token 排在第几个位置**无关**。早先的判据只看**第一个操作数**，于是
	// `add 1000+ff` 交给内核的是 `1000+ff`（内核报「未知的符号或模块 "ff"」），
	// 而 `load` 走内核 `normalizeCtAddress` 得 `0x1000+0xff` = 0x10ff ——
	// 同一段文本两条路给出不同结果。现在判据是位置无关的 `hasBareHexLiteral`。
	assert.equal(toAddressExpression("ff+20"), "0xff+0x20");
	assert.equal(toAddressExpression("ff + 20"), "0xff + 0x20");
	// 整条按 CE 语义 ⇒ 后续的裸数字也是十六进制（与 CE 一致）
	assert.equal(toAddressExpression("ff+20+30"), "0xff+0x20+0x30");
	assert.equal(toAddressExpression("[ff]+8"), "[0xff]+0x8");

	// ── 位置无关：同一个 token 出现在**中间**（0.1.9 的残留 bug） ──
	assert.equal(toAddressExpression("1000+ff"), "0x1000+0xff");
	assert.equal(toAddressExpression("10+ff"), "0x10+0xff");
	assert.equal(toAddressExpression("1000+ff+20"), "0x1000+0xff+0x20");
	assert.equal(toAddressExpression("(1000+ff)"), "(0x1000+0xff)");
	assert.equal(toAddressExpression("[1000+ff]"), "[0x1000+0xff]");
	// 模块名 + 偏移 + 裸字面量：模块名整体保留，末尾的 `ff` 当数字
	assert.equal(toAddressExpression("game.exe+10+ff"), "game.exe+0x10+0xff");

	// ⚠️ 模块名不能被切开：`ff.exe` 是**一个**标识符，不是"字面量 ff + .exe"
	assert.equal(toAddressExpression("ff.exe+10"), "ff.exe+0x10");
	assert.equal(toAddressExpression("dead.dll+10"), "dead.dll+0x10");
	assert.equal(toAddressExpression("ff+dead.dll"), "0xff+dead.dll", "第二个操作数里的模块名同样不能切开");
	// 模块名/符号名"本身像十六进制"、且**出现在中间**时同样不能被切开
	assert.equal(toAddressExpression("dead.dll+1a3f"), "dead.dll+0x1a3f", "`dead.dll` 整体是模块名");
	assert.equal(toAddressExpression("mySym+10+1a"), "mySym+0x10+0x1a", "`mySym` 整体是符号名");
	assert.equal(toAddressExpression("ff.exe+10+20"), "ff.exe+0x10+20");

	// 一个含 a-f 的裸字面量都没有 ⇒ **不受影响**（"裸数字＝十进制"的 add 约定不变）
	assert.equal(toAddressExpression("0x10+20"), "0x10+20");
	assert.equal(toAddressExpression("1000+1000"), "1000+1000");
	assert.equal(toAddressExpression("1000+20"), "1000+20");
	assert.equal(toAddressExpression("game.exe+10+20"), "game.exe+0x10+20");
	// 而**有**这种字面量时，整条（含本来按十进制读的裸数字）都按 CE 的十六进制语义 ——
	// 这是刻意取舍，也正是 add 与 load 能一致的前提
	assert.equal(toAddressExpression("[[0x1000]+8]+1C"), "[[0x1000]+0x8]+0x1c");
	assert.equal(toAddressExpression("1000+1c"), "0x1000+0x1c");
	// 引号里的模块名不参与（CE 的 tokenize 在引号内不切分）
	assert.equal(toAddressExpression('"ff"+20'), '"ff"+0x20');
});

test("toAddressExpression 拒绝空与负数地址", () => {
	assert.throws(() => toAddressExpression(""), /为空/);
	assert.throws(() => toAddressExpression(-1), /不能为负/);
});

test("pointerPathToExpression 复刻内核的 offsets 语义（base→target）", () => {
	assert.equal(
		pointerPathToExpression({ baseAddress: 0x1000n, offsets: [0x10, 0x20] }),
		"[[0x1000]+0x10]+0x20"
	);
	assert.equal(
		pointerPathToExpression({ baseAddress: 0x1000n, offsets: [0x10, -0x8] }),
		"[[0x1000]+0x10]-0x8"
	);
	assert.equal(pointerPathToExpression({ baseAddress: 0x1000n, offsets: [] }), "0x1000");
});

/* ───────────────────────────── 类型与选项 ───────────────────────────── */

test("resolveVariableType 认识友好名、CE 名与枚举名", () => {
	assert.equal(resolveVariableType(ce, "dword"), ce.VariableType.DWord);
	assert.equal(resolveVariableType(ce, "4 Bytes"), ce.VariableType.DWord);
	assert.equal(resolveVariableType(ce, "Float"), ce.VariableType.Single);
	assert.equal(resolveVariableType(ce, "aob"), ce.VariableType.ByteArray);
	assert.equal(resolveVariableType(ce, "wstring"), ce.VariableType.UnicodeString);
	assert.equal(resolveVariableType(ce, undefined), ce.VariableType.DWord);
	assert.throws(() => resolveVariableType(ce, "nope"), /不认识的变量类型/);
});

test("resolveScanOption / resolveRounding 认识别名", () => {
	assert.equal(resolveScanOption(ce, "exact"), ce.ScanOption.ExactValue);
	assert.equal(resolveScanOption(ce, "unchanged"), ce.ScanOption.Unchanged);
	assert.equal(resolveScanOption(ce, "increased_by"), ce.ScanOption.IncreasedValueBy);
	assert.equal(resolveScanOption(ce, ">"), ce.ScanOption.BiggerThan);
	assert.equal(resolveScanOption(ce, undefined), ce.ScanOption.ExactValue);
	assert.throws(() => resolveScanOption(ce, "nope"), /不认识的扫描方式/);
	assert.equal(resolveRounding(ce, "extreme"), ce.RoundingType.ExtremeRounded);
	assert.equal(resolveRounding(ce, undefined), ce.RoundingType.Rounded);
});

test("别名查找对下划线/空格/连字符/大小写都成立", () => {
	// 工具描述里宣传的是下划线写法，别名表必须真的认
	assert.equal(resolveScanOption(ce, "increased_by_percent"), ce.ScanOption.IncreasedValueByPercentage);
	assert.equal(resolveScanOption(ce, "decreased by percent"), ce.ScanOption.DecreasedValueByPercentage);
	assert.equal(resolveScanOption(ce, "Between-Percent"), ce.ScanOption.ValueBetweenPercentage);
	assert.equal(resolveScanOption(ce, "UNKNOWN_VALUE"), ce.ScanOption.UnknownValue);
	assert.equal(resolveScanOption(ce, "value_between"), ce.ScanOption.ValueBetween);
	assert.equal(resolveScanOption(ce, "bigger_than"), ce.ScanOption.BiggerThan);
	assert.equal(resolveRounding(ce, "extreme_rounded"), ce.RoundingType.ExtremeRounded);
	assert.equal(resolveVariableType(ce, "unicode_string"), ce.VariableType.UnicodeString);
	assert.equal(resolveVariableType(ce, "byte_array"), ce.VariableType.ByteArray);
	assert.equal(resolveVariableType(ce, "auto assembler script"), ce.VariableType.AutoAssembler);
	assert.equal(resolveVariableType(ce, "4 BYTES"), ce.VariableType.DWord);
});

test("widthOfType 给出定长宽度，变长类型需要显式 size", () => {
	assert.equal(widthOfType(ce, ce.VariableType.DWord), 4);
	assert.equal(widthOfType(ce, ce.VariableType.QWord), 8);
	assert.equal(widthOfType(ce, ce.VariableType.Pointer, { pointerSize: 4 }), 4);
	assert.equal(widthOfType(ce, ce.VariableType.String, { size: 32 }), 32);
	assert.ok(isVariableLengthType(ce, ce.VariableType.String));
	assert.ok(!isVariableLengthType(ce, ce.VariableType.DWord));
});

/* ───────────────────────────── 值编解码 ───────────────────────────── */

test("整数类型编解码往返一致（含 64 位边界）", () => {
	const cases = [
		[ce.VariableType.Byte, "200"],
		[ce.VariableType.Word, "65535"],
		[ce.VariableType.DWord, "4294967295"],
		[ce.VariableType.QWord, "18446744073709551615"]
	];
	for (const [type, text] of cases) {
		const buffer = encodeValue(ce, type, text);
		assert.equal(decodeValue(ce, buffer, type), text, `类型 ${variableTypeName(ce, type)}`);
	}
});

test("有符号与十六进制展示", () => {
	const buffer = Buffer.alloc(4);
	buffer.writeInt32LE(-1234, 0);
	assert.equal(decodeValue(ce, buffer, ce.VariableType.DWord, { signed: true }), "-1234");
	assert.equal(decodeValue(ce, buffer, ce.VariableType.DWord, { hexadecimal: true }), "0xfffffb2e");
});

test("浮点编解码往返", () => {
	const single = encodeValue(ce, ce.VariableType.Single, "3.5");
	assert.equal(decodeValue(ce, single, ce.VariableType.Single), "3.5");
	const double = encodeValue(ce, ce.VariableType.Double, "1234.5678");
	assert.equal(decodeValue(ce, double, ce.VariableType.Double), "1234.5678");
});

test("字符串编解码：UTF-8 与 UTF-16 都带 NUL 终止", () => {
	const utf8 = encodeValue(ce, ce.VariableType.String, "HELLO");
	assert.equal(utf8.length, 6);
	assert.equal(decodeValue(ce, utf8, ce.VariableType.String), "HELLO");

	const wide = encodeValue(ce, ce.VariableType.UnicodeString, "测试");
	assert.equal(wide.length, 6); // 2 个字符 * 2 字节 + 2 字节 NUL
	assert.equal(decodeValue(ce, wide, ce.VariableType.UnicodeString), "测试");
});

test("AOB 编解码：写入必须是纯字节，通配符要报错", () => {
	const bytes = parseAobBytes("DE AD BE EF");
	assert.deepEqual([...bytes], [0xde, 0xad, 0xbe, 0xef]);
	assert.deepEqual([...parseAobBytes("deadbeef")], [0xde, 0xad, 0xbe, 0xef]);
	assert.throws(() => parseAobBytes("DE ?? BE"), /通配符/);
	assert.throws(() => parseAobBytes("DEA"), /奇数/);
	assert.throws(() => parseAobBytes("ZZ"), /非法字符/);
	assert.throws(() => parseAobBytes(""), /为空/);
	assert.equal(decodeValue(ce, Buffer.from([0xde, 0xad]), ce.VariableType.ByteArray), "DE AD");
});

test("analyzeAobPattern 复刻内核的切分语义（含「落单字符当通配」这条）", () => {
	// 与内核 `value-codec.ts` 的 parseAob 必须逐条一致，否则"分析说很具体、
	// 内核却按全通配扫"就白算了。
	const plain = analyzeAobPattern("DE AD BE EF");
	assert.deepEqual(
		{ total: plain.total, fixed: plain.fixed, partial: plain.partial, wild: plain.wild },
		{ total: 4, fixed: 4, partial: 0, wild: 0 }
	);

	// `??` 与 `7*` / `*7` 是三种不同的东西：完全通配 / 高半字节通配 / 低半字节通配
	const mixed = analyzeAobPattern("DE ?? 7* *3");
	assert.equal(mixed.total, 4);
	assert.equal(mixed.fixed, 1, "只有 DE 是完全固定的");
	assert.equal(mixed.partial, 2, "7* 与 *3 是半字节约束");
	assert.equal(mixed.wild, 1, "?? 是完全通配");
	assert.equal(mixed.anchored, 3);

	// ⚠️ 关键：落单的字符会被内核当成**通配符**（不是 0x0B！）
	const odd = analyzeAobPattern("DE AD B");
	assert.equal(odd.total, 3);
	assert.equal(odd.fixed, 2);
	assert.equal(odd.wild, 1, "落单的 B 在内核里就是通配符");
	assert.deepEqual(odd.oddTokens, ["B"], "必须把落单片段报出来，便于提示用户");

	// 连写（无分隔符）与其它分隔符
	assert.equal(analyzeAobPattern("9090??").total, 3);
	assert.equal(analyzeAobPattern("DE,AD-BE").total, 3);
	assert.equal(analyzeAobPattern("").total, 0);
});

test("assessAobBreadth 只拦「宽泛」模式，单个 ?? 完全合法", () => {
	const broad = (text) => assessAobBreadth(analyzeAobPattern(text)).broad;

	// 必须拦：实测 `?? ?? ??` 命中 6222 万个、宿主 heap +2956 MiB
	assert.equal(broad("?? ?? ??"), true);
	assert.equal(broad("??"), true);
	assert.equal(broad("7*"), true, "半字节通配同样过宽");
	// 必须拦「短到没有约束力」的：密度 1/256，4GB 上约 1600 万条
	assert.equal(broad("90"), true);
	assert.equal(broad("?? 90"), true);
	// 只剩 1 个固定字节时，通配占比 87.5% 且密度 1/256 —— 必须拦
	assert.equal(broad("90 ?? ?? ?? ?? ?? ?? ??"), true);
	// ⚠️ 但 2 个固定字节就是另一回事：密度 1/65536（4GB 上约 6.5 万条），
	// 与 `90 90` 同量级，属可用范围，**刻意放行**。
	// 这条断言是为了把这个边界钉死：不要把"通配多"直接等同于"要拦"。
	assert.equal(
		broad("90 90 ?? ?? ?? ?? ?? ??"),
		false,
		"2 个固定字节已把密度压到 1/65536，与 90 90 同量级，应当放行"
	);

	// 必须放行：真实特征码几乎都带通配
	assert.equal(broad("DE AD BE EF ?? 90"), false);
	assert.equal(broad("DE AD ?? ?? 90 90"), false);
	assert.equal(broad("E8 ?? ?? ?? ?? 8B"), false);
	assert.equal(broad("90 90"), false, "1/65536 刚好在可用量级（4GB 上约 6.5 万条）");
	assert.equal(broad("DE AD B"), false, "奇数片段本身不构成宽泛（另有提示）");
});

test("describeValueTruncation 只在真的超范围时提示，且不误报 -1 这类正常写法", () => {
	const V = ce.VariableType;
	// 实测过的三种静默截断
	assert.equal(describeValueTruncation(ce, V.Byte, "999").effectiveHex, "0xE7");
	assert.equal(describeValueTruncation(ce, V.Byte, "256").effectiveHex, "0x00");
	assert.equal(describeValueTruncation(ce, V.DWord, "99999999999999999999").bits, 32);

	// 范围内不得提示
	assert.equal(describeValueTruncation(ce, V.Byte, "255"), null);
	assert.equal(describeValueTruncation(ce, V.Byte, "0"), null);
	assert.equal(describeValueTruncation(ce, V.Byte, "-1"), null, "-1 写 byte 是 0xFF 的标准写法，不能误报");
	assert.equal(describeValueTruncation(ce, V.Byte, "-128"), null);
	assert.equal(describeValueTruncation(ce, V.DWord, "4294967295"), null);
	assert.equal(describeValueTruncation(ce, V.QWord, "18446744073709551615"), null, "qword 上界");
	assert.equal(describeValueTruncation(ce, V.QWord, "-1"), null);

	// 越界的两侧都要抓
	assert.equal(describeValueTruncation(ce, V.Byte, "-129").effectiveHex, "0x7F");
	assert.equal(describeValueTruncation(ce, V.Word, "65536").effectiveHex, "0x0000");

	// 指针宽度跟随 pointerSize
	assert.equal(describeValueTruncation(ce, V.Pointer, "4294967296", { pointerSize: 4 }).bits, 32);
	assert.equal(describeValueTruncation(ce, V.Pointer, "4294967296", { pointerSize: 8 }), null);

	// 变长/浮点不做整数范围判断（float 溢出到 Infinity 另有提示）
	assert.equal(describeValueTruncation(ce, V.ByteArray, "DE AD"), null);
	assert.equal(describeValueTruncation(ce, V.Single, "1"), null);
	assert.equal(describeValueTruncation(ce, V.Single, "1e300").bits, 32, "float 溢出成 Infinity 要提示");
	assert.equal(describeValueTruncation(ce, V.Double, "1e300"), null, "double 装得下 1e300");

	// 解析不了的输入不归它管（交给 encodeValue 抛自己的错）
	assert.equal(describeValueTruncation(ce, V.Byte, "ZZ"), null);
});

test("verifyBytesWritten 只在回读与写入完全一致时才判成功", () => {
	const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
	assert.equal(verifyBytesWritten(payload, Buffer.from([0x01, 0x02, 0x03, 0x04])), true);
	assert.equal(verifyBytesWritten(payload, Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff])), true, "多出的尾字节不影响判定");
	assert.equal(verifyBytesWritten(payload, Buffer.from([0x01, 0x02, 0x03, 0x05])), false, "被目标改回去了必须判失败");
	assert.equal(verifyBytesWritten(payload, Buffer.from([0x01, 0x02])), false, "回读短于写入必须判失败");
	assert.equal(verifyBytesWritten(payload, Buffer.alloc(0)), false);
	assert.equal(verifyBytesWritten(payload, null), false);
	assert.equal(verifyBytesWritten(Buffer.alloc(0), Buffer.alloc(0)), false, "空 payload 不算写入成功");
});

/* ───────────────────────────── 展示辅助 ───────────────────────────── */

test("地址/保护/区域类型的展示形式", () => {
	assert.equal(formatAddress(0x7ff6aabbccddn), "0x7ff6aabbccdd");
	assert.equal(describeProtection(0x04), "RW");
	assert.equal(describeProtection(0x20), "RX");
	assert.equal(describeProtection(0x140), "RWX|GUARD");
	assert.equal(describeRegionType(0x1000000), "IMAGE");
	assert.equal(describeRegionType(0x20000), "PRIVATE");
	assert.equal(formatBytesCount(2048n), "2.0 KiB");
	assert.equal(formatBytesCount(512n), "512 B");
});

test("describeAddress 命中模块时给「模块+偏移」，否则给绝对地址", () => {
	const modules = [{ name: "game.exe", baseAddress: 0x1000n, size: 0x1000 }];
	assert.equal(describeAddress(0x1010n, modules), "game.exe+0x10");
	assert.equal(describeAddress(0x9000n, modules), "0x9000");
});

test("findModule 不区分大小写，且可省略扩展名", () => {
	const modules = [{ name: "Game.EXE", baseAddress: 0x1000n, size: 1 }];
	assert.ok(findModule(modules, "game") !== null);
	assert.ok(findModule(modules, "game.exe") !== null);
	assert.ok(findModule(modules, "GAME.EXE") !== null);
	assert.equal(findModule(modules, "other"), null);
});

test("stringifyLuaValue 能安全处理 bigint / Buffer / Map / 嵌套数组", () => {
	assert.equal(stringifyLuaValue(9007199254740993n), "9007199254740993");
	assert.equal(stringifyLuaValue(null), "nil");
	assert.equal(stringifyLuaValue(true), "true");
	assert.equal(stringifyLuaValue([1n, "a"]), "{1, a}");
	assert.equal(stringifyLuaValue(new Map([["k", 1n]])), "{k = 1}");
	assert.equal(stringifyLuaValue(Buffer.from([0xab, 0x01])), "AB 01");
	assert.equal(stringifyLuaValue({ a: { b: 2n } }), "{a = {b = 2}}");
});

/* ───────────────────────────── toolkit ───────────────────────────── */

test("defineTool 把 required 提到父级，并编译嵌套 items/properties", () => {
	const tool = fallbackDefineTool({
		name: "t",
		description: "d",
		parameters: {
			a: { type: "string", required: true },
			b: { type: "integer" },
			list: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: { x: { type: "string", required: true } }
				}
			}
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } }, render: () => [{ type: "text", text: "x" }] },
		execute: () => ({ ok: true })
	});
	assert.equal(tool.parameters.type, "object");
	assert.deepEqual(tool.parameters.required, ["a"]);
	assert.equal(tool.parameters.properties.b.type, "integer");
	assert.equal(tool.parameters.properties.list.items.properties.x.type, "string");
	assert.deepEqual(tool.parameters.properties.list.items.required, ["x"]);
	assert.equal(typeof tool.output.render, "function");
	assert.equal(typeof tool.execute, "function");
});

test("defineTool 拒绝非法 DSL", () => {
	const base = {
		name: "t", description: "d",
		output: { schema: { type: "object", additionalProperties: true }, render: () => [] },
		execute: () => ({})
	};
	assert.throws(() => fallbackDefineTool({ ...base, parameters: { a: { type: "bogus" } } }), /不支持的 type/);
	assert.throws(() => fallbackDefineTool({ ...base, parameters: { a: { type: "string", weird: 1 } } }), /未知字段/);
	assert.throws(() => fallbackDefineTool({ ...base, parameters: { a: null } }), /对象形式/);
	assert.throws(() => fallbackDefineTool({ ...base, timeoutMs: -1 }), /正的有限数/);
});

test("validateSchemaValue 复现注册表的严格规则", () => {
	const schema = {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: { type: "boolean" },
			name: { type: "string" },
			count: { type: "integer" }
		},
		required: ["ok"]
	};
	assert.deepEqual(validateSchemaValue(schema, { ok: true, name: "x", count: 3 }), []);
	assert.match(validateSchemaValue(schema, { name: "x" })[0], /ok 是必填项/);
	assert.match(validateSchemaValue(schema, { ok: true, extra: 1 })[0], /不是可接受的参数/);
	assert.match(validateSchemaValue(schema, { ok: true, name: null })[0], /应为 string，实际是 null/);
	assert.match(validateSchemaValue(schema, { ok: true, count: 1.5 })[0], /应为 integer/);
	assert.match(validateSchemaValue(schema, { ok: "yes" })[0], /应为 boolean，实际是 string/);
});

test("pickDeclared 丢掉未声明键与 null/undefined", () => {
	assert.deepEqual(pickDeclared({ a: 1, b: null, c: undefined, d: 2 }, ["a", "b", "c"]), { a: 1 });
	assert.deepEqual(pickDeclared(null, ["a"]), {});
});

test("withDefaults 只在键存在且非空时覆盖", () => {
	assert.deepEqual(withDefaults({ a: 1, b: null, c: undefined }, { a: 9, b: 9, c: 9, d: 9 }), { a: 1, b: 9, c: 9, d: 9 });
	assert.deepEqual(withDefaults(undefined, { a: 1 }), { a: 1 });
});

/* ───────────────────────── 提权判定与同意闸门 ───────────────────────── */

test("isPermissionDenied 只把真正的权限失败认成权限问题", () => {
	assert.equal(isPermissionDenied(new Error("打开进程 4 失败：拒绝访问 (Win32 错误 5)")), true);
	assert.equal(isPermissionDenied(new Error("Access is denied.")), true);
	assert.equal(isPermissionDenied(new Error("EPERM: operation not permitted")), true);
	assert.equal(isPermissionDenied(new Error("0x80070005")), true);
	// 关键：不能把无关失败误判成权限问题，否则会给出完全错误的排查方向
	assert.equal(isPermissionDenied(new Error('没有找到名字含 "nope" 的进程')), false);
	assert.equal(isPermissionDenied(new Error("Win32 错误 998：对内存位置的访问无效")), false);
	assert.equal(isPermissionDenied(new Error("Win32 错误 50")), false);
	assert.equal(isPermissionDenied(new Error("地址解析失败")), false);
	assert.equal(isPermissionDenied(null), false);
});

test("permissionDeniedAdvice 给出可执行的两条主路径", () => {
	const notElevated = permissionDeniedAdvice({ elevated: false, target: { pid: 4, name: "System" } }).join("\n");
	assert.match(notElevated, /权限不足/);
	assert.match(notElevated, /System（pid 4）/);
	assert.match(notElevated, /以管理员身份重启 DSH/);
	assert.match(notElevated, /native-ce/);

	// 已提权却仍被拒 → 方向完全不同（受保护进程），不能再说"去提权"
	const elevated = permissionDeniedAdvice({ elevated: true }).join("\n");
	assert.match(elevated, /PPL|反作弊/);
	assert.ok(!elevated.includes("以管理员身份重启 DSH"));
});

test("enrichPermissionError 只增强权限错误，其余原样返回", () => {
	const denied = enrichPermissionError(new Error("拒绝访问 (Win32 错误 5)"), { target: { pid: 1 }, action: "ce_read" });
	assert.match(denied.message, /\[ce_read\]/);
	assert.equal(denied.permissionDenied, true);

	const other = new Error("地址解析失败");
	assert.equal(enrichPermissionError(other, {}), other, "非权限错误必须原样返回，不能被包装成权限问题");
});

test("askToElevate 在拿不到 agent / 没有服务时一律拒绝提权", async () => {
	const noAgent = await askToElevate({ ask: async () => ({}) }, {}, { target: { pid: 4 } });
	assert.equal(noAgent.approved, false);
	assert.match(noAgent.reason, /无法向你确认|不做任何提权/);

	const noService = await askToElevate(undefined, { agent: {} }, { target: { pid: 4 } });
	assert.equal(noService.approved, false);
	assert.match(noService.reason, /没有 user-questions|不做任何提权/);
});

test("askToElevate 只认**明确同意**；「只告诉我做法」绝不能被当成同意", async () => {
	// ⚠️ 这条测试曾经把**缺陷**当成预期：断言选「告诉我如何提权」→ approved=true。
	// 那个选项的说明明写"我只给出做法，不自动执行"，被判成同意意味着
	// **同意闸门被绕过** —— 用户只要讲解，却真的去弹 UAC 提权（安全事故级）。
	// 根因是 approved 由**选项文案**推导；现已改为按**选项 id** 判定，
	// 选项集也与权威实现（dsh-get-admin）共用同一份。

	const decline = await askToElevate(
		{ ask: async () => ({ answers: [{ selected: ["decline"] }] }) },
		{ agent: {} },
		{ target: { pid: 4 } }
	);
	assert.equal(decline.approved, false);
	assert.match(decline.reason, /未获同意/);

	const approve = await askToElevate(
		{ ask: async () => ({ answers: [{ selected: ["approve"] }] }) },
		{ agent: {} },
		{ target: { pid: 4 } }
	);
	assert.equal(approve.approved, true);
	assert.match(approve.reason, /已获同意/);

	// 关键回归：这类"只要讲解、不动手"的文案一律不得批准
	for (const text of ["告诉我如何提权", "只告诉我做法", "先别动", ""]) {
		const r = await askToElevate(
			{ ask: async () => ({ answers: [{ selected: [text] }] }) },
			{ agent: {} },
			{ target: { pid: 4 } }
		);
		assert.equal(r.approved, false, `「${text || "(空)"}」不应被当成同意`);
	}

	// 没作答时同样不得默认批准
	const silent = await askToElevate({ ask: async () => ({}) }, { agent: {} }, { target: { pid: 4 } });
	assert.equal(silent.approved, false, "没作答时必须按未获同意处理");
});

/* ───────────────────────────── 注册形状 ───────────────────────────── */

const EXPECTED_TOOLS = [
	"ce_processes", "ce_attach", "ce_session", "ce_modules", "ce_regions",
	"ce_read", "ce_write", "ce_scan", "ce_pointer_scan",
	"ce_disassemble", "ce_assemble", "ce_auto_assemble", "ce_lua", "ce_cheat_table",
	"ce_kernel",
	// 提权入口的**兜底**：get-admin 未启用时，模型侧也必须有可调用的提权工具
	// （`get_admin` 来自 get-admin 的 apply，未启用就不存在）。
	"ce_elevation"
];

test("插件注册全部 16 个工具，且每个定义都满足注册表的硬要求", () => {
	const harness = createHarness();
	assert.deepEqual([...harness.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());

	for (const [name, definition] of harness.tools) {
		assert.equal(definition.name, name);
		assert.ok(typeof definition.description === "string" && definition.description.length > 20, `${name} 的 description 太短`);
		// 参数必须是对象根 JSON Schema
		assert.equal(definition.parameters.type, "object", `${name}.parameters 必须是 object 根`);
		assert.ok(definition.parameters.properties !== undefined, `${name}.parameters 缺少 properties`);
		// 输出必须是 { schema, render }
		assert.equal(typeof definition.output.render, "function", `${name}.output.render 必须是函数`);
		assert.equal(definition.output.schema.type, "object", `${name}.output.schema 必须是 object`);
		assert.equal(definition.output.schema.additionalProperties, false, `${name} 的输出应为封闭对象`);
		assert.deepEqual(
			[...(definition.output.schema.required ?? [])].sort(),
			["summary"],
			`${name} 的 summary 必须是必填`
		);
		for (const key of Object.keys(definition.output.schema.properties)) {
			assert.ok(["summary", "lines", "data"].includes(key), `${name} 的返回值声明了意外的键 ${key}`);
		}
		// 官方约定：失败靠**抛错**表达（isError），返回值里不该再有 ok 这种标志位
		assert.ok(
			!Object.hasOwn(definition.output.schema.properties, "ok"),
			`${name} 的返回值不应含 ok 字段（失败必须抛错，见 lib/tools/shared.js 顶部约定）`
		);
		// 不做 UI 卡片投影：内置 Web Client 不消费，且自造形状没有意义
		assert.equal(definition.output.presentationMeta, undefined, `${name} 不应声明 presentationMeta`);
		assert.equal(definition.presentCall, undefined, `${name} 不应声明 presentCall`);
		assert.equal(definition.presentResult, undefined, `${name} 不应声明 presentResult`);
		// 全部工具都会改共享的目标进程/扫描状态，必须串行
		assert.equal(definition.isConcurrencySafe({}), false, `${name} 应声明为非并发安全`);
	}
});

test("调用方已取消时工具拒绝开工（遵守 exec.signal）", async () => {
	const harness = createHarness();
	const tool = harness.tools.get("ce_processes");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => tool.execute({ filter: "node" }, { signal: controller.signal }),
		/取消/
	);
});

test("工具名不与 DSH 保留名冲突（run_code）", () => {
	const harness = createHarness();
	assert.ok(!harness.tools.has("run_code"));
	for (const name of harness.tools.keys()) {
		assert.ok(name.startsWith("ce_"), `${name} 缺少 ce_ 前缀`);
		assert.match(name, /^[a-z0-9_]+$/, `${name} 含非法字符`);
	}
});

test("未经参数校验的非法参数会被 defineTool 拦下（不进入 run）", async () => {
	const harness = createHarness();
	const scan = harness.tools.get("ce_scan");
	// action 是必填 + enum：缺了它应当在 execute 里被拦下
	await assert.rejects(() => scan.execute({}, {}), /参数不合法/);
	await assert.rejects(() => scan.execute({ action: "bogus" }, {}), /参数不合法/);
});

test("插件激活时记录了后端与开关状态，且提供清理入口", async () => {
	const harness = createHarness({ backend: "self", allowWrite: false, allowLua: false });
	assert.ok(harness.logs.some((line) => line.includes("cheat-engine 已激活")));
	assert.ok(harness.logs.some((line) => line.includes("写入 关闭")));
	assert.ok(harness.logs.some((line) => line.includes("Lua 关闭")));
	await harness.dispose(); // 不抛错即通过
});

test("没有 webServer 时安静跳过状态路由（headless profile 也能加载）", async () => {
	const headless = createHarness();
	assert.ok(headless.logs.some((line) => line.includes("已激活")), "缺少 webServer 不该影响插件激活");
	await headless.dispose();
});

test("有 webServer 时注册只读状态路由，回包自报家门且不触发内核加载", async () => {
	const registered = [];
	const harness = createHarness({}, {
		webServer: {
			register(route) {
				registered.push(route);
				return () => {};
			}
		}
	});
	// 该 harness **没有** getAdmin 服务 → 本插件应当**接管**提权界面，
	// 因此除只读状态路由外，还会注册提权控制与图标两条路由。
	// 这是刻意的行为：get-admin 未启用时（新装插件默认就是关的），
	// 若只有机制、没有界面与工具，就会出现「能静默提权但看不见也收不回」。
	assert.equal(registered.length, 3, "get-admin 未启用时应接管提权界面（状态 + 提权控制 + 图标）");
	const route = registered.find((r) => r.path === "/cheat-engine/status");
	assert.ok(route !== undefined, "应当有状态路由");
	assert.equal(route.kind, "prefix");

	let body = "";
	const response = {
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(text) {
			body = text;
		}
	};
	await route.handler({ url: "/cheat-engine/status" }, response);
	assert.equal(response.status, 200);
	assert.match(response.headers["content-type"], /application\/json/);

	const payload = JSON.parse(body);
	// 自报的包名 —— 发布名是 `dsh-ce-tools`（npm 封禁了 "cheat-engine" 这个词）
	assert.equal(payload.plugin, "dsh-ce-tools");
	assert.equal(payload.active, true);
	assert.equal(payload.toolCount, EXPECTED_TOOLS.length);
	assert.deepEqual([...payload.tools].sort(), [...EXPECTED_TOOLS].sort());
	assert.equal(payload.config.backend, "self");
	assert.equal(payload.config.allowWrite, true);
	assert.equal(payload.config.allowLua, true);
	// 状态查询必须轻量：它不该把 koffi / WASM 拖起来
	assert.equal(payload.kernel.loaded, false, "状态路由不应触发内核加载");
	assert.deepEqual(payload.sessions, []);
	// ⚠️ 这里**刻意不再暴露提权状态**。
	// 提权已归属独立插件 dsh-get-admin，其 `/get-admin/status` 才是权威来源
	// （它同时看进程内助手与跨进程发现记录）。本插件早先也报一份，
	// 但那套路由的唯一消费者是已被清空的 lib/client.js —— 属死代码，
	// 且两份 release 的语义已经分叉（本插件那条对"跨进程发现"的助手什么也不做）。
	assert.equal(payload.elevation, undefined, "不应再暴露提权快照（权威来源是 /get-admin/status）");
	await harness.dispose();
});

test("提权界面**按需接管**：get-admin 已启用时不注册提权路由，未启用时才接管", async () => {
	// 背景：插件管理器里"已安装"与"已启用"是两件事，**新装插件默认是关的**。
	// 而提权机制走的是**模块解析**（与启用无关），界面却来自 get-admin 的插件加载 ——
	// 于是开关关着时会出现「能静默提权，但看不见也收不回」。
	// 所以本插件在 get-admin 未启用时**自动接管**界面（含工具 ce_elevation）。
	//
	// 反过来说：get-admin 已启用时，本插件**绝不能**再注册一份，
	// 否则界面上会出现两个浮层、+ 菜单里两条同名项 —— 这个坑真踩过。

	/** 造一个 register 收集器。 */
	const collector = () => {
		const registered = [];
		return {
			registered,
			service: {
				webServer: {
					register(route) {
						registered.push(route);
						return () => {};
					}
				}
			}
		};
	};

	// ① get-admin 已启用 → 只注册只读状态路由（提权界面归它）
	{
		const { registered, service } = collector();
		const harness = createHarness({}, {
			...service,
			// harness 的 inject 复刻 cordis 语义：只有依赖存在时才触发回调，
			// 所以把 getAdmin 放进 ctx 就等于"服务已注册"。
			getAdmin: { status: () => ({}), release: () => ({}), getRemoteBackend: async () => ({}) }
		});
		const paths = registered.map((r) => r.path).sort();
		assert.deepEqual(
			paths,
			["/cheat-engine/status"],
			`get-admin 已启用时不应注册提权路由，实际：${paths.join(", ")}`
		);
		await harness.dispose();
	}

	// ② get-admin 未启用 → 接管：额外注册提权控制与图标路由
	{
		const { registered, service } = collector();
		const harness = createHarness({}, service);
		const paths = registered.map((r) => r.path).sort();
		assert.deepEqual(
			paths,
			["/cheat-engine/elevation", "/cheat-engine/icon", "/cheat-engine/status"],
			`get-admin 未启用时应当接管提权界面，实际：${paths.join(", ")}`
		);
		// 前缀路由**不能带结尾斜杠**：webServer 的匹配是
		// `pathname === prefix || pathname.startsWith(prefix + "/")`，
		// 前缀自带斜杠时子路径恒不匹配（早先因此图标全是破图）。
		for (const route of registered) {
			assert.ok(!String(route.path).endsWith("/"), `前缀路由不能以斜杠结尾：${route.path}`);
			assert.equal(typeof route.handler, "function", `${route.path} 应当有 handler`);
		}
		await harness.dispose();
	}
});
