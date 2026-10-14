#!/usr/bin/env node
/**
 * 把 dsh-ce-tools 接进一个 dsh profile。
 *
 * 四步，全部幂等、且每一步前都留时间戳备份：
 *   1. 校验内核（@bingine/cemem，仓库目录仍叫 node-cheat-engine）真的能 require 起来 ——
 *      不然后面接进去只会得到一个 `failed` 的行，比现在报错难查得多；
 *   2. 在插件自己的 `node_modules` 里为内核建目录联接，让 `require('@bingine/cemem')`
 *      能解析到（这是内核解析链的第 2 步，第 3 步是内置的默认目录兜底）；
 *   3. profile 的 `package.json` 里登记 `link:` 依赖；
 *   4. `<profile>/node_modules/<包名>` 建成指向本仓库的目录联接；
 *   5. 在 profile 的 `cordis.patch.yml` 里插入加载行。
 *
 * ⚠️ 包名与目录名是两件事（改名时最容易踩的坑）：
 *   · **包名** = `package.json` 的 `name`（现在是 `dsh-ce-tools`）；
 *   · **目录名** 随意 —— 本仓库所在的目录可能叫 `dsh-cheat-engine`（改名前的历史遗留）
 *     或 `dsh-ce-tools`（从 GitHub 克隆下来的默认名），**都不影响功能**。
 * 下面 `PACKAGE_NAME` 必须取**包名** —— 它同时用来建 profile 侧的联接、
 * 登记 profile 依赖、以及写加载行的 `name:`。写成目录名会让加载行指向一个
 * 不存在的包（`npm 封禁 "cheat-engine" 之后包名是 dsh-ce-tools`）。
 * `test/startup.test.mjs` 会检查它与 `package.json` 一致。
 *
 * **不需要任何 peer 联接**：本插件刻意不 import 任何 `@deepseek-ai/*` 包（见
 * `lib/index.js` 顶部第 1 条）—— 桌面版自带 dsh 与 profile 里 `@deepseek-ai/*`
 * 联接指向的 npm 全局 dsh 版本不同，asar 里的包又不可能做联接目标，所以「零依赖」
 * 是唯一能同时装进桌面版和 `dsh web`、且不受版本漂移影响的做法。
 *
 * 用法：
 *   node wire.mjs                          # 接入 desktop profile（桌面版本会话用的就是它）
 *   node wire.mjs --profile web            # 换一个 profile
 *   node wire.mjs --kernel <内核目录>       # 显式指定 node-cheat-engine 目录
 *   node wire.mjs --unwire                 # 摘掉加载行、联接与依赖
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
};

/**
 * 本包的**包名**（= `package.json` 的 `name`）与加载行标识。
 *
 * ⚠️ 这个常量有三个消费者，全都要求它是**包名**而不是目录名：
 *   1. `<profile>/node_modules/<PACKAGE_NAME>` 联接的目标名；
 *   2. profile `package.json` 的依赖键；
 *   3. 加载行的 `name: '<PACKAGE_NAME>'`。
 * 与**目录名**（可能是 `dsh-cheat-engine` 或 `dsh-ce-tools`，取决于你怎么拿到这份代码）
 * 混淆会让 profile 里出现一个指向本仓库、但名字是旧包名的联接，
 * 而加载行又会去解析一个不存在的包。
 */
const PACKAGE_NAME = "dsh-ce-tools";
const ROW_ID = "cheat-engine";
/** 只读状态路由：接入后用它确认插件真的激活了。 */
const STATUS_PATH = "/cheat-engine/status";

/**
 * 内核目录的候选（与 lib/kernel.js 的解析保持一致）。
 *
 * 刻意**不写死绝对路径**：本文件位于插件根，内核是与 `lib/` 并列的子目录，
 * 所以优先找 `<插件根>/node-cheat-engine`，其次 `node_modules/node-cheat-engine`。
 * 用 `--kernel` 或环境变量 CE_KERNEL_PATH 可显式覆盖。
 */
const KERNEL_CANDIDATES = [
	path.join(HERE, "node-cheat-engine"),
	path.join(HERE, "node_modules", "node-cheat-engine")
];

const PROFILE = value("--profile", "desktop");
const DSH_HOME = path.resolve(value("--home", process.env.DSH_HOME || path.join(os.homedir(), ".dsh")));
const UNWIRE = flag("--unwire");
const KERNEL_ARG = value("--kernel", "");

const profileDir = path.join(DSH_HOME, "profiles", PROFILE);
if (!fs.existsSync(profileDir)) {
	console.error(`找不到 profile：${profileDir}`);
	console.error(`已存在的 profile：${fs.existsSync(path.join(DSH_HOME, "profiles"))
		? fs.readdirSync(path.join(DSH_HOME, "profiles")).join(", ")
		: "(一个都没有)"}`);
	process.exit(1);
}
const packageJsonPath = path.join(profileDir, "package.json");
const patchPath = path.join(profileDir, "cordis.patch.yml");

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** 目录联接在 Windows 上要用 rmSync；普通符号链接要用 unlink。 */
function removeLink(target) {
	try {
		fs.rmSync(target, { recursive: false, force: true });
		return;
	} catch { /* 继续尝试其它方式 */ }
	try {
		fs.unlinkSync(target);
		return;
	} catch { /* 继续 */ }
	fs.rmdirSync(target);
}

const isLink = (target) => {
	try {
		return fs.lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
};

const sameReal = (left, right) => {
	try {
		return fs.realpathSync(left) === fs.realpathSync(right);
	} catch {
		return false;
	}
};

/** 改动 profile 前先留一份带时间戳的备份。 */
function backup(file) {
	if (!fs.existsSync(file)) return null;
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
	const target = `${file}.bak-${stamp}`;
	try {
		fs.copyFileSync(file, target);
		console.log(`+ 已备份：${path.basename(target)}`);
		return target;
	} catch (error) {
		console.error(`! 备份失败（继续）：${error.message}`);
		return null;
	}
}

/** 目标不是「我要的那个」就强制重建 —— pnpm 会留下空目录冒充成功。 */
function link(from, to, label) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	if (sameReal(to, from)) {
		console.log(`= 已联接：${label}`);
		return;
	}
	if (fs.existsSync(to) || isLink(to)) removeLink(to);
	fs.symlinkSync(from, to, "junction");
	console.log(`+ 已联接：${label}`);
}

/* ─────────────────────── 1. 校验内核可用 ─────────────────────── */

if (!UNWIRE) {
	const candidates = KERNEL_ARG === "" ? KERNEL_CANDIDATES : [KERNEL_ARG];
	let kernelDir = null;
	let kernelModule = null;
	const failures = [];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) {
			failures.push(`${candidate}（目录不存在）`);
			continue;
		}
		try {
			kernelModule = require(candidate);
			kernelDir = candidate;
			break;
		} catch (error) {
			failures.push(`${candidate}（${error && error.message ? error.message : String(error)}）`);
		}
	}
	if (kernelDir === null) {
		console.error("找不到可用的 node-cheat-engine 内核。已尝试：");
		for (const line of failures) console.error(`  - ${line}`);
		console.error("\n用 --kernel <目录> 显式指定内核目录。");
		process.exit(1);
	}
	const processes = kernelModule.listProcesses().length;
	console.log(`+ 内核可用：${kernelDir}`);
	console.log(`  导出 ${Object.keys(kernelModule).length} 项，当前可枚举 ${processes} 个进程，默认后端 "${kernelModule.getDefaultBackend().name}"`);

	// 2. 让 require('node-cheat-engine') 从插件目录能解析到
	link(kernelDir, path.join(HERE, "node_modules", "node-cheat-engine"), "插件/node_modules/node-cheat-engine");
}

/* ─────────────────────────── 卸载分支 ─────────────────────────── */

/** 加载行的文本块（插入与摘除共用同一段，保证能精确匹配）。 */
const ROW_BLOCK = [
	"",
	"# ── Cheat Engine 能力（跨进程内存读写 / 扫描 / 指针扫描 / 汇编注入 / Lua / .CT）",
	"# 内核：node-cheat-engine（Cheat Engine 核心引擎的 Node 移植），纯用户态、无需 CE 本体。",
	"# 配置项：backend(self|native-ce)、allowWrite、allowLua、kernelPath、pointerScanMaxLevel 等。",
	`# Source: ${HERE}`,
	"- insert:",
	`    - id: ${ROW_ID}`,
	`      name: '${PACKAGE_NAME}'`
].join("\n");

if (UNWIRE) {
	if (fs.existsSync(patchPath)) {
		let patch = fs.readFileSync(patchPath, "utf8");
		if (patch.includes(ROW_BLOCK)) {
			fs.writeFileSync(patchPath, patch.replace(ROW_BLOCK, "").trimEnd() + "\n", "utf8");
			console.log(`+ 已移除加载行：${patchPath}`);
		} else {
			const cleaned = patch.replace(
				new RegExp(`\\n- insert:\\n\\s+- id: ${ROW_ID}\\n\\s+name: '${PACKAGE_NAME}'`, "g"),
				""
			);
			if (cleaned !== patch) {
				fs.writeFileSync(patchPath, cleaned.trimEnd() + "\n", "utf8");
				console.log(`+ 已移除加载行（宽松匹配）：${patchPath}`);
			} else {
				console.log("= 加载行不存在");
			}
		}
	}
	if (fs.existsSync(packageJsonPath)) {
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		if (pkg.dependencies !== undefined && pkg.dependencies[PACKAGE_NAME] !== undefined) {
			delete pkg.dependencies[PACKAGE_NAME];
			fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
			console.log("+ 已移除 profile 依赖");
		}
	}
	for (const target of [
		path.join(profileDir, "node_modules", PACKAGE_NAME),
		path.join(HERE, "node_modules", "node-cheat-engine")
	]) {
		if (fs.existsSync(target) || isLink(target)) {
			removeLink(target);
			console.log(`+ 已移除联接：${target}`);
		}
	}
	console.log(`\n完成（卸载）—— profile: ${PROFILE}`);
	process.exit(0);
}

/* ─────────────────────────── 3~5. 接入 ─────────────────────────── */

backup(packageJsonPath);
backup(patchPath);

// 3. profile 依赖
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
pkg.dependencies = pkg.dependencies ?? {};
const wanted = `link:${HERE.replaceAll("\\", "/")}`;
if (pkg.dependencies[PACKAGE_NAME] === wanted) {
	console.log(`= 依赖已记录：${PACKAGE_NAME}`);
} else {
	pkg.dependencies[PACKAGE_NAME] = wanted;
	fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
	console.log(`+ 依赖：${PACKAGE_NAME} -> ${wanted}`);
}

// 4. profile 侧联接
link(HERE, path.join(profileDir, "node_modules", PACKAGE_NAME), `${PROFILE}/node_modules/${PACKAGE_NAME}`);

// 5. 加载行
let patch = fs.readFileSync(patchPath, "utf8");
if (patch.includes(ROW_BLOCK) || new RegExp(`- id: ${ROW_ID}\\n\\s+name: '${PACKAGE_NAME}'`).test(patch)) {
	console.log(`= 加载行已存在：${ROW_ID}`);
} else {
	// 新 profile 的根是空的 `[]`，插行前先把它去掉
	patch = `${patch.replace(/^\s*\[\]\s*$/m, "").trimEnd()}\n${ROW_BLOCK}\n`;
	fs.writeFileSync(patchPath, patch, "utf8");
	console.log(`+ 已插入加载行：${ROW_ID}`);
}

console.log("");
console.log(`完成 —— profile: ${PROFILE}`);
console.log("桌面版 dsh 通常能靠 HMR 直接热加载这一行；若工具没出现，重启一次即可。");
console.log(`验证插件是否激活：GET http://127.0.0.1:19387${STATUS_PATH}`);
console.log(`  返回 JSON 里 toolCount=16 就说明注册成功（该路由只读，不会触碰任何目标进程）。`);
console.log("卸载：node wire.mjs --unwire");
