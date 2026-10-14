/**
 * 内核（node-cheat-engine）目录的解析。
 *
 * ## 为什么需要它
 *
 * 插件运行时并不保证内核已被 npm 依赖解析到。早先的做法是把开发机的
 * 绝对路径写死成候选（形如 `"D:/某人的项目/.../node-cheat-engine"`），这有两个问题：
 *
 *   1. **不可移植** —— 换机器、换盘符、换目录布局就失效；
 *   2. **不可读** —— 把一个开发者的私有目录结构固化进了产品代码。
 *
 * ## 现在的解析顺序
 *
 * 全部基于"本文件自身的位置"或环境变量推导，**不依赖任何绝对路径**：
 *
 *   1. 显式配置（插件 config 的 `kernelPath`）与环境变量 `CE_KERNEL_PATH`；
 *   2. 插件包自己的依赖：`<插件>/node_modules/node-cheat-engine`
 *      （本仓库正是这种布局：内核作为子目录 + node_modules 联接）；
 *   3. 与插件根**同级**的子目录：`<插件根>/node-cheat-engine`
 *      （内核作为仓库子目录的布局）；
 *   4. 与插件根**并排**的兄弟仓库：`<父目录>/node-cheat-engine`
 *      （两个仓库并排 clone 的布局）。
 *
 * 任一路径只要含有 `package.json` 即视为有效候选。
 *
 * @module dsh-ce-tools/kernel-paths
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 本文件所在目录（`lib/` 或 `lib/remote/` 等），用于向上推导。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 本文件所在目录的**真实路径**。
 *
 * 必须解析符号链接/junction：本插件常以 junction 方式链进 DSH profile
 * （例如 `~/.dsh/profiles/<profile>/node_modules/<插件名>` → 插件的真实目录）。
 * 若不解析，向上推导会得到 profile 的目录树，
 * 永远找不到与插件放在一起的内核。
 */
const REAL_HERE = (() => {
	try {
		return fs.realpathSync(HERE);
	} catch {
		return HERE;
	}
})();

/**
 * 内核的 npm 包名。
 *
 * ⚠️ 这个包**改过名**：原先叫 `node-cheat-engine`，发布时为了让名字独特易记
 * 改成了 **`cecore`**。
 *
 * 但**两个名字都要认**，原因：
 *   · 新装的用户从 npm 拿到的是 `cecore`；
 *   · 而在改名前用 `wire.mjs` 接过的地方，`node_modules` 里那个**目录联接仍叫
 *     `node-cheat-engine`** —— 只认新名会让这些既有环境**突然起不来**。
 *
 * 注意"目录名"与"包名"是两件事：本仓库的**目录**依然叫 `node-cheat-engine`
 * （git 历史、路径引用、`wire.mjs` 都依赖它），改的只是`package.json` 里的 `name`。
 */
const PACKAGE_NAMES = ["@bingine/cemem", "node-cheat-engine"];

/** 首选包名（新建联接、依赖声明用这个）。 */
const PACKAGE_NAME = PACKAGE_NAMES[0];

/**
 * 判断一个目录是否像内核仓库（有 `package.json` 即可，避免误判空目录）。
 *
 * @param {string} dir 候选目录
 * @returns {boolean}
 */
function looksLikeKernel(dir) {
	try {
		return fs.statSync(path.join(dir, "package.json")).isFile();
	} catch {
		return false;
	}
}

/**
 * 按优先级给出内核目录候选（**不含任何硬编码绝对路径**）。
 *
 * @param {object} [options]
 * @param {string} [options.configured] 用户配置里显式指定的路径（最高优先级）
 * @param {string} [options.fromDir] 从哪里向上推导（默认本文件所在目录）
 * @returns {string[]} 去重后的候选路径列表
 */
export function kernelDirCandidates(options = {}) {
	const fromDir = options.fromDir ?? REAL_HERE;
	const out = [];

	/** 依次推入候选，跳过空值与重复项。 */
	const push = (value) => {
		if (typeof value !== "string" || value === "") return;
		const normalized = path.resolve(value);
		if (!out.includes(normalized)) out.push(normalized);
	};

	// 1. 显式配置 / 环境变量
	push(options.configured);
	push(process.env.CE_KERNEL_PATH);

	// 2. 插件包内的依赖目录：从 fromDir 向上找 node_modules
	//    ⚠️ 两个包名都试（见 PACKAGE_NAMES 的说明：改名后仍要认旧目录联接）
	let dir = path.resolve(fromDir);
	for (;;) {
		for (const name of PACKAGE_NAMES) push(path.join(dir, "node_modules", name));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// 3. 与"插件包根目录"同级的兄弟目录。
	//    插件包根目录 = 向上找到的第一个含 package.json 的目录。
	//    ⚠️ 这里**刻意不写死包名** —— 包名改过（`dsh-cheat-engine` → `dsh-ce-tools`），
	//    写死会让改名前后的 checkout 其中之一失效。
	dir = path.resolve(fromDir);
	for (;;) {
		if (looksLikeKernel(dir) || fs.existsSync(path.join(dir, "package.json"))) {
			const parent = path.dirname(dir);
			for (const name of PACKAGE_NAMES) {
				push(path.join(parent, name));
				// 4. 再上一层（仓库可能被放在一个分组目录里）
				push(path.join(path.dirname(parent), name));
			}
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return out;
}

/**
 * 解析出第一个有效的内核目录。
 *
 * @param {object} [options] 同 {@link kernelDirCandidates}
 * @returns {string|null} 内核目录绝对路径；都不存在时返回 null
 */
export function resolveKernelDir(options = {}) {
	for (const candidate of kernelDirCandidates(options)) {
		if (looksLikeKernel(candidate)) return candidate;
	}
	return null;
}

export { looksLikeKernel, PACKAGE_NAME as KERNEL_PACKAGE_NAME, PACKAGE_NAMES as KERNEL_PACKAGE_NAMES };
