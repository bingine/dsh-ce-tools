/**
 * 一次性提权执行器：在**管理员**权限下跑一个内核驱动操作，并把结果回传。
 *
 * ## 为什么不能复用 `remote/helper.js`
 *
 * `helper.js` 是个**常驻**进程，解决的是"内存操作要管理员权限"。
 * 而内核驱动的 install/load/unload 是**一次性、有副作用**的动作，
 * 需要的是"提权执行一次然后退出"，不是常驻服务。所以这里另做一个最小执行器：
 *
 * ```
 *   ce-kernel-elevate-runner.js --config=<临时json>
 *          ↓ 管理员权限下执行
 *   调用 kernel-driver.js 的 installDriver / loadDriver / unloadDriver
 *          ↓
 *   把 { ok, log, error } 写回结果文件
 * ```
 *
 * ## 提权后拿不到 stdout，所以结果走文件
 *
 * 与 `launch.js` 同一个原因：`Start-Process -Verb RunAs` 启动的进程与父进程
 * **没有继承关系**，拿不到 pid、拿不到 stdout/stderr。
 * 因此输入（动作与参数）走临时配置文件，输出走临时结果文件，父进程轮询等待。
 *
 * ## 安全取舍（与 launch.js 一致）
 *
 * - 输入**只走配置文件、不走命令行** —— Windows 下其他进程能用 WMI 读命令行；
 * - 结果文件用**随机名 + 父进程专属**，并校验写入者是本次请求的标记；
 * - 执行器**只接受白名单动作**（install / load / unload），拒绝任意代码执行；
 * - 超时后**不会**去杀提权进程（父进程无权终止它），只报告未就绪 ——
 *   所以动作本身必须是短命、幂等的（`sc.exe` 调用天然如此）。
 *
 * @module dsh-ce-tools/remote/kernel-elevate
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { elevationHelperStatus } from "../elevation-backend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "kernel-elevate-runner.js");

/** 允许通过提权执行的动作白名单。 */
export const ELEVATED_KERNEL_ACTIONS = Object.freeze(["install", "load", "unload"]);

/**
 * 用户最近一次**拒绝** UAC 的时间戳。
 *
 * 为什么需要它：用户点「否」说明他此刻不想提权。此时如果下一次动作又自动弹窗，
 * 体感就是「一直弹，很烦」。所以拒绝后进入一段冷却期，期间**不再自动弹 UAC**，
 * 而是把"手工怎么做"告诉他。
 *
 * 为什么冷却而不是永久：用户可能只是当时点错了，或者先去做别的事。
 * 冷却结束（或他显式要求）就恢复自动提权能力。
 */
let lastDeclinedAt = null;

/** 拒绝后的冷却时长（毫秒）。 */
export const ELEVATION_DECLINE_COOLDOWN_MS = 120_000;

/**
 * 拒绝记录的落盘路径。
 *
 * **为什么要落盘**：进程内变量在 DSH 重启后就没了，于是"你刚拒绝过"这件事
 * 也跟着丢失，重启后第一次动作又会弹 —— 用户感知依旧是「一直弹」。
 * 记到文件才能跨进程、跨重启地尊重用户的拒绝。
 *
 * 文件里只有一个时间戳，不含任何令牌 —— 单纯一个"别烦我"的标记。
 */
function declineRecordPath() {
	const base = process.env.DSH_PROFILE_DIR ?? process.env.LOCALAPPDATA ?? os.homedir();
	return path.join(base, "ce-elevation-declined.json");
}

/** 记录一次用户拒绝（同时落盘，跨重启生效）。 */
export function noteElevationDeclined(at = Date.now()) {
	lastDeclinedAt = at;
	try {
		fs.writeFileSync(declineRecordPath(), JSON.stringify({ at }), {
			encoding: "utf8",
			mode: 0o600
		});
	} catch {
		/* 写不进去就只保留进程内效果 */
	}
}

/** 清掉拒绝记录（用户显式要求再试时用）。 */
export function clearElevationDeclined() {
	lastDeclinedAt = null;
	try {
		fs.unlinkSync(declineRecordPath());
	} catch {
		/* 不存在更好 */
	}
}

/**
 * 当前是否处于"刚被拒绝"的冷却期。
 *
 * 先看进程内，再读落盘的记录 —— 后者让 **DSH 重启后也记得用户的拒绝**。
 * 没有这条，重启就等于"忘掉你刚点过否"，第一次动作又会弹。
 */
export function isElevationCoolingDown(now = Date.now()) {
	if (lastDeclinedAt !== null && now - lastDeclinedAt < ELEVATION_DECLINE_COOLDOWN_MS) return true;
	try {
		const raw = JSON.parse(fs.readFileSync(declineRecordPath(), "utf8"));
		if (raw !== null && typeof raw.at === "number" && Number.isFinite(raw.at)) {
			if (now - raw.at < ELEVATION_DECLINE_COOLDOWN_MS) {
				lastDeclinedAt = raw.at;
				return true;
			}
			// 记录已过期：顺手清掉，免得文件一直躺着
			clearElevationDeclined();
		}
	} catch {
		/* 没有记录 = 没拒绝过 */
	}
	return false;
}

/** 判断一个错误是否是"用户拒绝/取消提权"。 */
function isElevationDeclinedError(error) {
	const text = String((error && error.message) || error || "");
	return /提权被取消|UAC 被拒绝|UAC 被取消|点了「否」|被策略拦截/.test(text);
}

/**
 * 通过一个**提权助手**执行内核动作。
 *
 * @param {object} params
 * @param {string} params.action install / load / unload
 * @param {string} [params.driverPath] install 用
 * @param {number} [params.timeoutMs] 单次 RPC 超时
 * @param {boolean} params.launchIfMissing 没有提权助手时是否新建一个（会弹 UAC）
 * @param {boolean} [params.discoverExisting] 是否允许复用跨进程发现的提权助手
 * @param {(m: string) => void} params.log 日志
 * @returns {Promise<{ ok: boolean, log: string[], result: object|null, error: string|null }>}
 */
async function callKernelActionViaHelper(params) {
	// 可注入的启动器：默认走 `elevation-backend.js`（优先用 dsh-get-admin 的共享助手，
	// 解析不到才回退到本插件自带的 launch.js）。
	//
	// 注入点在测试里非常关键 —— 否则验证"启动助手失败"这条路径
	// **必须真的弹一次 UAC**（早先两条用例因此各耗 40+ 秒，还会打扰使用者）。
	//
	// 注意这里刻意**不直接 import "./launch.js"**：整个提权能力已经抽到
	// dsh-get-admin 插件，本插件只做消费。若这里仍连本地助手，就会出现
	// "引导提权走共享助手、内核动作却连本地助手"的分裂。
	const startElevationBackend =
		typeof params.launchHelper === "function"
			? params.launchHelper
			: (await import("../elevation-backend.js")).startElevationBackend;

	// ⚠️ **必须把 kernelAction 扩展传给助手**。
	//
	// 提权助手已经通用化（get-admin 的 helper.js 只有内存类方法），
	// `kernelAction` 不再内建 —— 不传扩展的话，助手会抛
	// `helper 不支持的方法：kernelAction`，而**用户已经点过一次 UAC 了**，
	// 只会看到"启动提权助手失败"这种误导性的报错（提权其实成功了）。
	// 这就是"统一到 get-admin"曾经造成的一次真实倒退，别把它改回去。
	//
	// `extensions` 收的是**模块路径**（助手进程用 require 加载），
	// 所以这里用 fileURLToPath 把 import.meta.url 转成真实路径。
	const extensionPath = fileURLToPath(new URL("./kernel-extension.js", import.meta.url));

	// `elevate: params.launchIfMissing` 的关键在于：
	//   - 已有**健康**助手时，启动器会先探活并直接复用（不弹 UAC）；
	//   - 没有助手且 launchIfMissing=true 时，它才通过 UAC 新建一个提权助手。
	// 早先我在这里固定传 elevate:false，结果"没有助手"时会**新建一个未提权的助手**，
	// 然后必然因为拿不到管理员权限而失败 —— 这正是要避免的。
	const backend = await startElevationBackend({
		elevate: params.launchIfMissing === true,
		extensions: extensionPath,
		timeoutMs: params.timeoutMs,
		// 允许/禁止跨进程复用（读发现记录）。默认允许 ——
		// 这正是"DSH 重启后也不用再弹 UAC"的关键。
		discoverExisting: params.discoverExisting !== false,
		log: params.log
	});

	if (backend.helperElevated !== true) {
		throw new Error(
			"现有助手**未提权**，无法执行内核驱动动作。\n" +
			"它可能是之前以 `backend: 'remote'` + `remoteElevate: false` 启动的自测助手。\n" +
			"处理：先用 ce_session detach 之类的操作断开它，或重启 DSH，让插件重新以提权方式启动助手。"
		);
	}

	try {
		const result = backend.kernelRpc("kernelAction", {
			action: params.action,
			...(params.driverPath === undefined ? {} : { driverPath: params.driverPath })
		});
		// 助手把成功/失败都作为 result 回传（见 helper.js 的注释：RPC 的错误通道
		// 只传 error.message，会把步骤日志丢掉），所以这里直接透传它的
		// { ok, log, result, error }。
		if (result !== null && typeof result === "object" && typeof result.ok === "boolean") {
			if (result.ok === true) {
				params.log(`已通过提权助手（pid ${backend.helperPid}）完成 ${params.action}`);
			}
			return {
				ok: result.ok,
				log: Array.isArray(result.log) ? result.log : [],
				result: result.result ?? null,
				error: typeof result.error === "string" ? result.error : null
			};
		}
		// 兼容未包装的返回值（旧版助手）
		return {
			ok: true,
			log: Array.isArray(result?.log) ? result.log : [],
			result: result ?? null,
			error: null
		};
	} catch (error) {
		return {
			ok: false,
			log: [],
			result: null,
			error: error && error.message ? error.message : String(error)
		};
	}
}

/** 简单的轮询等待。 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 临时文件路径（随机名，避免并发/残留冲突）。 */
function tempFile(prefix) {
	return path.join(
		os.tmpdir(),
		`${prefix}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`
	);
}

/** 尽力删除临时文件，不抛错。 */
function tryUnlink(file) {
	try {
		fs.unlinkSync(file);
	} catch {
		/* 不存在或删不掉都无所谓 */
	}
}

/**
 * 归一化并校验动作名（**纯函数**，便于单测而不触发任何提权）。
 *
 * @param {unknown} raw 原始动作名
 * @returns {string} 归一化后的动作名
 * @throws {Error} 不在白名单时
 */
export function normalizeKernelAction(raw) {
	// 去掉首尾空白再小写：调用方可能从工具参数里带进来空格（`" load "`），
	// 那不该被判成非法动作。
	const action = String(raw ?? "").trim().toLowerCase();
	if (!ELEVATED_KERNEL_ACTIONS.includes(action)) {
		throw new Error(
			`不允许提权执行的动作 "${raw}"。白名单：${ELEVATED_KERNEL_ACTIONS.join(", ")}。`
		);
	}
	return action;
}

/**
 * 决定这次走哪条提权路径（**纯函数**，无任何副作用）。
 *
 * 抽出来的动机：这段决策最容易写错，而验证它**不该**需要真的弹 UAC ——
 * 早先的测试直接调用整个 `runElevatedKernelAction`，结果每次跑都真的弹窗、
 * 单条用例耗 90 秒，还打扰使用者。
 *
 * @param {object} params
 * @param {boolean} params.hasElevatedHelper 当前是否已有已提权的助手
 * @param {boolean} [params.reuseHelper] 是否允许复用助手（默认 true）
 * @param {boolean} [params.preferPersistentHelper] 是否优先启动常驻助手（默认 true）
 * @returns {"reuse"|"launch-persistent"|"oneshot"}
 */
export function decideElevationPath(params) {
	if (params.reuseHelper !== false && params.hasElevatedHelper === true) return "reuse";
	if (params.preferPersistentHelper !== false) return "launch-persistent";
	return "oneshot";
}

/**
 * 在管理员权限下执行一次内核驱动动作。
 *
 * @param {object} options 选项
 * @param {"install"|"load"|"unload"} options.action 要执行的动作
 * @param {string} [options.driverPath] install 用：要安装的驱动路径
 * @param {number} [options.timeoutMs] 等待上限（默认 120s；要留时间给用户点 UAC）
 * @param {boolean} [options.reuseHelper] 是否允许复用已提权的助手（默认 true）
 * @param {boolean} [options.preferPersistentHelper] 是否优先启动**常驻**助手（默认 true）
 * @param {boolean} [options.discoverExisting] 是否允许跨进程复用（默认 true）
 * @param {(message: string) => void} [options.log] 日志回调
 * @returns {Promise<{ ok: boolean, log: string[], result: object|null, error: string|null }>}
 */
export async function runElevatedKernelAction(options) {
	const action = normalizeKernelAction(options.action);
	const log = options.log ?? (() => {});

	// 冷却期检查：用户刚拒绝过就不再自动弹 UAC，直接给手工做法。
	// `force: true` 可以绕过（用户明确要求"再试一次"时用）。
	if (options.force !== true && isElevationCoolingDown()) {
		const secondsLeft = Math.ceil(
			(ELEVATION_DECLINE_COOLDOWN_MS - (Date.now() - lastDeclinedAt)) / 1000
		);
		throw new Error(
			`你刚刚取消了 UAC 提权，${secondsLeft} 秒内不会再自动弹窗（避免反复打扰）。\n` +
				`要现在重试：再调用一次并传 force: true，然后在弹窗里点「是」。\n` +
				"或者以管理员身份重启 DSH，之后完全不需要 UAC。"
		);
	}

	const path = decideElevationPath({
		hasElevatedHelper: elevationHelperStatus()?.elevated === true,
		reuseHelper: options.reuseHelper,
		preferPersistentHelper: options.preferPersistentHelper
	});

	// 统一：把"用户拒绝"记下来，之后的调用会进入冷却期。
	const rememberDecline = (error) => {
		if (isElevationDeclinedError(error)) noteElevationDeclined();
		return error;
	};

	// ── 1) 复用**已经提权**的常驻助手 ──────────────────────────────────
	//
	// 这是「保存管理员权限」的正解：Windows 不允许保存凭据，
	// 能保存的是"一个还在跑的管理员进程"。助手本来就是常驻的（空闲自退），
	// 所以一旦它存在，后续所有内核动作都走它，**不再弹 UAC**。
	if (path === "reuse") {
		log("检测到已提权的助手，复用它执行（不再弹 UAC）");
		try {
			return await callKernelActionViaHelper({
				action,
				driverPath: options.driverPath,
				timeoutMs: options.timeoutMs,
				launchIfMissing: false,
				discoverExisting: options.discoverExisting,
				launchHelper: options.launchHelper,
				log
			});
		} catch (error) {
			// 复用失败（助手可能刚好自退了）→ **不在这里弹 UAC**：
			// 用户的意图是"复用"，突然弹窗会让人意外。如实报错让他自己决定。
			const reason = error && error.message ? error.message : String(error);
			throw new Error(
				`检测到提权助手但复用失败：${reason}\n` + "重试一次即可（届时会重新启动一个提权助手）。"
			);
		}
	}

	// ── 2) 通过 UAC 启动一个**常驻**提权助手 ────────────────────────────
	//
	// 刻意启动常驻助手而不是一次性执行器：这一次 UAC 之后，
	// 后续的内核动作（以及内存操作）都能复用它，不再反复弹窗。
	//
	// 失败时**不再兜底成第二个 UAC** —— 用户已经拒了一次，立刻再弹一次是很糟的体验。
	// 早先的实现在这里会"改走一次性执行器"，等于同一个动作连弹两次；
	// 实测被感知为「一直弹，很烦」，所以改成直接如实报错。
	if (path === "launch-persistent") {
		log("没有可用的提权助手，将通过 UAC 启动一个（只需这一次）");
		try {
			return await callKernelActionViaHelper({
				action,
				driverPath: options.driverPath,
				timeoutMs: options.timeoutMs,
				launchIfMissing: true,
				discoverExisting: options.discoverExisting,
				launchHelper: options.launchHelper,
				log
			});
		} catch (error) {
			const reason = error && error.message ? error.message : String(error);
			const detail =
				reason.includes("提权助手没有就绪") || /UAC/i.test(reason)
					? "看起来是 UAC 被拒绝或没被确认。"
					: `启动提权助手失败：${reason}`;
			throw rememberDecline(
				new Error(
					`无法以管理员权限执行 ${action}。\n${detail}\n\n` +
						"可选做法：\n" +
						"  1. 重新调用一次并在 UAC 弹窗里点「是」（点一次之后助手会常驻复用，后续不再弹）；\n" +
						"  2. 以管理员身份重启 DSH，之后完全不需要 UAC；\n" +
						"  3. 在管理员 PowerShell 里手工执行 sc.exe 命令（见错误下方的提示）。"
				)
			);
		}
	}

	// ── 3) 显式要求一次性执行器时（`preferPersistentHelper: false`）─────
	const nonce = crypto.randomBytes(16).toString("hex");
	const configFile = tempFile("ce-kernel-elevate-cfg");
	const resultFile = tempFile("ce-kernel-elevate-result");

	fs.writeFileSync(
		configFile,
		JSON.stringify({
			nonce,
			resultFile,
			action,
			...(options.driverPath === undefined ? {} : { driverPath: options.driverPath })
		}),
		"utf8"
	);
	tryUnlink(resultFile);

	// ⚠️ **硬闸门**：`GET_ADMIN_NO_ELEVATE=1` 时拒绝提权（无人值守保护）。
	// 这是**第三条**提权路径（前两条是 launch.js 与 dsh-get-admin 的 launch.js），
	// 三条都必须能一起关掉 —— 只关一条，另外两条仍会在无人看管时弹 UAC 并自动通过。
	if (process.env.GET_ADMIN_NO_ELEVATE === "1") {
		// 已经建出来的临时文件要收掉，否则每次被闸门拦下都会留垃圾
		tryUnlink(configFile);
		tryUnlink(resultFile);
		throw new Error(
			`内核驱动动作 ${action} 需要提权，但提权已被 GET_ADMIN_NO_ELEVATE=1 禁用（无人值守保护）。\n` +
				"要真正执行，请先清除该环境变量，并由人在 UAC 弹窗中确认。"
		);
	}

	// 与 launch.js 同样的做法：只把配置文件路径传给提权进程，避免引号/转义问题。
	const command =
		`Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' ` +
		`-ArgumentList @('${RUNNER_PATH.replace(/'/g, "''")}','--config=${configFile.replace(/'/g, "''")}') ` +
		"-Verb RunAs -WindowStyle Hidden";

	log(`请求 UAC 提权以执行内核驱动动作：${action}（请在弹窗中确认）`);
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
		windowsHide: true,
		stdio: "ignore"
	});
	/** 记录 powershell 自己的失败（例如 UAC 被取消）——它是有 stdout 的。 */
	let launcherError = null;
	child.on("error", (error) => {
		launcherError = error;
	});
	child.on("exit", (code) => {
		if (code !== 0 && launcherError === null) {
			launcherError = new Error(`请求提权的 PowerShell 退出码 ${code}`);
		}
	});

	const deadline = Date.now() + (options.timeoutMs ?? 120_000);
	let payload = null;
	while (Date.now() < deadline) {
		if (fs.existsSync(resultFile)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
				// 校验 nonce：防止读到上一次遗留/其他实例的结果文件
				if (parsed !== null && parsed.nonce === nonce) {
					payload = parsed;
					break;
				}
			} catch {
				/* 可能正写到一半，下一轮再读 */
			}
		}
		await sleep(200);
	}

	tryUnlink(configFile);
	tryUnlink(resultFile);

	if (payload === null) {
		// 区分"UAC 被拒"与"提权进程跑了但没写结果"——两者的处置完全不同
		const detail =
			launcherError !== null
				? `请求提权的进程报错：${launcherError.message}。`
				: "提权进程没有在时限内写回结果。";
		throw new Error(
			`提权执行 ${action} 失败：${detail}\n` +
				"常见原因：\n" +
				"  - 你在 UAC 弹窗里点了「否」（或弹窗被其他窗口挡住没看到）；\n" +
				"  - 组策略禁止了提权（标准用户账户无法提权）；\n" +
				"  - UAC 弹窗是安全桌面，自动化环境里可能需要手动确认。\n" +
				"替代做法：以管理员身份重启 DSH，或在管理员 PowerShell 里手动执行 sc.exe 命令。"
		);
	}

	return {
		ok: payload.ok === true,
		log: Array.isArray(payload.log) ? payload.log : [],
		result: payload.result ?? null,
		error: typeof payload.error === "string" ? payload.error : null
	};
}
