/**
 * 提权助手的生命周期：按需启动、等待就绪、连接、回收。
 *
 * ## 三种启动方式
 *
 * 1. **不提权**（`elevate: false`）：直接 `spawn(node, helper.js)`。用途是自测 ——
 *    整条远程链路可以在没有 UAC 的情况下被完整验证（e2e 就是这么跑的）。
 * 2. **提权**（`elevate: true`）：`PowerShell Start-Process -Verb RunAs` 触发 UAC。
 *    提权后**拿不到子进程的 pid，也拿不到它的 stdout**，所以端口靠一个临时文件回传。
 * 3. 复用：同一进程内如果已经有一个健康的助手，直接复用，避免反复弹 UAC。
 *
 * ## 安全取舍
 *
 * - token 与内核路径写进临时配置文件（助手读完即删），**不走命令行** ——
 *   Windows 下别的进程能通过 WMI 读到命令行，token 泄露等于把提权内存通道交出去。
 * - 助手只监听 `127.0.0.1`，首条消息必须带正确 token。
 * - 助手有空闲自退，调用方崩了也不会留下常驻的管理员进程。
 *
 * @module dsh-ce-tools/remote/launch
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { RemoteMemoryBackend } from "./backend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.join(HERE, "helper.js");

/** 已启动的助手（同一 DSH 进程内复用）。 */
let current = null;

/** 简单的同步等待（启动探测是短轮询，没必要引入计时器抽象）。 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成一次性临时文件名。 */
function tempFile(prefix) {
	return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`);
}

/**
 * 启动（或复用）助手，并返回一个已认证的远程后端。
 *
 * @param {object} options 选项
 * @param {boolean} options.elevate 是否通过 UAC 提权启动
 * @param {string} [options.kernelPath] 内核目录（透传给助手）
 * @param {number} [options.idleTimeoutMs] 助手空闲自退时间
 * @param {number} [options.timeoutMs] RPC 超时
 * @param {number} [options.launchTimeoutMs] 等待助手就绪的上限
 * @param {(message: string) => void} [options.log] 日志回调
 * @returns {Promise<RemoteMemoryBackend>}
 */
export async function startHelperBackend(options) {
	const log = options.log ?? (() => {});
	if (current !== null && current.backend !== null) {
		// 复用前先做一次便宜的探活：助手可能已经空闲自退或被关掉了
		try {
			current.backend.listProcesses();
			log("复用已运行的提权助手");
			return current.backend;
		} catch {
			disposeHelper();
		}
	}

	// 进程内没有 → 试试**跨进程**复用：上一轮（或上一次 DSH 运行）留下的提权助手
	// 可能还在跑。能连上就完全不弹 UAC。
	if (options.discoverExisting !== false) {
		const discovered = connectToDiscoveredHelper();
		if (discovered !== null) {
			const info = helperStatusFrom(discovered);
			current = { backend: discovered, ...info };
			log(`发现并复用了**已在运行**的提权助手（pid ${info.pid}，端口 ${info.port}），不需要 UAC`);
			return discovered;
		}
	}

	const token = crypto.randomBytes(24).toString("hex");
	const portFile = tempFile("ce-helper-port");
	const configFile = tempFile("ce-helper-cfg");

	// ⚠️ **闸门要在建临时文件之后立刻清理**。
	// 这里的 configFile 含本次 token（凭证性质），被闸门拦下时若不删，
	// 无人值守/CI 反复触发就会在 %TEMP% 里堆一串含 token 的配置文件。
	// 权威实现（dsh-get-admin/lib/launch.js）同样在抛错前清理 —— 三条提权路径
	// 的清洁度必须一致，否则"别留垃圾"这条验收项只做到了两条。
	if (options.elevate === true && process.env.GET_ADMIN_NO_ELEVATE === "1") {
		for (const file of [configFile, portFile]) {
			try {
				fs.unlinkSync(file);
			} catch {
				/* 不存在更好 */
			}
		}
		throw new Error(
			"提权已被 GET_ADMIN_NO_ELEVATE=1 禁用（无人值守保护）。\n" +
				"要真正提权，请先清除该环境变量，并由人在 UAC 弹窗中确认。"
		);
	}

	fs.writeFileSync(
		configFile,
		JSON.stringify({
			token,
			portFile,
			kernelPath: options.kernelPath ?? "",
			idleTimeoutMs: options.idleTimeoutMs ?? 1800000,
			// 领域扩展（例如 kernelAction）：助手是通用实现，不知道内核驱动，
			// 必须由消费方提供模块路径，否则 kernelAction 会"不存在"。
			extensions: options.extensions ?? ""
		}),
		"utf8"
	);
	try {
		fs.unlinkSync(portFile);
	} catch { /* 不存在更好 */ }

	const args = [HELPER_PATH, `--config=${configFile}`];
	/** 提权启动器进程（UAC 路径）；非提权路径为 null。 */
	let launcher = null;
	/** 启动器自身的错误（例如 powershell 找不到）。 */
	let launcherError = null;
	/** 启动器的退出码：UAC 被拒时 powershell 会以非零码退出。 */
	let launcherExitCode = null;
	if (options.elevate === true) {
		// 无人值守闸门已在前面（建临时文件之后、spawn 之前）统一判断并清理过，
		// 这里不再重复 —— 重复的闸门会让"到底哪一处生效"变得含糊。
		// UAC：只传一个配置文件路径，避免引号与转义问题
		const command =
			`Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' ` +
			`-ArgumentList @('${HELPER_PATH.replace(/'/g, "''")}','--config=${configFile.replace(/'/g, "''")}') ` +
			"-Verb RunAs -WindowStyle Hidden";
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
			windowsHide: true,
			stdio: "ignore",
			detached: false
		});
		launcher = child;
		child.on("error", (error) => {
			launcherError = error;
		});
		child.on("exit", (code) => {
			launcherExitCode = code;
		});
		log("已请求 UAC 提权启动助手（请在弹窗中确认）");
	} else {
		const child = spawn(process.execPath, args, { windowsHide: true, stdio: "ignore" });
		child.on("error", () => { /* 同上 */ });
		child.unref?.();
		log("已启动助手（未提权）");
	}

	// 提权时还要等用户点 UAC，给足时间。
	//
	// 但**不能只等超时**：用户在 UAC 弹窗点「否」时，powershell 会立刻退出，
	// 而助手永远不会就绪。早先的实现会一直干等到 90 秒才报错 ——
	// 实测被感知为「一拒绝耗时就变长」，非常糟。
	// 所以这里同时盯着启动器进程：它一消失且没有端口文件，就立刻给出结论。
	const deadline = Date.now() + (options.launchTimeoutMs ?? (options.elevate === true ? 90_000 : 20_000));
	let info = null;
	let launcherGone = false;
	while (Date.now() < deadline) {
		if (fs.existsSync(portFile)) {
			try {
				info = JSON.parse(fs.readFileSync(portFile, "utf8"));
				if (typeof info.port === "number" && info.port > 0) break;
			} catch { /* 文件可能正写到一半，下一轮再读 */ }
			info = null;
		}
		// 启动器退出且端口文件还没出现 → 提权未发生（UAC 被拒 / 被策略拦截）。
		// 再等下去没有意义，立刻失败。
		if (launcher !== null && launcherExitCode !== null && launcherError === null) {
			// 给助手一点点余量把端口文件写完（正常路径下它几乎同时出现）
			await sleep(300);
			if (!fs.existsSync(portFile)) {
				launcherGone = true;
				break;
			}
		}
		if (launcherError !== null) break;
		await sleep(150);
	}
	if (info === null) {
		// 助手启动失败时别留下半截临时文件
		for (const file of [configFile, portFile]) {
			try {
				fs.unlinkSync(file);
			} catch { /* 忽略 */ }
		}
		if (launcherGone || launcherError !== null) {
			throw new Error(
				"提权被取消：请求提权的进程已退出，但没有启动助手。\n" +
					"最常见的原因是**在 UAC 弹窗里点了「否」**（或弹窗被策略拦截、没被确认）。\n" +
					`（启动器退出码 ${launcherExitCode ?? "-"}` +
					`${launcherError !== null ? `，错误：${launcherError.message}` : ""}）`
			);
		}
		throw new Error(
			options.elevate === true
				? "提权助手没有就绪：可能 UAC 被取消、被策略拦截，或助手启动失败。"
				: "助手没有就绪：启动失败或端口文件未生成。"
		);
	}

	const backend = new RemoteMemoryBackend({
		host: "127.0.0.1",
		port: info.port,
		token,
		timeoutMs: options.timeoutMs ?? 60_000
	});
	try {
		fs.unlinkSync(portFile);
	} catch { /* 忽略 */ }
	current = { backend, pid: info.pid, elevated: info.elevated === true, port: info.port };
	// 只有**提权**助手才留"发现记录"：它的价值就是被复用，
	// 而未提权助手随时能便宜地重建，留记录反而增加攻击面。
	if (current.elevated) writeDiscovery({ port: info.port, pid: info.pid, token });
	else clearDiscovery();
	log(
		`助手就绪：pid ${info.pid}，端口 ${info.port}，` +
		`助手权限 ${backend.helperElevated ? "已提权" : "未提权"}`
	);
	return backend;
}

/* ------------------------------------------------------------------ *
 * 跨进程复用：发现记录
 *
 * 为什么需要：`current` 是**进程内**状态。DSH 一重启（或换一个进程调用），
 * 即使提权助手还在跑，也看不到它、只能重新弹 UAC。
 * 记一条发现记录后，新进程可以先试着连上那个**已经在运行**的助手，
 * 连上就完全不需要 UAC。
 *
 * 安全取舍：记录里含 token，等于"复用一个已授权通道的能力"。
 * 但它只写在**当前用户**的 profile 目录（非世界可读），
 * 且助手自身 30 分钟空闲就自退 —— 与"保存管理员密码"是完全不同量级的事：
 * 这里保存的是一个迟早会消失的会话凭证，而不是长期凭据。
 * ------------------------------------------------------------------ */

/** 发现记录路径（按用户隔离）。 */
function discoveryPath() {
	const base =
		process.env.DSH_PROFILE_DIR ??
		process.env.LOCALAPPDATA ??
		os.homedir();
	return path.join(base, "ce-helper-discovery.json");
}

/** 写入发现记录（尽力而为，失败不影响主流程）。 */
function writeDiscovery(info) {
	try {
		fs.writeFileSync(
			discoveryPath(),
			JSON.stringify({ ...info, at: Date.now() }),
			{ encoding: "utf8", mode: 0o600 }
		);
	} catch {
		/* 写不进去就只是失去"跨进程复用"这个优化 */
	}
}

/** 清除发现记录。 */
function clearDiscovery() {
	try {
		fs.unlinkSync(discoveryPath());
	} catch {
		/* 不存在更好 */
	}
}

/**
 * 尝试连上一个**已经在运行的提权助手**（来自发现记录）。
 *
 * @returns {RemoteMemoryBackend|null} 连上并认证成功则返回后端，否则 null
 */
function connectToDiscoveredHelper() {
	let info;
	try {
		info = JSON.parse(fs.readFileSync(discoveryPath(), "utf8"));
	} catch {
		return null;
	}
	if (
		info === null ||
		typeof info.port !== "number" ||
		typeof info.token !== "string" ||
		info.token === ""
	) {
		clearDiscovery();
		return null;
	}
	try {
		// 构造即验证：RemoteMemoryBackend 的构造函数会做一次 hello + token 认证
		const backend = new RemoteMemoryBackend({
			host: "127.0.0.1",
			port: info.port,
			token: info.token,
			timeoutMs: 15_000
		});
		if (backend.helperElevated !== true) {
			// 记录里本应只有提权助手；不是就当作过期记录清掉
			backend.dispose();
			clearDiscovery();
			return null;
		}
		return backend;
	} catch {
		// 助手已经自退 / 端口不通 —— 记录过期
		clearDiscovery();
		return null;
	}
}

/** 当前助手的描述（没有则为 null）。 */
export function helperStatus() {
	if (current === null) return null;
	return { pid: current.pid, port: current.port, elevated: current.elevated };
}

/**
 * 从一个已连接的后端取助手描述。
 *
 * `RemoteMemoryBackend` 自己知道助手 pid（`hello` 时拿到的）与是否提权，
 * 所以不需要额外的握手。
 */
function helperStatusFrom(backend) {
	const elevated = backend.helperElevated === true;
	// worker 与助手之间是本地 socket，对端端口可从后端记录里取；
	// 这里的 port 只用于诊断展示，取不到就给 0。
	return {
		pid: typeof backend.helperPid === "number" ? backend.helperPid : 0,
		port: typeof backend.helperPort === "number" ? backend.helperPort : 0,
		elevated
	};
}

/**
 * 释放当前助手。
 *
 * 两步都要做：
 *   1. 关掉 RPC 通道（worker 里的 socket）；
 *   2. **主动结束助手进程** —— 否则会在用户机器上留下一个常驻的、可能带管理员权限的进程。
 *      未提权时 `process.kill` 直接有效；提权时父进程无权杀它，改由助手自己察觉到
 *      「客户端断了」后退出（见 helper.js 的 socket close 宽限退出）。
 */
export function disposeHelper() {
	if (current === null) return;
	try {
		current.backend.dispose();
	} catch { /* 忽略 */ }
	try {
		if (typeof current.pid === "number" && current.pid > 0) process.kill(current.pid);
	} catch { /* 提权/已退出时会失败，交给助手的宽限退出 */ }
	current = null;
	// 也要清掉跨进程发现记录 —— 否则下一个进程会去连一个已经被我们放弃的助手
	clearDiscovery();
}
