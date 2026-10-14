/**
 * `ce_kernel action=acquire` 的**「本机已装 CE」路径**回归。
 *
 * ## 这条测试钉住的真实崩溃
 *
 * `acquireDriver()` 有两条路：
 *   1. **首选**：本机已装 Cheat Engine → 直接解它的 `dbk64.cepack`
 *      （不联网、不需要安装包、不需要管理员 —— README 说这条最省事）；
 *   2. 兜底：下载官方安装包再解包。
 *
 * 第 1 条路返回的 `installerPath` / `installerSize` / `installerSignature` /
 * `installerSha256` 全都是 `null`（它根本没经过安装包）。而 `lib/tools/kernel.js`
 * 的输出层早先直接写 `result.installerSignature.signer` 与 `.status` —— 于是
 * **最省事的那条路一调用就抛**
 * `TypeError: Cannot read properties of null (reading 'signer')`：
 *   · 是**内部异常**而不是可读的领域错误（用户看到 TypeError，不知道该改什么）；
 *   · 只在**本机装了 CE** 时出现 —— 恰恰是它被设计为最优路径的那种机器；
 *   · 现有测试抓不到，因为它们只走「缓存里没有驱动」的失败分支。
 *
 * ## 怎么做到确定、离线、不需要管理员
 *
 * 分两段验证，各管一件事：
 *
 *   A. **真实解包链路**：自己合成一个 `.cepack`（格式极简：`"CEPACK"` 6 字节
 *      + 原始大小 uint32 LE + **裸 deflate**），里面放一个**真 PE 内核驱动**
 *      （本机 `ntfs.sys` 等，都是 IMAGE_SUBSYSTEM_NATIVE），
 *      调真实的 `unpackCepack` 与 `probePeHeaders`，确认解出来的就是原字节、
 *      且 PE 校验把非内核驱动挡在外面。
 *
 *   B. **工具输出层**：直接调 `describeAcquireResult()`（从 `ce_kernel` 里抽出的
 *      输出组装函数），喂一份「本机 cepack 路径」的结果形状，断言它**不抛
 *      TypeError** 且输出「没有用到安装包」。这正是崩溃的准确复现点，
 *      而且**不依赖网络、驱动、CE 安装或管理员权限**。
 *
 * 运行：node --test test/acquire-local-cepack.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { CEPACK_MAGIC, probePeHeaders, unpackCepack } from "../lib/kernel-driver.js";
import { describeAcquireResult } from "../lib/tools/kernel.js";

/** 本机现成的真内核驱动（PE32+ / IMAGE_SUBSYSTEM_NATIVE）。 */
const REAL_DRIVER_CANDIDATES = ["ntfs.sys", "tcpip.sys", "ndis.sys", "http.sys", "storport.sys"];

/** 找一个可用的真驱动；找不到就跳过（不假装跑过）。 */
function findRealDriver() {
	const root = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers");
	for (const name of REAL_DRIVER_CANDIDATES) {
		const candidate = path.join(root, name);
		try {
			if (fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 4096) return candidate;
		} catch {
			/* 换下一个 */
		}
	}
	return null;
}

/**
 * 合成一个 `.cepack`：`"CEPACK"` + 原始大小(uint32 LE) + 裸 deflate。
 *
 * @param {Buffer} payload 原始驱动字节
 * @param {string} targetPath 写到哪里
 * @param {number} [declaredSize] 头部声明的大小（默认如实写）
 */
function writeCepack(payload, targetPath, declaredSize = payload.length) {
	const head = Buffer.alloc(CEPACK_MAGIC.length + 4);
	head.write(CEPACK_MAGIC, 0, "latin1");
	head.writeUInt32LE(declaredSize, CEPACK_MAGIC.length);
	fs.writeFileSync(targetPath, Buffer.concat([head, zlib.deflateRawSync(payload)]));
}

/** 造一个临时目录并在结束时删掉。 */
function withTempDir(name, run) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), name));
	try {
		return run(tempDir);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * 「本机已装 CE、直接解 cepack」这条路上 `acquireDriver()` 的返回形状。
 *
 * 字段与 `lib/kernel-driver.js` 的 `finishAcquire()` 在该路径上的返回值**逐一对齐**
 * （四个 `installer*` 都是 `null`）。
 *
 * @param {object} [overrides] 覆盖个别字段
 * @returns {object}
 */
function localCepackAcquireResult(overrides = {}) {
	return {
		installerPath: null,
		installerOrigin: null,
		installerSize: null,
		installerSignature: null,
		installerSha256: null,
		sourceDescription: "本机 Cheat Engine 的 dbk64.cepack（已用内置 zlib 解包）",
		driverPath: "C:\\fake\\cache\\installed\\DBK64.sys",
		driverSize: 118016,
		pe: { isPe: true, is64Bit: true, is64BitPe: true, machine: "x64", subsystem: 1, isNativeDriver: true },
		signature: { status: "Valid", present: true, signer: "Cheat Engine" },
		sha256: "a".repeat(64),
		log: ["发现本机已安装的 Cheat Engine 驱动：C:\\CE\\dbk64.cepack（cepack）"],
		...overrides
	};
}

const realDriver = findRealDriver();
const driverSkip = realDriver === null
	? "本机找不到可用的真实内核驱动（System32\\drivers），跳过"
	: false;

/* ───────────────────── A. 真实解包链路 ───────────────────── */

test("cep：合成 cepack 必须能被真实解包器还原成**原字节**", { skip: driverSkip }, () => {
	withTempDir("ce-cepack-", (tempDir) => {
		const cepackPath = path.join(tempDir, "dbk64.cepack");
		const driverBytes = fs.readFileSync(realDriver);
		writeCepack(driverBytes, cepackPath);

		const result = unpackCepack(cepackPath);
		assert.equal(result.declaredSize, driverBytes.length, "头部声明的原始大小");
		assert.equal(result.data.length, driverBytes.length, "解出来的字节数");
		assert.equal(result.data.equals(driverBytes), true, "解出来的字节必须与原文件逐字节相同");
	});
});

test("cep：真内核驱动必须被判为 IMAGE_SUBSYSTEM_NATIVE（与 acquire 的校验同一口径）", { skip: driverSkip }, () => {
	const pe = probePeHeaders(realDriver);
	assert.equal(pe.isPe, true, "应当是合法 PE");
	assert.equal(pe.is64Bit, true, "真内核驱动应当是 PE32+");
	assert.equal(
		pe.isNativeDriver,
		true,
		`子系统应当是 1（IMAGE_SUBSYSTEM_NATIVE）；实际 ${pe.subsystem}。` +
			"这条曾经的真实 bug 是把 DllCharacteristics 的偏移当成了 Subsystem。"
	);
});

test("cep：不是内核驱动的东西必须被判 false（反例，防止 PE 校验形同虚设）", () => {
	const notepad = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe");
	assert.ok(fs.existsSync(notepad), "需要 notepad.exe 作为反例");
	const pe = probePeHeaders(notepad);
	assert.equal(pe.isPe, true, "notepad.exe 是合法 PE");
	assert.equal(pe.isNativeDriver, false, "notepad.exe 不是内核驱动，必须被判 false");
});

test("cep：合成 cepack 的头部声明大小与实际不符时必须**报错**（不静默接受半截数据）", { skip: driverSkip }, () => {
	withTempDir("ce-cepack-mismatch-", (tempDir) => {
		const cepackPath = path.join(tempDir, "mismatch.cepack");
		const driverBytes = fs.readFileSync(realDriver);
		// 头部故意声明一个错误的大小。
		// `unpackCepack` 的契约是：对不上就**抛错**（"文件可能损坏或被篡改"），
		// 而不是把解出来的东西照常交出去 —— 否则会拿一个不可信的驱动去 install。
		writeCepack(driverBytes, cepackPath, driverBytes.length + 12345);
		assert.throws(
			() => unpackCepack(cepackPath),
			(error) => {
				assert.match(String(error.message), /大小/, `错误里要说清是大小对不上：${error.message}`);
				assert.match(String(error.message), /不一致|损坏|篡改/, `要说明可能的原因：${error.message}`);
				return true;
			},
			"声明大小与实际不符必须报错"
		);
	});
});

/* ───────────────── B. 工具输出层（崩溃的准确复现点） ───────────────── */

test("acquire 输出层：源码级守卫 —— 四个可能为 null 的 installer* 字段必须先归一再用", async () => {
	// ## 为什么还要一条源码级守卫
	//
	// `describeAcquireResult()` 目前在**函数体顶部**就把四个字段归一成显式 `null`
	// （`result.x ?? null`），所以运行时它已经安全了 ——
	// 靠"喂一份 null 进去看会不会抛"是**测不出退化的**（`?? null` 恰好容忍 undefined）。
	//
	// 而这次的 bug 本质是**"某个字段可能不存在，但代码假设它一定存在"**。
	// 这类假设会在重构时悄悄回来（把归一删掉、或直接写 `result.installerSignature.signer`），
	// 而运行时测试抓不到。所以这里补一条**源码级**守卫：
	// 任何对这四个字段的**裸链式取值**都必须先有归一。
	//
	// 代价是它依赖一点源码文本形状 —— 所以锚点选得很窄（只看这四个字段名），
	// 且报错信息会直接告诉你怎么修。
	const source = fs.readFileSync(new URL("../lib/tools/kernel.js", import.meta.url), "utf8");
	const NULLABLE = [
		"installerSignature",
		"installerSize",
		"installerPath",
		"installerSha256",
		"installerOrigin"
	];
	for (const field of NULLABLE) {
		assert.ok(
			new RegExp(`const ${field} = result\\.${field}\\s*\\?\\?\\s*null;`).test(source),
			`${field} 必须先归一：\`const ${field} = result.${field} ?? null;\` —— ` +
				"本机装 CE 那条路上这个字段是 null/缺失（see 文件顶部说明）"
		);
	}

	// 另一条独立的守卫：**代码里**不允许直接对 `result.installer*` 链式取属性。
	//
	// ⚠️ 只扫代码、不扫注释与字符串字面量 —— 否则上面那句报错信息里
	// 示范性的 `result.installerSignature.signer` 会被自己误判。
	const codeOnly = source
		.replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
		.replace(/^\s*\/\/.*$/gm, "")       // 行注释
		.replace(/`[^`]*`/g, "``")          // 模板字符串
		.replace(/"(?:[^"\\]|\\.)*"/g, '""') // 双引号字符串
		.replace(/'(?:[^'\\]|\\.)*'/g, "''"); // 单引号字符串
	const nakedChains = [...codeOnly.matchAll(/result\.(installer\w+)\.\w+/g)].map((match) => match[1]);
	assert.deepEqual(
		nakedChains,
		[],
		`不得对 result.installer* 裸取属性（会抛 TypeError: Cannot read properties of null）：${nakedChains.join(", ")}`
	);
});

test("acquire 输出层：installer* 全为 null（本机 cepack 路径）时不得抛 TypeError，并说明没用到安装包", () => {
	let described;
	assert.doesNotThrow(() => {
		described = describeAcquireResult(localCepackAcquireResult(), ["unpack: C:\\CE\\dbk64.cepack"]);
	}, "本机 cepack 路径必须能正常组装输出 —— 早先这里抛 TypeError: Cannot read properties of null (reading 'signer')");

	// ① 必须明确说"没用到安装包"，而不是留一段空白或一个莫名的 (读不到)
	const body = described.lines.join("\n");
	assert.match(body, /没有用到安装包/, `应当说明本次没经过安装包：\n${body}`);
	assert.doesNotMatch(body, /安装包签名主体/, "没有安装包就不该输出安装包签名那一行");
	assert.doesNotMatch(body, /undefined|null/, `输出里不该漏出 undefined/null：\n${body}`);

	// ② 驱动侧信息必须齐全（这段永远要有）
	assert.match(body, /驱动 SHA256：a{64}/, "驱动 SHA256 必须有");
	assert.match(body, /驱动来源：本机 Cheat Engine 的 dbk64\.cepack/, "驱动来源必须有");
	assert.match(body, /驱动签名状态：Valid/, "驱动签名状态必须有");
	assert.match(body, /action=install/, "必须给出下一步");
	assert.match(described.summary, /已获取并校验 DBK64\.sys/, `summary 形状：${described.summary}`);

	// ③ data 里四个 installer* 必须是显式 null，而不是缺键
	//    （注册表要求"声明过的键"必须存在；缺键会让调用方以为我们忘了填）
	for (const key of ["installerPath", "installerSize", "installerSignature", "installerSigner", "installerSha256"]) {
		assert.ok(Object.hasOwn(described.data, key), `data 里必须有 ${key} 键`);
		assert.equal(described.data[key], null, `本机 cepack 路径下 ${key} 应当是 null`);
	}
	assert.equal(described.data.driverSize, 118016);
	assert.equal(described.data.driverSignaturePresent, true);
	assert.deepEqual(described.data.progress, ["unpack: C:\\CE\\dbk64.cepack"], "进度轨迹应当原样带出");
});

test("acquire 输出层：走安装包那条路时必须把签名与哈希一并报出（不能把两种路混为一谈）", () => {
	const described = describeAcquireResult(
		localCepackAcquireResult({
			installerPath: "C:\\cache\\downloads\\CheatEngine-7.7.exe",
			installerOrigin: "https://example.invalid/ce.exe",
			installerSize: 12345678,
			installerSignature: { status: "Valid", present: true, signer: "Cheat Engine" },
			installerSha256: "b".repeat(64)
		}),
		[]
	);
	const body = described.lines.join("\n");
	assert.doesNotMatch(body, /没有用到安装包/, "走了安装包就不该说没用到它");
	assert.match(body, /安装包：12345678 字节，来源 https:\/\/example\.invalid\/ce\.exe/, `应当报出来源：\n${body}`);
	assert.match(body, /安装包签名主体：Cheat Engine/, "应当报出安装包签名主体");
	assert.match(body, /安装包 SHA256：b{64}/, "应当报出安装包 SHA256");
	assert.equal(described.data.installerSignature, "Valid");
	assert.equal(described.data.installerSigner, "Cheat Engine");
	assert.equal(described.data.installerSize, 12345678);
});

test("acquire 输出层：字段整个缺失（老内核）时也必须退化得可读，而不是抛错", () => {
	// 老版本内核的 acquireDriver 可能压根没有 installerSha256 这个键。
	// 出口层必须容忍"键不存在"，不能因此抛错。
	const legacy = localCepackAcquireResult({
		installerPath: "C:\\cache\\cheatengine.exe",
		installerSize: 4096,
		installerSignature: { status: "NotSigned", present: false }
	});
	delete legacy.installerSha256;
	delete legacy.installerOrigin;

	let described;
	assert.doesNotThrow(() => {
		described = describeAcquireResult(legacy, []);
	});
	const body = described.lines.join("\n");
	assert.match(body, /来源 \(未知\)/, `来源缺失时要写「(未知)」而不是 undefined：\n${body}`);
	assert.match(body, /安装包 SHA256：\(读不到\)/, "哈希缺失时要写「(读不到)」");
	assert.equal(described.data.installerSha256, null, "缺失的哈希应当是显式 null");
});

test("acquire 输出层：驱动签名 signer 缺失时不得输出 undefined", () => {
	// 签名主体有时读不到（目录签名 / 权限受限），此时 signer 可能不存在。
	const described = describeAcquireResult(
		localCepackAcquireResult({
			installerPath: "x.exe",
			installerSize: 1,
			installerSignature: { status: "Valid", present: true }
		}),
		[]
	);
	assert.match(described.lines.join("\n"), /安装包签名主体：\(读不到\)/, "读不到就写「(读不到)」");
	assert.equal(described.data.installerSigner, null, "signer 缺失应当是显式 null");
});
