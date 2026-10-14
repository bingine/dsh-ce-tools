/**
 * 提权相关的判定、用户同意闸门与错误增强。
 *
 * ## 为什么需要这一层
 *
 * Windows 的权限是**进程级**的：要读写以更高权限运行的目标进程（多数游戏、反作弊、
 * 系统工具），**发起调用的那个进程本身**必须有管理员权限。因此「按需提权」不可能只针对
 * 单次操作 —— 只有三条路：
 *
 *   1. 让本进程以管理员身份重启（会中断当前 DSH 会话）；
 *   2. 起一个管理员权限的**助手进程**，把内存操作转发给它；
 *   3. 连一个以管理员身份运行的 `ceserver`，切到内核的 `native-ce` 后端。
 *
 * 本文件只负责**判定与征求同意**这两件与安全边界直接相关的事，并且刻意做成
 * 「先问、不自动提权」：提权会扩大插件的权限边界，必须由人来决定。
 *
 * ## 关于第 2 条路（助手进程）的实现约束（重要）
 *
 * 内核的 `ScanSession` / `PointerScanner` / `AutoAssembler` 内部调用的是 `Process` 的
 * **同步**方法（`src/scanner/scanner.ts` 里 `this.proc.readMemory(...)`），而
 * `Process` 的同步方法在**异步后端**上会直接抛错（`win/process.ts` 的 `syncResult`）。
 * 因此助手进程若只做成普通的异步 RPC，扫描/指针扫描/汇编**全部不可用**，
 * 只能读写与枚举 —— 这不是一个可交付的「提权后全功能」方案。
 * 要全功能，远程后端必须是**同步**的，也就是：worker 线程持有 socket 做异步 I/O，
 * 主线程用 `SharedArrayBuffer` + `Atomics.wait` 等结果。这条路可行但有两个代价：
 *   - 每次内存操作都会阻塞 DSH 宿主主线程（与现有 `SelfBackend` 的行为一致，扫描本来就会阻塞）；
 *   - 4MB 级别的扫描分块要在主线程与 worker 之间来回拷贝。
 *
 * 所以本文件**不**假装已经实现了提权转发；它把「权限不足的识别」与「征求同意的闸门」
 * 先做扎实，让后续接入任何一种方案时，安全边界都已经在位。
 *
 * @module dsh-cheat-engine/elevation
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * 提权询问的选项集 —— **与权威实现共用同一份**。
 *
 * ## 为什么必须共用（这是安全事故级缺陷的修复）
 *
 * 早先本文件自己写了一套选项，第 2 项是「告诉我如何提权」（说明明写"不自动执行"），
 * 而权威实现（`dsh-get-admin/lib/elevation.js`）第 2 项是「同意提权」。
 * 两份的 `approved` 又都是 `chosen !== "不继续…"` 这种**按文案推导**的写法，
 * 于是同一个表达式在本文件里把"不要动手"读成了**同意**：
 * 用户只要求讲解，却真的去弹 UAC —— 同意闸门被绕过。
 *
 * 所以选项必须只有一份定义。这里优先用权威实现导出的那份，
 * 取不到（get-admin 不可用）才退回内置副本；两者内容保持一致。
 */
const FALLBACK_OPTIONS = Object.freeze([
	Object.freeze({
		id: "decline",
		label: "不继续（推荐先用只读/换目标）",
		description: "放弃对高权限目标的操作，不做任何提权。"
	}),
	Object.freeze({
		id: "approve",
		label: "同意提权（弹 UAC 确认）",
		description: "起一个管理员权限的助手进程，之后内存操作转发给它；助手常驻可复用。"
	})
]);

/** 缓存权威实现导出的选项集（解析一次即够）。 */
let sharedOptions = null;
let sharedOptionsResolved = false;

/**
 * 取提权询问的选项集。
 * @returns {ReadonlyArray<{id: string, label: string, description: string}>}
 */
function elevationOptions() {
	if (!sharedOptionsResolved) {
		sharedOptionsResolved = true;
		try {
			const require = createRequire(import.meta.url);
			const here = path.dirname(fileURLToPath(import.meta.url));
			const candidates = [
				path.join(path.dirname(here), "dsh-get-admin", "lib", "elevation.js"),
				path.join(here, "..", "node_modules", "dsh-get-admin", "lib", "elevation.js")
			];
			for (const candidate of candidates) {
				if (!fs.existsSync(candidate)) continue;
				const mod = require(candidate);
				if (Array.isArray(mod.ELEVATION_OPTIONS) && mod.ELEVATION_OPTIONS.length > 0) {
					sharedOptions = mod.ELEVATION_OPTIONS;
					break;
				}
			}
		} catch {
			/* 取不到就用内置副本 */
		}
	}
	return sharedOptions ?? FALLBACK_OPTIONS;
}

/** 用户没作答时一律按**不同意**处理，绝不默认批准。 */
const DEFAULT_OPTION_ID = "decline";

/**
 * 从作答里解出选了哪个选项（与权威实现同样的规则）。
 *
 * raw 值**同时**拿去和 id、label 比 —— 不要假设"非对象就是文案"
 * （把 id 当文案会导致"同意"被判成不同意）。匹配不上一律按不同意。
 */
function resolveChoice(answer) {
	const selected = answer?.answers?.[0]?.selected?.[0];
	const rawId = typeof selected === "object" && selected !== null ? selected.id : selected;
	const rawLabel = typeof selected === "object" && selected !== null ? selected.label : selected;
	const options = elevationOptions();

	for (const option of options) {
		if (rawId !== undefined && rawId !== null && String(rawId) === option.id) {
			return { id: option.id, label: option.label };
		}
	}
	for (const option of options) {
		if (rawLabel !== undefined && rawLabel !== null && String(rawLabel) === option.label) {
			return { id: option.id, label: option.label };
		}
	}
	return { id: DEFAULT_OPTION_ID, label: options[0].label };
}

/** `net session` 的结果缓存（一次探测约 50–150ms，没必要反复探）。 */
let elevatedCache = null;

/**
 * 当前进程是否以管理员身份运行。
 *
 * 判定方式：`net session` 需要管理员权限才能成功；能成功即说明已提权。
 * 这是无副作用、不触发 UAC 的只读探测。
 *
 * @returns {boolean}
 */
export function isElevated() {
	if (elevatedCache !== null) return elevatedCache;
	try {
		const result = spawnSync("net", ["session"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 10_000
		});
		// status === 0 表示命令成功 → 有管理员权限
		elevatedCache = result.status === 0;
	} catch {
		// 探测本身失败时按「未提权」处理：宁可多说一句「可能权限不足」，也不要谎报已提权
		elevatedCache = false;
	}
	return elevatedCache;
}

/** 供测试注入：重置已提权探测的缓存。 */
export function resetElevationCache() {
	elevatedCache = null;
}

/**
 * 判断一个错误是不是「权限不足」。
 *
 * 覆盖几类实际会碰到的形态：
 *   - Win32 `ERROR_ACCESS_DENIED` = 5（`OpenProcess` / 读写被拒时内核会带上它）；
 *   - `0x80070005`（HRESULT 形式的 access denied）；
 *   - 文本里的「拒绝访问」/「Access is denied」；
 *   - Node 的 `EPERM` / `EACCES`（文件与管道场景）。
 *
 * @param {unknown} error 抛出的错误
 * @returns {boolean}
 */
export function isPermissionDenied(error) {
	const text = String((error && error.message) || error || "");
	if (text === "") return false;
	// 明确的 Win32 错误码 5（注意别把 50/500 之类误判）
	if (/\bWin32\s*错误\s*5\b/.test(text) || /\bWin32\s*(error\s*)?5\b/i.test(text)) return true;
	if (/0x0*80070005/i.test(text)) return true;
	if (/拒绝访问|access\s+is\s+denied/i.test(text)) return true;
	if (/\bEPERM\b|\bEACCES\b/.test(text)) return true;
	return false;
}

/**
 * 为「权限不足」生成可执行的下一步说明。
 *
 * @param {{ elevated?: boolean, target?: { pid?: number, name?: string }|null, action?: string }} [context]
 * @returns {string[]} 面向模型/用户的多行建议
 */
export function permissionDeniedAdvice(context = {}) {
	const elevated = context.elevated === undefined ? isElevated() : context.elevated;
	const target = context.target ?? null;
	const who = target === null
		? "目标进程"
		: `${target.name ?? "目标"}（pid ${target.pid ?? "?"}）`;
	const lines = [
		`权限不足：${who}以**更高的权限**运行，而当前 DSH 进程${elevated ? "已提权" : "**未提权**"}。`,
		"Windows 的权限是进程级的，无法只对单次操作提权。可选做法："
	];
	if (!elevated) {
		// ⚠️ 与权威实现（dsh-get-admin/lib/elevation.js）保持一致：
		// `GET_ADMIN_NO_ELEVATE=1` 时不要再推荐"会弹 UAC"的做法 ——
		// 它们全部会被立刻拒绝、一次窗都不弹。推荐一条走不通的路比不推荐更糟。
		if (process.env.GET_ADMIN_NO_ELEVATE === "1") {
			lines.push(
				"  ⚠️ 当前进程设置了 `GET_ADMIN_NO_ELEVATE=1`，**提权助手与 UAC 已被禁用**：",
				"     `ce_elevation action=request` 与 `remoteElevate: true` 都会被直接拒绝，不会弹窗。",
				"  不需要 UAC 的可行做法：",
				"  1. 以管理员身份重启 DSH（最直接；会中断当前会话）：",
				'     右键 DeepSeek Harness → 以管理员身份运行；',
				"     或在管理员 PowerShell 里启动它。",
				"  2. 用管理员权限运行官方 ceserver，然后把插件配置的 backend 设为 native-ce：",
				"     config: { backend: 'native-ce', ceserverHost: '127.0.0.1', ceserverPort: 52736 }",
				"     （这条需要一个**已经以管理员身份启动**的 ceserver，不是插件弹窗）"
			);
			lines.push("  只读分析时也可换一个不以管理员权限运行的目标进程。");
			return lines;
		}
		lines.push(
			"  1. 以管理员身份重启 DSH（最直接；会中断当前会话）：",
			'     右键 DeepSeek Harness → 以管理员身份运行；',
			"     或在管理员 PowerShell 里启动它。",
			"  2. 用管理员权限运行官方 ceserver，然后把插件配置的 backend 设为 native-ce：",
			"     config: { backend: 'native-ce', ceserverHost: '127.0.0.1', ceserverPort: 52736 }"
		);
	} else {
		lines.push(
			"  已提权却仍被拒 → 目标多半受 PPL/反作弊保护（普通用户态无解，需要内核驱动）。",
			"  可尝试：换用 native-ce 后端连接更高权限的 ceserver；或确认目标确实允许外部读取。"
		);
	}
	lines.push("  3. 只读分析时也可换一个不以管理员权限运行的目标进程。");
	return lines;
}

/**
 * 把「权限不足」的错误增强成带可执行建议的错误。
 *
 * 非权限错误原样返回，避免把无关失败也说成权限问题。
 *
 * @param {unknown} error 原错误
 * @param {{ target?: object|null, action?: string }} [context]
 * @returns {Error} 原始错误或增强后的错误
 */
export function enrichPermissionError(error, context = {}) {
	if (!isPermissionDenied(error)) return error;
	const advice = permissionDeniedAdvice(context);
	const original = (error && error.message) || String(error);
	const enriched = new Error(
		`${context.action ? `[${context.action}] ` : ""}${advice.join("\n")}\n\n原始错误：${original}`
	);
	enriched.cause = error;
	enriched.permissionDenied = true;
	return enriched;
}

/**
 * 提权**之前**征求用户同意。
 *
 * 这是本插件唯一会扩大权限边界的入口，所以一律先问、不自动提权。
 * 需要活的根 agent（子代理调用无法打开人机交互），所以拿不到 agent 时
 * 直接按「未获同意」处理，并把原因说清楚。
 *
 * @param {object} userQuestions `ctx.userQuestions`
 * @param {object} exec 工具执行上下文（需要 `exec.agent` 与 `exec.signal`）
 * @param {{ target?: object|null, action?: string }} [context]
 * @returns {Promise<{ approved: boolean, reason: string }>}
 */
export async function askToElevate(userQuestions, exec, context = {}) {
	const advice = permissionDeniedAdvice(context);
	if (exec === undefined || exec.agent === undefined) {
		return {
			approved: false,
			reason:
				"当前调用没有可用的 agent 会话，无法向你确认是否提权，因此**不做任何提权动作**。\n" +
				advice.join("\n")
		};
	}
	if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
		return {
			approved: false,
			reason: "当前 profile 没有 user-questions 服务，无法征求同意，因此不做任何提权动作。\n" + advice.join("\n")
		};
	}
	const target = context.target ?? null;
	const who = target === null ? "目标进程" : `${target.name ?? "目标"}（pid ${target.pid ?? "?"}）`;
	// ⚠️ **`ask` 必须包在 try/catch 里**（fail-closed），与权威实现
	// `dsh-get-admin/lib/elevation.js` 保持一致。
	//
	// 用户不介入是**常态**：关掉弹窗、点取消、会话超时、profile 没有可交互的
	// user-questions 前端、`signal` 提前 abort …… 每一种都会让 `ask` 抛异常。
	// 早先这里是裸 `await`，于是"用户没回应"变成异常**穿透**到调用方：
	// 工具层失败、模型看到的是与"权限不足"无关的栈信息，真正原因被吞掉；
	// 而且闸门从 fail-closed（拿不到同意就不提权）退化成了"抛错"这种不确定状态。
	//
	// 权威实现已经修过，这里必须同步 —— 两份实现的**行为**要一致，
	// 否则"回退路径"会成为绕过闸门的暗门。
	let answer;
	try {
		answer = await userQuestions.ask({
			questions: [
				{
					id: "elevate",
					header: "需要管理员权限",
					question:
						`${who}以更高权限运行，当前 DSH 未提权，读写被拒绝。\n` +
						"提权会扩大插件的权限边界（**会弹一次 UAC**），需要你确认。是否继续？",
					options: elevationOptions()
				}
			],
			agent: exec.agent,
			signal: exec.signal
		});
	} catch (error) {
		// 取消 / 超时 / 无可交互前端 / signal 中断 —— 都不能当成"同意"
		const why = error && error.message ? String(error.message) : String(error);
		return {
			approved: false,
			reason:
				"未能就提权征求到你的确认（提问被取消、超时或不可用），因此**不做任何提权动作**。\n" +
				`（原因：${why}）\n` +
				advice.join("\n")
		};
	}
	// ⚠️ 早先这里是 `chosen !== "不继续（推荐先用只读/换目标）"` —— 由**文案**推导。
	// 而本文件的选项 2 曾写作「告诉我如何提权」（说明明写"不自动执行"），
	// 于是同一个表达式把这个"不要动手"的选项读成了**同意**：
	// 用户只要求讲解，却真的去弹 UAC —— 同意闸门被绕过（安全事故级）。
	//
	// 现在与权威实现一致：用**选项 id** 判定，且选项集共用同一份定义。
	// 拿不到明确同意时一律按不同意处理。
	const choice = resolveChoice(answer);
	const approved = choice.id === "approve";
	return {
		approved,
		reason: approved
			? [`已获同意（你选择了「${choice.label}」）。具体做法：`, ...advice].join("\n")
			: [`未获同意（你选择了「${choice.label}」），未做任何提权动作。`, ...advice].join("\n")
	};
}
