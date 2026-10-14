/**
 * 目标发现与附加类工具：
 * `ce_processes` / `ce_attach` / `ce_session` / `ce_modules` / `ce_regions`
 *
 * 这一组是使用 Cheat Engine 能力的第一步：先找到目标进程，附加它，再看清它的
 * 模块（拿到静态基址）与内存区域（判断哪段可写/可执行）。
 *
 * @module dsh-ce-tools/tools/process
 */

import {
	describeAddress,
	describeProtection,
	describeRegionType,
	formatAddress,
	formatBytesCount,
	resolveAddressInput
} from "../values.js";
import { askToElevate } from "../elevation.js";
// 提权后端走**共享**入口：优先用 dsh-get-admin 插件的实现，解析不到才回退到自带副本。
import { startElevationBackend } from "../elevation-backend.js";
import { makeEnvelopeTool, prepare } from "./shared.js";

/**
 * 取内核 + 会话 + 后端（附加拿路径也要用）。
 *
 * 配置 `backend: 'remote'` 时走**提权助手**：助手在自己的进程里持有句柄，因此能读得动
 * 高权限目标（配合 `remoteElevate: true` 时会弹一次 UAC）。助手是懒启动且进程内复用的，
 * 所以这里必须是 async。
 */
async function contextFor(runtime, exec) {
	const { ce, session } = prepare(runtime, exec);
	if (String(runtime.config.backend ?? "self").toLowerCase() === "remote") {
		const remote = runtime.remoteBackend ?? (runtime.remoteBackend = await startElevationBackend({
			elevate: runtime.config.remoteElevate === true,
			kernelPath: runtime.config.kernelPath,
			timeoutMs: runtime.config.helperTimeoutMs,
			log: (message) => runtime.logger.info("cheat-engine: %s", message)
		}));
		// async: false —— 远程后端在 JS 侧是同步的（内部 Atomics 阻塞等结果），
		// 所以走的是 Process.open 的同步分支，扫描/汇编也照常可用
		return { ce, session, backend: { backend: remote, name: remote.name, async: false } };
	}
	return { ce, session, backend: runtime.resolveBackend(ce) };
}

/**
 * 枚举进程。
 * @param {object} runtime 插件运行时
 */
export function createProcessesTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_processes",
		description:
			"列出 Windows 上正在运行的进程（pid / 名字 / 线程数），用于找到要附加的目标。" +
			"传入 filter 做名字部分匹配（不区分大小写）能得到更短的结果。" +
			"拿到 pid 后调用 ce_attach。注意：系统进程（pid 0/4）与受保护进程无法打开句柄。" +
			"【后端差异】原生 CE（ceserver）协议的进程枚举**只带 pid 与名字**，" +
			"所以 backend: native-ce 时这两个字段**不提供**：data.processes[] 里" +
			"不会有 threads / parentPid 键，取而代之的是 threadsKnown: false /" +
			"parentPidKnown: false（文本输出里显示「未知」）—— 绝不会用 0 冒充真值。" +
			"self 后端给的是真实线程数与父进程 pid（threadsKnown: true）。",
		parameters: {
			filter: { type: "string", description: "进程名的一部分（不区分大小写）。省略则列出全部。" },
			limit: { type: "integer", description: "最多返回多少个进程，默认 40。" }
		},
		async run(args, exec) {
			// 枚举进程不需要目标会话，也就不该为它凭空建一个。
			//
			// ⚠️ 但**必须**走 contextFor 拿后端 —— 早先这里直接调 `ce.listProcesses()`，
			// 没把配置里的 `backend` 传下去，于是它永远用内核的**默认（self）后端**：
			// 配置成 `native-ce` 时，即使把 ceserverPort 指向一个没人监听的端口，
			// `ce_processes` 也照样成功返回本机进程（实测：监听端收到 0 个连接）。
			// 而 `ce_attach` 是走 contextFor 的 —— 同一个配置下两个工具行为不一致，
			// 而且 `ce_processes` 给出的 threads/parentPid 会与目标后端不是同一来源。
			//
			// native-ce 是**异步**后端，必须走 `*Async` 变体（同步变体会抛错）。
			const { ce, backend } = await contextFor(runtime, exec);
			const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 40;
			const filter = typeof args.filter === "string" ? args.filter.trim() : "";
			const all = backend.async
				? filter === ""
					? await ce.listProcessesAsync(backend.backend)
					: await ce.findProcessesByNameAsync(filter, backend.backend)
				: filter === ""
					? ce.listProcesses(backend.backend)
					: ce.findProcessesByName(filter, backend.backend);
			const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
			const shown = sorted.slice(0, limit);
			// ⚠️ `threadCount` / `parentPid` 可能是 `null`（该后端不提供这个字段，
			// 例如原生 CE 的 ceserver 协议只回 pid + 名字）。
			// 必须显示成「未知」——早先内核把不支持硬编码成 0，
			// 于是这里对每个进程都显示「线程 0」，一个**看起来像真值**的假值。
			const unknownText = "未知";
			const threadsText = (count) =>
				typeof count === "number" && Number.isFinite(count) ? String(count) : unknownText;
			/** 是否至少有一个进程的线程数未知（用于在末尾补一句说明，而不是让人猜）。 */
			const threadsUnknown = shown.some((p) => typeof p.threadCount !== "number");
			const parentUnknown = shown.some((p) => typeof p.parentPid !== "number");
			const lines = shown.map((p) => {
				const duplicate = p.duplicateName ? "  (同名多进程，可加 index 选中)" : "";
				return `pid ${String(p.pid).padStart(6)}  ${p.name}  [线程 ${threadsText(p.threadCount)}]${duplicate}`;
			});
			if (threadsUnknown || parentUnknown) {
				lines.push(
					"注：当前后端不提供" +
						[threadsUnknown ? "线程数" : null, parentUnknown ? "父进程 pid" : null]
							.filter((part) => part !== null)
							.join("与") +
						"（显示为「未知」，不是 0）。原生 CE（ceserver）只回 pid + 名字；" +
						"需要真实线程数请用 self 后端。"
				);
			}
			if (sorted.length > shown.length) {
				lines.push(`… 还有 ${sorted.length - shown.length} 个未显示（用 filter 缩小范围，或调大 limit）`);
			}
			return {
				summary:
					`共 ${all.length} 个进程` +
					(filter === "" ? "" : `，名字匹配 "${filter}"`) +
					`，显示 ${shown.length} 个`,
				lines,
				data: {
					total: all.length,
					count: shown.length,
					// 「未知」怎么表达：**省略该键 + 显式 known 标志**。
					//
					// ⚠️ 这里刻意**不用 `null`** —— 不是省事，而是信封层装不下它：
					// `lib/toolkit.js` 的 `toJsonSafe`（工具出口统一走它）把 `null` 与
					// `undefined` 一并转成 `undefined` 再丢掉，理由是"保留 null 会让
					// 「字段缺失」和「字段是 null」不可分辨"。那是全插件范围的既定契约
					// （`progress.js` / `kernel-driver.js` 等大量 `data` 都依赖它），
					// 不该为了一个字段去改核心序列化。
					// 所以"后端不提供"就按契约表达成**键缺失**，并额外给一个
					// `threadsKnown: false` 把"这是未知、不是我们忘了填"讲明白。
					threadsKnown: !threadsUnknown,
					parentPidKnown: !parentUnknown,
					processes: shown.map((p) => {
						const threadsKnownOne = typeof p.threadCount === "number";
						const parentKnownOne = typeof p.parentPid === "number";
						return {
							pid: p.pid,
							name: p.name,
							// 有真值才给这个键；没有就整个省掉，**绝不填 0 冒充真值**
							...(threadsKnownOne ? { threads: p.threadCount } : {}),
							threadsKnown: threadsKnownOne,
							...(parentKnownOne ? { parentPid: p.parentPid } : {}),
							parentPidKnown: parentKnownOne,
							duplicateName: p.duplicateName === true
						};
					})
				}
			};
		}
	});
}

/**
 * 附加到目标进程。
 * @param {object} runtime 插件运行时
 */
export function createAttachTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_attach",
		description:
			"附加到目标进程，之后的读写/扫描/汇编都作用于它。用 pid 精确指定，或用 name 做名字匹配" +
			"（同名多进程时用 index 选第几个，从 1 开始，顺序与 ce_processes 的默认排序一致）。" +
			"成功后会返回主模块基址与模块/区域统计 —— 模块基址就是「模块名+偏移」地址表达式的参照。" +
			"切换目标会自动释放上一个目标的句柄与扫描状态。",
		parameters: {
			pid: { type: "integer", description: "目标进程 pid。与 name 二选一。" },
			name: { type: "string", description: "目标进程名（不区分大小写、支持部分匹配）。与 pid 二选一。" },
			index: { type: "integer", description: "name 命中多个进程时取第几个，从 1 开始。默认 1。" }
		},
		timeoutMs: 60_000,
		async run(args, exec) {
			if ((args.pid === undefined || args.pid === null) && (!args.name || args.name === "")) {
				throw new Error("需要 pid 或 name 之一。可先调用 ce_processes 找到目标。");
			}
			const { ce, session, backend } = await contextFor(runtime, exec);
			let target;
			/** 走提权助手时的说明（有值时拼进输出，绝不静默）。 */
			let elevationNote = null;
			try {
				target = await session.attach(ce, { pid: args.pid, name: args.name, index: args.index }, backend);
			} catch (error) {
				// 目标以更高权限运行（Win32 错误 5）时，**先征求用户同意**再谈任何提权动作。
				// 提权会扩大插件的权限边界，必须由人决定；这里绝不自动提权。
				if (error !== null && typeof error === "object" && error.permissionDenied === true) {
					// ① 先征求用户同意 —— 提权会扩大插件的权限边界，必须由人决定
					const decision = await askToElevate(runtime.userQuestions, exec, {
						target: { pid: args.pid, name: args.name },
						action: "ce_attach"
					});
					if (decision.approved !== true || runtime.config.autoElevate === false) {
						const combined = new Error(`${error.message}\n\n${decision.reason}`);
						combined.cause = error;
						combined.permissionDenied = true;
						throw combined;
					}
					// ② 用户同意 → 走 UAC 启动提权助手，并用远程后端重新附加。
					//    助手在自己的进程里持有句柄，所以它能读得动高权限目标。
					let remote;
					try {
						remote = await startElevationBackend({
							elevate: true,
							kernelPath: runtime.config.kernelPath,
							timeoutMs: runtime.config.helperTimeoutMs,
							log: (message) => runtime.logger.info("cheat-engine: %s", message)
						});
					} catch (launchError) {
						throw new Error(
							`${error.message}\n\n${decision.reason}\n\n` +
							`提权助手启动失败：${launchError && launchError.message ? launchError.message : String(launchError)}`
						);
					}
					target = await session.attach(ce, { pid: args.pid, name: args.name, index: args.index }, {
						backend: remote,
						name: remote.name,
						async: false
					});
					// 助手真的拿到管理员令牌了吗？这是"提权成功"的唯一硬证据，必须如实报告
					elevationNote =
						remote.helperElevated === true
							? `已通过提权助手（pid ${remote.helperPid}）附加；助手已获得管理员权限。` +
								"注意：远程后端下扫描走单线程（内核的并行扫描 worker 不走本通道）。"
							: `已通过助手（pid ${remote.helperPid}）附加，但助手**没有**获得管理员权限 —— ` +
								"若目标是以管理员运行的程序，读写仍会被拒（UAC 可能被取消或被策略拦截）。";
				} else {
					throw error;
				}
			}
			const described = await session.describeTarget();
			const main = described.mainModule;
			const lines = [
				`进程：${described.name}  pid ${described.pid}  ${described.bitness} 位  后端 ${described.backend}`,
				main === null
					? "主模块：未识别"
					: `主模块：${main.name}  基址 ${formatAddress(main.base)}  大小 ${formatBytesCount(main.size)}`,
				main !== null && main.path !== "" ? `路径：${main.path}` : "",
				`模块：${described.moduleCount} 个    已提交区域：${described.regionCount} 个（共 ${formatBytesCount(described.committedBytes)}）`
			].filter((line) => line !== "");
			if (target.reused === true) lines.unshift("（该目标已附加，沿用现有句柄与扫描状态）");
			if (elevationNote !== null) lines.unshift(elevationNote);
			if (described.backend === "native-ce") {
				lines.push(
					"提示：当前用原生 CE（ceserver）后端。内存读写可用，但扫描 / 指针扫描 / " +
					"AutoAssembler 需要同步后端，请把 backend 设为 \"self\" 后重新附加。"
				);
			}
			return {
				summary: `已附加到 ${described.name} (pid ${described.pid}, ${described.bitness} 位)`,
				lines,
				data: {
					target: {
						pid: described.pid,
						name: described.name,
						bitness: described.bitness,
						backend: described.backend,
						path: main === null ? "" : main.path
					},
					moduleCount: described.moduleCount,
					regionCount: described.regionCount,
					mainModule: main === null
						? undefined
						: { name: main.name, base: formatAddress(main.base), size: main.size, path: main.path }
				}
			};
		}
	});
}

/**
 * 会话状态与摘除。
 * @param {object} runtime 插件运行时
 */
export function createSessionTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_session",
		description:
			"查看或管理当前 Cheat Engine 会话：附加了哪个进程、用的什么后端、扫描/指针映射/Lua/" +
			"地址表当前的状况、以及哪些能力被配置关掉了。action: " +
			"status（默认）只看状态；detach 关闭目标进程句柄并清掉扫描状态（可再 ce_attach 回来）。",
		parameters: {
			action: {
				type: "string",
				enum: ["status", "detach"],
				description: "status（默认）= 查看状态；detach = 摘下目标并释放句柄。"
			}
		},
		async run(args, exec) {
			const { ce, session, kernelInfo } = prepare(runtime, exec);
			const action = typeof args.action === "string" ? args.action : "status";
			if (action === "detach") {
				const before = session.target === null ? "（未附加）" : `${session.target.name} (pid ${session.target.pid})`;
				await session.detach();
				return {
					summary: `已摘下 ${before}`,
					lines: ["进程句柄、扫描会话、指针映射、AutoAssembler 历史与 Lua state 都已释放。"],
					data: { action: "detach" }
				};
			}

			const lines = [
				`工具开关：allowWrite=${runtime.config.allowWrite !== false}  allowLua=${runtime.config.allowLua !== false}`,
				`内核：${kernelInfo.resolvedFrom}（导出 ${kernelInfo.exports} 项）`,
				`配置的后端：${String(runtime.config.backend ?? "self")}`
			];
			const targetAlive = session.target === null ? undefined : await session.isTargetAlive();
			if (session.target === null) {
				lines.push("目标：未附加。用 ce_processes 找 pid，然后 ce_attach。");
			} else {
				const t = session.target;
				lines.push(`目标：${t.name}  pid ${t.pid}  ${t.bitness} 位  后端 ${t.backend}`);
				// ⚠️ 目标自己退出后，句柄依然"打开"（Windows 语义），不主动问一句
				// 就会一直报着这个已经死掉的目标。这里如实标注，并给出下一步。
				if (targetAlive === false) {
					lines.push(
						"⚠️ **该目标进程已退出** —— 句柄已失效，读写/扫描都会失败。" +
						"请用 ce_processes 重新找目标并 ce_attach（或 action: detach 显式摘下）。"
					);
				}
				lines.push(
					`扫描会话：${session.scan === null ? "无" : `${session.scan.resultCount} 个结果，可继续筛选=${session.scan.canNextScan}`}`
				);
				if (session.scanStats !== null) {
					lines.push(
						`上次扫描：扫了 ${session.scanStats.regionsScanned} 个区域 / ` +
						`${formatBytesCount(session.scanStats.bytesScanned)}，耗时 ${session.scanStats.elapsedMs} ms，` +
						`命中 ${session.scanStats.resultCount}，worker ${session.scanStats.workersUsed}`
					);
				}
				lines.push(
					`指针映射：${session.pointerScanner !== null && session.pointerScanner.hasPointerMap ? "已建立（可直接复用）" : "未建立"}`
				);
				lines.push(
					`AutoAssembler：${session.autoAssembler === null ? "未创建" : `已创建，${session.allocations.length} 个记录在案的分配`}`
				);
				lines.push(`Lua：${session.lua === null ? "未创建" : session.lua.isReady ? "就绪" : "已创建未初始化"}`);
				lines.push(`地址表：${session.addressList === null ? "未创建" : `${session.addressList.count} 条记录`}`);
			}
			return {
				summary: session.target === null ? "当前未附加任何进程" : `目标 ${session.target.name} (pid ${session.target.pid})`,
				lines,
				data: {
					action: "status",
					attached: session.target !== null,
					targetAlive: targetAlive === undefined ? session.target !== null : targetAlive,
					target: session.target === null
						? undefined
						: { pid: session.target.pid, name: session.target.name, bitness: session.target.bitness, backend: session.target.backend },
					scanResults: session.scan === null ? 0 : session.scan.resultCount,
					canNextScan: session.scan === null ? false : session.scan.canNextScan,
					kernelFrom: kernelInfo.resolvedFrom
				}
			};
		}
	});
}

/**
 * 模块列表。
 * @param {object} runtime 插件运行时
 */
export function createModulesTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_modules",
		description:
			"列出目标进程加载的模块（DLL/EXE）及其基址与大小。这是做「静态地址」的关键：" +
			"把找到的地址写成 \"模块名+偏移\" 形式（例如 notepad.exe+1234），进程重启后依然有效。" +
			"返回值同时给出每个模块的基址，可直接用于计算偏移。",
		parameters: {
			filter: { type: "string", description: "模块名的一部分（不区分大小写）。省略则列出全部。" },
			limit: { type: "integer", description: "最多返回多少个模块，默认 60。" }
		},
		async run(args, exec) {
			const { session } = prepare(runtime, exec);
			await session.requireLiveProcess();
			const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 60;
			const filter = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
			const modules = await session.refreshModules();
			const sorted = [...modules].sort((a, b) => {
				const aBase = BigInt(a.baseAddress);
				const bBase = BigInt(b.baseAddress);
				return aBase < bBase ? -1 : aBase > bBase ? 1 : 0;
			});
			const matched = filter === ""
				? sorted
				: sorted.filter((m) => String(m.name).toLowerCase().includes(filter));
			const shown = matched.slice(0, limit);
			const lines = shown.map(
				(m) => `${String(m.name).padEnd(28)} ${formatAddress(m.baseAddress)}  ${formatBytesCount(m.size)}`
			);
			if (matched.length > shown.length) {
				lines.push(`… 还有 ${matched.length - shown.length} 个未显示`);
			}
			return {
				summary: filter === "" ? `${modules.length} 个模块` : `${matched.length} 个模块匹配 "${args.filter}"`,
				lines,
				data: {
					total: modules.length,
					count: shown.length,
					modules: shown.map((m) => ({
						name: m.name,
						base: formatAddress(m.baseAddress),
						size: Number(m.size),
						path: m.path
					}))
				}
			};
		}
	});
}

/**
 * 内存区域列表。
 * @param {object} runtime 插件运行时
 */
export function createRegionsTool(runtime) {
	return makeEnvelopeTool({
		name: "ce_regions",
		description:
			"列出目标进程的内存区域（起始地址 / 大小 / 保护属性 / 类型）。用于判断哪段内存可写、" +
			"哪段可执行、某个地址落不落在已提交区域里，也用于解释「为什么扫描扫不到」。" +
			"默认只列已提交区域；用 writableOnly / executableOnly 等过滤可快速定位关键区域。",
		parameters: {
			writableOnly: { type: "boolean", description: "只列可写区域。" },
			executableOnly: { type: "boolean", description: "只列可执行区域。" },
			includeImage: { type: "boolean", description: "包含 MEM_IMAGE（可执行映像 / 模块）。" },
			includeMapped: { type: "boolean", description: "包含 MEM_MAPPED（映射文件 / 共享内存）。" },
			includePrivate: { type: "boolean", description: "包含 MEM_PRIVATE（堆、栈、私有分配）。" },
			includeGuard: { type: "boolean", description: "包含 PAGE_GUARD 区域（默认排除）。" },
			includeFree: { type: "boolean", description: "包含空闲（未提交）区域。默认 false。" },
			near: { type: "string", description: "只看包含该地址的区域，例如 game.exe+1234。" },
			limit: { type: "integer", description: "最多返回多少个区域，默认 60。" }
		},
		async run(args, exec) {
			const { ce, session } = prepare(runtime, exec);
			await session.requireLiveProcess();
			const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 60;
			const filter = {
				includeFree: args.includeFree === true,
				...(args.writableOnly === true ? { writableOnly: true } : {}),
				...(args.executableOnly === true ? { executableOnly: true } : {}),
				...(args.includeImage !== undefined ? { includeImage: args.includeImage === true } : {}),
				...(args.includeMapped !== undefined ? { includeMapped: args.includeMapped === true } : {}),
				...(args.includePrivate !== undefined ? { includePrivate: args.includePrivate === true } : {}),
				...(args.includeGuard !== undefined ? { includeGuard: args.includeGuard === true } : {})
			};
			let regions = session.usesAsyncBackendProxy
				? await session.process.scannableRegionsAsync(filter)
				: session.process.scannableRegions(filter);

			let nearAddress = null;
			if (typeof args.near === "string" && args.near.trim() !== "") {
				const ctx = await session.evalContext();
				nearAddress = resolveAddressInput(ce, args.near, ctx);
				regions = regions.filter((region) => {
					const base = BigInt(region.baseAddress);
					return nearAddress >= base && nearAddress < base + BigInt(region.memorySize);
				});
			}

			const sorted = [...regions].sort((a, b) => (BigInt(a.baseAddress) < BigInt(b.baseAddress) ? -1 : 1));
			const shown = sorted.slice(0, limit);
			const lines = shown.map((region) => {
				const base = BigInt(region.baseAddress);
				const size = BigInt(region.memorySize);
				const label = moduleLabelFor(base, session);
				return (
					`${formatAddress(base)}  ${formatBytesCount(size).padStart(9)}  ` +
					`0x${Number(region.protect).toString(16).padStart(3, "0")} ${describeProtection(region.protect).padEnd(10)} ` +
					`${describeRegionType(region.type).padEnd(7)}${label}`
				);
			});
			if (sorted.length > shown.length) lines.push(`… 还有 ${sorted.length - shown.length} 个未显示`);
			let totalBytes = 0n;
			for (const region of sorted) totalBytes += BigInt(region.memorySize);
			return {
				summary: nearAddress === null
					? `${sorted.length} 个内存区域（共 ${formatBytesCount(totalBytes)}）`
					: `包含 ${formatAddress(nearAddress)} 的区域：${sorted.length} 个`,
				lines,
				data: {
					total: sorted.length,
					count: shown.length,
					totalBytes: totalBytes.toString(),
					near: nearAddress === null ? undefined : formatAddress(nearAddress),
					regions: shown.map((region) => ({
						base: formatAddress(region.baseAddress),
						size: String(region.memorySize),
						protect: formatAddress(BigInt(region.protect)),
						protectText: describeProtection(region.protect),
						type: describeRegionType(region.type),
						committed: region.committed === true
					}))
				}
			};
		}
	});
}

/** 地址若落在某个模块内，渲染成模块+偏移；否则返回空串。 */
function moduleLabelFor(address, session) {
	const label = describeAddress(address, session.modules);
	return label === formatAddress(address) ? "" : `  ${label}`;
}
