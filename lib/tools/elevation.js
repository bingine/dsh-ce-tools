/**
 * `ce_elevation` —— **提权状态查询 / 请求 / 释放**，让模型在 get-admin 未启用时
 * 也能调用提权能力。
 *
 * ## 为什么需要这个工具（一个真实的缺口）
 *
 * 提权能力归属独立插件 `dsh-get-admin`，模型侧的入口是它的 `get_admin` 工具。
 * 但插件管理器里**"已安装"与"已启用"是两件事，而新装插件默认是关的**。
 * 关着的时候会出现一个比"界面缺失"更严重的缺口：
 *
 *   - 提权**机制**仍然可用（本插件取 get-admin 的实现走的是模块解析，与启用无关）；
 *   - 但 `get_admin` **工具没注册**（它来自 get-admin 的 `apply`）；
 *   - 于是**模型根本调不到提权能力** —— 用户既看不见、也用它不了。
 *
 * 所以本插件补一个自己的工具。它与界面接管同属一个策略：
 * **自动接管入口，但提权本身仍然调用 get-admin 的实现**，不另起一套。
 *
 * ## 与 `get_admin` 的关系
 *
 * 两者功能重叠但**不冲突**（工具名不同）。get-admin 启用时，模型看到两个入口，
 * 选哪个都能用、行为一致（因为底层是同一套实现）；
 * get-admin 未启用时，至少还有这一个可用。
 * 这正是"可见 = 可控 = 可用"三者一致所要求的。
 *
 * @module dsh-ce-tools/tools/elevation
 */
import {
	disposeElevationHelper,
	elevationBackendStatus,
	elevationHelperStatus,
	startElevationBackend
} from "../elevation-backend.js";
import { askToElevate, permissionDeniedAdvice } from "../elevation.js";
import { makeEnvelopeTool } from "./shared.js";

/** 助手空闲自退时间（与 get-admin 的默认一致）。 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 提权是否被环境变量硬禁用（`GET_ADMIN_NO_ELEVATE=1`）。
 *
 * 与 `launch.js` / `kernel-elevate.js` 里的闸门**读同一个变量**，
 * 只是把判断提到用户看得到的这一层，好让"一个窗都不弹"成为可验证的行为。
 *
 * @returns {boolean}
 */
function elevationDisabledByEnv() {
	return process.env.GET_ADMIN_NO_ELEVATE === "1";
}

/**
 * 组装 `ce_elevation` 工具。
 *
 * @param {object} runtime 插件运行时
 * @returns {object} 工具定义
 */
export function createElevationTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_elevation",
		description:
			"管理员权限的查询 / 请求 / 释放。Windows 的权限是**进程级**的：要读写以更高权限运行的" +
			"目标（多数游戏、反作弊、系统工具），发起调用的进程本身必须是管理员。" +
			"action=status 只读（**先看它**：能一次看清有没有助手、UAC 是否被禁用）；" +
			"action=request 会**先征求你的同意**，确认后经 UAC 起一个常驻提权助手" +
			"（一次确认后跨进程复用，不再反复弹窗）；action=release 立刻结束助手、收回权限。" +
			"⚠️ 若进程设置了 GET_ADMIN_NO_ELEVATE=1，request 会**直接拒绝且一个窗都不弹** —— " +
			"这时不要再重复尝试 request（它不会成功），改用 status 查看可做什么即可。" +
			"注意：错误码 998/299 通常**不是**权限问题（是地址无效），别用提权去治它。",
		// ⚠️ `parameters` 是**属性表**（属性名 → 定义），不是完整 JSON Schema 对象。
		// 早先这里写成了 `{ type: "object", properties: {...} }`，而
		// `makeEnvelopeTool` 会把每个键当作属性去编译 —— 于是 `type: "object"`
		// 被当成一个叫 "type" 的属性、值为字符串 "object"，直接抛
		// 「defineTool 的 "type" 必须是对象形式的 schema 定义」，**插件加载失败**。
		// 必填用属性上的 `required: true`，编译时会提到父级 required 数组。
		parameters: {
			action: {
				type: "string",
				enum: ["status", "request", "release"],
				required: true,
				description: "status=查状态（只读，默认）；request=请求提权（会先征求同意）；release=释放权限"
			}
		},
		async run(args, exec) {
			const action = String(args.action ?? "status");

			/* ---------------- 只读：查状态 ---------------- */
			if (action === "status") {
				const helper = elevationHelperStatus();
				const backend = elevationBackendStatus();
				const hasHelper = helper !== null;
				const elevated = hasHelper && helper.elevated === true;
				const blocked = elevationDisabledByEnv();
				return {
					summary: blocked
						? "提权已被 GET_ADMIN_NO_ELEVATE=1 禁用（不会弹 UAC）"
						: elevated
							? `已获得管理员权限（提权助手 pid ${helper.pid}）`
							: hasHelper
								? "有提权助手在运行，但它**未提权**"
								: "未获得管理员权限",
					lines: [
						`提权助手：${hasHelper ? `pid ${helper.pid}，端口 ${helper.port}，${elevated ? "已提权" : "未提权"}` : "未运行"}`,
						`提权实现来源：${backend.shared ? `dsh-get-admin（${backend.via}）` : "本插件自带回退实现"}`,
						...(backend.error !== null ? [`（解析 get-admin 的说明：${backend.error}）`] : []),
						`UAC 策略：${blocked ? "已被 GET_ADMIN_NO_ELEVATE=1 禁用，request 会直接拒绝，**不会弹窗**" : "允许（request 会先征求同意，确认后弹一次 UAC）"}`,
						"",
						...permissionDeniedAdvice({})
					],
					data: {
						action,
						hasHelper,
						elevated,
						helper,
						uacBlocked: blocked,
						backend: { shared: backend.shared, via: backend.via }
					}
				};
			}

			/* ---------------- 释放权限（不需要管理员） ---------------- */
			if (action === "release") {
				const before = elevationHelperStatus();
				const had = before !== null;
				disposeElevationHelper();
				const after = elevationHelperStatus();
				return {
					summary: had ? "已释放管理员权限（提权助手已结束）" : "当前没有提权助手，无需释放",
					lines: [
						had
							? `已结束提权助手（pid ${before.pid}）并清掉跨进程复用记录。`
							: "没有正在运行的提权助手。",
						`释放后：${after === null ? "未提权" : "仍有助手"}`,
						"",
						"说明：若助手是**别的进程**以管理员启动的，本进程无权结束它 —— " +
							"这种情况下会清掉复用记录，它将在空闲超时后自行退出。"
					],
					data: { action, released: had, before, after }
				};
			}

			/* ---------------- 请求提权（先征求同意） ---------------- */
			if (action === "request") {
				// 已经有提权助手 → 直接说明，不再打扰用户
				const existing = elevationHelperStatus();
				if (existing !== null && existing.elevated === true) {
					return {
						summary: `已经拥有管理员权限（助手 pid ${existing.pid}），无需再次请求`,
						lines: ["复用了现有的提权助手，**没有弹 UAC**。"],
						data: { action, hasHelper: true, elevated: true, helper: existing }
					};
				}

				// ⚠️ **无人值守闸门必须在弹窗之前**。
				//
				// `launch.js` 里已经有 `GET_ADMIN_NO_ELEVATE=1` 的硬闸门，但它在
				// **启动器 spawn 之前**才检查 —— 也就是说流程会先走完
				// 「征求同意 → 用户点了同意 → 然后才被拒绝」。
				// 对于明确表态"我不会点 UAC"的用户，这等于**先弹一次窗再拒绝**，
				// 体验上就是"它还是弹了"。所以这里前置检查，
				// 保证被禁用时**一个窗都不会弹**，也不必去打扰用户点同意。
				if (elevationDisabledByEnv()) {
					return {
						summary: "提权已被 GET_ADMIN_NO_ELEVATE=1 禁用（无人值守保护），未做任何提权动作",
						lines: [
							"当前进程设置了 `GET_ADMIN_NO_ELEVATE=1`，插件**不会**请求 UAC 提权。",
							"因此本次请求直接拒绝：既没有弹窗，也不需要你点任何东西。",
							"",
							"如果你确实想允许提权，清除该环境变量后重开 DSH 即可。",
							"",
							...permissionDeniedAdvice({})
						],
						data: { action, approved: false, disabledByEnv: true }
					};
				}

				// ⚠️ 提权前**必须**取得人的同意。拿不到人机交互时 `askToElevate`
				// 返回 approved:false（fail-closed），所以这里是"拒绝并说明"，
				// 绝不是静默提权。这一层闸门与 get-admin 的 `get_admin` 工具一致。
				const consent = await askToElevate(runtime.userQuestions, exec, {
					target: null,
					action: "ce_elevation request"
				});
				if (!consent.approved) {
					return {
						summary: "未获同意，未做任何提权动作",
						lines: [consent.reason, "", ...permissionDeniedAdvice({})],
						data: { action, approved: false }
					};
				}

				// ⚠️ 这里**刻意不做** kernelPath 的解析 —— 交给适配层。
				//
				// `elevation-backend.js` 的 `startElevationBackend` 已经有这段逻辑，
				// 而且它的注释记录的正是**同一个 bug**：配置默认值是 `kernelPath: ""`，
				// 而空字符串不是 nullish，早先用 `??` 判断导致 "" 被原样传给助手，
				// 助手只能从自己所在目录向上找内核 —— 但 `dsh-get-admin` 与
				// `dsh-cheat-engine` 是**兄弟目录**，逐级向上永远走不到对方的
				// node_modules，兜底的 `require("node-cheat-engine")` 也解析不到，
				// 于是助手一启动就退出。
				//
				// 我一度在**这里**又加了一遍解析，那会变成"同一件事的两份真相"
				// （本项目的典型伤）。适配层是所有提权路径的**唯一出口**，
				// 兜在那里就不会漏；这里照原样透传配置即可。
				const backend = await startElevationBackend({
					elevate: true,
					kernelPath: runtime.config.kernelPath,
					idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
					timeoutMs: runtime.config.helperTimeoutMs,
					launchTimeoutMs: runtime.config.launchTimeoutMs,
					log: (message) => runtime.logger.info("cheat-engine: %s", message)
				});
				const after = elevationHelperStatus();
				return {
					summary: `已获得管理员权限${after !== null ? `（助手 pid ${after.pid}）` : ""}`,
					lines: [
						"已通过 UAC 启动提权助手，后续需要权限的调用都复用它，**不再重复弹窗**。",
						`助手权限：${backend.helperElevated === true ? "管理员" : "普通用户"}`,
						"用完可以 action=release 立刻收回（或等它空闲 30 分钟自行退出）。"
					],
					data: {
						action,
						approved: true,
						hasHelper: after !== null,
						elevated: backend.helperElevated === true,
						helperPid: backend.helperPid
					}
				};
			}

			throw new Error(`ce_elevation 不支持的 action：${action}（支持 status / request / release）`);
		}
	});
}
