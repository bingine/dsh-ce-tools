/**
 * 把旧包名/版本号统一改成发布用的新值。
 *
 * ## 改什么
 *
 *   · 内核包名：`node-cheat-engine` → **`@bingine/cemem`**
 *   · 主包名  ：`dsh-cheat-engine`  → **`dsh-ce-tools`**（npm 封禁了 "cheat-engine"）
 *   · 主包版本：→ **0.1.5**
 *   · 内核版本：→ **0.2.0**
 *
 * ## ⚠️ 只改白名单内的文件
 *
 * 本仓库里混着**第三方 Cheat Engine 源码**（`ce-src/`、`node-cheat-engine/_extract/`），
 * 它们的 README 里也有 "Cheat Engine" 字样 —— **绝不能动**。
 * 所以这里用**显式白名单**，而不是"排除某些目录"（后者一旦漏排除就会污染第三方源码）。
 *
 * 用法：node tools/rename-and-bump.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.dirname(HERE); // dsh-cheat-engine
const KERNEL = path.join(MAIN, "node-cheat-engine");
const GET_ADMIN = path.join(path.dirname(MAIN), "dsh-get-admin");

const DRY = process.argv.includes("--dry");

const NEW_KERNEL_NAME = "@bingine/cemem";
const OLD_KERNEL_NAME = "node-cheat-engine";
const NEW_MAIN_NAME = "dsh-ce-tools";
const OLD_MAIN_NAME = "dsh-cheat-engine";
const MAIN_VERSION = "0.1.5";
const KERNEL_VERSION = "0.2.0";

let touched = 0;
/** 记录改动，便于复核。 */
const report = [];

/** 读改写：把 oldName 换成 newName。返回是否改动。 */
function replaceInFile(file, pairs, label) {
	if (!fs.existsSync(file)) {
		report.push(`  ⚠️ 不存在，跳过：${label ?? file}`);
		return false;
	}
	const before = fs.readFileSync(file, "utf8");
	let after = before;
	for (const [from, to] of pairs) after = after.split(from).join(to);
	if (after === before) {
		report.push(`  · 无改动：${label ?? path.basename(file)}`);
		return false;
	}
	if (!DRY) fs.writeFileSync(file, after, "utf8");
	touched += 1;
	report.push(`  🔧 ${label ?? path.basename(file)}`);
	return true;
}

console.log(`=== ${DRY ? "干跑（不写盘）" : "执行"} ===\n`);

// ── ① 内核 package.json：版本 ───────────────────────────────
{
	const f = path.join(KERNEL, "package.json");
	const j = JSON.parse(fs.readFileSync(f, "utf8"));
	j.version = KERNEL_VERSION;
	if (!DRY) fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
	touched += 1;
	report.push(`  🔧 内核 package.json → ${j.name}@${j.version}`);
}

// ── ② 主包 package.json：版本 + 内核依赖 ────────────────────
{
	const f = path.join(MAIN, "package.json");
	const j = JSON.parse(fs.readFileSync(f, "utf8"));
	j.name = NEW_MAIN_NAME;
	j.version = MAIN_VERSION;
	j.dependencies = { ...(j.dependencies ?? {}), [NEW_KERNEL_NAME]: `^${KERNEL_VERSION}` };
	delete j.dependencies[OLD_KERNEL_NAME];
	if (!DRY) fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
	touched += 1;
	report.push(`  🔧 主包 package.json → ${j.name}@${j.version}，依赖 ${JSON.stringify(j.dependencies)}`);
}

// ── ③ 主包 lib/index.js：自报的包名与版本 ───────────────────
replaceInFile(
	path.join(MAIN, "lib", "index.js"),
	[
		[`const PACKAGE_NAME = "${OLD_MAIN_NAME}";`, `const PACKAGE_NAME = "${NEW_MAIN_NAME}";`],
		[/const PLUGIN_VERSION = "[^"]*";/, `const PLUGIN_VERSION = "${MAIN_VERSION}";`]
	],
	"主包 lib/index.js（PACKAGE_NAME + PLUGIN_VERSION）"
);

// ── ④ 我们自己文档里的包名引用（**显式白名单**）────────────
const DOCS = [
	path.join(MAIN, "README.md"),
	path.join(KERNEL, "README.md"),
	path.join(KERNEL, "PORT-SCOPE.md"),
	path.join(KERNEL, "docs", "assembler.md"),
	path.join(KERNEL, "docs", "autoassembler.md"),
	path.join(KERNEL, "docs", "backend-dbk.md"),
	path.join(KERNEL, "docs", "backends.md"),
	path.join(KERNEL, "docs", "lua-api.md")
];
for (const doc of DOCS) {
	replaceInFile(
		doc,
		[
			// require('node-cheat-engine') 这类**包名**引用
			[`require('${OLD_KERNEL_NAME}')`, `require('${NEW_KERNEL_NAME}')`],
			[`require("${OLD_KERNEL_NAME}")`, `require("${NEW_KERNEL_NAME}")`],
			[`'${OLD_KERNEL_NAME}'`, `'${NEW_KERNEL_NAME}'`],
			[`"${OLD_KERNEL_NAME}"`, `"${NEW_KERNEL_NAME}"`]
		],
		path.relative(MAIN, doc)
	);
}

// ── ⑤ 契约测试里若钉住了旧的内核包名，也要改 ────────────────
for (const testFile of ["test/e2e.test.mjs", "test/remote.test.mjs", "test/unit.test.mjs"]) {
	replaceInFile(
		path.join(MAIN, testFile),
		[[`"${OLD_KERNEL_NAME}"`, `"${NEW_KERNEL_NAME}"`]],
		testFile
	);
}

// ── ⑥ 内核解析链：新名优先，并保留旧名做兼容 ────────────────
replaceInFile(
	path.join(MAIN, "lib", "kernel-paths.js"),
	[[/const PACKAGE_NAMES = \[[^\]]*\];/, `const PACKAGE_NAMES = ["${NEW_KERNEL_NAME}", "${OLD_KERNEL_NAME}"];`]],
	"lib/kernel-paths.js 解析链"
);
replaceInFile(
	path.join(MAIN, "lib", "remote", "helper.js"),
	[[/for \(const packageName of \[[^\]]*\]\)/, `for (const packageName of ["${NEW_KERNEL_NAME}", "${OLD_KERNEL_NAME}"])`]],
	"lib/remote/helper.js 解析链"
);

console.log(report.join("\n"));
console.log(`\n  改动文件数：${touched}`);
console.log(`  目标：主包 ${NEW_MAIN_NAME}@${MAIN_VERSION} ／ 内核 ${NEW_KERNEL_NAME}@${KERNEL_VERSION}`);
if (DRY) console.log("  （干跑：未写盘）");
console.log(`  get-admin 不在改动范围内（路径：${path.basename(GET_ADMIN)}）`);
