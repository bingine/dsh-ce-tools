#!/usr/bin/env node
/**
 * 提权助手进程 —— 权限不足时由插件按需拉起（可带 UAC 提权）。
 *
 * 它做两件事：
 *   1. 在本进程内加载 `node-cheat-engine` 内核并持有目标进程句柄；
 *   2. 在 `127.0.0.1` 上开一个只服务本插件的 TCP 端口，把内存操作暴露出去。
 *
 * 为什么必须是独立进程：Windows 的权限是进程级的，只有**这个进程**拿到管理员令牌，
 * 它打开的句柄才读得动高权限目标。
 *
 * 为什么它自己是**同步**的：它就在本进程里直接调 koffi/Win32，天然同步，
 * 于是扫描/指针扫描/汇编这些内部走同步路径的功能在它这一侧完全正常
 * （插件侧再通过 Atomics 桥把它伪装成同步后端，见 `worker.js`）。
 *
 * 安全约束：
 *   - 只监听 `127.0.0.1`；
 *   - 第一条消息必须是带正确 token 的 `hello`，否则立即断开（token 由调用方随机生成，
 *     128 位，防止同机其它进程误连或越权下单）；
 *   - 不提供任意文件读写、不执行任意代码（Lua/AA 是内核 API，不是 shell）。
 *
 * @module dsh-ce-tools/remote/helper
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { kernelDirCandidates } from "../kernel-paths.js";

import { encodeResponse, FrameReader } from "./protocol.js";
import { isElevated } from "../elevation.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 内核驱动模块（`lib/kernel-driver.js`）的懒加载缓存。
 *
 * 用 `require`（而不是 ESM 静态 import）的原因：该模块会用到 `node:fs`/`node:zlib`
 * 等，且在**不需要内核动作**的会话里完全没必要加载它 —— 助手的主要职责还是内存 RPC。
 * 助手是 CJS 互操作可用的（`createRequire`），所以拿得到。
 */
let kernelDriverModule = null;

/** 取内核驱动模块（只加载一次）。 */
function kernelDriver() {
	if (kernelDriverModule === null) {
		kernelDriverModule = require("../kernel-driver.js");
	}
	return kernelDriverModule;
}

/** 解析命令行参数。 */
function argOf(name, fallback) {
	const prefix = `--${name}=`;
	const hit = process.argv.find((value) => value.startsWith(prefix));
	return hit === undefined ? fallback : hit.slice(prefix.length);
}

/**
 * 读配置。
 *
 * 刻意**不**把 token 放在命令行上：Windows 下其它进程能通过 WMI 读到别人的命令行，
 * 所以 token 与路径统一走一个临时 JSON 文件，助手读完立刻删除。
 */
function readConfig() {
	const configPath = argOf("config", "");
	if (configPath !== "") {
		const raw = fs.readFileSync(configPath, "utf8");
		try {
			fs.unlinkSync(configPath);
		} catch { /* 删不掉不影响功能 */ }
		return JSON.parse(raw);
	}
	// 兼容直接传参的形式（测试与手工调试用）
	return {
		token: argOf("token", ""),
		portFile: argOf("port-file", ""),
		kernelPath: argOf("kernel", ""),
		idleTimeoutMs: Number(argOf("idle-timeout-ms", "1800000"))
	};
}

const CONFIG = readConfig();
const TOKEN = CONFIG.token ?? "";
const PORT_FILE = CONFIG.portFile ?? "";
const KERNEL_PATH = CONFIG.kernelPath ?? "";
const IDLE_TIMEOUT_MS = Number(CONFIG.idleTimeoutMs ?? 1800000);

if (TOKEN === "" || PORT_FILE === "") {
	process.stderr.write("helper: 缺少 token 或 portFile（见 lib/remote/helper.js 顶部说明）\n");
	process.exit(2);
}

/**
 * 内核目录的候选（与 lib/kernel.js 保持一致，插件侧显式传入时优先）。
 *
 * 刻意**不含任何硬编码绝对路径** —— 全部由 lib/kernel-paths.js 基于本文件位置推导，
 * 这样插件目录被移动到任何位置、或换台机器，都还能找到内核。
 */
function resolveKernel() {
	const candidates = [
		...(KERNEL_PATH === "" ? [] : [KERNEL_PATH]),
		...kernelDirCandidates()
	];
	const failures = [];
	for (const candidate of candidates) {
		try {
			return require(path.resolve(candidate));
		} catch (error) {
			failures.push(`${candidate}: ${error && error.message ? error.message : String(error)}`);
		}
	}
	// ⚠️ **两个包名都试**：内核发布时从 `node-cheat-engine` 改名为 `cecore`，
	// 而提权助手是**在另一个进程、另一个目录**里跑的 —— 它只能靠这里的顺序去找。
	// 只认新名会让既有环境（目录联接仍叫旧名）的助手**起来就退出**，
	// 而调用方只看到"助手没有就绪"，极难定位。
	for (const packageName of ["@bingine/cemem", "node-cheat-engine"]) {
		try {
			return require(packageName);
		} catch (error) {
			failures.push(`${packageName}: ${error && error.message ? error.message : String(error)}`);
		}
	}
	throw new Error(`helper 无法加载内核：\n  ${failures.join("\n  ")}`);
}

const ce = resolveKernel();

/** 句柄表：id → 内核 Process。 */
const handles = new Map();
let nextHandleId = 1;
let lastActivity = Date.now();
let authenticated = false;
/** 客户端断开后的宽限退出计时器。 */
let shutdownTimer = null;
/** 当前连接数。 */
let openConnections = 0;

/**
 * 客户端断开后等多久就自退。
 *
 * 为什么需要它：提权启动的助手**父进程无权杀死它**（管理员进程不能被普通进程终止），
 * 所以「插件卸载/DSH 退出后不留常驻管理员进程」这件事只能由助手自己决定 ——
 * 一旦客户端断连且宽限期内没有新连接，就自己退出。
 */
const CLIENT_GONE_GRACE_MS = Number(argOf("grace-ms", "8000"));

/** 进程是否以管理员身份运行（写进 port-file 供调用方核对）。 */
function isElevatedNow() {
	// 复用 lib/elevation.js 的只读探测（`net session` 能成功即有管理员权限）
	return isElevated();
}

/**
 * 执行一条 RPC。
 *
 * 内存类调用一律**直通内核后端**（`proc.backend` + `proc.backendHandle`），
 * 而不是走 `Process` 的高层方法：高层方法会把 `BackendRegion` 转成 `MemoryRegion`
 * （`regionSize`/`state` → `memorySize`/`committed`），再转回来就会丢信息、也可能走样。
 * 直通后端接口意味着这条通道的两端严格是同一种语义。
 *
 * @param {string} method 方法名
 * @param {object} params 参数
 * @param {Buffer} payload 原始字节（写内存用）
 * @returns {{ result?: unknown, payload?: Buffer }}
 */
function dispatch(method, params, payload) {
	/** 取句柄所在的内核后端与后端句柄，然后调用。 */
	const viaBackend = (id, name, ...args) => {
		const proc = requireHandle(id);
		const backend = proc.backend;
		const handle = proc.backendHandle;
		if (typeof backend[name] !== "function") {
			throw new Error(`内核后端 ${backend.name} 不支持 ${name}()`);
		}
		return backend[name](handle, ...args);
	};

	switch (method) {
		case "hello":
			return { result: { ok: true, pid: process.pid, elevation: isElevatedNow(), platform: process.platform } };
		case "listProcesses":
			return { result: ce.listProcesses() };
		case "openProcess": {
			// 句柄由助手持有：权限不足的失败就发生在这里，也正是需要提权的原因
			const proc = ce.Process.open(params.pid);
			const id = nextHandleId++;
			handles.set(id, proc);
			return { result: { id, pid: proc.pid, name: proc.name } };
		}
		case "closeProcess": {
			const proc = handles.get(params.id);
			handles.delete(params.id);
			if (proc !== undefined) proc.close();
			return { result: null };
		}
		case "queryRegions":
			return { result: viaBackend(params.id, "queryRegions", params.filter ?? {}) };
		case "readProcessMemory": {
			const buffer = viaBackend(params.id, "readProcessMemory", BigInt(params.address), params.size);
			return { result: { length: buffer.length }, payload: buffer };
		}
		case "writeProcessMemory":
			return {
				result: viaBackend(
					params.id,
					"writeProcessMemory",
					BigInt(params.address),
					payload,
					params.fixProtection !== false
				)
			};
		case "queryModules":
			return { result: viaBackend(params.id, "queryModules") };
		case "queryThreads":
			return { result: viaBackend(params.id, "queryThreads") };
		case "allocate":
			return {
				result: viaBackend(
					params.id,
					"allocate",
					params.size,
					params.protect,
					params.preferred === undefined ? undefined : BigInt(params.preferred)
				)
			};
		case "free":
			viaBackend(params.id, "free", BigInt(params.address));
			return { result: null };
		case "changeProtection":
			return {
				result: viaBackend(params.id, "changeProtection", BigInt(params.address), params.size, params.newProtect)
			};
		case "isWow64":
			return { result: viaBackend(params.id, "isWow64") };
		// 目标存活判断。
		//
		// ⚠️ 这个方法**必须**存在，否则「目标已退出」这条信息在远程后端下整个丢失：
		// 内核 `Process.isProcessAlive()`（win/process.ts）在 `backend.isProcessAlive`
		// 不是函数时如实返回 `undefined`，而 `CeSession.isTargetAlive()` 把 undefined
		// 当成「未知」放行 —— 于是所有工具退回旧行为，产物是**静默错值**：
		// `ce_modules` 返回 0 个模块、`ce_regions` 返回 0 个区域、
		// `ce_read` 报「…但目标进程**仍在运行**」（与事实相反）、
		// `ce_write` 甚至被包装成误导性的「权限不足」。
		// 句柄由助手持有，只有助手能问 Windows 真相，所以这里必须桥一次。
		case "isProcessAlive": {
			const proc = requireHandle(params.id);
			const backend = proc.backend;
			if (typeof backend.isProcessAlive !== "function") {
				// 后端自己无法判断（例如 ceserver）—— 如实报"未知"，而不是猜
				return { result: undefined };
			}
			return { result: backend.isProcessAlive(proc.backendHandle) };
		}
		case "kernelAction": {
			// 内核驱动动作（install/load/unload）。放在助手里的意义：
			// 助手**已经**是管理员，所以一次 UAC 之后，后续每次内核动作都复用
			// 这个进程，不再反复弹窗 —— 这正是「保存管理员权限」的正解
			// （Windows 不允许保存凭据；能保存的是"一个还在跑的提权进程"）。
			//
			// 仍然用白名单：助手是管理员进程，绝不能被当成任意函数调用通道。
			const allowed = new Set(["install", "load", "unload"]);
			const action = String(params.action ?? "");
			if (!allowed.has(action)) {
				throw new Error(`kernelAction 不允许的动作：${action}`);
			}
			// 同步 require（助手启动时已解析过内核），避免把 async 引入 dispatch
			const kd = kernelDriver();
			try {
				let result;
				if (action === "install") result = kd.installDriver({ driverPath: params.driverPath });
				else if (action === "load") result = kd.loadDriver();
				else result = kd.unloadDriver();
				return { result: { ok: true, log: Array.isArray(result?.log) ? result.log : [], result, error: null } };
			} catch (error) {
				// **失败也当正常返回值**（而不是 throw）：
				// RPC 的错误通道只传 `error.message`，挂在错误对象上的步骤日志会被丢掉；
				// 而内核动作的失败恰恰需要带上"走到哪一步了"。
				// 所以这里把 { ok:false, log, error } 作为 result 回传，让信息完整过去。
				return {
					result: {
						ok: false,
						log: Array.isArray(error && error.log) ? error.log : [],
						result: null,
						error: error && error.message ? String(error.message) : String(error)
					}
				};
			}
		}
		default:
			throw new Error(`helper 不支持的方法：${method}`);
	}
}

/** 取句柄，句柄失效时给出明确错误。 */
function requireHandle(id) {
	const proc = handles.get(id);
	if (proc === undefined) throw new Error(`句柄 ${id} 不存在（可能已关闭，或助手重启过）`);
	if (!proc.isOpen) throw new Error(`句柄 ${id} 已失效（目标进程可能已退出）`);
	return proc;
}

const server = net.createServer((socket) => {
	socket.setNoDelay(true);
	const reader = new FrameReader();
	authenticated = false;
	openConnections += 1;
	// 客户端来了就取消宽限退出
	if (shutdownTimer !== null) {
		clearTimeout(shutdownTimer);
		shutdownTimer = null;
	}

	socket.on("data", (chunk) => {
		lastActivity = Date.now();
		let frames;
		try {
			frames = reader.push(chunk);
		} catch (error) {
			socket.destroy();
			return;
		}
		for (const { header, payload } of frames) {
			// 认证：第一条消息必须是带正确 token 的 hello
			if (!authenticated) {
				if (header.method !== "hello" || header.token !== TOKEN) {
					socket.destroy();
					return;
				}
				authenticated = true;
			}
			lastActivity = Date.now();
			try {
				const { result, payload: outPayload } = dispatch(header.method, header.params ?? {}, payload);
				socket.write(encodeResponse({ id: header.id, ok: true, result }, outPayload ?? Buffer.alloc(0)));
			} catch (error) {
				socket.write(
					encodeResponse({
						id: header.id,
						ok: false,
						error: error && error.message ? String(error.message) : String(error)
					})
				);
			}
		}
	});
	socket.on("error", () => socket.destroy());
	socket.on("close", () => {
		openConnections -= 1;
		// 最后一条连接断了 → 宽限期后自退（提权进程无法被父进程杀掉，只能自己收尾）
		if (openConnections <= 0 && shutdownTimer === null) {
			shutdownTimer = setTimeout(() => shutdown(), CLIENT_GONE_GRACE_MS);
			shutdownTimer.unref?.();
		}
	});
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	// 端口写进文件：提权启动时拿不到子进程的 stdout，只能靠文件回传
	fs.writeFileSync(
		PORT_FILE,
		JSON.stringify({ port: address.port, pid: process.pid, elevated: isElevatedNow(), at: Date.now() }),
		"utf8"
	);
});

// 空闲自退：调用方崩了也不会留下一个常驻的管理员进程
setInterval(() => {
	if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
		for (const proc of handles.values()) {
			try {
				proc.close();
			} catch { /* 忽略 */ }
		}
		process.exit(0);
	}
}, 30_000).unref();

/** 被信号终止或客户端消失后收尾：尽量把句柄关掉再退出。 */
function shutdown() {
	for (const proc of handles.values()) {
		try {
			proc.close();
		} catch { /* 忽略 */ }
	}
	handles.clear();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
