/**
 * 提权能力的**统一入口**：优先用 `dsh-get-admin` 插件，取不到时回退到本插件自带的实现。
 *
 * 承载三类东西：
 *   1. **后端**：启动/复用提权助手，拿到同步的远程内存后端（`startElevationBackend` 等）；
 *   2. **判定与建议**：是否已提权、识别权限错误、生成可执行建议
 *      （`isElevated` / `isPermissionDenied` / `permissionDeniedAdvice` / `enrichPermissionError`）；
 *   3. **同意闸门**：`askToElevate` —— 提权前征求用户同意。
 *
 * ## 为什么要这一层
 *
 * 「管理员权限」是**跨插件共享**的资源，不该由 cheat-engine 独占一份实现。
 * 它已被抽成独立插件 `dsh-get-admin`，通过 cordis 服务 `getAdmin` 对外提供；
 * cheat-engine 是消费方之一。
 *
 * 但直接 `import "dsh-get-admin"` 有几个现实问题，所以这里做一层适配：
 *
 *  1. **加载顺序不确定**：两个插件各自由 DSH 启动，get-admin 不一定先就绪。
 *  2. **包解析路径不确定**：插件目录下不一定能解析到 `dsh-get-admin`
 *     （取决于是否声明为依赖、是否被 pnpm 联接）。
 *  3. **回退要平滑**：解析不到时不能把 cheat-engine 弄坏 ——
 *     它自带的 `remote/launch.js` 与 `elevation-impl.js` 仍然可用，
 *     只是少一个"共享"的好处。
 *
 * 因此这里按顺序尝试几种解析方式，全失败则回退，并把原因记下来供诊断。
 *
 * ## 为什么第 2、3 类也放在这里
 *
 * 早先 `elevation.js` 在两个插件里**各有一份**，两份的 `permissionDeniedAdvice`
 * 文案很快就开始漂移（其中一份把"用助手提权"写成了不可行，会误导用户去重启会话）。
 * 既然提权归 get-admin，这些能力就以它为准、由本层统一转发，
 * 本地只保留一份**回退实现**（`elevation-impl.js`）。
 *
 * ## 与 cordis 服务的关系
 *
 * 走 cordis 服务（`ctx.inject(["getAdmin"], ...)`）是**更正统**的方式，但本模块
 * 也被 `lib/tools/*` 在**没有 ctx** 的场合调用（工具直接拿后端、直接给建议），
 * 所以这里用"模块解析"作为主路径，保持函数式接口不变。
 *
 * @module dsh-cheat-engine/elevation-backend
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import * as localElevation from "./elevation-impl.js";
import { resolveKernelDir } from "./kernel-paths.js";
import * as localLaunch from "./remote/launch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 插件根目录（`lib/` 的上一级）。 */
const PLUGIN_DIR = path.dirname(HERE);

/** 记住上一次解析失败的原因，便于 `ce_session` 之类的诊断输出如实说明。 */
let lastResolveError = null;
/** 缓存的 get-admin launch 模块（解析成功才有值）。 */
let cachedModule = null;

/**
 * 尝试解析 `dsh-get-admin` 的 `lib/launch.js`。
 *
 * 依次尝试：
 *   1. 包解析（`require("dsh-get-admin/lib/launch.js")`）—— 声明为依赖时可用；
 *   2. 与 cheat-engine **并排**的兄弟目录 `../dsh-get-admin`；
 *   3. pnpm 把 link 依赖实体化到的 `<profile>/node_modules/dsh-get-admin`
 *      （本插件目录经联接指向仓库，`..\..` 即 profile 的 node_modules）。
 *
 * @returns {{ module: object, via: string }|null}
 */
function resolveGetAdmin() {
	const require = createRequire(import.meta.url);
	const attempts = [];

	// ① 包解析（get-admin 声明为依赖时走这条）
	//
	// 用 `exports` 里声明的子路径 `dsh-get-admin/launch`，**不要**写
	// `dsh-get-admin/lib/launch.js` —— 后者会被 Node 的 exports 门禁拒掉
	// （ERR_PACKAGE_PATH_NOT_EXPORTED），在任何已发布安装里都必然失败。
	// get-admin 的 package.json 现已声明 `./launch` 等子路径。
	try {
		const mod = require("dsh-get-admin/launch");
		return { module: mod, via: "包解析（dsh-get-admin/launch）" };
	} catch (error) {
		attempts.push(`require("dsh-get-admin/launch"): ${error.message}`);
	}

	// ② 兄弟目录（两个仓库并排放在同一个父目录下）
	//
	// 支持用 `CE_GET_ADMIN_DIR` 覆盖：既方便把 get-admin 放在非默认位置，
	// 也让"回退分支"可被实测（指向一个不存在的目录即可强制走回退），
	// 否则要验证回退就得真的把 get-admin 移走，风险大且容易忘记还原。
	const siblingBase = process.env.CE_GET_ADMIN_DIR ?? path.join(path.dirname(PLUGIN_DIR), "dsh-get-admin");
	const sibling = path.join(siblingBase, "lib", "launch.js");
	if (fs.existsSync(sibling)) {
		try {
			return { module: require(sibling), via: `兄弟目录 ${sibling}` };
		} catch (error) {
			attempts.push(`${sibling}: ${error.message}`);
		}
	} else {
		attempts.push(`${sibling}: 不存在`);
	}

	// ③ 通过**包解析**再试一次（`dsh-get-admin` 声明为依赖时可用）。
	//
	// ⚠️ 这里**刻意不用"从仓库根往上跳一级找 profile 的 node_modules"这种推断**。
	// 早先的注释是错的：ESM 默认解析 realpath，`import.meta.url` 给出的是
	// **真实仓库路径** `<...>/dsh-cheat-engine/lib`，往上跳一级得到的是
	// `<父目录>/node_modules`（本机即 `D:\Project\node_modules`，不存在），
	// **不是** profile 的 node_modules。在 junction 布局下那条推断恒不命中。
	//
	// 正确的做法是交给 Node 的解析算法：它会依次查 `node_modules`、
	// 再向上逐级查（若 profile 把本插件与 get-admin 一起链进同一层，就能命中）。
	// 为了让"声明为依赖"这条路真的可用，get-admin 的 `exports` 已补上
	// `./launch`、`./elevation` 等子路径 —— 早先只有 `.`/`./client`/`./service`，
	// 于是子路径 require 必然抛 ERR_PACKAGE_PATH_NOT_EXPORTED。
	try {
		const resolved = require.resolve("dsh-get-admin/launch");
		return { module: require(resolved), via: `包解析 ${resolved}` };
	} catch (error) {
		attempts.push(`require.resolve("dsh-get-admin/launch"): ${error.message}`);
	}

	lastResolveError = attempts.join("；");
	return null;
}

/** 取 get-admin 的 launch 模块（带缓存）。解析不到返回 null。 */
function getAdminLaunch() {
	if (cachedModule !== null) return cachedModule;
	const resolved = resolveGetAdmin();
	if (resolved === null) return null;
	cachedModule = resolved.module;
	return cachedModule;
}

/**
 * 当前是否在使用 get-admin 的共享实现（而不是回退到自带副本）。
 *
 * @returns {{ shared: boolean, via: string|null, error: string|null }}
 */
export function elevationBackendStatus() {
	if (cachedModule !== null) return { shared: true, via: "已解析（get-admin）", error: null };
	const resolved = resolveGetAdmin();
	if (resolved !== null) return { shared: true, via: resolved.via, error: null };
	return { shared: false, via: null, error: lastResolveError };
}

/**
 * 启动（或复用）提权助手后端。
 *
 * 契约与 `dsh-get-admin` 的 `startHelperBackend` 一致，但**多一层内核解析**：
 * get-admin 的助手是通用实现，它不知道该用哪个 `node-cheat-engine`，
 * 所以必须由消费方（本插件）解析后传下去。少了这一步，助手会因为
 * "加载不到内核"而启动失败（实测：`助手没有就绪：启动失败或端口文件未生成`）。
 *
 * 调用方显式给了 `kernelPath` 时优先用它，否则用本插件的中立路径解析。
 *
 * @param {object} options 见 get-admin 的 `lib/launch.js`
 * @returns {Promise<object>}
 */
export async function startElevationBackend(options = {}) {
	// ⚠️ 这里必须把**空字符串**也当作"没给"。
	// 插件配置的默认值就是 `kernelPath: ""`（见 lib/index.js 的 CONFIG_DEFAULTS），
	// 而空字符串**不是 nullish** —— 早先用 `??` 判断，于是 "" 被原样传给助手，
	// 助手只能从自己所在目录向上找内核，必然失败：
	//   `helper 无法加载内核（node-cheat-engine）：... Cannot find module ...`
	// 表现为 e2e 里 `助手没有就绪：启动失败或端口文件未生成`，极难定位。
	const configured = typeof options.kernelPath === "string" && options.kernelPath.trim() !== "" ? options.kernelPath : undefined;
	const resolvedKernelPath = configured ?? resolveKernelDir({ configured }) ?? undefined;

	// ⚠️ **默认带上内核动作扩展**（除非调用方显式给了别的）。
	//
	// 提权助手已通用化：get-admin 的 `helper.js` 只有内存类方法，
	// `kernelAction`（安装/加载/卸载 DBK5 驱动）属于**领域知识**，只能由本插件提供。
	// 少了它，`ce_kernel install/load/unload` 会在**用户已点过一次 UAC 之后**
	// 抛 `helper 不支持的方法：kernelAction`，还把它误报成"启动助手失败"。
	//
	// 放在这一层而不是各调用点，是因为"记得传扩展"这件事不该靠人记：
	// 适配层是唯一的出口，兜在这里就不会漏。
	const withKernel = {
		...options,
		kernelPath: resolvedKernelPath,
		extensions: options.extensions ?? fileURLToPath(new URL("./remote/kernel-extension.js", import.meta.url))
	};

	const shared = getAdminLaunch();
	if (shared !== null) return await shared.startHelperBackend(withKernel);
	return await localLaunch.startHelperBackend(withKernel);
}

/**
 * 查询助手状态。
 *
 * @returns {object|null}
 */
export function elevationHelperStatus() {
	const shared = getAdminLaunch();
	if (shared !== null) return shared.helperStatus();
	return localLaunch.helperStatus();
}

/**
 * 释放助手（结束助手进程、清掉跨进程发现记录）。
 */
export function disposeElevationHelper() {
	// 两个实现都释放一次：解析结果可能在中途变化（例如插件热重载），
	// 而且两者都有幂等保护，重复调用是安全的。
	try {
		localLaunch.disposeHelper();
	} catch {
		/* 本地实现释放失败不该阻止共享实现释放 */
	}
	const shared = getAdminLaunch();
	if (shared !== null) {
		try {
			shared.disposeHelper();
		} catch {
			/* 已释放 */
		}
	}
}

/* ─────────────────── 提权「判定 / 建议 / 同意闸门」 ─────────────────── */

/**
 * 这些能力原本在 cheat-engine 的 `lib/elevation.js` 里，而 get-admin 里有一份
 * 几乎相同的副本 —— 两份的 `permissionDeniedAdvice` 文案已经开始漂移
 * （get-admin 那份还把"用助手提权"写成了不可行）。
 *
 * 既然提权已归属 get-admin，这些就以它为准，由本适配层统一转发；
 * 解析不到 get-admin 时回退到本插件自带的实现，**接口完全一致**。
 */

/**
 * 取 get-admin 的 elevation 模块（与 launch.js 同目录）。
 * @returns {object|null}
 */
function sharedElevation() {
	if (getAdminLaunch() === null) return null;
	const launchPath = getAdminPaths();
	if (launchPath === null) return null;
	try {
		const require = createRequire(import.meta.url);
		return require(path.join(path.dirname(launchPath), "elevation.js"));
	} catch (error) {
		lastResolveError = `elevation：${error.message}`;
		return null;
	}
}

/** get-admin 的 launch.js 绝对路径（用于定位同目录的兄弟模块，如 elevation.js）。 */
function getAdminPaths() {
	// 与 resolveGetAdmin 保持同样的候选顺序，别再各自维护一套推断。
	// ⚠️ 不要写 "从 PLUGIN_DIR 往上跳一级找 profile 的 node_modules" ——
	// ESM 解析 realpath，那一步会指向 `<父目录>/node_modules`（本机不存在），
	// 在 junction 布局下恒不命中。包解析交给 Node 即可。
	const siblingBase = process.env.CE_GET_ADMIN_DIR ?? path.join(path.dirname(PLUGIN_DIR), "dsh-get-admin");
	const candidates = [path.join(siblingBase, "lib", "launch.js")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	try {
		return createRequire(import.meta.url).resolve("dsh-get-admin/launch");
	} catch {
		return null;
	}
}

/** 当前进程是否以管理员身份运行。 */
export function isElevated() {
	const shared = sharedElevation();
	return (shared ?? localElevation).isElevated();
}

/** 重置已提权探测的缓存（测试用）。 */
export function resetElevationCache() {
	const shared = sharedElevation();
	(shared ?? localElevation).resetElevationCache();
}

/** 判断错误是否为「权限不足」。 */
export function isPermissionDenied(error) {
	const shared = sharedElevation();
	return (shared ?? localElevation).isPermissionDenied(error);
}

/** 生成「权限不足」的可执行建议。 */
export function permissionDeniedAdvice(context) {
	const shared = sharedElevation();
	return (shared ?? localElevation).permissionDeniedAdvice(context);
}

/** 把权限错误增强成带建议的错误。 */
export function enrichPermissionError(error, context) {
	const shared = sharedElevation();
	return (shared ?? localElevation).enrichPermissionError(error, context);
}

/** 提权前征求用户同意（拿不到人机交互时一律拒绝，绝不默默提权）。 */
export async function askToElevate(userQuestions, exec, context) {
	const shared = sharedElevation();
	return await (shared ?? localElevation).askToElevate(userQuestions, exec, context);
}
