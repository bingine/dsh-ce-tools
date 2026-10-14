/**
 * 内核驱动工具：`ce_kernel`
 *
 * 把 `kernel-driver.js` 的能力暴露给模型/用户。**默认只读**：只有显式传
 * `action: "acquire" | "install" | "load" | "unload"` 才会下载或改动系统。
 *
 * ## 为什么做成一个带 action 的工具，而不是四个工具
 *
 * 内核驱动是**一条有顺序的链路**（获取 → 安装 → 加载），每一步的前置条件都是上一步的产物。
 * 拆成四个工具会让「当前走到哪一步、缺什么」散落在多次调用里；一个工具带 action
 * 能在每次输出里完整报告当前状态与下一步该做什么。
 *
 * ## 安全闸门（与用户约定一致：默认关闭 + 显式同意）
 *
 * - `status` 是**纯只读**探测，随时可调，不下载任何东西、不改系统；
 * - `acquire` 会联网下载官方安装包（约 100–200MB，仅在没有本机 CE 可解时才下）
 *   并在缓存目录解包 —— **不碰系统目录**；
 * - `install` / `load` / `unload` 会改系统（复制驱动到 System32、建内核服务、加载驱动），
 *   因此**必须管理员权限**，且需要显式传 `confirm: true`。
 *
 * ## 必须如实说清的能力边界
 *
 * **驱动装好 ≠ 受保护进程立刻可读**，还差两步：加载驱动（需要管理员），
 * 以及把插件配置的 `backend` 从 `self` 改成 `dbk`（`DbkBackend` 才走内核 ioctl）。
 * 这个前提会出现在 `status` 与每次安装/加载的输出里，不会让人误以为「装好就能读」。
 *
 * 另外两处**已知短板**（会一并在输出里说明）：
 *   - `changeProtection` / `free` 仍是用户态实现 —— CE 驱动的 `MAKEWRITABLE`
 *     在 x64 上是空的，所以对受保护进程这两个操作会失败；
 *   - `DbkBackend` 的驱动侧结构布局**尚未在真机上验证**，
 *     所以提供 `probe_driver` 这个只读动作让人先确认连通性。
 *
 * @module dsh-cheat-engine/tools/kernel
 */
import {
	DBK64_FILE,
	DBK64_SERVICE,
	DBK64_SYSTEM_PATH,
	acquireDriver,
	cleanupDriverCache,
	driverStatus,
	fetchInnoextract,
	installDriver,
	loadDriver,
	unloadDriver
} from "../kernel-driver.js";
import { askToElevate, isElevated, isPermissionDenied } from "../elevation.js";
import { askToDownload } from "../download-consent.js";
import { beginKernelProgress } from "../progress.js";
import { clearElevationDeclined } from "../remote/kernel-elevate.js";
import { disposeElevationHelper, elevationHelperStatus } from "../elevation-backend.js";
import { runElevatedKernelAction } from "../remote/kernel-elevate.js";
import { makeEnvelopeTool } from "./shared.js";

/** 需要管理员的关键动作。 */
const ADMIN_ACTIONS = new Set(["install", "load", "unload"]);

/**
 * `acquireDriver()` 的结果 → 工具返回值（`{ summary, lines, data }`）。
 *
 * ## 为什么抽成独立导出的函数（这是一次真实崩溃的修复）
 *
 * `acquireDriver()` 有两条路：
 *   1. **首选**：本机已装 Cheat Engine → 直接解它的 `dbk64.cepack`
 *      （不联网、不需要安装包、不需要管理员）；
 *   2. 兜底：下载官方安装包再解包。
 *
 * 第 1 条路上 `installerPath` / `installerSize` / `installerSignature` /
 * `installerSha256` **全是 `null`**（根本没经过安装包）。早先这段输出是内联在
 * `run()` 里的，直接写 `result.installerSignature.signer` —— 于是**最省事的那条路
 * 一调用就抛** `TypeError: Cannot read properties of null (reading 'signer')`。
 *
 * 抽出来有两个好处：**可被直接单测**（不必真的装 CE、不必联网、不必注入假内核），
 * 且这段"两条路都要正确表达"的逻辑有了唯一归属。
 *
 * @param {object} result `acquireDriver()` 的返回值
 * @param {string[]} [progress] 本次进度轨迹（来自 `onProgress` 回调）
 * @returns {{ summary: string, lines: string[], data: object }}
 */
export function describeAcquireResult(result, progress = []) {
	const sig = result.signature;
	// ⚠️ 这五个字段必须**统一先归一成显式 null** 再用（见上面的长注释）。
	// `test/acquire-local-cepack.test.mjs` 有一条源码级守卫盯着这五行的存在 ——
	// 因为运行时"喂 null 看会不会抛"测不出退化（`?? null` 恰好容忍 undefined）。
	const installerPath = result.installerPath ?? null;
	const installerOrigin = result.installerOrigin ?? null;
	const installerSize = result.installerSize ?? null;
	const installerSignature = result.installerSignature ?? null;
	const installerSha256 = result.installerSha256 ?? null;
	const lines = [
		...(result.log ?? []),
		"",
		installerSize === null
			? "本次**没有用到安装包**（直接取自本机已装的 Cheat Engine），所以没有安装包签名与哈希。"
			: `安装包：${installerSize} 字节，来源 ${installerOrigin ?? "(未知)"}`,
		...(installerSignature === null
			? []
			: [
				`安装包签名主体：${installerSignature.signer ?? "(读不到)"}`,
				`安装包 SHA256：${installerSha256 ?? "(读不到)"}`
			]),
		`驱动 SHA256：${result.sha256}`,
		`驱动来源：${result.sourceDescription}`,
		`驱动签名状态：${sig.status}${sig.present ? "（带内嵌证书表）" : "（无内嵌证书表）"}`,
		"",
		"下一步：action=install 安装为内核服务（需要管理员权限），然后 action=load 加载。",
		"加载之后把插件配置的 backend 改成 dbk，内存读写与分配才会走内核 ioctl；",
		"可用 action=probe_driver 先确认设备连通性（该后端的结构布局尚未在真机验证）。"
	];
	return {
		summary: `已获取并校验 ${DBK64_FILE}（${result.driverSize} 字节，${result.pe.machine} 内核驱动）`,
		lines,
		data: {
			installerPath,
			installerSize,
			installerSignature: installerSignature === null ? null : installerSignature.status,
			installerSigner: installerSignature === null ? null : (installerSignature.signer ?? null),
			installerSha256,
			driverPath: result.driverPath,
			driverSize: result.driverSize,
			driverSha256: result.sha256,
			driverSource: result.sourceDescription,
			driverSignatureStatus: sig.status,
			driverSignaturePresent: sig.present,
			pe: result.pe,
			progress
		}
	};
}

/** 把 driverStatus() 的结果整理成给人看的行。 */
function statusLines(status) {
	const service = status.service;
	const lines = [
		`提权状态：${status.elevated ? "已提权（管理员）" : "**未提权** —— 安装/加载驱动会被系统拒绝"}`,
		`内核服务 ${DBK64_SERVICE}：${service.installed ? `${service.state}${service.state === "RUNNING" ? "（已加载）" : ""}` : "未安装"}`,
		`服务映像路径：${status.servicePath ?? "(无)"}`,
		`System32 驱动：${status.systemDriver.present ? `存在，${status.systemDriver.sizeBytes} 字节` : "不存在"}`,
		`缓存中的驱动：${
			status.cachedDrivers.length === 0
				? "无（还没获取过）"
				: status.cachedDrivers
						.map((d) => `${d.path.split(/[\\/]/).pop()}（${d.sizeBytes} 字节，原生驱动=${d.pe.isNativeDriver}）`)
						.join("；")
		}`
	];
	if (status.systemDriver.present && status.systemDriver.pe !== null) {
		const pe = status.systemDriver.pe;
		lines.push(`System32 驱动 PE：${pe.machine} / PE32+=${pe.is64Bit} / subsystem=${pe.subsystem}（1=内核驱动）`);
	}
	lines.push("");
	lines.push(`⚠️ ${status.backendNote}`);
	return lines;
}

/**
 * 执行一个需要管理员权限的内核驱动动作，**必要时自动提权**。
 *
 * ## 流程（与 `ce_attach` 的提权路径同一套约定）
 *
 * 1. 先**直接试一次** —— 如果当前已经是管理员，就没必要弹 UAC；
 * 2. 失败且是权限问题 → 检查 `autoElevate` 开关；
 * 3. 开关开着 → 用 `runElevatedKernelAction` 走 UAC 提权执行一次；
 * 4. 开关关着 → 抛出原始错误（带手工命令），**绝不偷偷提权**。
 *
 * ## 为什么不需要再问一次用户
 *
 * `ce_kernel` 的这几个 action **本来就强制要求 `confirm: true`**
 * （见上面的闸门），那已经是明确的用户同意。users-questions 再弹一次是重复确认，
 * 所以这里只在 `autoElevate` 允许时才走 UAC。
 *
 * @param {object} params
 * @param {object} params.runtime 插件运行时
 * @param {object} params.exec 工具执行上下文
 * @param {string} params.action install / load / unload
 * @param {() => object} params.direct 直接执行（不提权）的函数
 * @param {string} [params.driverPath] install 用
 * @returns {Promise<{ elevated: boolean, log: string[], result: object|null }>}
 */
async function runKernelAction({ runtime, exec, action, direct, driverPath }) {
	try {
		const result = direct();
		return { elevated: false, log: Array.isArray(result?.log) ? result.log : [], result };
	} catch (error) {
		// 判断"是否值得走 UAC"用**结构化标记**而不是文本匹配：
		// `requireAdmin` 抛的是 KernelAdminRequiredError（带 permissionDenied 标记），
		// 而 elevation.js 的 isPermissionDenied() 不认「需要管理员权限」这个措辞 ——
		// 只靠文本会让提权分支永远进不去（踩过）。
		const needsAdmin =
			error !== null &&
			typeof error === "object" &&
			(error.adminRequired === true || error.permissionDenied === true || isPermissionDenied(error));
		if (!needsAdmin) throw error;
		if (runtime.config.kernelElevate === false) {
			// 明确按配置关掉了自动提权：保留原始错误（它已带手工命令）
			throw error;
		}

		// 走 UAC 提权执行一次
		const elevated = await runElevatedKernelAction({
			action,
			driverPath,
			timeoutMs:
				Number(runtime.config.kernelElevateTimeoutMs) > 0
					? Number(runtime.config.kernelElevateTimeoutMs)
					: undefined,
			log: (message) => runtime.logger.info("cheat-engine: %s", message)
		});
		if (!elevated.ok) {
			throw new Error(
				`提权执行 ${action} 失败：${elevated.error ?? "未知原因"}\n\n` +
				`原始错误（未提权时）：${error.message}`
			);
		}
		return { elevated: true, log: elevated.log, result: elevated.result };
	}
}

/**
 * 创建 `ce_kernel` 工具。
 * @param {object} runtime 插件运行时
 */
export function createKernelTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_kernel",
		description:
			"管理 Cheat Engine 的内核驱动 DBK64（自动获取驱动 → 校验 → 安装 → 加载 → 卸载 → 清理缓存）。" +
			"action=status（默认）只做只读探测，不改任何东西；" +
			"action=probe_driver 只读：测试 DBK 驱动设备能否打开、GETVERSION 是否响应；" +
			"action=acquire 获取驱动到插件缓存（优先解本机已装 CE 的 dbk64.cepack，不碰系统目录、不需要管理员）；" +
			"action=install / load / unload 会改系统，**需要管理员权限**且必须显式传 confirm: true；" +
			"action=cleanup 清缓存（不需要管理员，不动系统里的驱动）。" +
			"要真正用上内核读写还需把插件配置的 backend 改成 dbk（DbkBackend 走内核 ioctl 读写与分配）。" +
			"已知短板：changeProtection/free 仍是用户态（CE 驱动的 MAKEWRITABLE 在 x64 上为空），对受保护进程会失败。",
		parameters: {
			action: {
				type: "string",
				description:
					"status（默认，只读）| probe_driver（只读：测试 DBK 驱动设备能否打开、GETVERSION 是否响应）|" +
					" acquire（下载并提取）| install（安装内核服务）| load（加载）| unload（停止并卸载）|" +
					" cleanup（清理缓存，不需要管理员）\| revoke（立即释放已授予的管理员权限）\| fetch_extractor（下载 innoextract 解包工具）"
			},
			confirm: {
				type: "boolean",
				description: "install / load / unload 必须传 true，表示你确认要改动系统（会装内核驱动）。"
			},
			keepExtractor: {
				type: "boolean",
				description: "cleanup 用：是否保留 innoextract 解包工具（默认 false，一并删掉）。"
			},
			localInstaller: {
				type: "string",
				description: "acquire 用：本地已有的 CE 安装包路径（给了就不下载）。"
			},
			installerUrl: {
				type: "string",
				description: "acquire 用：直接指定安装包下载地址（跳过页面解析）。"
			},
			localDriver: {
				type: "string",
				description: "install 用：直接指定要安装的 DBK64.sys 路径（跳过获取链路）。"
			},
			allowSilentInstall: {
				type: "boolean",
				description:
					"acquire 用：解包工具取不到驱动时，是否允许用官方安装包静默解包到私有目录兜底（默认 true）。" +
					"该兜底会装出完整 CE 文件到插件缓存并写一条卸载信息到注册表，装完会尽量清理。"
			}
		},
		timeoutMs: 600_000,
		async run(args, exec) {
			const action = typeof args.action === "string" && args.action.trim() !== "" ? args.action.trim().toLowerCase() : "status";

			/* ---------------- 只读状态 ---------------- */
			if (action === "status") {
				const status = driverStatus();
				return {
					summary: status.service.state === "RUNNING"
						? `内核驱动已加载（服务 ${DBK64_SERVICE} RUNNING）`
						: `内核驱动未加载（服务 ${DBK64_SERVICE}：${status.service.state}；当前${status.elevated ? "已" : "未"}提权）`,
					lines: statusLines(status),
					data: {
						elevated: status.elevated,
						serviceName: DBK64_SERVICE,
						serviceState: status.service.state,
						serviceInstalled: status.service.installed,
						servicePath: status.servicePath,
						systemDriverPath: DBK64_SYSTEM_PATH,
						systemDriverPresent: status.systemDriver.present,
						systemDriverSize: status.systemDriver.sizeBytes,
						cachedDrivers: status.cachedDrivers.map((d) => ({
							path: d.path,
							sizeBytes: d.sizeBytes,
							isNativeDriver: d.pe.isNativeDriver,
							machine: d.pe.machine
						})),
						backendNote: status.backendNote
					}
				};
			}

			/* ---------------- 驱动连通性自检（只读） ---------------- */
			if (action === "probe_driver") {
				// 这是**唯一能在真机上验证 DBK 后端的手段**：
				// ioctl 码与结构布局无法在没有管理员权限的机器上验证，所以让用户
				// 在装好驱动后跑这个动作，得到「设备能否打开、GETVERSION 是否响应」的明确结论。
				const kernelInfo = runtime.loadKernel();
				const ce = kernelInfo.ce;
				if (typeof ce.DbkBackend !== "function") {
					throw new Error(
						"当前加载的 node-cheat-engine 内核版本没有导出 DbkBackend。" +
						`已加载：${kernelInfo.resolvedFrom}（导出 ${kernelInfo.exports} 项）。请更新内核。`
					);
				}
				const backend = new ce.DbkBackend({
					serviceName: runtime.config.dbkServiceName ?? "",
					cheatEngineDir: runtime.config.cheatEngineDir ?? ""
				});
				const probe = backend.probe();
				const status = driverStatus();
				const lines = [
					`设备路径：${probe.devicePath}`,
					`能否打开：${probe.opened ? "能" : "**不能**"}`,
					`驱动版本：${probe.version ?? "(读不到)"}`,
					`内核服务 ${DBK64_SERVICE}：${status.service.state}`,
					`当前提权：${status.elevated ? "是" : "否"}`
				];
				if (!probe.opened) {
					lines.push("");
					lines.push("打不开设备的原因（按可能性排序）：");
					lines.push("  1. 驱动未加载 —— 先 ce_kernel action=install 再 action=load（需要管理员）；");
					lines.push("  2. 服务名不是默认的 CEDRIVER73 —— CE 安装时会随机化，");
					lines.push("     可在插件配置里设 dbkServiceName，或设 cheatEngineDir 让插件读 driver.dat；");
					lines.push("  3. 当前进程未提权 —— 打开驱动设备同样需要管理员。");
					lines.push("");
					lines.push(`底层错误：${probe.error}`);
				} else if (probe.version === null) {
					lines.push("");
					lines.push(
						"⚠️ 设备打开了，但 GETVERSION 没有返回可解释的内容 —— " +
						"这通常意味着 ioctl 结构布局与驱动预期不一致（本后端的已知未验证点）。" +
						"内存读写可能因此失败，请把这条输出反馈出来。"
					);
				} else {
					lines.push("");
					lines.push(
						"✅ 设备可打开且 GETVERSION 有响应 —— 驱动连通性正常。" +
						"接下来可把插件配置的 backend 设为 dbk 走内核读写。"
					);
				}
				const result = {
					summary: probe.opened
						? `DBK 驱动设备可打开（${probe.devicePath}，版本 ${probe.version ?? "未知"}）`
						: `DBK 驱动设备打不开（${probe.devicePath}）`,
					lines,
					data: {
						devicePath: probe.devicePath,
						opened: probe.opened,
						version: probe.version,
						serviceState: status.service.state,
						elevated: status.elevated,
						error: probe.error
					}
				};
				backend.dispose();
				return result;
			}

			/* ---------------- 下载解包工具 ---------------- */
			if (action === "fetch_extractor") {
				const fetched = await fetchInnoextract();
				return {
					summary: `已下载 innoextract 解包工具（${fetched.zipBytes} 字节）`,
					lines: [`来源：${fetched.url}`, `解包器：${fetched.extractorPath}`],
					data: { extractorPath: fetched.extractorPath, url: fetched.url, zipBytes: fetched.zipBytes }
				};
			}

			/* ---------------- 获取（不需要管理员） ---------------- */
			if (action === "acquire") {
				// ⚠️ 下载也要先取得人的同意。
				//
				// 早先这里**没有任何确认**：模型可以自主发起外部下载
				// （抓 cheatengine.org → 解析直链 → 下 100–200MB 安装包 → 解包出驱动）。
				// 它不改系统，但会消耗带宽、在磁盘留下大文件、产生外部请求 ——
				// 这些不该由模型单方面决定。
				//
				// 刻意**不用** `askToElevate`：这里不需要管理员、也不扩大权限边界，
				// 硬套"提权"的话文案会误导用户。但两者**同规格**：
				// fail-closed、按选项 id 判定、默认不同意。
				const downloadOk = await askToDownload(runtime.userQuestions, exec, { what: "Cheat Engine 安装包" });
				if (!downloadOk.approved) {
					const error = new Error(downloadOk.reason);
					error.permissionDenied = true;
					throw error;
				}

				const progress = [];
				// 实时进度：写进宿主状态，界面/后续调用可查（见 lib/progress.js）。
				// 下载会持续几十秒到几分钟，早先**全程无反馈**，用户只看到"卡住"。
				const tracker = beginKernelProgress("acquire");
				let result;
				try {
					result = await acquireDriver({
						installerUrl: args.installerUrl,
						localInstaller: args.localInstaller,
						allowSilentInstall: args.allowSilentInstall !== false,
						onProgress: (phase, detail) => {
							progress.push(`${phase}: ${String(detail).slice(0, 160)}`);
							tracker.step(phase, detail);
						}
					});
				} catch (error) {
					// 失败也要如实标记，否则界面会一直显示"进行中"
					tracker.fail(error && error.message ? error.message : String(error));
					throw error;
				}
				tracker.done(`已获取并校验 ${DBK64_FILE}`);
				return describeAcquireResult(result, progress);
			}

			/* ---------------- 需要管理员的动作 ---------------- */
			if (ADMIN_ACTIONS.has(action)) {
				if (args.confirm !== true) {
					throw new Error(
						`ce_kernel action=${action} 会改动系统（安装/加载内核驱动），必须显式传 confirm: true。\n` +
						"这个动作会：把 DBK64.sys 复制到 System32\\drivers、创建名为 DBK64 的内核服务、或加载/停止它。\n" +
						"请确认你理解它会加载一个内核级驱动（会削弱系统防护、可能被反作弊或安全软件拦截）后再调用。"
					);
				}

				// 未提权时先征求**人的**同意（提权会扩大插件权限边界，不自动做）。
				//
				// ⚠️ 这里**刻意不再判断 `runtime.userQuestions !== undefined`**。
				//
				// 早先的写法是 `if (!isElevated() && runtime.userQuestions !== undefined)`，
				// 于是没有 `user-questions` 服务的 profile（例如 headless）会**整段跳过**这一步，
				// 直接进提权分支 —— 与 lib/index.js 里"没装也只会退化成一封不含交互的建议"
				// 这句注释**正好相反**。后果：模型凭 `confirm: true`（那是给模型看的确认）
				// 就能触发真实 UAC，而没有任何人的确认。
				//
				// 现在改为**无条件调用** `askToElevate`：它自身在拿不到
				// `userQuestions` / `agent` 时会返回 `approved:false`（fail-closed），
				// 所以"服务缺失"的正确表现是**拒绝并说明原因**，而不是放行。
				// 这与另一个调用点（lib/tools/process.js）的契约也就一致了。
				if (!isElevated()) {
					const consent = await askToElevate(runtime.userQuestions, exec, {
						target: null,
						action: `ce_kernel ${action}`
					});
					if (!consent.approved) {
						const error = new Error(consent.reason);
						error.permissionDenied = true;
						throw error;
					}
				}

				if (action === "install") {
					let driverPath = args.localDriver;
					if (typeof driverPath !== "string" || driverPath.trim() === "") {
						// 没给路径就用缓存里已获取的驱动
						const status = driverStatus({ ce: runtime.loadKernel().ce });
						const cached = status.cachedDrivers.find((d) => d.pe.isNativeDriver);
						if (cached === undefined) {
							throw new Error(
								"还没获取到驱动。请先调用 ce_kernel action=acquire，或用 localDriver 参数直接给出 DBK64.sys 路径。"
							);
						}
						driverPath = cached.path;
					}
					const run = await runKernelAction({
						runtime, exec, action: "install", driverPath,
						direct: () => installDriver({ driverPath })
					});
					const after = driverStatus({ ce: runtime.loadKernel().ce });
					return {
						summary: `已安装内核服务 ${DBK64_SERVICE}（状态 ${after.service.state}）`,
						lines: [
							...(run.elevated ? ["已通过 UAC 提权执行。"] : []),
							...run.log,
							`服务状态：${after.service.state}`,
							`服务映像：${after.servicePath ?? "(读不到)"}`,
							"下一步：action=load 加载驱动。"
						],
						data: {
							driverPath,
							serviceName: DBK64_SERVICE,
							serviceState: after.service.state,
							servicePath: after.servicePath,
							elevated: run.elevated === true
						}
					};
				}

				if (action === "load") {
					const run = await runKernelAction({
						runtime, exec, action: "load",
						direct: () => loadDriver()
					});
					const after = driverStatus({ ce: runtime.loadKernel().ce });
					return {
						summary: run.result?.alreadyRunning
							? "内核驱动本来就在运行"
							: `内核驱动已加载（${DBK64_SERVICE} RUNNING）`,
						lines: [
							...(run.elevated ? ["已通过 UAC 提权执行。"] : []),
							...(run.result?.message === undefined ? run.log : [run.result.message]),
							`服务状态：${after.service.state}`,
							"",
							`⚠️ ${after.backendNote}`
						],
						data: {
							started: run.result?.started,
							alreadyRunning: run.result?.alreadyRunning,
							serviceState: after.service.state,
							backendNote: after.backendNote,
							elevated: run.elevated === true
						}
					};
				}

				// unload
				const run = await runKernelAction({
					runtime, exec, action: "unload",
					direct: () => unloadDriver()
				});
				const unloaded = run.result;
				const state = unloaded?.state ?? "UNKNOWN";
				const deleted = unloaded?.deleted === true;
				return {
					summary: deleted
						? `已卸载内核服务 ${DBK64_SERVICE}（服务已删除，状态 ${state}）`
						: `卸载未完全成功：服务 ${DBK64_SERVICE} 仍存在（状态 ${state}）`,
					lines: [
						...(run.elevated ? ["已通过 UAC 提权执行。"] : []),
						...run.log,
						"",
						"提示：卸载只处理驱动本身（服务 + System32 下的驱动文件）。",
						"缓存里的安装包/解出的驱动副本可以用 action=cleanup 单独清掉（不需要管理员）。"
					],
					data: { log: run.log, serviceState: state, deleted, elevated: run.elevated === true }
				};
			}

			/* ---------------- 立即释放管理员权限（不需要管理员） ---------------- */
			if (action === "revoke") {
				// 用户诉求：不想等助手空闲自退，也不想每次都弹 UAC，
				// 而是能**主动**把已经授予的管理员权限收回。
				const before = elevationHelperStatus();
				const lines = [];
				if (before === null) {
					lines.push("当前没有运行中的提权助手，无需释放。");
				} else {
					lines.push(
						`释放前：助手 pid ${before.pid}，端口 ${before.port}，权限 ${
							before.elevated ? "**已提权**" : "未提权"
						}`
					);
				}
				disposeElevationHelper();
				clearElevationDeclined();
				lines.push("已释放提权助手通道（关闭 RPC、请求结束助手进程、清掉跨进程发现记录）。");
				lines.push("已清除「拒绝提权」的冷却记录 —— 下次动作可以重新请求提权。");
				lines.push("");
				lines.push("注意：这**不会**卸载内核驱动（若已加载）。DBK64 是独立的内核服务，");
				lines.push("要卸掉它请用 action=unload（需要管理员权限）。");
				const after = driverStatus({ ce: runtime.loadKernel().ce });
				return {
					summary:
						before === null
							? "已释放提权助手与拒绝记录（此前没有助手在运行）"
							: `已释放提权助手（pid ${before.pid}${before.elevated ? "，此前已提权" : ""}）`,
					lines,
					data: {
						hadHelper: before !== null,
						previousHelperPid: before?.pid ?? null,
						previousHelperElevated: before?.elevated ?? null,
						driverServiceState: after.service.state
					}
				};
			}

			/* ---------------- 清理缓存（不需要管理员） ---------------- */
			if (action === "cleanup") {
				const result = cleanupDriverCache({ keepExtractor: args.keepExtractor === true });
				const status = driverStatus({ ce: runtime.loadKernel().ce });
				return {
					summary: `已清理驱动缓存（释放 ${(result.freedBytes / 1048576).toFixed(1)} MB）`,
					lines: [
						...result.log,
						"",
						`内核服务 ${DBK64_SERVICE}：${status.service.state}${status.service.installed ? "（仍在，未受影响）" : ""}`,
						"注意：cleanup 不动内核服务，也不动 System32 下的驱动文件 —— 那是 action=unload 的职责。",
						"缓存清掉后用 action=acquire 可以随时重新获取。"
					],
					data: { log: result.log, freedBytes: result.freedBytes, serviceState: status.service.state }
				};
			}

			// ⚠️ 这个列表必须与工具 description 里的 action 列表**逐个对齐**。
			// 早先这里只列了 4 个（漏了 probe_driver / revoke / cleanup），
			// 于是拼错 action 的人拿到的"可用值"本身就是错的 —— 照着改还是错。
			throw new Error(
				`未知的 action "${action}"。可用：status、probe_driver、acquire、install、load、` +
					"unload、revoke、cleanup、fetch_extractor。"
			);
		}
	});
}
