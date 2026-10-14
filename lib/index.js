/**
 * dsh-ce-tools — 宿主半。
 *
 * 让 AI 拥有 Cheat Engine 的能力，内核用同机的 `@bingine/cemem`
 * （Cheat Engine 核心引擎的 Node 移植：跨进程内存扫描/修改、指针扫描、
 * AutoAssembler、反汇编/汇编、.CT 读写、CE Lua 桥）。
 *
 * 注册 16 个工具，覆盖 Cheat Engine 在**用户态**能做的核心工作：
 *
 * | 工具 | 作用 |
 * | --- | --- |
 * | `ce_processes` | 找目标进程 |
 * | `ce_attach` | 附加（读写/扫描/汇编都作用于它） |
 * | `ce_session` | 会话状态 / 摘下目标 |
 * | `ce_modules` | 模块基址（做「模块+偏移」静态地址） |
 * | `ce_regions` | 内存区域（判断可写/可执行） |
 * | `ce_read` / `ce_write` | 读 / 写内存（写后回读校验） |
 * | `ce_scan` | 首次扫描 → 再次扫描 → 结果（含 AOB） |
 * | `ce_pointer_scan` | 找「基址+多级偏移」的稳定路径 |
 * | `ce_disassemble` / `ce_assemble` | 反汇编 / 汇编（可写入） |
 * | `ce_auto_assemble` | AutoAssembler 脚本（代码注入、[ENABLE]/[DISABLE]） |
 * | `ce_lua` | 直接跑 CE Lua 脚本（逃生通道） |
 * | `ce_cheat_table` | .CT 地址表读写（与 CE 本体互通） |
 * | `ce_kernel` | 内核驱动 DBK64 的获取/安装/加载（自动从官方或本机 CE 取，见下） |
 * | `ce_elevation` | 提权入口的兜底（`dsh-get-admin` 未启用时模型侧仍可调用） |
 *
 * ## 关于 `ce_kernel` 与内核能力（诚实说明）
 *
 * `ce_kernel` 能把 CE 的 DBK64 内核驱动**自动取到并加载**：
 *   1. 本机已装 Cheat Engine 时，直接解它的 `dbk64.cepack`（用 Node 内置 zlib，
 *      不需要任何外部工具，也不需要联网）；
 *   2. 否则抓官方下载页取安装包，再解包提取。
 * 校验按 PE 头判定「是不是 64 位原生子系统内核驱动」并读 Authenticode 签名状态。
 *
 * 但有两条边界必须说清：
 *   - **加载内核驱动必须管理员权限**（Windows 硬边界，无法绕过）。未提权会明确报错。
 *   - **驱动加载 ≠ 受保护进程可读**：还要把配置的 `backend` 改成 `dbk`
 *     （只有 `DbkBackend` 走内核 ioctl，默认的 `self` 仍是用户态）。
 *     另外 `changeProtection`/`free` 仍是用户态实现，对受保护进程会失败。
 *     这些前提会出现在 `ce_kernel` 的输出里，不会让人误判。
 *
 * ## 三条贯穿设计（踩过的坑）
 *
 * 1. **不 import 任何 `@deepseek-ai/*` 包。** 桌面版跑的是 asar 里自带的 dsh，
 *    而 profile 的 `@deepseek-ai/*` 联接指向 npm 全局那份，两者版本不同
 *    （0.2.0-rc.2 vs 0.1.0-rc.8）。只要 import 就会把另一个版本的实现拉进来，
 *    注册表校验对不上时 `tools.register()` 直接抛错、插件显示 `failed` 且极难定位。
 *    所以自己实现 `defineTool`（见 `toolkit.js`），只依赖注册表真正要求的那几个字段。
 * 2. **内核延迟加载。** 内核在 require 时就 eager 加载 koffi 原生扩展并绑定 kernel32。
 *    若在 `apply` 里加载，任何环境问题都会变成「插件激活失败」；放到第一次真正用工具时，
 *    它就只是一条可读的工具错误。
 * 3. **出口统一收敛。** 注册表对返回值做 lossless-JSON 规范化，bigint 会直接抛错，
 *    而未声明的键会让整次调用失败。所以全部工具都经 `makeEnvelopeTool` 返回
 *    `{ ok, summary, lines, data }`，bigint/Buffer 在出口处转成字符串。
 *
 * ## 能力边界（诚实的部分）
 *
 * 本移植复刻的是 CE **未加载内核驱动时**的用户态能力。没有内核驱动，因此做不到：
 * 读写被保护进程（可改配置走 ceserver）、硬件断点、DBVM 超管隐身。
 * 另外 `createthread` 不会真正创建远程线程（Node 无 `CreateRemoteThread`），
 * 只做校验与报告。这些限制都会在工具输出里如实说明，而不是静默失败。
 *
 * @module dsh-cheat-engine
 */
import { createSessionStore } from "./session.js";
import { ensureAsm, kernelStatus, loadKernel, resolveBackend } from "./kernel.js";
import { clearElevationDeclined, isElevationCoolingDown } from "./remote/kernel-elevate.js";
// `disposeElevationHelper`：插件卸载时必须结束提权助手进程（提权进程不该在卸载后留在用户机器上）。
// `elevationHelperStatus`：**接管界面**时（get-admin 未启用）状态路由要用它。
import { disposeElevationHelper, elevationHelperStatus } from "./elevation-backend.js";
import { withDefaults } from "./toolkit.js";
import { kernelProgressSnapshot } from "./progress.js";

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 插件根目录（`lib/` 的上一级）。
 *
 * 必须用 `realpath` 解析 junction：本插件常以目录联接装进 DSH profile，
 * 不解析的话这里会指向 profile 下的链接路径 —— 接管界面的图标路由要按它
 * 去读 `icons/*.svg`，路径不对就会读到空。
 */
const PLUGIN_DIR = (() => {
	const here = dirname(fileURLToPath(import.meta.url));
	try {
		return dirname(realpathSync(here));
	} catch {
		return dirname(here);
	}
})();

import {
	createAttachTool,
	createModulesTool,
	createProcessesTool,
	createRegionsTool,
	createSessionTool
} from "./tools/process.js";
import { createReadTool, createWriteTool } from "./tools/memory.js";
import { createPointerScanTool, createScanTool } from "./tools/scan.js";
import { createAssembleTool, createAutoAssembleTool, createDisassembleTool } from "./tools/asm.js";
import { createLuaTool } from "./tools/lua.js";
import { createCheatTableTool } from "./tools/table.js";
import { createKernelTool } from "./tools/kernel.js";
import { createElevationTool } from "./tools/elevation.js";


/** Loader 诊断用的插件名。 */
export const name = "cheat-engine";

/** npm 包名（与 package.json 的 name 一致，供状态路由自报家门）。 */
const PACKAGE_NAME = "dsh-ce-tools";

/** 与 package.json 的 version 保持一致。 */
const PLUGIN_VERSION = "0.1.9";

/** 只读状态路由的路径。 */
const STATUS_PATH = "/cheat-engine/status";

/** 工具注册表是唯一硬依赖；其余能力（webServer 等）本插件不需要。 */
export const inject = ["tools"];

/**
 * 行配置的**出厂默认**。
 *
 * 刻意**不导出 `Config`**，也**不 import `@deepseek-ai/schemastery`** —— 这是本插件能同时
 * 装进桌面版与 `dsh web` 的关键（见文件顶部第 1 条）。代价是少了一张自动生成的设置卡片，
 * 但插件本身没有设置界面，所以只是少了个空卡片；`Config` 缺失时 cordis 会原样返回配置，
 * 由 `withDefaults` 兜底合并。
 */
export const CONFIG_DEFAULTS = Object.freeze({
	/** 内核目录；空 = 自动（依赖 → 同机默认目录 → 插件内 node_modules）。 */
	kernelPath: "",
	/** 内存后端：self（默认，零依赖、同步、跨进程可用）、native-ce（连 ceserver）、dbk（走 DBK 内核驱动）。 */
	backend: "self",
	ceserverHost: "127.0.0.1",
	ceserverPort: 52736,
	/** DBK 后端用：驱动服务名（空 = 自动：driver.dat → CEDRIVER73）。 */
	dbkServiceName: "",
	/** DBK 后端用：Cheat Engine 安装目录（用于读 driver.dat 拿真实服务名）。 */
	cheatEngineDir: "",
	/** 是否允许写内存 / 执行 AutoAssembler 的写入段。 */
	allowWrite: true,
	/** 是否允许执行 CE Lua 脚本。 */
	allowLua: true,
	/** 汇编架构；空 = 按目标位数推断。 */
	arch: "",
	/** 扫描是否用 worker 线程并行。 */
	scanParallel: true,
	/** 并行 worker 数；0 = 内核默认（逻辑核数，上限 8）。 */
	workerCount: 0,
	/** 扫描块大小；0 = 内核默认 4MB。 */
	scanBlockSize: 0,
	/** 单次读取的字节上限（防止把超长字符串读爆内存）。 */
	maxReadBytes: 4096,
	/** 指针扫描默认最大层数。 */
	pointerScanMaxLevel: 5,
	/** 指针扫描默认单级最大偏移。 */
	pointerScanMaxOffset: 2048,
	/** Lua 里 sleep() 的上限（毫秒），防止脚本把宿主卡太久。 */
	luaMaxSleepMs: 60_000,
	/** 空闲多久回收一个会话（释放句柄、worker、Lua state）；0 = 不回收。 */
	idleTimeoutMs: 30 * 60 * 1000,
	/**
	 * 权限不足且**用户已同意**后，是否允许通过 UAC 启动提权助手。
	 * 关掉它就是「只提示、不提权」；注意无论如何都**不会自动提权**。
	 */
	autoElevate: true,
	/** 提权助手单次 RPC 的超时（毫秒）。 */
	helperTimeoutMs: 60_000,
	/**
	 * 启动提权助手后，等待它写出端口文件的限（毫秒）。
	 *
	 * ## 为什么要有这一项（曾经是个洞）
	 *
	 * `ce_elevation action=request` 把 `launchTimeoutMs` 传给启动器，但配置里
	 * **从来没有定义过这个键** —— 于是它恒为 `undefined`，启动器套用自己
	 * 的提权默认值 **90 秒**。用户一旦不点 UAC（关掉弹窗 / 点取消 / 走开），
	 * 这一次调用就**干等 90 秒**才报错，非常糟。
	 *
	 * 启动器其实已经会在"启动器进程退出且没有端口文件"时提前失败（UAC 被拒的
	 * 典型情形），所以真正的长等待发生在**UAC 弹窗一直挂着没人管**时 ——
	 * 那种情况只能靠超时兜底，所以这个值必须存在、且可配。
	 */
	launchTimeoutMs: 30_000,
	/**
	 * `ce_kernel` 的 install / load / unload 在**未提权**时，是否允许通过 UAC 提权执行。
	 *
	 * 与 `autoElevate` 是两回事，刻意分开：
	 *   - `autoElevate` 管的是"内存操作要管理员"（走常驻助手进程）；
	 *   - 这项管的是"装/卸内核驱动要管理员"（走一次性提权执行器）。
	 *
	 * 这两个动作本来就强制要求 `confirm: true`（已是明确同意），
	 * 所以这里默认 `true`：你确认过的动作，遇到权限不足就自动弹一次 UAC 完成它，
	 * 而不是丢给你一条手工 `sc.exe` 命令。设 `false` 则保持"只提示、不弹 UAC"。
	 */
	kernelElevate: true,
	/** `ce_kernel` 提权执行动作的等待上限（毫秒）；要留足用户点 UAC 的时间。 */
	kernelElevateTimeoutMs: 120_000,
	/**
	 * 仅配合 `backend: 'remote'` 生效：启动提权助手时是否弹 UAC。
	 * 默认 false（不提权启动助手），用于自测与「显式走助手但不提权」的场景。
	 */
	remoteElevate: false
});

/**
 * 注册全部工具并接管清理。
 *
 * @param {object} ctx cordis 上下文（必须已注入 tools）
 * @param {object} [rawConfig] 插件行的 config
 */
export function apply(ctx, rawConfig) {
	const config = withDefaults(rawConfig, CONFIG_DEFAULTS);
	const logger = ctx.logger;
	const sessions = createSessionStore(config, logger);
	const instanceStartedAt = Date.now();

	/** 传给各工具的运行时依赖。 */
	const runtime = {
		config,
		logger,
		sessions,
		loadKernel: () => loadKernel(config),
		ensureAsm: (ce) => ensureAsm(ce),
		resolveBackend: (ce) => resolveBackend(ce, config),
		/** `user-questions` 服务（可选）：提权前征求用户同意要用它。 */
		userQuestions: undefined,
		/** `backend: 'remote'` 时懒启动并复用的提权助手后端。 */
		remoteBackend: undefined
	};

	// 软依赖：这个 profile 装了 user-questions 才拿得到；没装也不影响其它功能，
	// 只是「权限不足时向用户确认」这一步会退化成一封不含交互的建议。
	ctx.inject(["userQuestions"], (questionCtx) => {
		runtime.userQuestions = questionCtx.userQuestions;
	});

	const tools = [
		createProcessesTool(runtime),
		createAttachTool(runtime),
		createSessionTool(runtime),
		createModulesTool(runtime),
		createRegionsTool(runtime),
		createReadTool(runtime),
		createWriteTool(runtime),
		createScanTool(runtime),
		createPointerScanTool(runtime),
		createDisassembleTool(runtime),
		createAssembleTool(runtime),
		createAutoAssembleTool(runtime),
		createLuaTool(runtime),
		createCheatTableTool(runtime),
		createKernelTool(runtime),
		// 提权入口的**兜底**：get-admin 未启用时，模型侧也必须有可调用的提权工具
		// （`get_admin` 来自 get-admin 的 apply，未启用就不存在）。
		// 底层仍调用 get-admin 的实现，不另起一套。
		createElevationTool(runtime)
	];

	for (const tool of tools) ctx.tools.register(tool);

	// 插件卸载：关掉目标进程句柄、扫描 worker 池、指针映射与 Lua state，
	// 并且**结束提权助手进程** —— 提权进程绝不该在插件卸载后继续留在用户机器上。
	ctx.effect(
		() => () => {
			disposeElevationHelper();
			return sessions.disposeAll();
		},
		"cheat-engine: 释放目标进程、扫描资源与提权助手"
	);

	// 只读状态路由。它有两个作用：
	// 1. 让人（和我）能确认插件在**运行中的** DSH 里真的激活了 —— 拿浏览器/curl 打一下就有答案，
	//    不用去翻日志或猜；2. 排查「工具没出现」时能区分「插件没激活」和「工具没被模型看到」。
	// 完全没有副作用：不读进程内存、不写任何东西。
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "prefix",
					path: STATUS_PATH,
					handler: async (_req, res) => {
						const payload = {
							plugin: PACKAGE_NAME,
							version: PLUGIN_VERSION,
							active: true,
							startedAt: instanceStartedAt,
							uptimeMs: Date.now() - instanceStartedAt,
							toolCount: tools.length,
							tools: tools.map((tool) => tool.name),
							kernel: kernelStatus(),
							config: {
								backend: config.backend,
								allowWrite: config.allowWrite !== false,
								allowLua: config.allowLua !== false,
								kernelPath: config.kernelPath === "" ? null : config.kernelPath
							},
							sessions: sessions.list().map((session) => ({
								key: session.key,
								target: session.target,
								scanResults: session.scan === null ? 0 : session.scan.resultCount,
								luaReady: session.lua !== null && session.lua.isReady
							})),
							// 长任务实时进度（目前是 ce_kernel acquire 的下载/解包）。
							//
							// 为什么放在这里：工具调用期间**没有标准的进度回传通道**，
							// 而下载官方安装包要几十秒到几分钟 —— 早先用户只看到"卡住"。
							// 所以把进度写进宿主状态，界面可以轮询这个路由显示出来。
							// 只读：没有任何入口能通过它改进度。
							progress: kernelProgressSnapshot()
							// ⚠️ 这里**刻意不再暴露提权状态**。
							//
							// 提权已经归属独立插件 `dsh-get-admin`：它的 `/get-admin/status`
							// 才是提权状态的唯一权威来源（且它会同时看进程内助手与跨进程发现记录）。
							// 本插件早先也报一份，还配套了控制路由与图标路由 ——
							// 那套东西的唯一消费者是已被清空的 `lib/client.js`（本插件现在没有界面），
							// 于是全成了死代码，而且两份 release 的语义已经分叉。
							// 要查提权状态请用 /get-admin/status。
						};
						res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
						res.end(JSON.stringify(payload, null, 2));
					}
				}),
			"cheat-engine: 状态路由"
		);

		// ── 提权界面的**接管**：仅在 get-admin 未启用时注册 ──────────────
		//
		// 背景：提权能力归属独立插件 `dsh-get-admin`，界面也随之归它。
		// 但插件管理器里"已安装"与"已启用"是两件事，而**新装插件默认是关的**。
		// 于是会出现一种很拧巴的状态（实测确认过）：
		//   · 提权机制**仍然可用** —— 因为本插件取 get-admin 的实现走的是
		//     **模块解析**（`require` 兄弟目录 / 包解析），与"是否启用"无关；
		//   · 但界面全没了（状态路由、右下角图标、`+` 菜单项、`get_admin` 工具
		//     全都来自 get-admin 的**插件加载**）。
		// 结果就是：**能悄无声息地拿到管理员权限，而用户看不见、也收不回**。
		//
		// 所以这里做**自动接管**：get-admin 没启用时，本插件补上它那份界面
		// （状态/控制/图标三条路由 + 客户端浮层与菜单项），
		// 但**提权本身仍然调用 get-admin 的代码**（`elevation-backend.js` 的模块解析），
		// 不另起一套实现 —— 这样"能用 = 可见 = 可控"三者始终一致。
		//
		// 判据：`ctx.get("getAdmin", false)`。`strict=false` 时服务缺失返回
		// `undefined` 而不是抛错，所以可以安全地当探测用。
		// ⚠️ 这个判断只在**插件启动时**做一次 —— 插件管理器的启停本来就伴随重启，
		// 不需要运行时反复探测。
		const getAdminService = typeof ctx.get === "function" ? ctx.get("getAdmin", false) : undefined;
		const ownsElevationUi = getAdminService === undefined;

		if (!ownsElevationUi) {
			logger.info("cheat-engine: dsh-get-admin 已启用，提权界面归它（本插件不注册提权路由）");
			return;
		}
		logger.info("cheat-engine: dsh-get-admin 未启用 → 本插件接管提权界面（提权仍走 get-admin 的实现）");

		// ① 提权状态/控制路由（GET 查状态，POST 释放）
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "prefix",
					path: "/cheat-engine/elevation",
					handler: async (req, res) => {
						const send = (status, body) => {
							res.writeHead(status, {
								"content-type": "application/json; charset=utf-8",
								"cache-control": "no-store"
							});
							res.end(JSON.stringify(body));
						};
						const snapshot = () => {
							const helper = elevationHelperStatus();
							return {
								hasHelper: helper !== null,
								helperElevated: helper !== null && helper.elevated === true,
								declined: isElevationCoolingDown()
							};
						};
						if (req.method === "GET") {
							send(200, { ok: true, elevation: snapshot() });
							return;
						}
						if (req.method !== "POST") {
							send(405, { ok: false, error: "只支持 GET（查状态）与 POST（释放权限）" });
							return;
						}
						try {
							// 与 `ce_kernel action=revoke` 走**同一套**逻辑：
							// `disposeElevationHelper()` 已同时处理"进程内助手"与
							// "跨进程发现记录"，不会出现"显示已获得却收不回"。
							disposeElevationHelper();
							clearElevationDeclined();
							logger.info("cheat-engine: 已按界面请求释放提权助手");
							send(200, { ok: true, elevation: snapshot() });
						} catch (error) {
							send(500, { ok: false, error: error && error.message ? error.message : String(error) });
						}
					}
				}),
			"cheat-engine: 提权控制路由（接管 get-admin 未启用时的界面）"
		);

		// ② 图标路由（供接管时自己的浮层与菜单项使用）
		//
		// ⚠️ 前缀**绝不能带结尾斜杠**：webServer 的匹配是
		// `pathname === prefix || pathname.startsWith(prefix + "/")`，
		// 前缀自带斜杠时子路径恒不匹配（早先正是如此导致图标全是破图）。
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "prefix",
					path: "/cheat-engine/icon",
					handler: async (req, res) => {
						const pathname = new URL(String(req.url ?? ""), "http://localhost").pathname;
						const name = pathname.slice("/cheat-engine/icon".length).replace(/^\/+/, "");
						// 白名单：必须是白名单而不是拼路径，否则 `..` 会变成任意文件读取
						const files = {
							admin: "dsh-cheat-engine-admin.svg",
							"yes-admin": "dsh-cheat-engine-yes-admin.svg",
							"no-admin": "dsh-cheat-engine-no-admin.svg"
						};
						const fileName = files[name];
						if (fileName === undefined) {
							res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
							res.end(`未知图标「${name}」。可用：${Object.keys(files).join(", ")}`);
							return;
						}
						try {
							const svg = readFileSync(join(PLUGIN_DIR, "icons", fileName));
							res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" });
							res.end(svg);
						} catch (error) {
							res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
							res.end(`读取图标失败：${error && error.message ? error.message : String(error)}`);
						}
					}
				}),
			"cheat-engine: 图标路由（接管 get-admin 未启用时的界面）"
		);
	});

	logger.info(
		"cheat-engine 已激活：注册 %d 个 Cheat Engine 工具（后端 %s，写入 %s，Lua %s）",
		tools.length,
		config.backend,
		config.allowWrite === false ? "关闭" : "开启",
		config.allowLua === false ? "关闭" : "开启"
	);
	logger.info(
		"cheat-engine 内核将在首次调用工具时加载（kernelPath=%s）。用 ce_processes 开始。",
		config.kernelPath === "" ? "自动解析" : config.kernelPath
	);
}
