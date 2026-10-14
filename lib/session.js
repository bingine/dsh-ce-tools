/**
 * 每会话的 Cheat Engine 状态。
 *
 * 为什么需要它：CE 的操作是**有状态**的。一次「首次扫描」之后才有「再次扫描」，
 * 指针扫描会缓存整张指针映射，AutoAssembler 要记住 [ENABLE] 期间写进去的原字节
 * 才能在 [DISABLE] 精确还原，Lua 引擎有自己的 state 与符号表。这些状态必须跨
 * 工具调用存活，且归属于「谁在操作」（不同会话/子代理不该互相踩）。
 *
 * 归属键：`exec.agent.session.id`（顶层会话 id）。取不到时回落到 `"default"`，
 * 因此无 agent 的调用（例如 PTC 子调用）仍然可用，只是共用一份状态。
 *
 * 资源纪律：每个会话最多持有一个进程句柄、一个扫描会话（内含 worker 池）、
 * 一个指针映射、一个 Lua state。换目标/换扫描/插件卸载时必须显式释放，
 * 否则会泄漏 worker 线程与目标进程句柄。
 *
 * @module dsh-cheat-engine/session
 */

import { enrichPermissionError } from "./elevation.js";

/** 把字节数转成正斜杠路径，便于比较。 */
function normalizeKey(key) {
	return typeof key === "string" && key !== "" ? key : "default";
}

/** 会话目标的简短描述，用于权限错误里的人话说明。 */
function targetBrief(session, fallbackPid) {
	const target = session?.target;
	if (target !== null && target !== undefined) return { pid: target.pid, name: target.name };
	return { pid: fallbackPid, name: undefined };
}

/**
 * 指针扫描选项的**归一化签名**（用于判断能否复用 Scanner 实例）。
 *
 * 逐键比较、按键名排序后拼接，所以 `{a:1,b:2}` 与 `{b:2,a:1}` 得到同一个签名。
 * 假值（`false`/`0`/`""`/`undefined`/`null`）一律归一成"未给出" ——
 * 内核构造器对它们套的就是同一套默认值，所以复用实例不会改变语义。
 *
 * @param {object} [options] PointerScanOptions
 * @returns {string} 签名
 */
function pointerScannerSignature(options) {
	const out = {};
	for (const key of Object.keys(options ?? {}).sort()) {
		const value = options[key];
		if (value === undefined || value === null || value === false || value === 0 || value === "") continue;
		out[key] = value;
	}
	return JSON.stringify(out);
}

/**
 * 一个会话的 CE 状态容器。
 */
export class CeSession {
	/**
	 * @param {string} key 会话键
	 * @param {object} config 已合并默认值的插件配置
	 * @param {object} logger 日志器
	 */
	constructor(key, config, logger) {
		this.key = normalizeKey(key);
		this.config = config;
		this.logger = logger;

		/** @type {object|null} 内核模块（延迟注入） */
		this.ce = null;
		/** @type {object|null} 已打开的目标进程 */
		this.process = null;
		/** @type {{ pid: number, name: string, path: string, bitness: number, backend: string }|null} 目标摘要 */
		this.target = null;

		/** @type {Array<object>} 模块列表缓存 */
		this.modules = [];
		this.modulesAt = 0;

		/** @type {object|null} ScanSession */
		this.scan = null;
		/** @type {object|null} 上一次扫描的 ScanConfig（用于再次扫描的默认值） */
		this.scanConfig = null;
		/** @type {string|null} 上一次扫描用的类型名（再次扫描省略 type 时复用） */
		this.scanTypeName = null;
		/** @type {object|null} 上一次扫描的统计 */
		this.scanStats = null;
		/** @type {object|null} 扫描进度（onProgress 回调写入） */
		this.scanProgress = null;

		/** @type {object|null} PointerScanner（指针映射可跨多次扫描复用） */
		this.pointerScanner = null;
		/**
		 * @type {Map<string, object>} 指针扫描器缓存，键是选项签名。
		 *
		 * ## 为什么是"按选项签名缓存"而不是"只留最新一个"
		 *
		 * `ce_pointer_scan` 在一次调用里最多会用到**两组**选项：
		 *   1. 普通组 `{maxLevel, maxOffset, maxResults, …}`；
		 *   2. 汇总组 `{…, preferShallow: true}`（第 1..maxLevel 级全收）。
		 * 内核的指针映射（`PointerScanner.pointerMap`）是**实例字段**，所以两组选项
		 * 天然对应两张映射。若只留最新一个实例，两组选项就会互相把它踢掉，
		 * 于是每次调用都重建整张映射 —— 正是这条缓存要消除的成本。
		 * 而且汇总模式为空时的兜底会**回到普通组**，也要能命中已建好的那张映射。
		 *
		 * 组数是常量级的（目前 2 组），所以不需要淘汰策略；`detach`/`dispose` 清空。
		 */
		this.pointerScanners = new Map();
		/** @type {object|null} AutoAssembler */
		this.autoAssembler = null;
		/** @type {object|null} LuaEngine */
		this.lua = null;
		/** @type {object|null} AddressList（.CT 表） */
		this.addressList = null;
		/**
		 * @type {Map<string, bigint>} `.CT` 表里 `<UserdefinedSymbols>` 的符号。
		 *
		 * 与 `autoAssembler.symbols` / `lua.symbols` 并列参与地址表达式求值
		 * （见 `symbols()`）。载入 .CT 时整表替换（`setTableSymbols`）——
		 * 换了一张表，上一张表的符号就不该再能解析到。
		 * @see setTableSymbols
		 */
		this.tableSymbols = new Map();

		/** @type {Array<object>} AutoAssembler 已分配的内存（便于报告与清理） */
		this.allocations = [];

		this.createdAt = Date.now();
		this.lastUsedAt = this.createdAt;
	}

	/** 标记一次使用（供空闲回收判断）。 */
	touch() {
		this.lastUsedAt = Date.now();
	}

	/** 目标是否已就绪；否则给出可读的引导。 */
	requireProcess() {
		if (this.process === null || !this.process.isOpen) {
			throw new Error(
				"还没有附加到任何进程。请先调用 ce_attach（或 ce_processes 找到 pid 后再 ce_attach）。"
			);
		}
		return this.process;
	}

	/**
	 * 目标是否**仍然存活**。
	 *
	 * ⚠️ 不能只看 `process.isOpen`：Windows 上**进程退出后句柄依然有效**，
	 * 直到 `CloseHandle` 之前 `isOpen` 一直是 true。于是目标一退出，
	 * 所有工具都会静默退化成"看起来正常的空结果"：
	 *   - `ce_modules` / `ce_regions` → 0 个，且不报错；
	 *   - `ce_read` → 抛一句**误导性**的「读不到内存，但目标仍在运行」。
	 * 只有 detach + 重新 attach 才能恢复，而模型完全看不出发生什么。
	 *
	 * @returns {Promise<boolean|undefined>} true=存活；false=已退出；undefined=后端无法判断
	 */
	async isTargetAlive() {
		if (this.process === null || !this.process.isOpen) return false;
		try {
			if (this.usesAsyncBackendProxy()) {
				if (typeof this.process.isProcessAliveAsync !== "function") return undefined;
				return await this.process.isProcessAliveAsync();
			}
			if (typeof this.process.isProcessAlive !== "function") return undefined;
			return this.process.isProcessAlive();
		} catch {
			// 判断本身失败不该让调用方炸掉：如实报"未知"，退回旧行为
			return undefined;
		}
	}

	/**
	 * `requireProcess` + **存活检查**。
	 *
	 * 所有"接下来要真的碰目标"的工具入口都该用它：目标已退出时给一句明确的
	 * 「目标进程已退出，请重新 attach」，而不是让它退化成 0 个模块 / 误导性的读失败。
	 *
	 * @returns {Promise<object>} 内核 Process 对象
	 */
	async requireLiveProcess() {
		const proc = this.requireProcess();
		const alive = await this.isTargetAlive();
		if (alive === false) {
			const brief = this.target === null
				? `pid ${proc.pid}`
				: `${this.target.name} (pid ${this.target.pid})`;
			throw new Error(
				`目标进程已退出（${brief}），当前会话持有的句柄已失效。` +
				"请用 ce_processes 重新找到目标，再 ce_attach 附加。"
			);
		}
		return proc;
	}

	/** 目标是否使用异步后端（原生 CE）。 */
	get usesAsyncBackend() {
		return this.target !== null && this.target.backend === "native-ce";
	}

	/** 目标位数（32/64），用于反汇编与指针宽度。 */
	get bitness() {
		return this.target !== null && this.target.bitness === 32 ? 32 : 64;
	}

	/** 指针宽度：WOW64 目标为 4，否则 8。 */
	get pointerSize() {
		return this.bitness === 32 ? 4 : 8;
	}

	/**
	 * 附加到进程。
	 *
	 * @param {object} ce 内核模块
	 * @param {{ pid?: number, name?: string, index?: number }} want 目标
	 * @param {{ backend: object|null, name: string, async: boolean }} backend 后端选择
	 * @returns {Promise<{ pid: number, name: string, path: string, bitness: number, backend: string, modules: number, regions: number }>}
	 */
	async attach(ce, want, backend) {
		this.ce = ce;
		const options = backend.backend === null ? undefined : { backend: backend.backend };

		let pid = want.pid;
		if (pid === undefined || pid === null) {
			const wanted = String(want.name ?? "").trim();
			if (wanted === "") throw new Error("ce_attach 需要 pid 或 name 之一");
			// 先枚举同名进程，便于在多个候选时给出可读的报错
			const candidates = backend.async
				? await ce.findProcessesByNameAsync(wanted, backend.backend)
				: ce.findProcessesByName(wanted, backend.backend);
			if (candidates.length === 0) {
				throw new Error(`没有找到名字含 "${wanted}" 的进程（名字匹配不区分大小写、支持部分匹配）`);
			}
			const index = Number.isInteger(want.index) && want.index > 0 ? want.index : 1;
			if (index > candidates.length) {
				throw new Error(
					`名字含 "${wanted}" 的进程只有 ${candidates.length} 个，取不到第 ${index} 个。候选：` +
					candidates.map((p, i) => `[${i + 1}] ${p.name} (pid ${p.pid})`).join(", ")
				);
			}
			pid = candidates[index - 1].pid;
		}
		if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid 必须是正整数，收到 ${want.pid}`);

		// 已经是同一目标就不重复打开（保留扫描会话与指针映射）
		if (this.process !== null && this.target !== null && this.target.pid === pid && this.process.isOpen) {
			this.touch();
			return { ...this.target, reused: true };
		}

		// 换目标：先把旧目标的全部状态释放干净
		await this.detach();

		const proc = backend.async
			? await this.#openAsyncOrExplain(ce, pid, options)
			: await this.#openSyncOrExplain(ce, pid, options);
		this.process = proc;
		this.ce = ce;

		const targetBitness = (await this.#isWow64()) ? 32 : 64;
		await this.refreshModules();

		let path = "";
		for (const module of this.modules) {
			// 主模块通常就是与进程同名的那个模块
			const moduleName = String(module.name).toLowerCase();
			if (moduleName === String(proc.name).toLowerCase() || moduleName.endsWith(".exe")) {
				path = module.path ?? "";
				if (moduleName === String(proc.name).toLowerCase()) break;
			}
		}

		this.target = {
			pid,
			name: proc.name,
			path,
			bitness: targetBitness,
			backend: backend.name
		};
		this.logger.info(
			"cheat-engine: 已附加 %s (pid %d, %d 位, 后端 %s, %d 模块)",
			proc.name, pid, targetBitness, backend.name, this.modules.length
		);
		return this.target;
	}

	/**
	 * 打开进程，并在被拒时把「权限不足」翻译成可执行的建议。
	 *
	 * `OpenProcess` 失败最常见的原因就是**目标以更高权限运行**（Win32 错误 5）。
	 * 这类失败必须区分出来，否则用户只看到一句"打开进程失败"，不知道要提权。
	 */
	async #openAsyncOrExplain(ce, pid, options) {
		try {
			return await ce.openProcessAsync(pid, options);
		} catch (error) {
			throw enrichPermissionError(error, { target: { pid }, action: "ce_attach" });
		}
	}

	/** 同步后端版本的打开进程（见 #openAsyncOrExplain）。 */
	async #openSyncOrExplain(ce, pid, options) {
		try {
			return ce.Process.open(pid, options);
		} catch (error) {
			throw enrichPermissionError(error, { target: { pid }, action: "ce_attach" });
		}
	}

	/** 同步/异步分支：是否 WOW64。 */
	async #isWow64() {
		return this.usesAsyncBackendProxy() ? await this.process.isWow64Async() : this.process.isWow64();
	}

	/** 后端是否异步（attach 过程中 target 还没建立，用 process 自己判断）。 */
	usesAsyncBackendProxy() {
		return this.process !== null && this.process.backendName === "native-ce";
	}

	/** 同步/异步分支：内存区域。 */
	async #regions() {
		return this.usesAsyncBackendProxy() ? await this.process.regionsAsync() : this.process.regions({ includeFree: false });
	}

	/** 同步/异步分支：模块列表。 */
	async #modules() {
		return this.usesAsyncBackendProxy() ? await this.process.modulesAsync() : this.process.modules();
	}

	/** 刷新模块缓存。 */
	async refreshModules() {
		const proc = this.requireProcess();
		this.modules = await this.#modules();
		this.modulesAt = Date.now();
		return this.modules;
	}

	/** 取模块列表（带缓存，默认 5 秒有效）。 */
	async modulesCached(maxAgeMs = 5000) {
		if (this.modules.length === 0 || Date.now() - this.modulesAt > maxAgeMs) await this.refreshModules();
		return this.modules;
	}

	/** 读内存（自动选择同步/异步后端）。 */
	async read(address, size) {
		const proc = this.requireProcess();
		try {
			return this.usesAsyncBackendProxy()
				? await proc.readMemoryAsync(BigInt(address), size)
				: proc.readMemory(BigInt(address), size);
		} catch (error) {
			// 权限不足（Win32 5 等）会被增强成「为什么 + 怎么办」；
			// 其余错误原样抛出，避免把无关失败也说成权限问题
			throw enrichPermissionError(error, {
				target: targetBrief(this),
				action: "ce_read"
			});
		}
	}

	/** 写内存（自动选择同步/异步后端）。 */
	async write(address, buffer) {
		const proc = this.requireProcess();
		try {
			return this.usesAsyncBackendProxy()
				? await proc.writeMemoryAsync(BigInt(address), buffer)
				: proc.writeMemory(BigInt(address), buffer);
		} catch (error) {
			throw enrichPermissionError(error, {
				target: targetBrief(this),
				action: "ce_write"
			});
		}
	}

	/** 读内存区域列表。 */
	async regions(options = {}) {
		const proc = this.requireProcess();
		return this.usesAsyncBackendProxy()
			? await proc.regionsAsync(options)
			: proc.regions(options);
	}

	/**
	 * 地址表达式求值上下文。
	 * 模块缓存直接复用，避免每个表达式都重新枚举模块。
	 */
	async evalContext() {
		const modules = await this.modulesCached();
		return {
			process: this.requireProcess(),
			moduleCache: modules.map((m) => ({ name: m.name, baseAddress: m.baseAddress, size: m.size })),
			symbols: this.symbols()
		};
	}

	/**
	 * 记录 `.CT` 表载入的用户自定义符号（整表替换）。
	 *
	 * ⚠️ 必须**整表替换**而不是合并：`load` 是"换一张表"，上一张表的符号留着
	 * 会让 `myStat+8` 解析到**另一张表**里的旧地址 —— 又一个静默错值。
	 * 内核已经按 .CT 语义（裸数字＝十六进制）解析过地址，这里只做投影。
	 *
	 * @param {Map<string, bigint>} symbols 内核 `AddressList.symbols`（原名与小写名各一份）
	 */
	setTableSymbols(symbols) {
		this.tableSymbols = new Map();
		if (symbols === null || symbols === undefined) return;
		for (const [name, address] of symbols) {
			this.tableSymbols.set(name, BigInt(address));
		}
	}

	/** 已注册的符号（AutoAssembler、Lua 与 `.CT` 表各有一份，这里合并）。 */
	symbols() {
		const merged = new Map();
		if (this.autoAssembler !== null) {
			for (const [name, address] of this.autoAssembler.symbols ?? []) merged.set(name, address);
		}
		if (this.lua !== null && this.lua.symbols) {
			for (const [name, address] of this.lua.symbols.entries()) merged.set(name, address);
		}
		for (const [name, address] of this.tableSymbols) merged.set(name, address);
		return merged;
	}

	/** 断言某能力在当前后端下可用（扫描/指针/汇编都需要同步后端）。 */
	requireSyncBackend(capability) {
		this.requireProcess();
		if (this.usesAsyncBackendProxy()) {
			throw new Error(
				`${capability}需要同步内存后端，当前目标用的是原生 CE（ceserver）后端。` +
				"ceserver 协议只能异步交互，而扫描/汇编/地址表内部是同步路径。" +
				"请把插件配置的 backend 改回 \"self\"（默认）后重新 ce_attach。"
			);
		}
	}

	/** 建（或复用）扫描会话。传 fresh=true 时丢弃旧会话。 */
	async scanSession(ce, { fresh = false } = {}) {
		this.requireSyncBackend("内存扫描");
		if (fresh && this.scan !== null) {
			this.scan.dispose();
			this.scan = null;
		}
		if (this.scan === null) {
			// 远程（提权助手）后端下必须关掉并行扫描：内核的扫描 worker
			// （`win/scan-worker.ts`）自己 `import { Process }`，用它自己那份 koffi 读内存，
			// 走不到我们的远程后端。用单线程路径才能保证每次读取都经由助手。
			const isRemote = this.process !== null && this.process.backendName === "remote-elevated";
			const options = {
				parallel: this.config.scanParallel !== false && !isRemote
			};
			if (Number.isInteger(this.config.workerCount) && this.config.workerCount > 0) {
				options.workerCount = this.config.workerCount;
			}
			if (Number.isInteger(this.config.scanBlockSize) && this.config.scanBlockSize > 0) {
				options.blockSize = this.config.scanBlockSize;
			}
			options.onProgress = (total, scanned, found) => {
				this.scanProgress = {
					total: String(total),
					scanned: String(scanned),
					found: String(found),
					at: Date.now()
				};
			};
			this.scan = new ce.ScanSession(this.process, options);
		}
		return this.scan;
	}

	/** 丢弃扫描会话（释放 worker 池）。 */
	disposeScan() {
		if (this.scan !== null) {
			try {
				this.scan.dispose();
			} catch { /* worker 可能已退出 */ }
			this.scan = null;
		}
		this.scanConfig = null;
		this.scanTypeName = null;
		this.scanStats = null;
		this.scanProgress = null;
	}

	/**
	 * 丢弃**全部**缓存过的指针扫描器（连同它们各自持有的指针映射）。
	 *
	 * 换目标或释放会话时必须逐个清 —— 只清"最新那一个"会让另外几组的映射
	 * 留在内存里（每张都是整片进程内存的索引，很占地方）。
	 */
	#dropPointerScanners() {
		for (const scanner of this.pointerScanners.values()) {
			try {
				scanner.clearPointerMap();
			} catch { /* 已释放 */ }
		}
		this.pointerScanners.clear();
		this.pointerScanner = null;
	}

	/**
	 * 指针扫描器（**同一目标 + 同一组选项**时复用同一个实例）。
	 *
	 * ## 为什么必须复用实例（实测的成本问题）
	 *
	 * 内核的指针映射是**实例字段**（`PointerScanner.pointerMap`，按进程全量扫描一次内存
	 * 建索引，秒级到数十秒级），不是进程级共享缓存。而早先这里写的是
	 * `else if (Object.keys(options).length > 0) this.pointerScanner = new …` ——
	 * 工具**每次都传选项**（maxLevel/maxOffset/maxResults），于是那个条件恒真：
	 *   · 每次调用都重建扫描器 → 每次调用都重建映射，"第二次快很多"的承诺从未生效；
	 *   · `ce_pointer_scan` 一次调用会取**两组**选项（普通 + 汇总），
	 *     于是**单次工具调用把整张映射建了两遍**（实测：修好后 e2e 从 11.4s 降到 7.0s）；
	 *   · 工具里的 `if (args.rebuild === true) scanner.clearPointerMap()` 作用在
	 *     刚 new 出来的空实例上 —— `rebuild` 参数实际上是**空操作**。
	 *
	 * 现在按**选项签名**缓存（见 `pointerScanners` 的注释），且缓存多个组，
	 * 于是"普通组 ↔ 汇总组"来回切也不会重建映射。
	 * 「强制重建」由调用方在**取到同一个扫描器之后**调用 `clearPointerMap()` 表达。
	 *
	 * @param {object} ce 内核模块
	 * @param {object} [options] PointerScanOptions
	 * @returns {object} PointerScanner
	 */
	pointerScannerFor(ce, options = {}) {
		this.requireSyncBackend("指针扫描");
		const wanted = options ?? {};
		const signature = pointerScannerSignature(wanted);
		const cached = this.pointerScanners.get(signature);
		if (cached !== undefined) {
			this.pointerScanner = cached;
			return cached;
		}
		const scanner = new ce.PointerScanner(this.process, wanted);
		this.pointerScanners.set(signature, scanner);
		this.pointerScanner = scanner;
		return scanner;
	}

	/** AutoAssembler（跨调用保留符号、alloc 与原字节历史）。 */
	autoAssemblerFor(ce, options = {}) {
		this.requireSyncBackend("AutoAssembler 脚本");
		if (this.autoAssembler === null) {
			this.autoAssembler = new ce.AutoAssembler({
				process: this.process,
				bitness: this.bitness,
				arch: this.config.arch || undefined,
				...options
			});
		}
		return this.autoAssembler;
	}

	/** 地址表（.CT）。 */
	addressListFor(ce) {
		if (this.addressList === null) this.addressList = new ce.AddressList(this.process);
		return this.addressList;
	}

	/**
	 * Lua 引擎（首次调用才创建 WASM state）。
	 * @returns {Promise<object>} 就绪的 LuaEngine
	 */
	async luaEngine(ce) {
		this.requireProcess();
		if (this.lua === null) {
			this.lua = new ce.LuaEngine({
				process: this.process,
				maxSleepMs: this.config.luaMaxSleepMs,
				onOutput: (text, kind) => {
					this.logger.info("cheat-engine lua[%s]: %s", kind, text);
				}
			});
		}
		if (!this.lua.isReady) await this.lua.createState();
		// 目标可能已变（重新 attach）；attachProcess 是幂等的
		if (this.lua.processId() !== this.target.pid) this.lua.attachProcess(this.process);
		return this.lua;
	}

	/** 采一份目标概览（模块/区域统计），供 ce_attach / ce_session 展示。 */
	async describeTarget() {
		const proc = this.requireProcess();
		const modules = await this.modulesCached();
		const regions = (await this.#regions()).filter((r) => r.committed);
		let committedBytes = 0n;
		for (const region of regions) committedBytes += BigInt(region.memorySize);
		const mainModule = modules.find((m) => String(m.name).toLowerCase().endsWith(".exe")) ?? modules[0] ?? null;
		return {
			pid: proc.pid,
			name: proc.name,
			bitness: this.bitness,
			backend: proc.backendName,
			moduleCount: modules.length,
			regionCount: regions.length,
			committedBytes,
			mainModule: mainModule === null
				? null
				: {
					name: mainModule.name,
					path: mainModule.path,
					base: BigInt(mainModule.baseAddress),
					size: Number(mainModule.size)
				},
			modules: modules.map((m) => ({
				name: m.name,
				path: m.path,
				base: BigInt(m.baseAddress),
				size: Number(m.size)
			}))
		};
	}

	/** 释放本会话持有的全部资源。 */
	async dispose() {
		this.disposeScan();
		this.#dropPointerScanners();
		if (this.autoAssembler !== null) {
			try {
				this.autoAssembler.cleanup();
			} catch { /* 忽略 */ }
			this.autoAssembler = null;
		}
		if (this.lua !== null) {
			try {
				await this.lua.dispose({ closeProcess: false });
			} catch { /* 忽略 */ }
			this.lua = null;
		}
		this.addressList = null;
		this.tableSymbols = new Map();
		await this.detach();
	}
	/** 只关闭进程句柄与依赖它的状态（保留会话对象本身）。 */
	async detach() {
		this.disposeScan();
		this.#dropPointerScanners();
		if (this.autoAssembler !== null) {
			try {
				this.autoAssembler.cleanup();
			} catch { /* 忽略 */ }
			this.autoAssembler = null;
		}
		if (this.lua !== null) {
			try {
				await this.lua.dispose({ closeProcess: false });
			} catch { /* 忽略 */ }
			this.lua = null;
		}
		this.addressList = null;
		// .CT 的符号随表一起消失（表没了，符号指向的地址也就不再有出处）
		this.tableSymbols = new Map();
		this.allocations = [];
		const proc = this.process;
		this.process = null;
		this.target = null;
		this.modules = [];
		this.modulesAt = 0;
		this.scanConfig = null;
		if (proc !== null) {
			try {
				if (proc.backendName === "native-ce") await proc.closeAsync();
				else proc.close();
			} catch { /* 句柄可能已随目标进程退出而失效 */ }
		}
	}
}

/**
 * 会话仓库。
 *
 * @param {object} config 已合并默认值的插件配置
 * @param {object} logger 日志器
 */
export function createSessionStore(config, logger) {
	/** @type {Map<string, CeSession>} */
	const sessions = new Map();

	/** 回收空闲会话，避免长期运行后堆积句柄。 */
	const sweep = () => {
		const idleMs = Number(config.idleTimeoutMs);
		if (!Number.isFinite(idleMs) || idleMs <= 0) return [];
		const now = Date.now();
		const dropped = [];
		for (const [key, session] of sessions) {
			if (now - session.lastUsedAt <= idleMs) continue;
			// 有活动扫描或未还原的脚本时不动它，避免把用户正在做的事清掉
			if (session.scan !== null && session.scan.canNextScan) continue;
			dropped.push(key);
			void session.dispose();
		}
		for (const key of dropped) sessions.delete(key);
		if (dropped.length > 0) logger.info("cheat-engine: 回收空闲会话 %o", dropped);
		return dropped;
	};

	return {
		/**
		 * 取（或创建）一个会话。
		 * @param {string} key 会话键
		 */
		get(key) {
			const normalized = normalizeKey(key);
			let session = sessions.get(normalized);
			if (session === undefined) {
				sweep();
				session = new CeSession(normalized, config, logger);
				sessions.set(normalized, session);
			}
			session.touch();
			return session;
		},
		/** 会话是否已存在。 */
		has(key) {
			return sessions.has(normalizeKey(key));
		},
		/** 列出全部会话（诊断用）。 */
		list() {
			return [...sessions.values()];
		},
		/** 丢弃某个会话。 */
		async drop(key) {
			const normalized = normalizeKey(key);
			const session = sessions.get(normalized);
			if (session === undefined) return false;
			sessions.delete(normalized);
			await session.dispose();
			return true;
		},
		/** 插件卸载时释放全部资源。 */
		async disposeAll() {
			const all = [...sessions.values()];
			sessions.clear();
			await Promise.all(all.map((session) => session.dispose().catch(() => undefined)));
		},
		get size() {
			return sessions.size;
		}
	};
}

/**
 * 从工具调用的 `exec` 里取会话键。
 *
 * 研究结论：`exec` **没有** `sessionId` 字段，会话要从 agent 上取
 * （`exec.agent?.session?.id`）。取不到就回落到 "default"，
 * 这样无 agent 的调用（PTC 子调用）仍然可用。
 *
 * @param {object} exec 工具执行上下文
 * @returns {string}
 */
export function sessionKeyOf(exec) {
	const id = exec?.agent?.session?.id
		?? exec?.agent?.sessionId
		?? exec?.session?.id
		?? exec?.sessionId;
	return typeof id === "string" && id !== "" ? id : "default";
}

/** 供展示：把目标写成一行。 */
/** 预测用：地址 → 模块+偏移（供工具输出统一风格）。 */