/**
 * **反向验证** `test/startup.test.mjs` 里每一条守卫：把 bug 改回去，确认测试真的会红。
 *
 * ## 为什么必须有这个脚本
 *
 * 一条守卫测试如果**永远不会失败**，那它只是装饰 —— 本项目真实发生过
 * "把 `<StringLength>` 谎报为已修"这种事，而没有反向验证的守卫是同类问题的温床。
 *
 * 本脚本对每个变异：**临时改文件 → 跑对应测试 → 断言它失败 → 立刻还原**，
 * 并在 finally 里保证还原（即使测试进程崩了）。
 *
 * 用法：node tools/verify-guards.mjs
 * 需要环境变量 `GET_ADMIN_NO_ELEVATE=1`（否则提权路径可能弹窗）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
/** 相对仓库根的默认测试文件（变异可以自带 `tests` 覆盖）。 */
const TEST_FILE_REL = path.join("test", "startup.test.mjs");

/**
 * 每个变异：把某个文件里 `from` 换成 `to`（必须真的换到，否则算脚本自身出错），
 * 然后跑整个 startup 测试文件，期望它**失败**。
 *
 * 用「跑整个文件 + 期望失败 + 失败信息里必须出现 `expect`」的方式，
 * 而不是给 `node --test` 传 `--test-name-pattern`：后者在不同 Node 版本上
 * 过滤语义有差异，而且我们需要的是"这个变异一定被某条断言抓住"。
 */
const MUTATIONS = [
	{
		name: "① 客户端 id 改成旧包名（就是让应用起不来的那次改动）",
		file: "lib/client.js",
		from: 'id: "dsh-ce-tools"',
		to: 'id: "dsh-cheat-engine"',
		expect: /id（dsh-cheat-engine）必须等于包名|没注册|loaded without registering/
	},
	{
		name: "② 客户端 id 改成任意别的名字（id 与包名不一致的普遍情形）",
		file: "lib/client.js",
		from: 'id: "dsh-ce-tools"',
		to: 'id: "dsh-ce-tools-typo"',
		expect: /必须等于包名|loaded without registering/
	},
	{
		name: "③ wire.mjs 用旧包名（会把 profile 的加载行插成不存在的包）",
		file: "wire.mjs",
		from: 'const PACKAGE_NAME = "dsh-ce-tools";',
		to: 'const PACKAGE_NAME = "dsh-cheat-engine";',
		expect: /wire\.mjs 的 PACKAGE_NAME/
	},
	{
		name: "④ cordis.patch.yml 的加载行用旧包名",
		file: "cordis.patch.yml",
		from: "      name: 'dsh-ce-tools'",
		to: "      name: 'dsh-cheat-engine'",
		expect: /cordis\.patch\.yml 的 insert 行里必须有 name/
	},
	{
		name: "⑤ 工具数声称漂了（README 写回 15）",
		file: "README.md",
		from: "注册 16 个模型可直接调用的工具",
		to: "注册 15 个模型可直接调用的工具",
		expect: /声称的工具数不是 16/
	},
	{
		name: "⑥ 工具数声称漂了（lib/index.js 写回 15）",
		file: "lib/index.js",
		from: "注册 16 个工具，覆盖 Cheat Engine",
		to: "注册 15 个工具，覆盖 Cheat Engine",
		expect: /声称的工具数不是 16/
	},
	{
		name: "⑦ 工具数声称漂了（wire.mjs 的 toolCount）",
		file: "wire.mjs",
		from: "toolCount=16",
		to: "toolCount=14",
		expect: /声称的工具数不是 16/
	},
	{
		name: "⑧ PLUGIN_VERSION 与 package.json 不同步",
		file: "lib/index.js",
		// ⚠️ 锚点**不能写死版本号** —— 升版本时这条变异会"找不到锚点"而静默失效。
		// 用正则形式的 replaceFirst 不支持，所以改成按文件里**当前**的版本构造锚点。
		dynamicFrom: (text) => {
			const match = text.match(/const PLUGIN_VERSION = "[^"]*";/);
			return match === null ? null : match[0];
		},
		to: 'const PLUGIN_VERSION = "0.0.0-not-a-real-version";',
		expect: /PLUGIN_VERSION 必须等于 package\.json 的 version/
	},
	{
		name: "⑨ 出站 user-agent 用旧包名",
		file: "lib/kernel-driver.js",
		from: 'const PACKAGE_NAME = "dsh-ce-tools";',
		to: 'const PACKAGE_NAME = "dsh-cheat-engine";',
		expect: /user-agent 里的包名/
	},
	{
		name: "⑩ 出站 user-agent 版本漂了",
		file: "lib/kernel-driver.js",
		dynamicFrom: (text) => {
			const match = text.match(/const PACKAGE_VERSION = "[^"]*";/);
			return match === null ? null : match[0];
		},
		to: 'const PACKAGE_VERSION = "0.0.0-not-a-real-version";',
		expect: /user-agent 里的版本/
	},
	{
		name: "⑪ 内核解析链漏掉当前内核包名",
		file: "lib/kernel-paths.js",
		from: 'const PACKAGE_NAMES = ["@bingine/cemem", "node-cheat-engine"];',
		to: 'const PACKAGE_NAMES = ["node-cheat-engine"];',
		expect: /解析链必须包含内核包名/
	},
	{
		name: "⑫ exports 里 ./client 指向错误文件（客户端 bundle 解析不到）",
		file: "package.json",
		from: '"default": "./lib/client.js"',
		to: '"default": "./lib/client-broken.js"',
		expect: /exports 必须导出 \.\/client/
	},
	{
		name: "⑬ 同一份 bundle 里再注册一次（旧 id 残留的典型形态：load 被调两次）",
		file: "lib/client.js",
		from: "\nwindow.__ModuleLoader__.load({",
		to:
			'\nwindow.__ModuleLoader__.load({ id: "dsh-cheat-engine", factory: () => ({ apply() {}, inject: [] }) });\n' +
			"window.__ModuleLoader__.load({",
		expect: /只有一次 __ModuleLoader__\.load|绝不能|必须等于包名|duplicate factory registration/
	},
	{
		name: "⑭ acquire 输出层写回 `null.signer`（本机装了 CE 就抛 TypeError 的那个 bug）",
		file: "lib/tools/kernel.js",
		from: "const installerSignature = result.installerSignature ?? null;",
		to: "const installerSignature = result.installerSignature;",
		expect: /installerSignature 必须先归一|Cannot read properties of null/,
		tests: ["test/acquire-local-cepack.test.mjs"]
	},
	{
		name: "⑮ 从 installerSignature 上无保护地取 signer",
		file: "lib/tools/kernel.js",
		from: "`安装包签名主体：${installerSignature.signer ?? \"(读不到)\"}`",
		to: "`安装包签名主体：${result.installerSignature.signer}`",
		expect: /installerSignature|不得输出 undefined|裸取属性/,
		tests: ["test/acquire-local-cepack.test.mjs"]
	},
	{
		name: "⑯ 指针扫描器不再按选项复用（整张指针映射每次重建）",
		file: "lib/session.js",
		from: "const cached = this.pointerScanners.get(signature);",
		to: "const cached = undefined; void this.pointerScanners;",
		expect: /复用同一个实例|只应构造一次/,
		tests: ["test/startup.test.mjs"]
	},
	/* ── 下面这几条是 `.CT` 地址语义 / 表元数据那一轮（B1–B9）的守卫 ── */
	{
		name: "⑰ add 的地址规范化漏掉 `0d`/`0b` 字面量（0d20 会从 0x14 变成 0xd20）",
		// 审计用它做过反向验证：把 `add` 的规范化退回去之后
		// `ct-address-semantics.test.mjs` 曾经 12/12 全绿 —— 因为没有用例钉住
		// `add 0d20` / `add 0b101` 的实际取值。现在钉住了。
		file: "lib/values.js",
		from: "\tif (/^0d[0-9]+$/i.test(text)) {",
		to: "\tif (false && /^0d[0-9]+$/i.test(text)) {",
		expect: /add「0d20」|add「0b101」/,
		tests: ["test/ct-address-semantics.test.mjs"]
	},
	{
		name: "⑱ 裸十六进制字面量的表达式不再按 CE 语义（ff+20 / 1000+ff 两条路又不一致）",
		// ⚠️ 锚点跟着实现走：判据从「第一个操作数」（`startsWithBareHexLiteral`）
		// 换成**位置无关**的 `hasBareHexLiteral` 之后，这里也必须同步，
		// 否则这条变异会"找不到锚点"而静默失效（等于没验证）。
		file: "lib/values.js",
		from: "if (hasBareHexLiteral(text)) return toCeHexExpression(text);",
		to: "if (false && hasBareHexLiteral(text)) return toCeHexExpression(text);",
		expect: /未知的符号或模块|B3/,
		tests: ["test/ct-address-semantics.test.mjs"]
	},
	{
		name: "⑲ save 不再写回载入的表版本（又写死 46）",
		file: "lib/tools/table.js",
		from: "version: list.version,",
		to: "version: 46,",
		expect: /save 要写回载入的版本|必须原样写回 45/,
		tests: ["test/ct-address-semantics.test.mjs"]
	},
	{
		name: "⑳ save 覆盖用户表里原有的注释（插件那句替换原注释）",
		file: "lib/tools/table.js",
		from: 'comment: existingComment !== "" ? existingComment : `由 DSH cheat-engine 导出（目标 ${targetBrief}）`',
		to: "comment: `由 DSH cheat-engine 导出（目标 ${targetBrief}）`",
		expect: /原注释必须逐字保留/,
		tests: ["test/ct-address-semantics.test.mjs"]
	},
	{
		name: "㉑ save 丢掉根级未建模元素（<Structures>/<LuaScript>/<Forms>/<Files>/<CheatCodes>）",
		file: "lib/tools/table.js",
		from: "version: list.version,",
		to: "version: list.version,\n\t\t\t\trootExtra: [],",
		expect: /根级内容必须保留/,
		tests: ["test/ct-address-semantics.test.mjs"]
	},
	{
		name: "㉒ 合法空表与「不是 .CT」又共用一个说法（不实报错）",
		file: "lib/tools/table.js",
		from: 'if (parsed.rootName !== "CheatTable") {',
		to: "if (true) {",
		expect: /合法但没有任何 CheatEntry/,
		tests: ["test/ct-address-semantics.test.mjs"]
	},
	{
		name: "㉓ 未附加进程时 load 又去调 modulesCached（纯文件操作直接失败）",
		file: "lib/tools/table.js",
		from: "\tif (!hasLiveProcess(session)) return [];",
		to: "",
		expect: /还没有附加到任何进程/,
		tests: ["test/ct-address-semantics.test.mjs"]
	}
];

const NO_ELEVATE = { GET_ADMIN_NO_ELEVATE: "1" };

/**
 * 只替换**第一处**（与 `String.prototype.replace(string, string)` 一致）。
 *
 * ⚠️ 不能用 `String.prototype.replaceAll`，也不能用 PowerShell 的 `-replace`：
 * 后者是**正则替换全部**，而 `lib/client.js` 的注释里也有一处
 * `window.__ModuleLoader__.load({` —— 全替换会把注释里的示例也改掉，
 * 于是变异形态与真实 bug 不一致，反向验证就失去意义（本脚本第一版正是这么错的）。
 *
 * @param {string} text 原文
 * @param {string} from 要替换的文本
 * @param {string} to 替换成
 * @returns {string}
 */
function replaceFirst(text, from, to) {
	const index = text.indexOf(from);
	if (index === -1) return text;
	return text.slice(0, index) + to + text.slice(index + from.length);
}

/**
 * 跑一组测试文件，返回 `{ ok, output }`。
 *
 * 默认跑 `test/startup.test.mjs`；变异可以自带 `tests` 数组指向更贴切的文件
 * （例如 acquire 输出层的变异跑 `test/acquire-local-cepack.test.mjs` 更快、更精准）。
 *
 * @param {string[]} files 相对仓库根的测试文件
 */
function runTests(files) {
	const result = spawnSync(process.execPath, ["--test", ...files.map((file) => path.join(REPO, file))], {
		cwd: REPO,
		encoding: "utf8",
		env: { ...process.env, ...NO_ELEVATE },
		timeout: 600_000
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return { ok: result.status === 0, output };
}

/** 默认基线用的测试文件集（每个变异自己的 tests 会被单独跑）。 */
const ALL_TEST_FILES = [...new Set(MUTATIONS.flatMap((mutation) => mutation.tests ?? [TEST_FILE_REL]))];

console.log("=== 先确认基线：未变异时相关测试必须全绿 ===");
const baseline = runTests(ALL_TEST_FILES);
if (!baseline.ok) {
	console.error("❌ 基线就是红的 —— 先修好测试再谈反向验证。输出末尾：");
	console.error(baseline.output.slice(-3000));
	process.exit(1);
}
console.log("✅ 基线全绿\n");

let passed = 0;
const failures = [];

for (const mutation of MUTATIONS) {
	const target = path.join(REPO, mutation.file);
	const original = fs.readFileSync(target, "utf8");
	const mutationTests = mutation.tests ?? [TEST_FILE_REL];
	// 变异锚点可以是静态字符串（`from`），也可以按文件当前内容动态构造（`dynamicFrom`）——
	// 后者用于**含版本号**的锚点：写死版本的话，升版本时这条变异会"找不到锚点"而静默失效。
	const from = mutation.dynamicFrom !== undefined ? mutation.dynamicFrom(original) : mutation.from;
	try {
		if (from === null || from === undefined || !original.includes(from)) {
			// ⚠️ 找不到锚点**必须算失败**，不能跳过：跳过等于"这条守卫没被验证"，
			// 而脚本最后会报"通过 N/M"让人以为都验过了（本脚本第一版正是这么错的）。
			failures.push(`${mutation.name}：在 ${mutation.file} 里找不到要替换的文本「${from}」`);
			console.log(`  ❌ ${mutation.name} —— 找不到锚点（守卫未被验证）`);
			continue;
		}
		fs.writeFileSync(target, replaceFirst(original, from, mutation.to), "utf8");
		const { ok, output } = runTests(mutationTests);
		if (ok) {
			failures.push(`${mutation.name}：变异后测试**依然通过** —— 这条守卫是装饰品`);
			console.log(`  ❌ ${mutation.name} —— 测试没红（守卫无效）`);
			continue;
		}
		if (!mutation.expect.test(output)) {
			failures.push(
				`${mutation.name}：测试确实红了，但不是被预期的断言抓住（期望匹配 ${mutation.expect}）`
			);
			console.log(`  ⚠️  ${mutation.name} —— 红了但不是预期的那条断言`);
			continue;
		}
		passed += 1;
		console.log(`  ✅ ${mutation.name}`);
	} finally {
		// 无论如何都还原 —— 变异绝不能留在工作区里
		fs.writeFileSync(target, original, "utf8");
	}
}

console.log("");
console.log(`  反向验证通过 ${passed}/${MUTATIONS.length}`);
if (failures.length > 0) {
	console.log("  失败：");
	for (const line of failures) console.log(`    - ${line}`);
}

// 最后再确认一次：还原之后基线仍然全绿（保证脚本自身没有污染工作区）
const after = runTests(ALL_TEST_FILES);
if (!after.ok) {
	console.error("\n❌ 还原后基线变红 —— 脚本污染了工作区！输出末尾：");
	console.error(after.output.slice(-3000));
	process.exit(1);
}
console.log("  ✅ 还原后基线仍然全绿");

process.exit(failures.length === 0 ? 0 : 1);
