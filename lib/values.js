/**
 * 值编解码、地址解析与展示格式化。
 *
 * 这一层刻意不依赖内核的 `value-codec` 内部导出（那些 `readInt32` 之类没有从包入口
 * 再导出），只用 Node 的 Buffer 原语实现，行为完全可控、可单测。
 *
 * 三个必须说清楚的约定：
 *
 * 1. **地址**：`0x…` / `$…` 前缀按十六进制；纯十进制数字按**十进制**；
 *    含有 a-f 的裸串按 CE 习惯当十六进制；其余（含 `+`、`[]`、模块名、引号）
 *    一律当作 CE 地址表达式交给内核求值。所有工具输出的地址都是 `0x…`，
 *    因此「输出 → 再输入」永远无损往返。
 * 2. **数值**：默认十进制，`hexadecimal: true` 时按十六进制；`0x` 前缀在任何
 *    情况下都生效。这一点与 CE 的扫描数值框一致（CE 的**地址框**才是默认十六进制）。
 * 3. **`[...]` 是解引用**：按 CE 语义读指针（指针宽度 = 8 字节，WOW64 目标为 4）。
 *
 * @module dsh-cheat-engine/values
 */

/* ────────────────────────────── 类型名映射 ────────────────────────────── */

/** 友好类型名 / CE 表里的类型名 → 内核的 VariableType 名字。 */
const VARIABLE_TYPE_ALIASES = new Map(Object.entries({
	byte: "Byte", uint8: "Byte", int8: "Byte", "1byte": "Byte", "1 byte": "Byte",
	word: "Word", uint16: "Word", int16: "Word", short: "Word", "2bytes": "Word", "2 bytes": "Word",
	dword: "DWord", uint32: "DWord", int32: "DWord", int: "DWord", integer: "DWord",
	"4bytes": "DWord", "4 bytes": "DWord", long: "DWord",
	qword: "QWord", uint64: "QWord", int64: "QWord", "8bytes": "QWord", "8 bytes": "QWord",
	int64_t: "QWord", longlong: "QWord",
	single: "Single", float: "Single", float32: "Single",
	double: "Double", float64: "Double",
	string: "String", ascii: "String", utf8: "String", "codepage string": "CodePageString",
	unicode: "UnicodeString", unicode_string: "UnicodeString", wstring: "UnicodeString",
	utf16: "UnicodeString", "unicode string": "UnicodeString",
	aob: "ByteArray", bytes: "ByteArray", bytearray: "ByteArray", "array of byte": "ByteArray",
	"arrayofbyte": "ByteArray", byte_array: "ByteArray", aobs: "ByteArrays", bytearrays: "ByteArrays",
	binary: "Binary", bit: "Binary", bitfield: "Binary",
	all: "All", pointer: "Pointer", ptr: "Pointer",
	autoassembler: "AutoAssembler", "auto assembler script": "AutoAssembler",
	custom: "Custom", grouped: "Grouped"
}));

/** 归一化查找索引（见 buildLookupIndex）。 */
const VARIABLE_TYPE_INDEX = buildLookupIndex(VARIABLE_TYPE_ALIASES);

/**
 * 为别名表建一个「归一化索引」：除了原键，再登记去掉空格/下划线/连字符后的形式。
 *
 * 这样 `increased_by`、`increased by`、`InCreased-By` 都能命中同一个条目，
 * 不用为每种写法各写一遍别名（第一版就是漏了 `increased_by` 而被单测抓住）。
 */
function buildLookupIndex(aliases) {
	const index = new Map();
	for (const [key, canonical] of aliases) {
		index.set(key, canonical);
		index.set(key.replace(/[\s_-]/g, ""), canonical);
	}
	return index;
}

/**
 * 查别名：**查询键与索引键都要归一化**，否则 `increased_by` 查不到 `increasedby`。
 * （第一版只归一化了索引键，于是 `increased_by` 依然落空 —— 单测第二次抓住的正是这点。）
 */
function lookupAlias(index, name) {
	const key = String(name).trim().toLowerCase();
	return index.get(key) ?? index.get(key.replace(/[\s_-]/g, ""));
}

/**
 * 把类型名解析成内核的 `VariableType` 枚举值。
 *
 * @param {object} ce 内核模块
 * @param {string} name 用户/模型给的类型名
 * @returns {number} VariableType 枚举值
 */
export function resolveVariableType(ce, name) {
	if (name === undefined || name === null || name === "") return ce.VariableType.DWord;
	if (typeof name === "number") return name;
	const key = String(name).trim().toLowerCase();
	const canonical = lookupAlias(VARIABLE_TYPE_INDEX, key);
	if (canonical !== undefined) return ce.VariableType[canonical];
	// 也接受枚举的精确名字（如 "DWord"）
	if (Object.hasOwn(ce.VariableType, String(name))) return ce.VariableType[String(name)];
	throw new Error(
		`不认识的变量类型 "${name}"。可用：byte/word/dword/qword/float/double/string/unicode/aob/binary/all/pointer`
	);
}

/** 枚举值 → 面向模型的短类型名。 */
export function variableTypeName(ce, type) {
	const name = ce.VARIABLE_TYPE_NAMES[type];
	return typeof name === "string" ? name : String(type);
}

/** 类型是否变长（需要显式长度，宽度不固定）。 */
export function isVariableLengthType(ce, type) {
	return (
		type === ce.VariableType.String ||
		type === ce.VariableType.UnicodeString ||
		type === ce.VariableType.CodePageString ||
		type === ce.VariableType.ByteArray ||
		type === ce.VariableType.ByteArrays ||
		type === ce.VariableType.Binary
	);
}

/* ────────────────────────────── 扫描选项 ────────────────────────────── */

/** 扫描选项名 → 内核 ScanOption 名字。 */
const SCAN_OPTION_ALIASES = new Map(Object.entries({
	exact: "ExactValue", exactvalue: "ExactValue", equal: "ExactValue", eq: "ExactValue", "=": "ExactValue",
	between: "ValueBetween", valuebetween: "ValueBetween", range: "ValueBetween",
	greater: "BiggerThan", greaterthan: "BiggerThan", bigger: "BiggerThan", biggerthan: "BiggerThan",
	biggerthen: "BiggerThan", ">": "BiggerThan",
	less: "SmallerThan", lessthan: "SmallerThan", smaller: "SmallerThan", "<": "SmallerThan",
	increased: "IncreasedValue", inc: "IncreasedValue", "increased value": "IncreasedValue",
	increasedby: "IncreasedValueBy", incby: "IncreasedValueBy", "increased by": "IncreasedValueBy", "+": "IncreasedValueBy",
	decreased: "DecreasedValue", dec: "DecreasedValue", "decreased value": "DecreasedValue",
	decreasedby: "DecreasedValueBy", decby: "DecreasedValueBy", "decreased by": "DecreasedValueBy", "-": "DecreasedValueBy",
	changed: "Changed", diff: "Changed", "!=": "Changed",
	unchanged: "Unchanged", same: "Unchanged", still: "Unchanged",
	increasedbypercent: "IncreasedValueByPercentage", incpct: "IncreasedValueByPercentage", "increased by percent": "IncreasedValueByPercentage",
	decreasedbypercent: "DecreasedValueByPercentage", decpct: "DecreasedValueByPercentage", "decreased by percent": "DecreasedValueByPercentage",
	betweenpercent: "ValueBetweenPercentage", rangepct: "ValueBetweenPercentage", "between percent": "ValueBetweenPercentage",
	unknown: "UnknownValue", unknownvalue: "UnknownValue", "?": "UnknownValue"
}));

/** 归一化查找索引（见 buildLookupIndex）。 */
const SCAN_OPTION_INDEX = buildLookupIndex(SCAN_OPTION_ALIASES);

/**
 * 把扫描选项名解析成内核的 `ScanOption` 枚举值。
 *
 * @param {object} ce 内核模块
 * @param {string} name 选项名；省略时按 ExactValue
 * @returns {number}
 */
export function resolveScanOption(ce, name) {
	if (name === undefined || name === null || name === "") return ce.ScanOption.ExactValue;
	if (typeof name === "number") return name;
	const key = String(name).trim().toLowerCase();
	const canonical = lookupAlias(SCAN_OPTION_INDEX, key);
	if (canonical !== undefined) return ce.ScanOption[canonical];
	if (Object.hasOwn(ce.ScanOption, String(name))) return ce.ScanOption[String(name)];
	throw new Error(
		`不认识的扫描方式 "${name}"。可用：exact/between/greater/less/increased/increased_by/` +
		"decreased/decreased_by/changed/unchanged/increased_by_percent/decreased_by_percent/between_percent/unknown"
	);
}

/** 浮点比较策略名 → 内核 RoundingType。 */
const ROUNDING_ALIASES = new Map(Object.entries({
	rounded: "Rounded", round: "Rounded", none: "Rounded",
	extreme: "ExtremeRounded", extremerounded: "ExtremeRounded", extreme_rounded: "ExtremeRounded", tolerant: "ExtremeRounded",
	truncated: "Truncated", truncate: "Truncated"
}));

/** 归一化查找索引（见 buildLookupIndex）。 */
const ROUNDING_INDEX = buildLookupIndex(ROUNDING_ALIASES);

/**
 * 把浮点比较策略名解析成 `RoundingType`。
 * @param {object} ce 内核模块
 * @param {string} name 省略时按 Rounded
 * @returns {number}
 */
export function resolveRounding(ce, name) {
	if (name === undefined || name === null || name === "") return ce.RoundingType.Rounded;
	if (typeof name === "number") return name;
	const canonical = lookupAlias(ROUNDING_INDEX, name);
	if (canonical !== undefined) return ce.RoundingType[canonical];
	if (Object.hasOwn(ce.RoundingType, String(name))) return ce.RoundingType[String(name)];
	throw new Error(`不认识的浮点比较策略 "${name}"。可用：rounded/extreme/truncated`);
}

/* ───────────────────────────── 数值解析 ───────────────────────────── */

/**
 * 解析整数文本成 BigInt。
 *
 * 优先级：`0x`/`$` 前缀 → 十六进制；`0d` 前缀 → 十进制；`forceHex` → 十六进制；
 * 其余按十进制。负号在任何情况下都支持。
 *
 * @param {string|number|bigint} input 输入
 * @param {{ hexadecimal?: boolean }} [options]
 * @returns {bigint}
 */
export function parseInteger(input, options = {}) {
	const forceHex = options.hexadecimal === true;
	let text = typeof input === "number" || typeof input === "bigint" ? String(input) : String(input ?? "").trim();
	if (text === "") throw new Error("数值为空");
	let negative = false;
	if (text.startsWith("-")) {
		negative = true;
		text = text.slice(1).trim();
	} else if (text.startsWith("+")) {
		text = text.slice(1).trim();
	}
	let radix = forceHex ? 16 : 10;
	if (/^0x/i.test(text)) {
		radix = 16;
		text = text.slice(2);
	} else if (text.startsWith("$")) {
		radix = 16;
		text = text.slice(1);
	} else if (/^0d/i.test(text)) {
		radix = 10;
		text = text.slice(2);
	} else if (/^0b/i.test(text)) {
		radix = 2;
		text = text.slice(2);
	}
	if (text === "") throw new Error(`数值 "${input}" 不完整`);
	const valid = radix === 16 ? /^[0-9a-f]+$/i : radix === 2 ? /^[01]+$/ : /^[0-9]+$/;
	if (!valid.test(text)) {
		throw new Error(
			`无法把 "${input}" 解析成 ${radix === 16 ? "十六进制" : radix === 2 ? "二进制" : "十进制"}整数` +
			(forceHex ? "" : "（要按十六进制解析请设 hexadecimal: true）")
		);
	}
	const magnitude = BigInt(radix === 16 ? `0x${text}` : radix === 2 ? `0b${text}` : text);
	return negative ? -magnitude : magnitude;
}

/** 解析浮点文本。 */
export function parseFloatValue(input) {
	const text = typeof input === "number" ? String(input) : String(input ?? "").trim();
	if (text === "") throw new Error("浮点数为空");
	const value = Number(text);
	if (!Number.isFinite(value)) throw new Error(`无法把 "${input}" 解析成有限浮点数`);
	return value;
}

/** 把 BigInt 截断成指定位宽的无符号值。 */
function toUnsigned(value, bits) {
	const mask = (1n << BigInt(bits)) - 1n;
	return value & mask;
}

/**
 * 判断这次写入是否**按位宽静默截断**了（只提示，不改行为）。
 *
 * ## 为什么保留截断、但必须提示
 *
 * CE 本身就是这么做的（`TMemoryRecord.SetValue` 把值写进对应宽度的缓冲区，
 * 超出部分自然丢掉），所以**功能上可接受、不该改**。问题是工具此前会报
 * 「已写入并校验通过」，一个字都不提，实测三种情形：
 *   · `byte ← 999`  → 写成 `E7`（231）
 *   · `byte ← 256`  → 写成 `00`
 *   · `dword ← 99999999999999999999` → 截断成低 32 位
 * 用户看到"校验通过"会以为自己写的值真的进去了 —— 这是**静默错值**，
 * 比报错危险。所以这里只补提示。
 *
 * ## 判据（刻意宽松，避免误报）
 *
 * 范围内 = `-2^(bits-1) <= n <= 2^bits - 1`，即**无符号与有符号两种解释都接受**。
 * 这样 `byte ← -1`（写 `0xFF` 的标准写法）不会被误报 —— 它是完全正常的用法。
 *
 * @param {object} ce 内核模块
 * @param {number} type VariableType
 * @param {string|number|bigint} value 用户给的值
 * @param {{ hexadecimal?: boolean, signed?: boolean, pointerSize?: number }} [options]
 * @returns {{ bits: number, original: string, effectiveHex: string, effectiveDecimal: string, message: string }|null}
 *          没有截断时返回 null
 */
export function describeValueTruncation(ce, type, value, options = {}) {
	const bitsOf = () => {
		if (type === ce.VariableType.Byte) return 8;
		if (type === ce.VariableType.Word) return 16;
		if (type === ce.VariableType.DWord) return 32;
		if (type === ce.VariableType.QWord) return 64;
		if (type === ce.VariableType.Pointer) return (options.pointerSize ?? 8) * 8;
		return 0;
	};
	const bits = bitsOf();

	// 浮点：只提示"溢出成无穷大"这一种静默失真（精度损失是浮点固有的，不算）
	if (bits === 0 && (type === ce.VariableType.Single || type === ce.VariableType.Double)) {
		const parsed = parseFloatValue(value);
		if (type === ce.VariableType.Single && Number.isFinite(parsed) && !Number.isFinite(Math.fround(parsed))) {
			return {
				bits: 32,
				original: String(value),
				effectiveHex: "（±Infinity）",
				effectiveDecimal: String(Math.fround(parsed)),
				message:
					`值 ${value} 超出 32 位浮点（float）的可表示范围，按 IEEE-754 会写成为 ` +
					`${Math.fround(parsed)} —— 目标读到的是一个无穷大，不是你给的那个数。`
			};
		}
		return null;
	}
	if (bits === 0) return null;

	let parsed;
	try {
		parsed = parseInteger(value, options);
	} catch {
		// 解析不了就不是"截断"问题，交给 encodeValue 抛它自己的错
		return null;
	}

	const unsignedMax = (1n << BigInt(bits)) - 1n;
	const signedMin = -(1n << BigInt(bits - 1));
	if (parsed >= signedMin && parsed <= unsignedMax) return null;

	const effective = toUnsigned(parsed, bits);
	return {
		bits,
		original: parsed.toString(),
		effectiveHex: `0x${effective.toString(16).toUpperCase().padStart(bits / 4, "0")}`,
		effectiveDecimal: effective.toString(),
		message:
			`值 ${parsed.toString()} 超出 ${bits} 位范围（无符号 0..${unsignedMax.toString()}，` +
			`有符号 ${signedMin.toString()}..${(unsignedMax >> 1n).toString()}），` +
			`已按位宽**截断**写入：实际写入的**数值**是 ${effective.toString(16).toUpperCase()} ` +
			`（无符号 ${effective.toString()}，内存里按小端存放）。` +
			"这与 Cheat Engine 的行为一致（保留低位、丢弃高位），" +
			"但**你给的值没有被原样写入** —— 如果这不是你想要的，请检查数值本身或改用更宽的类型。"
	};
}

/** 把无符号 BigInt 解释成有符号值。 */
function toSigned(value, bits) {
	const signBit = 1n << BigInt(bits - 1);
	const mask = (1n << BigInt(bits)) - 1n;
	const v = value & mask;
	return v >= signBit ? v - (1n << BigInt(bits)) : v;
}

/* ───────────────────────────── 值编解码 ───────────────────────────── */

/** 每种定长类型占用的字节数。 */
const FIXED_WIDTHS = { Byte: 1, Word: 2, DWord: 4, QWord: 8, Single: 4, Double: 8, Pointer: 8 };

/**
 * 取某类型在目标进程上的读取宽度。
 *
 * @param {object} ce 内核模块
 * @param {number} type VariableType
 * @param {{ size?: number, pointerSize?: number }} [options] 变长类型的显式长度
 * @returns {number} 字节数
 */
export function widthOfType(ce, type, options = {}) {
	for (const [name, width] of Object.entries(FIXED_WIDTHS)) {
		if (type === ce.VariableType[name]) {
			if (name === "Pointer" && options.pointerSize) return options.pointerSize;
			return width;
		}
	}
	// 变长：字符串/字节数组必须有显式长度
	if (options.size !== undefined && Number.isFinite(options.size) && options.size > 0) return Math.floor(options.size);
	return 16;
}

/**
 * 把内存字节解码成可读字符串。
 *
 * @param {object} ce 内核模块
 * @param {Buffer} buffer 读到的字节
 * @param {number} type VariableType
 * @param {{ hexadecimal?: boolean, signed?: boolean, size?: number }} [options]
 * @returns {string}
 */
export function decodeValue(ce, buffer, type, options = {}) {
	const hex = options.hexadecimal === true;
	const signed = options.signed === true;
	const need = (n) => {
		if (buffer.length < n) throw new Error(`只有 ${buffer.length} 字节，解不出 ${variableTypeName(ce, type)}`);
	};
	if (type === ce.VariableType.Byte) {
		need(1);
		const raw = BigInt(buffer.readUInt8(0));
		return hex ? `0x${raw.toString(16)}` : (signed ? toSigned(raw, 8) : raw).toString();
	}
	if (type === ce.VariableType.Word) {
		need(2);
		const raw = BigInt(buffer.readUInt16LE(0));
		return hex ? `0x${raw.toString(16)}` : (signed ? toSigned(raw, 16) : raw).toString();
	}
	if (type === ce.VariableType.DWord) {
		need(4);
		const raw = BigInt(buffer.readUInt32LE(0));
		return hex ? `0x${raw.toString(16)}` : (signed ? toSigned(raw, 32) : raw).toString();
	}
	if (type === ce.VariableType.QWord || type === ce.VariableType.Pointer) {
		need(8);
		const raw = buffer.readBigUInt64LE(0);
		return hex ? `0x${raw.toString(16)}` : (signed ? toSigned(raw, 64) : raw).toString();
	}
	if (type === ce.VariableType.Single) {
		need(4);
		return String(buffer.readFloatLE(0));
	}
	if (type === ce.VariableType.Double) {
		need(8);
		return String(buffer.readDoubleLE(0));
	}
	if (type === ce.VariableType.UnicodeString) {
		return decodeCString(buffer, "utf16le");
	}
	if (type === ce.VariableType.String || type === ce.VariableType.CodePageString) {
		return decodeCString(buffer, "utf8");
	}
	// AOB / Binary / 其他：按十六进制字节展示
	return formatBytesHex(buffer);
}

/** 截断到第一个 NUL 并解码；没有 NUL 就用整段。 */
function decodeCString(buffer, encoding) {
	const unit = encoding === "utf16le" ? 2 : 1;
	let end = buffer.length;
	for (let i = 0; i + unit <= buffer.length; i += unit) {
		if (buffer.readUIntLE(i, unit) === 0) {
			end = i;
			break;
		}
	}
	return buffer.subarray(0, end - (end % unit)).toString(encoding);
}

/** 按十六进制展示字节（大写、空格分隔），与 CE 内存视图一致。 */
export function formatBytesHex(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
	const parts = new Array(buffer.length);
	for (let i = 0; i < buffer.length; i += 1) parts[i] = buffer[i].toString(16).toUpperCase().padStart(2, "0");
	return parts.join(" ");
}

/**
 * 判断一次写入是否真的落到了内存上（写完回读的比对规则）。
 *
 * 抽成独立函数有两个理由：`ce_write` 与 `ce_assemble` 共用同一套判定，避免两处各写一遍
 * 而慢慢分叉；而且它是「写完到底成没成功」的唯一判据，必须能被单测直接钉住 ——
 * 只测成功路径等于没测（「目标进程把值改回去了」才是这条规则存在的意义）。
 *
 * @param {Buffer} payload 期望写入的字节
 * @param {Buffer} after 回读到的字节（可能比 payload 短）
 * @returns {boolean} 是否完全一致
 */
export function verifyBytesWritten(payload, after) {
	if (!Buffer.isBuffer(payload) || payload.length === 0) return false;
	if (!Buffer.isBuffer(after) || after.length < payload.length) return false;
	return Buffer.compare(after.subarray(0, payload.length), payload) === 0;
}

/**
 * 把文本编码成要写入目标进程的字节。
 *
 * @param {object} ce 内核模块
 * @param {number} type VariableType
 * @param {string|number|bigint} value 待写入的值
 * @param {{ hexadecimal?: boolean, signed?: boolean, size?: number, pointerSize?: number }} [options]
 * @returns {Buffer} 字节
 */
export function encodeValue(ce, type, value, options = {}) {
	const bits = (n) => n;
	if (type === ce.VariableType.Byte) {
		const n = parseInteger(value, options);
		const buf = Buffer.alloc(1);
		buf.writeUInt8(Number(toUnsigned(n, 8)), 0);
		return buf;
	}
	if (type === ce.VariableType.Word) {
		const n = parseInteger(value, options);
		const buf = Buffer.alloc(2);
		buf.writeUInt16LE(Number(toUnsigned(n, 16)), 0);
		return buf;
	}
	if (type === ce.VariableType.DWord) {
		const n = parseInteger(value, options);
		const buf = Buffer.alloc(4);
		buf.writeUInt32LE(Number(toUnsigned(n, 32)), 0);
		return buf;
	}
	if (type === ce.VariableType.QWord || type === ce.VariableType.Pointer) {
		const n = parseInteger(value, options);
		const width = type === ce.VariableType.Pointer ? (options.pointerSize ?? 8) : 8;
		const buf = Buffer.alloc(width);
		if (width === 4) buf.writeUInt32LE(Number(toUnsigned(n, 32)), 0);
		else buf.writeBigUInt64LE(toUnsigned(n, 64), 0);
		return buf;
	}
	if (type === ce.VariableType.Single) {
		const buf = Buffer.alloc(4);
		buf.writeFloatLE(parseFloatValue(value), 0);
		return buf;
	}
	if (type === ce.VariableType.Double) {
		const buf = Buffer.alloc(8);
		buf.writeDoubleLE(parseFloatValue(value), 0);
		return buf;
	}
	if (type === ce.VariableType.UnicodeString) {
		const text = String(value ?? "");
		const body = Buffer.from(text, "utf16le");
		return Buffer.concat([body, Buffer.alloc(2)]);
	}
	if (type === ce.VariableType.String || type === ce.VariableType.CodePageString) {
		const text = String(value ?? "");
		return Buffer.concat([Buffer.from(text, "utf8"), Buffer.alloc(1)]);
	}
	// AOB / Binary：必须是无通配符的纯字节
	return parseAobBytes(value);
}

/**
 * 解析 AOB 文本成字节（写入用；通配符没有意义，直接报错）。
 *
 * @param {string} text 形如 `"DE AD BE EF"` 或 `"DEADBEEF"`
 * @returns {Buffer}
 */
export function parseAobBytes(text) {
	const cleaned = String(text ?? "").trim();
	if (cleaned === "") throw new Error("AOB 为空");
	if (/[?*]/.test(cleaned)) {
		throw new Error("写入的 AOB 不能含通配符（? / *）：通配符只用于扫描匹配，没有可写入的字节");
	}
	const compact = cleaned.replace(/[\s,;]+/g, "");
	if (!/^[0-9a-fA-F]+$/.test(compact)) throw new Error(`AOB "${text}" 含非法字符（只允许十六进制与空格）`);
	if (compact.length % 2 !== 0) throw new Error(`AOB "${text}" 的十六进制位数是奇数，无法按字节切分`);
	return Buffer.from(compact, "hex");
}

/**
 * 分析 AOB **扫描模式**的"宽泛程度"（用于挡住会让内存爆掉的全通配扫描）。
 *
 * ## 为什么需要这个（实测的宿主崩溃级问题）
 *
 * `ce_scan {type:"aob", value:"?? ?? ??"}` 实测命中 **62,221,896** 个地址、
 * 耗时 4.8s、**宿主 heap +2956 MiB** —— 内核会把每个命中都存进结果数组，
 * 于是"扫个内存"直接把 DSH 宿主推到 OOM 边缘。而工具当时**一句提示都没有**。
 *
 * ## 语义必须与内核的 `parseAob` 严格一致
 *
 * 内核 `value-codec.ts` 的 `parseAob` 是两字符一字节地切、分隔符为 `空格/逗号/横线`，
 * 并且**落空的片段会被当成通配符**（`DE AD B` 里的 `B` 就成了 `??`）。
 * 这里逐条复刻，否则"分析说很具体、内核却按全通配扫"就白算了。
 *
 * ## 具体度模型
 *
 * 每个**完整固定**字节把命中概率压到 1/256，每个**半字节通配**（`7*` / `*7`）压到 1/16。
 * 于是 `specificity = (1/256)^fixed * (1/16)^partial` 就是"任意一个位置命中"的概率，
 * 可直接用来判断"这次扫描大概会命中多少"：4 GB 内存上 1/65536 也才 ~6.5 万条，
 * 而 1/256 就是 ~1600 万条。
 *
 * @param {string} text AOB 模式串，如 `"DE AD BE EF ?? 90"`、`"9090??"`
 * @returns {{
 *   total: number, fixed: number, partial: number, wild: number,
 *   anchored: number, wildRatio: number, specificity: number, oddTokens: string[]
 * }} 统计结果
 */
export function analyzeAobPattern(text) {
	const trimmed = String(text ?? "").trim();
	const words = trimmed.split(/[\s,\-]+/).filter((word) => word !== "");
	let total = 0;
	let fixed = 0;
	let partial = 0;
	let wild = 0;
	/** 长度不是偶数的片段（内核会把落单的那个字符当成通配符 —— 必须如实提示）。 */
	const oddTokens = [];

	for (const word of words) {
		let j = 0;
		while (j < word.length) {
			const pair = word.slice(j, j + 2);
			j += 2;
			total += 1;

			if (/^[0-9a-f]{2}$/i.test(pair)) {
				fixed += 1;
				continue;
			}
			// 与内核一致：完全通配优先于"奇数片段"判断（单独的 `x` 也是通配）
			if (/^[?*x]{1,2}$/i.test(pair)) {
				wild += 1;
				continue;
			}
			if (pair.length === 2) {
				const hi = pair[0];
				const lo = pair[1];
				if (
					(/[0-9a-f]/i.test(hi) && /[?*x]/i.test(lo)) ||
					(/[?*x]/i.test(hi) && /[0-9a-f]/i.test(lo))
				) {
					partial += 1;
					continue;
				}
			}
			// 落到这里 = 内核会把它当通配符：奇数长度片段，或无法识别的字符
			wild += 1;
			if (pair.length === 1 && !oddTokens.includes(word)) oddTokens.push(word);
		}
	}

	const anchored = fixed + partial;
	const specificity = Math.pow(1 / 256, fixed) * Math.pow(1 / 16, partial);
	return {
		total,
		fixed,
		partial,
		wild,
		anchored,
		wildRatio: total === 0 ? 1 : wild / total,
		specificity,
		oddTokens
	};
}

/**
 * 判断一个 AOB 模式是否"宽泛到会把内存撑爆"，需要调用方显式确认。
 *
 * 阈值（三条任一命中即算宽泛）：
 *   1. `anchored === 0` —— 一个固定字节都没有，等于"匹配一切"；
 *   2. `wildRatio >= 0.8` —— 八成以上是通配符；
 *   3. `specificity > 1/65536` —— 按概率估算命中密度过高（`90`、`?? 90`、`7*` 都落在这里）。
 *
 * 第 3 条是主判据：它同时抓住"模式极短"与"通配占比过高"两种成因。
 * `90 90`（= 1/65536）刚好通过：4 GB 上约 6.5 万条，是可用量级。
 *
 * @param {{total:number,fixed:number,partial:number,wild:number,anchored:number,wildRatio:number,specificity:number}} stats
 * @returns {{ broad: boolean, reason: string|null }}
 */
export function assessAobBreadth(stats) {
	if (stats.total === 0) return { broad: false, reason: null };
	if (stats.anchored === 0) {
		return {
			broad: true,
			reason: `模式里没有任何固定字节（${stats.total} 个字节全是通配符），等价于在整片内存里「匹配一切」`
		};
	}
	if (stats.wildRatio >= 0.8) {
		return {
			broad: true,
			reason:
				`通配字节占 ${Math.round(stats.wildRatio * 100)}%（${stats.wild}/${stats.total}），` +
				"只有极少数位置有约束"
		};
	}
	if (stats.specificity > 1 / 65536) {
		const expected = Math.round(1 / stats.specificity);
		return {
			broad: true,
			reason:
				`模式过于宽泛：平均每 ${expected} 个字节就会命中一次` +
				`（固定字节 ${stats.fixed} 个、半字节约束 ${stats.partial} 个），` +
				"在 GB 级内存上会产生千万级命中"
		};
	}
	return { broad: false, reason: null };
}

/* ───────────────────────────── 地址解析 ───────────────────────────── */

/** 把 BigInt 地址格式化成 `0x…`。 */
export function formatAddress(address) {
	if (address === null || address === undefined) return "";
	return `0x${BigInt(address).toString(16)}`;
}

/** 看起来像「纯数值字面量」的输入（可直接自己解析，不必交给表达式引擎）。 */
function looksLikeLiteral(text) {
	return /^(0x[0-9a-f]+|\$[0-9a-f]+|0d[0-9]+|0b[01]+|[0-9]+|[0-9a-f]*[a-f][0-9a-f]*)$/i.test(text);
}

/**
 * 把地址输入规范成 CE 地址表达式。
 *
 * 见模块顶部「约定 1」。返回值一定是可以直接交给 `resolveAddress` 的字符串。
 *
 * @param {string|number|bigint} input 地址或表达式
 * @param {{ hexadecimal?: boolean }} [options] 纯十进制数字是否按十六进制解释
 * @returns {string} 规范化的表达式
 */
export function toAddressExpression(input, options = {}) {
	if (input === undefined || input === null || input === "") throw new Error("地址为空");
	if (typeof input === "bigint") return `0x${input.toString(16)}`;
	if (typeof input === "number") {
		if (!Number.isFinite(input) || !Number.isInteger(input)) throw new Error(`地址必须是整数，收到 ${input}`);
		if (input < 0) throw new Error(`地址不能为负：${input}`);
		return `0x${BigInt(input).toString(16)}`;
	}
	const text = String(input).trim();
	if (text === "") throw new Error("地址为空");
	// 明确的字面量：自己解析，避免与表达式引擎对「裸数字」的理解产生歧义
	if (/^0x[0-9a-f]+$/i.test(text)) return `0x${text.slice(2).toLowerCase()}`;
	if (/^\$[0-9a-f]+$/i.test(text)) return `0x${text.slice(1).toLowerCase()}`;
	if (/^0d[0-9]+$/i.test(text)) {
		const n = BigInt(text.slice(2));
		if (n < 0n) throw new Error(`地址不能为负：${text}`);
		return `0x${n.toString(16)}`;
	}
	if (/^0b[01]+$/i.test(text)) {
		const n = BigInt(`0b${text.slice(2)}`);
		return `0x${n.toString(16)}`;
	}
	if (/^[0-9]+$/.test(text)) {
		// 纯数字：默认十进制（与 CE 的扫描数值一致）；hexadecimal 时才当十六进制
		const n = options.hexadecimal === true ? BigInt(`0x${text}`) : BigInt(text);
		return `0x${n.toString(16)}`;
	}
	if (/^[0-9a-f]+$/i.test(text) && /[a-f]/i.test(text)) {
		// 含 a-f 的裸串：按 CE 习惯当十六进制
		return `0x${text.toLowerCase()}`;
	}
	// 其余：模块相对地址（game.exe+1234）、解引用链（[[game.exe+10]+8]）、
	// 算术表达式、引号包裹的模块名 —— 交给内核的表达式引擎
	if (!looksLikeLiteral(text) && /[\s]/.test(text) && !/["[\]()+\-*/%<>&|^~]/.test(text)) {
		throw new Error(`地址 "${input}" 不像数值也不像表达式（含空格却没有运算符）`);
	}
	return normalizeModuleOffsets(text);
}

/**
 * 把「模块相对地址」里的**裸数字偏移**规范成十六进制。
 *
 * ## 为什么必须做这一步（实测踩到的真 bug）
 *
 * 内核表达式引擎的词法规则是：
 *   · **裸数字（纯 0-9）按十进制**解析；
 *   · 含 `a-f` 的裸串按十六进制解析。
 *
 * 而 CE 的用户习惯、以及**内核自己的文档示例**（`"game.exe"+1234`）都把
 * `+` 后面的数字当作**十六进制偏移**。两者冲突，后果是**静默读错地址**：
 *
 *   实测：`CheatTestWindow.exe+9030`
 *     · 期望读到 `模块基址 + 0x9030`（那里是 g_level = 7）
 *     · 实际读到 `模块基址 + 0x2346`（因为 9030 十进制 = 0x2346）
 *
 * 这比报错更危险 —— 它给出的是**看起来正常但完全错误**的内存值。
 *
 * ## 只改偏移，不改别处
 *
 * 只把**紧跟在模块名（标识符，可带点/连字符/斜杠）后面的 `+`/`-` 的数字**转成 `0x…`。
 * 其余保持原样，所以：
 *   · `0x10+20`      —— 前面不是标识符（`x10` 从 `0` 后面开始，被后行断言挡住），
 *                       20 仍是十进制 ⇒ 与 `$10+20` **同值**（0x24）；
 *   · `game.exe+1a3f` —— 含 a-f，本来就是十六进制，值不变（只是补上前缀）；
 *   · `game.exe+0x10` —— 已带前缀，不动。
 *
 * ## ⚠️ 例外：表达式里**任意位置**出现"含 a-f 的裸十六进制字面量"时，整条按 CE 语义
 *
 * `ff+20` 这种写法里 `ff` 长得像标识符，但它**不是**模块/符号名 ——
 * CE 的 `getAddressFromName`（`symbolhandler.pas:5264-5275`）对每个 token
 * **先**做 `val('$'+tokens[i]),v64,j`，只有 `j>0`（不是合法十六进制串）时才去
 * `getmodulebyname`。所以 `ff` 在 CE 眼里就是数字 **0xff**，
 * `ff+20` = `0xff + 0x20` = **0x11f**（而不是"未知的符号或模块 ff"）。
 * （审计给的说法是"CE 先查模块/符号、再当数字"，查证源码后**恰好相反**：
 *  先 `val('$'+token)`、再查模块。这里按源码实现。）
 *
 * ## 为什么判据必须**位置无关**（0.1.9 的残留 bug）
 *
 * CE 的这段判定是**逐 token** 的（`:5264` 的 `for i:=0 to length(tokens)-1`），
 * 与 token 排在第几个位置无关。上一轮只看了**第一个操作数**
 * （`startsWithBareHexLiteral`），于是 `ff+20` 修好了，同一个 token 落到**中间**
 * 时却仍走标识符路径：
 *   · `1000+ff`：`add` 交给内核的是 `1000+ff` ⇒ 报「未知的符号或模块 "ff"」，
 *     而 `load` 走内核 `normalizeCtAddress` 得 `0x1000+0xff` = 0x10ff；
 *   · `game.exe+10+ff` 同理（紧跟模块名的那个偏移归一化了，末尾的 `ff` 没有）。
 *
 * 所以判据换成 `hasBareHexLiteral`：**只要表达式里任意位置**有一个这样的 token，
 * 就整条按 CE 的十六进制语义处理（每个裸 token 都补 `0x`）。这样
 *   · `add {address:"1000+ff"}` → `0x1000+0xff`，与 `load <Address>1000+ff</Address>`
 *     （走内核 `normalizeCtAddress`）**给出同一个地址**，与 CE 也一致；
 *   · `0x10+20`、`1000+1000`、`1000+20`（没有任何裸十六进制字面量）不受影响，
 *     仍保持「裸数字＝十进制」的 add 约定 ⇒ 0x24 / 0x7d0 / 0x3fc。
 *
 * 判据要求这个 token 的**前后都不是标识符字符**（`[0-9A-Za-z_.$\-\\/]`），
 * 否则模块名会被误判：`ff.exe+10` 里的 `ff.exe`、`dead.dll+20` 里的 `dead.dll`
 * 都是**整体**标识符（`.` 属于标识符字符），不会被切成"字面量 + 后缀"。
 *
 * ⚠️ 规则是**词法级**的，不解析嵌套结构，于是"整条按十六进制"是**全有或全无**：
 * 表达式里一旦出现裸十六进制字面量（如 `1000+1c`），同一表达式里本来按十进制读的
 * 裸数字也会一起按十六进制读（`1000+1c` = 0x1000+0x1c = 0x101c，而不是
 * 0x3e8+0x1c = 0x404）。这正是 CE 的语义（每个 token 都进 `val('$'+token)`），
 * 也是 `add` 与 `load` 能一致的前提；确实要十进制语义请写显式形式（`0d1000+1c`）。
 *
 * @param {string} text 规范化后的表达式
 * @returns {string} 偏移已规范成十六进制的表达式
 *
 * @note 导出供 `lib/tools/table.js` 使用 ——
 *   地址表的 `add` 参数是**用户手输**（裸数字＝十进制），走的就是这条。
 *   ⚠️ 而**从 .CT 文件读进来**的地址是另一套语义（裸数字＝十六进制），
 *   那条路已下沉到内核 `parseCheatEntry`（`normalizeCtAddress`），
 *   **不要**再把两者混在一起（0.1.7 曾因此让 add / load 两条路给出不同地址）。
 */
export function normalizeModuleOffsets(text) {
	// 「表达式里任意位置有裸十六进制字面量」⇒ 整条按 CE 的十六进制语义
	if (hasBareHexLiteral(text)) return toCeHexExpression(text);

	// 标识符：字母/下划线/反斜杠开头，后接字母数字与 `_ . - \ / $`
	// （覆盖 `game.exe`、`my-mod.dll`、`C:\path\a.exe`、`"带空格的模块名.exe"`）
	//
	// ⚠️ 有两个坑，必须一起挡住，否则会把**数字字面量**当成"标识符 + 偏移"：
	//
	//   1. **已带后缀的数字字面量**（`0x10`、`0b101`、`0d7`）里的 `x10`/`b101`/`d7`
	//      看起来像标识符。用"标识符后面**不紧跟**后缀"来排除（负向先行断言）。
	//   2. **标识符不能从数字/字面量中间开始**（`0x10` 里的 `x10` 就是从 `0` 后面
	//      开始的）。这一条曾经缺失，实测后果是
	//        `0x10+20` → `x10+0x20` → `0x10+0x20` = 0x30
	//        `$10+20`  → `$10+20`   → 0x10 + 20 = 0x24
	//      同一个算术两种写法给出**不同地址**，而且不报错。
	//      本文件下面那条注释写的"前面不是标识符，20 仍是十进制"才是预期语义，
	//      所以这里用**后行断言**挡住，让实现与注释一致（`$` 也要挡：
	//      `$ff+20` 里的 `ff` 同样不是标识符）。
	const IDENT = `(?<![0-9A-Za-z_$])(?:"[^"]*"|'[^']*'|[A-Za-z_\\\\][A-Za-z0-9_.$\\-\\\\/]*)(?![xbd][0-9A-Za-z])`;
	// 偏移的两种写法都要覆盖：
	//   · 纯数字        `+9030`  —— 这是本次修复的 bug（内核当十进制）
	//   · 含 a-f 的裸串 `+1a3f`  —— 内核本来就当十六进制，补前缀统一形态、值不变
	const OFFSET = `([0-9]+|[0-9a-f]*[a-f][0-9a-f]*)`;
	const pattern = new RegExp(`(${IDENT}\\s*[+-]\\s*)${OFFSET}(?![0-9A-Za-z_])`, "gi");
	return text.replace(pattern, (_all, head, digits) => `${head}0x${digits.toLowerCase()}`);
}

/** 标识符可能包含的字符（模块名/符号名），用于给"裸十六进制字面量"划边界。 */
const IDENT_CHARS = "[0-9A-Za-z_.$\\-\\\\/]";

/**
 * 只对**引号外**的片段做变换。
 *
 * CE 的 `tokenize`（`symbolhandler.pas:3125-3163`）在引号内**不切分**，
 * 所以 `"my-mod.exe"` 是一个整体，不能被当作若干个"裸 token"改写。
 *
 * @param {string} text 文本
 * @param {(segment: string) => string} fn 对引号外片段的变换
 * @returns {string}
 */
function transformOutsideQuotes(text, fn) {
	const parts = text.split(/("[^"]*")/);
	// `split` 带捕获组时，引号段落在奇数下标上，原样保留
	for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i]);
	return parts.join("");
}

/** 去掉十六进制串的前导零（`00401000` → `401000`）；全零保留一位 `0`。 */
function trimHexZeros(digits) {
	const trimmed = digits.replace(/^0+/, "").toLowerCase();
	return trimmed === "" ? "0" : trimmed;
}

/** 整条表达式是否按 CE 的 `val('$'+token)` 语义（每个裸 token 都是十六进制）。 */
function toCeHexExpression(text) {
	const pattern = new RegExp(`(?<!${IDENT_CHARS})([0-9a-f]+)(?!${IDENT_CHARS})`, "gi");
	return transformOutsideQuotes(text, (segment) =>
		segment.replace(pattern, (_all, digits) => `0x${trimHexZeros(digits)}`)
	);
}

/**
 * 表达式里**任意位置**是否出现「含 a-f 的裸十六进制字面量」（CE 会把它当数字）。
 *
 * 位置无关是必须的：CE 是**逐 token** 做 `val('$'+token)`（`symbolhandler.pas:5264-5275`），
 * 排在第几个 token 都一视同仁，所以 `1000+ff` 里的 `ff` 与 `ff+20` 里的 `ff` 等价。
 * 早先只看第一个操作数，同一个 token 落在中间时就不走这条语义
 * （`add 1000+ff` 报「未知的符号或模块 ff」，而 `load` 得 0x10ff）。
 *
 * 判据要求这个 token 的**前后都不是标识符字符**（`[0-9A-Za-z_.$\-\\/]`），
 * 于是模块名整体匹配、不会被切开：`ff.exe+10` 里的 `ff` 后面紧跟 `.`
 * （标识符字符）⇒ 不算字面量；`dead.dll+20` 同理。引号内不参与
 * （CE 的 `tokenize` 在引号内不切分，见 `transformOutsideQuotes`）。
 *
 * @param {string} text 表达式
 * @returns {boolean}
 */
function hasBareHexLiteral(text) {
	const pattern = new RegExp(`(?<!${IDENT_CHARS})[0-9a-f]*[a-f][0-9a-f]*(?!${IDENT_CHARS})`, "i");
	let found = false;
	// 复用 `transformOutsideQuotes` 对"哪里算引号外"的切分（只借这个定义，不改文本）
	transformOutsideQuotes(text, (segment) => {
		if (pattern.test(segment)) found = true;
		return segment;
	});
	return found;
}

/**
 * 求值地址表达式。
 *
 * @param {object} ce 内核模块
 * @param {string|number|bigint} input 地址或表达式
 * @param {object} ctx EvalContext（至少含 process）
 * @param {{ hexadecimal?: boolean }} [options]
 * @returns {bigint} 解析出的地址
 */
export function resolveAddressInput(ce, input, ctx, options = {}) {
	const expression = toAddressExpression(input, options);
	try {
		return BigInt(ce.resolveAddress(expression, ctx));
	} catch (error) {
		const detail = error && error.message ? error.message : String(error);
		throw new Error(`无法解析地址 "${input}"（规范化后："${expression}"）：${detail}`);
	}
}

/**
 * 把一条指针路径渲染成可再次喂给地址参数的表达式。
 *
 * 内核语义：`addr = base; for (const o of offsets) addr = readPtr(addr) + o`。
 *
 * @param {{ baseAddress: bigint, offsets: number[] }} path 指针路径
 * @returns {string}
 */
export function pointerPathToExpression(path) {
	let expression = formatAddress(path.baseAddress);
	for (const offset of path.offsets ?? []) {
		expression = `[${expression}]`;
		if (offset > 0) expression += `+0x${offset.toString(16)}`;
		else if (offset < 0) expression += `-0x${(-offset).toString(16)}`;
	}
	return expression;
}

/**
 * 把绝对地址渲染成「模块名+偏移」形式（命中模块时），否则返回 `0x…`。
 *
 * @param {bigint} address 目标地址
 * @param {Array<{name: string, baseAddress: bigint, size: number}>} modules 模块列表
 * @returns {string}
 */
export function describeAddress(address, modules) {
	const value = BigInt(address);
	for (const module of modules ?? []) {
		const base = BigInt(module.baseAddress);
		const size = BigInt(module.size ?? 0);
		if (value >= base && value < base + size) {
			return `${module.name}+0x${(value - base).toString(16)}`;
		}
	}
	return formatAddress(value);
}

/** 在模块列表里按名字（大小写不敏感、可带/不带扩展名）找模块。 */
export function findModule(modules, name) {
	if (typeof name !== "string" || name.trim() === "") return null;
	const wanted = name.trim().toLowerCase();
	const bare = wanted.replace(/\.exe$|\.dll$/, "");
	for (const module of modules ?? []) {
		const moduleName = String(module.name).toLowerCase();
		if (moduleName === wanted) return module;
		if (moduleName.replace(/\.exe$|\.dll$/, "") === bare) return module;
	}
	return null;
}

/* ───────────────────────────── 展示辅助 ───────────────────────────── */

/** 把大数字节数渲染成人的读法。 */
export function formatBytesCount(bytes) {
	const value = BigInt(bytes);
	if (value < 1024n) return `${value} B`;
	if (value < 1024n * 1024n) return `${(Number(value) / 1024).toFixed(1)} KiB`;
	if (value < 1024n * 1024n * 1024n) return `${(Number(value) / 1048576).toFixed(1)} MiB`;
	return `${(Number(value) / 1073741824).toFixed(2)} GiB`;
}

/** 把毫秒渲染成人的读法。 */
export function formatDuration(ms) {
	if (!Number.isFinite(ms)) return "-";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

/** 内存保护属性 → 可读标志串。 */
export function describeProtection(protect) {
	const flags = [];
	if (protect & 0x100) flags.push("GUARD");
	if (protect & 0x200) flags.push("NOCACHE");
	const base = protect & 0xff;
	const table = {
		0x01: "NOACCESS",
		0x02: "R",
		0x04: "RW",
		0x08: "WC",
		0x10: "X",
		0x20: "RX",
		0x40: "RWX",
		0x80: "WCX"
	};
	flags.unshift(table[base] ?? `0x${base.toString(16)}`);
	return flags.join("|");
}

/** 内存区域分配类型 → 可读名字。 */
export function describeRegionType(type) {
	if (type === 0x1000000) return "IMAGE";
	if (type === 0x40000) return "MAPPED";
	if (type === 0x20000) return "PRIVATE";
	if (type === 0) return "FREE";
	return `0x${Number(type).toString(16)}`;
}

/**
 * 把 Lua / 内核返回值安全地转成可展示文本。
 *
 * 内核的 `LuaValue` 可以是 bigint / Buffer / Map / 嵌套数组 / 桥接对象，
 * 直接 JSON.stringify 会抛（bigint）或输出无意义内容，所以这里统一收敛。
 *
 * @param {unknown} value 任意返回值
 * @param {number} [depth] 递归深度上限
 * @returns {string}
 */
export function stringifyLuaValue(value, depth = 0) {
	if (value === null) return "nil";
	if (value === undefined) return "nil";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return formatBytesHex(value);
	if (depth > 6) return "…";
	if (Array.isArray(value)) {
		return `{${value.map((item) => stringifyLuaValue(item, depth + 1)).join(", ")}}`;
	}
	if (value instanceof Map) {
		const parts = [];
		for (const [k, v] of value) parts.push(`${stringifyLuaValue(k, depth + 1)} = ${stringifyLuaValue(v, depth + 1)}`);
		return `{${parts.join(", ")}}`;
	}
	if (typeof value === "object") {
		const seen = new Set();
		const parts = [];
		for (const [k, v] of Object.entries(value)) {
			if (typeof v === "function") continue;
			if (seen.has(k)) continue;
			seen.add(k);
			parts.push(`${k} = ${stringifyLuaValue(v, depth + 1)}`);
		}
		if (parts.length === 0) return "{}";
		return `{${parts.join(", ")}}`;
	}
	return String(value);
}

/** 人可读的字节数（Buffer / bigint / number 皆可）。 */