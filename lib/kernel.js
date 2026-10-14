/**
 * node-cheat-engine 内核的加载与后端选择。
 *
 * 设计要点：
 * - **延迟加载**：插件激活时不去 require 内核。内核会 eager 加载 koffi 原生扩展
 *   并绑定 kernel32，任何环境问题都应在第一次真正用工具时暴露成一条可读错误，
 *   而不是让整个插件激活失败（那样界面只显示 `failed`，非常难查）。
 * - **可配置路径**：默认按「profile 配置 → 包依赖 → 同机默认内核目录」依次尝试。
 * - **只加载一次**：内核带状态（默认后端、指针映射缓存），重复 require 同一路径
 *   由 Node 的模块缓存保证单例；这里额外记住解析结果避免重复探测。
 *
 * @module dsh-cheat-engine/kernel
 */
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

import { KERNEL_PACKAGE_NAMES, kernelDirCandidates } from "./kernel-paths.js";

const require = createRequire(import.meta.url);

/** 已解析的内核（模块缓存之外再记一层，避免反复做文件系统探测）。 */
let cachedKernel = null;

/** 汇编后端（capstone/keystone WASM）的初始化 Promise；幂等。 */
let asmReady = null;

/** 把 Windows 路径统一成正斜杠，便于拼进错误信息与 require。 */
function toSlashes(value) {
	return String(value).replace(/\\/g, "/");
}

/**
 * 依次尝试各候选路径，返回第一个可 require 的。
 *
 * @param {object} config 已合并默认值的配置
 * @returns {{ ce: object, resolvedFrom: string }}
 */
function requireKernel(config) {
	const attempts = [];

	/** 试一个 require 目标；成功返回模块，失败记录原因。 */
	const attempt = (target, label) => {
		try {
			const ce = require(target);
			return { ce, resolvedFrom: label, target };
		} catch (error) {
			attempts.push(`${label}: ${error && error.message ? error.message : String(error)}`);
			return null;
		}
	};

	// 1) 显式配置优先
	if (typeof config.kernelPath === "string" && config.kernelPath.trim() !== "") {
		const explicit = toSlashes(config.kernelPath.trim());
		const hit = attempt(explicit, `config.kernelPath (${explicit})`);
		if (hit) return hit;
	}

	// 2) 作为包依赖解析（profile 或插件自己的 node_modules）
	//
	// ⚠️ **两个包名都试**：内核发布时从 `node-cheat-engine` 改名为 `cecore`，
	// 而改名前用 `wire.mjs` 接过的地方，`node_modules` 里的**目录联接仍叫旧名**。
	// 只认新名会让这些既有环境突然起不来（而报错只会说"未安装"，很难定位）。
	for (const packageName of KERNEL_PACKAGE_NAMES) {
		try {
			const resolved = require.resolve(packageName);
			const hit = attempt(resolved, `依赖 ${packageName} (${toSlashes(resolved)})`);
			if (hit) return hit;
		} catch (error) {
			attempts.push(`依赖 ${packageName}: 未安装（${error && error.message ? error.message : String(error)}）`);
		}
	}

	// 3) 基于自身位置推导出的候选（依赖目录 / 兄弟仓库目录）
	//    刻意**不含任何硬编码绝对路径** —— 见 lib/kernel-paths.js 的说明。
	for (const candidate of kernelDirCandidates()) {
		const hit = attempt(toSlashes(candidate), `就近推导 (${toSlashes(candidate)})`);
		if (hit) return hit;
	}

	const error = new Error(
		[
			"未能加载 node-cheat-engine 内核。已尝试：",
			...attempts.map((line) => `  - ${line}`),
			"",
			"处理办法（任选其一）：",
			"  1. 在插件行的 config 里设置 kernelPath 指向内核目录；",
			"  2. 把内核作为依赖装进插件或 profile（node_modules/node-cheat-engine）；",
			"  3. 设置环境变量 CE_KERNEL_PATH 指向内核目录；",
			"  4. 把内核仓库与插件仓库放在**同一个父目录**下（例如 tasks/ 与 tasks/plugin/ 并列）。"
		].join("\n")
	);
	error.attempts = attempts;
	throw error;
}

/**
 * 加载内核（幂等）。
 *
 * @param {object} config 已合并默认值的配置
 * @returns {{ ce: object, resolvedFrom: string }}
 */
export function loadKernel(config) {
	if (os.platform() !== "win32") {
		throw new Error(
			`Cheat Engine 能力只能在 Windows 上使用（当前平台：${os.platform()}）。` +
			"node-cheat-engine 通过 koffi 直接调用 kernel32/psapi，其他平台没有等价实现。"
		);
	}
	const wanted = typeof config.kernelPath === "string" ? config.kernelPath.trim() : "";
	if (cachedKernel !== null && cachedKernel.configKey === wanted) return cachedKernel;

	const hit = requireKernel(config);
	const kernel = {
		ce: hit.ce,
		resolvedFrom: hit.resolvedFrom,
		configKey: wanted,
		// 导出项数一并带上：ce_session 会展示它，用来区分「内核加载了」和
		// 「加载到的是一个空壳/错版本」。第一版漏了这个字段，界面上显示成
		// 「导出 undefined 项」——实时调用时才看出来。
		exports: Object.keys(hit.ce).length
	};
	cachedKernel = kernel;
	// 换内核意味着换实现，汇编后端必须重新初始化
	asmReady = null;
	return kernel;
}

/** 已加载的内核信息（供诊断；不会触发加载）。 */
export function kernelStatus() {
	if (cachedKernel === null) return { loaded: false };
	return {
		loaded: true,
		resolvedFrom: cachedKernel.resolvedFrom,
		exports: cachedKernel.exports
	};
}

/**
 * 确保反汇编/汇编后端（capstone-wasm / keystone-wasm）已初始化。
 *
 * 内核**不会**替你初始化：没 await 过就调用 `assemble` / `disassemble` /
 * `AutoAssembler.*` 会抛 `AsmBackendError('…尚未初始化…')`。初始化失败不会被缓存，
 * 因此可以重试。
 *
 * @param {object} ce 内核模块
 * @returns {Promise<{ capstone: string, keystone: string }>} 引擎版本
 */
export async function ensureAsm(ce) {
	if (asmReady === null) {
		asmReady = (async () => {
			await ce.ensureAsmBackend();
			return ce.backendVersions();
		})().catch((error) => {
			asmReady = null; // 允许重试
			throw error;
		});
	}
	return asmReady;
}

/**
 * 取用哪个「内存后端」。
 *
 * - `self`（默认）：内核自带引擎，koffi 直接调 Win32，零外部依赖、同步、跨进程可用。
 * - `native-ce`：连接官方 `ceserver` 的 TCP 协议，可读受保护进程，但需要你自己
 *   先跑起 ceserver，且所有内存操作必须走 await 的异步变体。
 * - `dbk`：走 CE 的 DBK 内核驱动 ioctl。**需要驱动已加载**（用 `ce_kernel` 装），
 *   同步、可读受保护进程。⚠️ 该后端的 ioctl 结构未经真机验证，详见 README。
 *
 * @param {object} ce 内核模块
 * @param {object} config 已合并默认值的配置
 * @returns {{ backend: object | null, name: string, async: boolean, note?: string }}
 */
export function resolveBackend(ce, config) {
	const wanted = String(config.backend ?? "self").toLowerCase();

	if (wanted === "dbk" || wanted === "dbk64" || wanted === "kernel") {
		const backend = new ce.DbkBackend({
			serviceName: config.dbkServiceName ?? "",
			cheatEngineDir: config.cheatEngineDir ?? ""
		});
		return {
			backend,
			name: "dbk",
			async: false,
			note:
				"DBK 后端：内存读写走内核驱动 ioctl。设备打不开时会明确报错" +
				"（需要先用 ce_kernel 安装并加载驱动，且需管理员权限）。"
		};
	}

	if (wanted === "native-ce" || wanted === "ceserver") {
		const backend = new ce.NativeCeBackend({
			host: config.ceserverHost ?? "127.0.0.1",
			port: Number(config.ceserverPort ?? ce.CESERVER_DEFAULT_PORT ?? 52736)
		});
		return { backend, name: "native-ce", async: true };
	}
	// self：用内核的进程级默认后端，不额外 new（保持指针映射与句柄复用）
	return { backend: null, name: "self", async: false };
}
