/**
 * CE 内核驱动（DBK64）的自动获取、校验、安装与加载。
 *
 * ## 这一层解决什么、不解决什么（先说清楚）
 *
 * **解决**：官方 DBK64.sys 不在本地时，自动从 Cheat Engine 官方安装包取出来，
 * 校验它是真的内核驱动且带有效签名，然后安装成内核服务并加载。
 *
 * **不解决**（能力边界，工具输出里也会如实写）：
 *   - **加载内核驱动必须管理员权限**，这是 Windows 的硬边界。非管理员会**明确报错**，
 *     不会假装成功，也不会偷偷提权。
 *   - **装上了驱动 ≠ 立刻就能读写受保护进程**。还差两步：
 *     ① 加载驱动（需要管理员）；② 把插件配置的 `backend` 改成 `dbk` ——
 *     只有 `DbkBackend` 才走内核 ioctl，默认的 `self` 后端仍是用户态。
 *   - **`DbkBackend` 的驱动侧结构布局尚未在真机验证**（本机无法加载驱动来试），
 *     所以本模块提供 `ce_kernel action=probe_driver` 让人先确认设备连通性。
 *   - **受保护进程（PPL/反作弊）在 Secure Boot + HVCI 下可能仍然拒绝加载 DBK64**：
 *     HVCI 会拒绝不符合要求的驱动。驱动本身是 CE 签名的正式驱动，但系统策略可能更强。
 *
 * ## 为什么从官方安装包提取，而不是直接下 .sys
 *
 * Cheat Engine 的 GitHub release **没有二进制产物**（`assets` 为空数组），
 * 源码仓库也不含编译好的 `.sys`。官方唯一的正规二进制分发渠道是
 * cheatengine.org 的安装包。所以流程是：
 *
 *   1. 抓 `cheatengine.org/downloads.php`，解析出当前版本的安装包直链
 *      （它是 CloudFront 链接，会随版本变，不能写死）；
 *   2. 下载安装包到缓存目录（约 50MB）；
 *   3. 用 Inno Setup 解包工具**只取出 DBK64.sys**（不跑安装程序、不改注册表）；
 *   4. 校验：PE 头 `IMAGE_SUBSYSTEM_NATIVE` + `PE32+` + Authenticode 签名状态。
 *
 * ## 安全闸门
 *
 * 本模块**不做任何自动动作**：下载、安装、加载都必须显式调用（`acquire` / `load`），
 * 且由上层 `elevation.js` 的同意闸门把关。默认状态只读探测。
 *
 * @module dsh-cheat-engine/kernel-driver
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { isElevated } from "./elevation.js";

/**
 * 出站 HTTP 请求的 `user-agent`。
 *
 * ## 为什么这里需要一条守卫
 *
 * 它自报的是**包名 + 版本**，而包名改过（`dsh-cheat-engine` → `dsh-ce-tools`）。
 * 改包名时漏掉这里不会让任何测试变红，但会在 cheatengine.org 的访问日志里
 * 留下一个**不存在的包**，也让"这个请求是谁发的"这条线索失效。
 * 所以取值独立成常量，并由 `test/startup.test.mjs` 与 `package.json` 交叉校验 ——
 * 与 `PLUGIN_VERSION`（`tools/sync-plugin-version.mjs` 管）同一类问题。
 *
 * ⚠️ 用常量而不是在运行时读 `package.json`：本模块在**提权助手进程**里也会被执行，
 * 那条路径上读文件会多一个失败点（而且读的是安装目录，不是 cwd）。
 * 代价是版本号要手工跟 —— 守卫测试会提醒。
 */
const PACKAGE_NAME = "dsh-ce-tools";
const PACKAGE_VERSION = "0.1.9";
const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION} (+kernel-driver-acquire)`;

/** 导出给守卫测试用（`test/startup.test.mjs` 交叉校验它们与 package.json 一致）。 */
export const OUTBOUND_USER_AGENT = USER_AGENT;

/** 内核服务名（与 DBK64.inf 的 `AddService = DBK64` 一致）。 */
export const DBK64_SERVICE = "DBK64";

/** 驱动文件名。 */
export const DBK64_FILE = "DBK64.sys";

/** 官方下载页（安装包直链要在这里解析，不能写死——它是会变的 CloudFront 链接）。 */
export const CE_DOWNLOADS_PAGE = "https://www.cheatengine.org/downloads.php";

/** 驱动安装后的固定位置（内核加载时按这个路径读，必须是稳定路径）。 */
export const DBK64_SYSTEM_PATH = "C:\\Windows\\System32\\drivers\\DBK64.sys";

/** 缓存根目录（下载的安装包、解出来的驱动都放这里）。 */
export const CACHE_ROOT = path.join(import.meta.dirname, "..", ".cache", "ce-kernel");

/** 缓存子目录。 */
export const CACHE_DIRS = Object.freeze({
	downloads: path.join(CACHE_ROOT, "downloads"),
	extract: path.join(CACHE_ROOT, "extract"),
	installed: path.join(CACHE_ROOT, "installed")
});

/** 单次下载上限（防呆：官方安装包约 50MB，给足余量）。 */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** 确保缓存目录存在。 */
export function ensureCacheDirs() {
	for (const dir of Object.values(CACHE_DIRS)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/* ------------------------------------------------------------------ *
 * .cepack 解包（CE 自己的驱动打包格式）
 * ------------------------------------------------------------------ */

/** `.cepack` 的魔数。 */
export const CEPACK_MAGIC = "CEPACK";

/**
 * 解开 `.cepack` 文件。
 *
 * ## 格式（来自 CE 源码 `Cheat Engine/libcepack.pas`，全文只有 116 行）
 *
 * ```pascal
 * s := 'CEPACK';
 * o.WriteBuffer(s[1], length(s));   // 6 字节 ASCII 魔数
 * o.WriteDWord(m.size);             // 4 字节小端：**原始未压缩大小**
 * oz := Tcompressionstream.create(clmax, o, true);   // 之后是 zlib 流
 * oz.CopyFrom(m, 0);
 * ```
 *
 * 所以布局是：`"CEPACK"`(6) + `原始大小`(4, LE) + **zlib 压缩数据**。
 *
 * ## 为什么这个格式很关键
 *
 * CE 7.5+ **不再随安装包直接放 `DBK64.sys`**，而是打包成 `dbk64.cepack`
 * （实测 55KB，比裸驱动小，说明确实压缩过）。这是为了降低杀软误报。
 * 结果是：`innoextract`/7-Zip 即使能解开安装包，**取出来的也只是 `.cepack`**，
 * 仍然需要这一步解包。
 *
 * 好消息是格式足够简单，Node 内置的 `zlib` 就能解 —— **不需要任何外部工具**。
 *
 * @param {string} sourcePath `.cepack` 路径
 * @returns {{ data: Buffer, declaredSize: number, magic: string }}
 */
export function unpackCepack(sourcePath) {
	const raw = fs.readFileSync(sourcePath);
	if (raw.length < 10) {
		throw new Error(`${path.basename(sourcePath)} 太小（${raw.length} 字节），不是合法的 cepack。`);
	}
	const magic = raw.subarray(0, 6).toString("ascii");
	if (magic !== CEPACK_MAGIC) {
		throw new Error(
			`${path.basename(sourcePath)} 的魔数是 "${magic}"，期望 "${CEPACK_MAGIC}"，不是 cepack 文件。`
		);
	}
	const declaredSize = raw.readUInt32LE(6);
	const compressed = raw.subarray(10);

	// 负载是**裸 deflate**，不是带 2 字节头的 zlib 流。
	//
	// 依据（实测 + 源码）：FPC 的 `Tcompressionstream.create(clmax, o, true)`
	// 在**提供了输出流**时直接写 deflate 数据，不写 zlib 头。
	// 实测 `dbk64.cepack` 偏移 10 起是 `ec bd 7b 7c ...`：
	//   - `inflateRawSync` → 118016 字节的合法 PE ✅
	//   - `inflateSync`    → "unknown compression method" ❌
	//
	// 仍然容忍带 zlib 头的版本（万一某个 CE 版本写了头）：先试 raw、再试 zlib，
	// 两种失败原因都保留在错误里，避免将来排查时丢信息。
	let data;
	const failures = [];
	for (const [label, attempt] of [
		["裸 deflate", () => zlib.inflateRawSync(compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH })],
		["zlib 流", () => zlib.inflateSync(compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH })]
	]) {
		try {
			data = attempt();
			break;
		} catch (error) {
			failures.push(`${label}: ${error.message}`);
		}
	}
	if (data === undefined) {
		throw new Error(
			`解压 ${path.basename(sourcePath)} 失败（已试裸 deflate 与 zlib 流）。\n` +
			`  声明原始大小：${declaredSize} 字节；压缩数据：${compressed.length} 字节\n` +
			failures.map((line) => `  - ${line}`).join("\n")
		);
	}
	if (declaredSize !== 0 && data.length !== declaredSize) {
		throw new Error(
			`解压后大小 ${data.length} 与头部声明的 ${declaredSize} 不一致 —— 文件可能损坏或被篡改。`
		);
	}
	return { data, declaredSize, magic };
}

/**
 * 把 `.cepack` 解成真正的 `.sys` 文件。
 *
 * @param {object} options
 * @param {string} options.cepackPath `.cepack` 路径
 * @param {string} options.outPath 输出 `.sys` 路径
 * @returns {{ data: Buffer, outPath: string, declaredSize: number }}
 */
export function unpackCepackToFile(options) {
	const { data, declaredSize } = unpackCepack(options.cepackPath);
	fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
	fs.writeFileSync(options.outPath, data);
	return { data, outPath: options.outPath, declaredSize };
}

/**
 * 在本机已安装的 Cheat Engine 里找 DBK64 驱动。
 *
 * 现实意义：**很多人机器上本来就装了 CE**（实测本机就装了 7.6），
 * 那就完全不需要下载安装包 —— 直接从安装目录取 `.cepack` 解包即可。
 * 这是最快的路径，也避免了从网络引入任何东西。
 *
 * 查找顺序：
 *   1. 已解出来的 `DBK64.sys`（老版本 CE 是直接放的）；
 *   2. `dbk64.cepack` / `DBK64.cepack`（7.5+ 的打包形式）。
 *
 * @returns {{ kind: "sys"|"cepack", path: string, ceVersion: string|null }|null}
 */
export function findLocalCheatEngineDriver() {
	const candidates = [];

	// 注册表里的卸载项能给出真实安装位置（用户可能装到非默认目录）
	for (const hive of ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]) {
		const result = run("reg.exe", ["query", `${hive}\\Cheat Engine_is1`, "/v", "InstallLocation"]);
		const match = result.stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
		if (match !== null) candidates.push(match[1].trim());
	}
	// 默认位置兜底
	for (const dir of [
		"C:\\Program Files\\Cheat Engine",
		"C:\\Program Files (x86)\\Cheat Engine",
		path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Cheat Engine")
	]) {
		if (dir !== "") candidates.push(dir);
	}

	for (const dir of candidates) {
		if (!fs.existsSync(dir)) continue;
		for (const sysName of ["DBK64.sys", "dbk64.sys"]) {
			const sysPath = path.join(dir, sysName);
			if (fs.existsSync(sysPath)) return { kind: "sys", path: sysPath, ceVersion: null };
		}
		for (const packName of ["dbk64.cepack", "DBK64.cepack", "dbk32.cepack"]) {
			const packPath = path.join(dir, packName);
			if (fs.existsSync(packPath)) return { kind: "cepack", path: packPath, ceVersion: null };
		}
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * 只读探测
 * ------------------------------------------------------------------ */

/** 跑一个命令并取回 { code, stdout, stderr }（不抛错，便于判定）。 */
function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		windowsHide: true,
		timeout: options.timeoutMs ?? 20_000,
		stdio: ["ignore", "pipe", "pipe"]
	});
	return {
		code: result.status === null ? -1 : result.status,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
		error: result.error ?? null
	};
}

/**
 * 查询 DBK64 内核服务的状态（只读，不需要管理员）。
 *
 * `sc query` 对不存在的服务返回错误码 1060，据此区分「没安装」与「装了但没跑」。
 *
 * @returns {{ installed: boolean, state: string, raw: string, win32ExitCode: number|null }}
 */
export function queryServiceState(serviceName = DBK64_SERVICE) {
	const result = run("sc.exe", ["query", serviceName]);
	if (result.code === 0) {
		// `STATE : 4 RUNNING` 这类行
		const match = result.stdout.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/);
		return {
			installed: true,
			state: match === null ? "UNKNOWN" : match[1],
			raw: result.stdout,
			win32ExitCode: null
		};
	}
	const notInstalled = /1060|does not exist|指定的服务|does not exist as an installed service/i.test(
		`${result.stdout} ${result.stderr}`
	);
	return {
		installed: false,
		state: notInstalled ? "NOT_INSTALLED" : "UNKNOWN",
		raw: `${result.stdout}\n${result.stderr}`.trim(),
		win32ExitCode: notInstalled ? 1060 : result.code
	};
}

/** 查询服务的可执行路径（从注册表读，`sc qc` 的输出格式在不同语言下不好解析）。 */
export function queryServicePath(serviceName = DBK64_SERVICE) {
	const result = run("reg.exe", [
		"query",
		`HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`,
		"/v",
		"ImagePath"
	]);
	if (result.code !== 0) return null;
	const match = result.stdout.match(/ImagePath\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
	if (match === null) return null;
	// `\??\C:\...` 这种 NT 路径前缀要去掉
	return match[1].trim().replace(/^\\\?\?\\/, "").replace(/^\\SystemRoot\\/i, "C:\\Windows\\");
}

/**
 * 判断一个文件是不是 Windows 内核驱动（PE 头探测）。
 *
 * 判据（缺一不可）：
 *   - `MZ` 头 + 合法 `PE\0\0` 签名；
 *   - `PE32+`（可选头魔数 0x20B）—— DBK64 是 64 位驱动；
 *   - `IMAGE_SUBSYSTEM_NATIVE`（子系统 1）—— 这是**驱动**区别于普通 exe/dll 的关键标志。
 *
 * @param {string} filePath 文件路径
 * @returns {{ isPe: boolean, is64Bit: boolean, subsystem: number|null, isNativeDriver: boolean, machine: string }}
 */
export function probePeHeaders(filePath) {
	const out = { isPe: false, is64Bit: false, subsystem: null, isNativeDriver: false, machine: "" };
	let fd;
	try {
		fd = fs.openSync(filePath, "r");
		const dos = Buffer.alloc(64);
		if (fs.readSync(fd, dos, 0, 64, 0) < 64) return out;
		if (dos[0] !== 0x4d || dos[1] !== 0x5a) return out; // "MZ"
		const peOffset = dos.readUInt32LE(0x3c);
		const pe = Buffer.alloc(26);
		if (fs.readSync(fd, pe, 0, 26, peOffset) < 26) return out;
		if (pe[0] !== 0x50 || pe[1] !== 0x45 || pe[2] !== 0 || pe[3] !== 0) return out; // "PE\0\0"
		out.isPe = true;
		const machine = pe.readUInt16LE(4);
		out.machine = machine === 0x8664 ? "x64" : machine === 0x14c ? "x86" : `0x${machine.toString(16)}`;
		const optionalMagic = pe.readUInt16LE(24);
		out.is64Bit = optionalMagic === 0x20b;
		// Subsystem 在**可选头**里的偏移：
		//   PE32+  = 0x44，PE32 = 0x44
		// 两者恰好相同，但**必须分别写清楚**，不要凭记忆合成一个魔数 ——
		// 曾经写成 24 + 0x5c(PE32+)/0x44(PE32)，把 DllCharacteristics 当成了 Subsystem，
		// 结果 ntfs.sys 被判成「不是内核驱动」。
		const subsystemOffsetInOptionalHeader = 0x44;
		const subsystemOffset = peOffset + 24 + subsystemOffsetInOptionalHeader;
		const sub = Buffer.alloc(2);
		if (fs.readSync(fd, sub, 0, 2, subsystemOffset) === 2) {
			out.subsystem = sub.readUInt16LE(0);
			out.isNativeDriver = out.subsystem === 1; // IMAGE_SUBSYSTEM_NATIVE
		}
		return out;
	} catch {
		return out;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* 忽略 */
			}
		}
	}
}

/**
 * 纯 Node 探测 PE 里的 Authenticode 证书表（不依赖任何外部工具）。
 *
 * 原理：可选头的数据目录第 5 项（索引 4）是 `IMAGE_DIRECTORY_ENTRY_SECURITY`，
 * 非零即表示这个 PE **带有** Authenticode 签名。它不能证明签名**有效**，
 * 但能回答一个关键问题：**这个驱动到底签没签**。
 *
 * 为什么需要这个兜底：本机实测 32 位的 `powershell.exe` 加载 64 位 PowerShell 7 的
 * `Microsoft.PowerShell.Security` 模块会失败（位数不匹配），于是
 * `Get-AuthenticodeSignature` 报「模块无法加载」，拿不到任何签名信息。
 * 纯 Node 解析没有这个问题，也不依赖系统装了什么。
 *
 * @param {string} filePath 文件路径
 * @returns {{ present: boolean, offset: number|null, size: number|null, revoked: boolean }}
 */
export function probeCertificateTable(filePath) {
	const out = { present: false, offset: null, size: null, revoked: false };
	let fd;
	try {
		fd = fs.openSync(filePath, "r");
		const dos = Buffer.alloc(64);
		if (fs.readSync(fd, dos, 0, 64, 0) < 64) return out;
		if (dos[0] !== 0x4d || dos[1] !== 0x5a) return out;
		const peOffset = dos.readUInt32LE(0x3c);
		const pe = Buffer.alloc(26);
		if (fs.readSync(fd, pe, 0, 26, peOffset) < 26) return out;
		if (pe[0] !== 0x50 || pe[1] !== 0x45 || pe[2] !== 0 || pe[3] !== 0) return out;

		const magic = pe.readUInt16LE(24);
		// 数据目录的起始偏移：PE32 从可选头 +0x60，PE32+ 从 +0x70
		const dataDirStart = peOffset + 24 + (magic === 0x20b ? 0x70 : 0x60);
		// 第 5 项（索引 4）：安全目录
		const entryOffset = dataDirStart + 4 * 8;
		const entry = Buffer.alloc(8);
		if (fs.readSync(fd, entry, 0, 8, entryOffset) < 8) return out;

		const va = entry.readUInt32LE(0);
		const size = entry.readUInt32LE(4);
		out.offset = va;
		out.size = size;
		out.present = va !== 0 && size !== 0;
		return out;
	} catch {
		return out;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* 忽略 */
			}
		}
	}
}

/**
 * 取 Authenticode 签名信息（只读）。
 *
 * 优先纯 Node 判断「签没签」（稳定、无依赖），再用 PowerShell 取「签名是否有效」
 * （能取到就带上签名者）。PowerShell 那一步失败不影响 `present` 结论。
 *
 * @param {string} filePath 文件路径
 * @returns {{ present: boolean, status: string, signer: string|null, checked: boolean, error: string|null }}
 */
export function probeSignature(filePath) {
	const table = probeCertificateTable(filePath);
	const psResult = queryAuthenticode(filePath);
	return {
		present: table.present,
		status: psResult.status,
		signer: psResult.signer,
		checked: psResult.checked,
		error: psResult.error,
		certificateTable: table
	};
}

/**
 * 用 PowerShell 查询签名有效性。
 *
 * **优先 `pwsh.exe`（PowerShell 7）**：本机实测 32 位 `powershell.exe` 去加载
 * 64 位 PS7 的 `Microsoft.PowerShell.Security` 模块会失败，导致拿不到签名状态。
 * `Import-Module` 显式导入可提高成功率，因此脚本里先试导入。
 */
function queryAuthenticode(filePath) {
	const quoted = filePath.replace(/'/g, "''");
	const script = [
		"$ErrorActionPreference = 'Continue'",
		"try { Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue } catch { }",
		`$s = Get-AuthenticodeSignature -LiteralPath '${quoted}'`,
		"if ($s -eq $null) { Write-Output 'STATUS=NULL'; exit 0 }",
		"Write-Output ('STATUS=' + $s.Status)",
		"if ($s.SignerCertificate -ne $null) { Write-Output ('SIGNER=' + $s.SignerCertificate.Subject) }"
	].join("\n");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];

	// 依次试 pwsh.exe（PS7，位数与本机模块匹配概率更高）与 powershell.exe（Windows PowerShell）
	const errors = [];
	for (const exe of ["pwsh.exe", "powershell.exe"]) {
		const which = run("where.exe", [exe]);
		if (which.code !== 0 || which.stdout === "") continue;
		const result = run(exe, args, { timeoutMs: 45_000 });
		const status = result.stdout.match(/STATUS=(\S+)/);
		if (status !== null) {
			const signer = result.stdout.match(/SIGNER=(.+)/);
			return {
				status: status[1],
				signer: signer === null ? null : signer[1].trim(),
				checked: true,
				error: null
			};
		}
		errors.push(`${exe}: 退出码 ${result.code} ${(result.stderr || result.stdout || "").slice(0, 200)}`);
	}
	return {
		status: "UNKNOWN",
		signer: null,
		checked: false,
		error: errors.length > 0 ? errors.join(" | ") : "找不到 pwsh.exe / powershell.exe"
	};
}

/** 计算文件的 SHA256（用于留档与比对）。 */
export function sha256Of(filePath) {
	const hash = createHash("sha256");
	hash.update(fs.readFileSync(filePath));
	return hash.digest("hex");
}

/**
 * 汇总驱动现状（**只读**，不做任何下载或系统改动）。
 *
 * 会顺带探测一次驱动设备能否打开（`probe`），因为「服务在跑」与「设备真能用」
 * 是两件事，而后者才是使用者关心的。探测是纯只读的 `CreateFile`，失败也不抛错。
 *
 * @param {object} [options]
 * @param {(message: string) => void} [options.onProbeLog] 探测过程日志（每一步都记，便于排查）
 * @returns {object} 状态报告
 */
export function driverStatus(options = {}) {
	ensureCacheDirs();
	const service = queryServiceState();
	const servicePath = service.installed ? queryServicePath() : null;
	const systemPresent = fs.existsSync(DBK64_SYSTEM_PATH);

	// 设备连通性探测（只读）。设备名的解析规则（serviceName → driver.dat → CEDRIVER73）
	// 只有 DbkBackend 一处实现，所以这里直接借它来探，避免两边规则不一致。
	// 探测失败一律吞成 null —— 状态报告本身不该因为探测不到而崩。
	let deviceProbe = null;
	try {
		deviceProbe = probeDeviceViaKernel(options);
	} catch (error) {
		probeLog(`设备探测失败：${error && error.message ? error.message : String(error)}`);
		deviceProbe = null;
	}

	// 缓存里已有的候选驱动（之前下载/提取过的）
	const candidates = [];
	for (const dir of [CACHE_DIRS.installed, CACHE_DIRS.extract]) {
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			if (name.toLowerCase() === DBK64_FILE.toLowerCase()) {
				candidates.push(path.join(dir, name));
			}
		}
	}
	const cached = candidates.length > 0
		? candidates.map((file) => ({
				path: file,
				sizeBytes: fs.statSync(file).size,
				pe: probePeHeaders(file)
			}))
		: [];

	return {
		elevated: isElevated(),
		service,
		servicePath,
		systemDriver: {
			path: DBK64_SYSTEM_PATH,
			present: systemPresent,
			sizeBytes: systemPresent ? fs.statSync(DBK64_SYSTEM_PATH).size : null,
			pe: systemPresent ? probePeHeaders(DBK64_SYSTEM_PATH) : null
		},
		cachedDrivers: cached,
		/** 设备连通性探测结果；驱动没装时为 null 或 opened=false。 */
		deviceProbe,
		/**
		 * 说明「驱动就绪」之后还需要做什么才真的能读受保护进程。
		 *
		 * `DbkBackend` 已经实现，所以这里描述的是**剩余前提**，而不是声称能力缺失。
		 */
		backendNote:
			"DBK 后端（DbkBackend）已实现：内存读写与分配走内核驱动 ioctl。" +
			"要真正用到它还需两步：① 用 ce_kernel 的 install + load 加载驱动（需要管理员权限）；" +
			"② 把插件配置的 backend 改成 dbk。" +
			"注意事项：改内存保护与释放内存仍是用户态实现（CE 驱动的 MAKEWRITABLE 在 x64 上是空的），" +
			"对受保护进程会失败；且该后端的驱动侧结构布局尚未在真机上验证，先用 probe_driver 确认连通性。"
	};
}

/**
 * 只读探测一次驱动设备。
 *
 * 设备名的解析规则只有 `DbkBackend` 一处实现，所以借它来探，避免两边规则不一致。
 * 内核模块需要调用方注入（`options.ce`）—— 它可能因为 koffi/环境问题加载失败，
 * 而那不该让整个状态报告崩掉，所以这里只做防御性处理，不自己 require。
 *
 * @param {object} [options]
 * @param {object} [options.ce] 内核模块（含 DbkBackend）
 * @param {string} [options.serviceName] 显式服务名
 * @param {string} [options.cheatEngineDir] CE 安装目录（用于读 driver.dat）
 * @returns {object|null} `DbkBackend.probe()` 的结果；拿不到内核时返回 null
 */
function probeDeviceViaKernel(options = {}) {
	const ce = options.ce;
	if (ce === undefined || ce === null || typeof ce.DbkBackend !== "function") return null;
	const backend = new ce.DbkBackend({
		serviceName: options.serviceName ?? "",
		cheatEngineDir: options.cheatEngineDir ?? ""
	});
	try {
		return backend.probe();
	} finally {
		backend.dispose();
	}
}

/* ------------------------------------------------------------------ *
 * 获取（下载官方安装包 → 提取 DBK64.sys）
 * ------------------------------------------------------------------ */

/**
 * 从官方下载页解析当前安装包的直链。
 *
 * 页面里的链接形如 `<a href="https://d3gpt2g9zwv61d.cloudfront.net/XXXX.exe">Download Cheat Engine 7.7</a>`。
 * 链接会随版本变，所以必须实时解析；解析不到就明确报错，不猜 URL。
 *
 * @param {string} [pageUrl] 下载页地址
 * @returns {Promise<{ url: string, label: string }>}
 */
export async function resolveInstallerUrl(pageUrl = CE_DOWNLOADS_PAGE) {
	const response = await fetch(pageUrl, {
		headers: { "user-agent": USER_AGENT }
	});
	if (!response.ok) {
		throw new Error(`抓取 CE 下载页失败：HTTP ${response.status} ${response.statusText}`);
	}
	const html = await response.text();

	// 优先匹配「Download Cheat Engine x.y」附近的 .exe 链接
	const patterns = [
		/<a[^>]+href="(https?:\/\/[^"]+\.exe)"[^>]*>\s*<img[^>]*>\s*Download Cheat Engine ([0-9.]+)/i,
		/href="(https?:\/\/[^"]+\.exe)"[^>]*>\s*Download Cheat Engine ([0-9.]+)/i,
		/href="(https?:\/\/[^"]+\.exe)"/i
	];
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match !== null) {
			return { url: match[1], label: match[2] ?? "unknown" };
		}
	}
	throw new Error(
		`未能从 ${pageUrl} 解析出安装包直链。` +
		"可能是页面结构变了 —— 请用 installerUrl 参数直接给出安装包地址，或用 localInstaller 给出本地文件。"
	);
}

/** 下载一个 URL 到文件（流式，带大小上限与进度回调）。 */
export async function downloadTo(url, targetPath, options = {}) {
	const limit = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
	const response = await fetch(url, {
		headers: { "user-agent": USER_AGENT }
	});
	if (!response.ok) {
		throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}（${url}）`);
	}
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > limit) {
		throw new Error(`文件声明大小 ${declared} 字节超过上限 ${limit} 字节，已中止（${url}）。`);
	}

	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	const handle = await fs.promises.open(targetPath, "w");
	let received = 0;
	try {
		for await (const chunk of response.body) {
			received += chunk.length;
			if (received > limit) {
				throw new Error(`下载超过上限 ${limit} 字节，已中止（已收 ${received} 字节）。`);
			}
			await handle.write(chunk);
		}
	} catch (error) {
		await handle.close();
		try {
			fs.unlinkSync(targetPath);
		} catch {
			/* 忽略 */
		}
		throw error;
	}
	await handle.close();
	return { path: targetPath, bytes: received, declaredBytes: declared === 0 ? null : declared };
}

/**
 * 找一个能解 Inno Setup 包的工具。
 *
 * 顺序：
 *   1. 缓存里的 innoextract（本模块之前下载的）；
 *   2. PATH 上的 innoextract；
 *   3. 常见的 7-Zip 位置（含 Docker/VMware/NVIDIA 等软件自带的那份）。
 *
 * @returns {{ command: string, kind: "innoextract"|"7z", label: string }|null}
 */
export function findExtractor() {
	const innoFiles = [
		path.join(CACHE_DIRS.installed, "innoextract.exe"),
		path.join(CACHE_ROOT, "innoextract.exe")
	];
	for (const file of innoFiles) {
		if (fs.existsSync(file)) return { command: file, kind: "innoextract", label: file };
	}

	const onPath = run("where.exe", ["innoextract"]);
	if (onPath.code === 0 && onPath.stdout !== "") {
		const first = onPath.stdout.split(/\r?\n/)[0].trim();
		return { command: first, kind: "innoextract", label: `PATH: ${first}` };
	}

	const sevenZipCandidates = [
		"C:\\Program Files\\7-Zip\\7z.exe",
		"C:\\Program Files (x86)\\7-Zip\\7z.exe",
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "7-Zip", "7z.exe") : "",
		// 一些软件自带 7z（实测本机存在）
		"C:\\Program Files\\VMware\\VMware Workstation\\7za.exe",
		"C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\7z.exe",
		"C:\\Program Files\\Docker\\Docker\\7zr.exe"
	].filter((item) => item !== "");
	for (const candidate of sevenZipCandidates) {
		if (fs.existsSync(candidate)) return { command: candidate, kind: "7z", label: candidate };
	}
	return null;
}

/**
 * 从安装包里提取 DBK64.sys。
 *
 * 两条路，按可靠性排序：
 *   1. **innoextract / 7-Zip**（不装任何东西，最干净）—— 但实测对 CE 7.7 的包解不开；
 *   2. **官方安装包静默解包安装**（`extractDriverViaInstaller`）—— 官方包一定能解开自己，
 *      代价是会在私有目录装出完整 CE 并写一条卸载信息到注册表。
 *
 * @param {object} options
 * @param {string} options.installerPath 安装包路径
 * @param {string} options.outDir 输出目录
 * @param {boolean} [options.allowSilentInstall] 是否允许走静默安装兜底（默认 true）
 * @returns {{ driverPath: string, extractor: string, stdout: string, attempts: string[] }}
 */
export function extractDriver(options) {
	const attempts = [];
	const extractor = findExtractor();

	if (extractor !== null) {
		fs.mkdirSync(options.outDir, { recursive: true });
		const args = extractor.kind === "innoextract"
			? ["-e", "--include", DBK64_FILE, "-d", options.outDir, options.installerPath]
			: ["x", "-y", `-o${options.outDir}`, options.installerPath, DBK64_FILE, "-r"];
		const result = run(extractor.command, args, { timeoutMs: 300_000 });
		const found = findFileRecursive(options.outDir, DBK64_FILE);
		if (found !== null) {
			return {
				driverPath: found,
				extractor: `${extractor.kind} (${extractor.label})`,
				stdout: result.stdout.slice(0, 500),
				attempts
			};
		}
		attempts.push(
			`${extractor.kind}（${extractor.label}）：退出码 ${result.code}，` +
			`${(result.stdout || result.stderr || "(空输出)").slice(0, 200)}`
		);
	} else {
		attempts.push("没有找到 innoextract / 7-Zip");
	}

	if (options.allowSilentInstall === false) {
		throw new Error(
			`用解包工具没能取出 ${DBK64_FILE}，且已禁用静默安装兜底。\n` +
			attempts.map((line) => `  - ${line}`).join("\n") +
			"\n处理办法：装一个较新的 innoextract；或用 localDriver 参数直接给出 DBK64.sys 路径。"
		);
	}

	// 兜底：让官方安装包自己解开自己
	try {
		const silent = extractDriverViaInstaller({ installerPath: options.installerPath });
		attempts.push(`静默解包安装成功（${silent.installDir}）`);
		return {
			driverPath: silent.driverPath,
			extractor: "官方安装包静默解包（/VERYSILENT /DIR=私有目录）",
			stdout: silent.stdout,
			attempts
		};
	} catch (error) {
		attempts.push(`静默解包安装：${error.message.split("\n")[0]}`);
		throw new Error(
			`所有提取方式都失败了，没能取出 ${DBK64_FILE}。\n` +
			attempts.map((line) => `  - ${line}`).join("\n") +
			"\n处理办法（任选其一）：\n" +
			"  1. 自己用 CE 安装包装一份，把 DBK64.sys 路径用 localDriver 参数传进来；\n" +
			"  2. 装一个支持新版 Inno Setup 的解包工具后重试。"
		);
	}
}

/** 在目录里递归找同名文件（安装包解开后目录层级不定）。 */
function findFileRecursive(dir, name) {
	if (!fs.existsSync(dir)) return null;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.toLowerCase() === name.toLowerCase()) return full;
		}
	}
	return null;
}

/**
 * 兜底提取：用官方安装包自带的**静默解包安装**能力，只装到私有目录后取出驱动。
 *
 * ## 为什么需要这条兜底
 *
 * Inno Setup 的包格式随版本演进，而 `innoextract` 最后一个版本是 1.9（2020 年，
 * 声明支持到 Inno Setup 6.1.0）。实测 **CE 7.7 的安装包用 innoextract 1.9 取不到
 * DBK64.sys**（`Done with 1 error and 2 warnings`），7-Zip 也解不开。
 * 官方安装包本身是 Inno Setup 生成的，它**自己一定能解开自己**，
 * 因此用 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=<私有目录>`
 * 装到插件缓存目录，再把 `DBK64.sys` 取出来。
 *
 * ## 这条路径的实际副作用（不隐瞒）
 *
 * - 会在私有目录下装出**完整的 Cheat Engine 文件**（约 100–200MB），不只是驱动。
 *   装完会尽量删除该目录；删不掉也不影响功能。
 * - Inno Setup 会写它的**卸载信息到注册表**（`HKLM\...\Uninstall\...`）。
 *   这是驱动无害的部分，但确实是系统改动；本函数不额外写任何别的东西。
 * - 安装包本身的"推荐软件"选项由 `/SUPPRESSMSGBOXES` + `/VERYSILENT` 抑制。
 *
 * @param {object} options
 * @param {string} options.installerPath 安装包路径
 * @returns {{ driverPath: string, installDir: string, cleanup: boolean, stdout: string }}
 */
export function extractDriverViaInstaller(options) {
	const installDir = path.join(CACHE_ROOT, "ce-silent-install");
	fs.mkdirSync(installDir, { recursive: true });

	const args = [
		"/VERYSILENT",
		"/SUPPRESSMSGBOXES",
		"/NORESTART",
		"/NOCANCEL",
		"/SP-",
		`/DIR=${installDir}`
	];
	const result = run(options.installerPath, args, { timeoutMs: 600_000 });

	const found = findFileRecursive(installDir, DBK64_FILE);
	if (found === null) {
		throw new Error(
			`静默解包安装也没有得到 ${DBK64_FILE}。\n` +
			`  安装目录：${installDir}\n` +
			`  退出码：${result.code}\n` +
			`  输出：${(result.stdout || result.stderr || "(空)").slice(0, 500)}`
		);
	}
	return {
		driverPath: found,
		installDir,
		stdout: `${result.stdout}\n${result.stderr}`.trim().slice(0, 500)
	};
}

/**
 * 完整获取链路：解析直链 → 下载 → 解包 → 校验。
 *
 * **不会**安装或加载任何东西（那是 `installDriver` / `loadDriver` 的事），
 * 因此这一步即使非管理员也能跑。
 *
 * @param {object} [options]
 * @param {string} [options.installerUrl] 直接指定安装包地址（跳过页面解析）
 * @param {string} [options.localInstaller] 本地已有的安装包路径（跳过下载）
 * @param {string} [options.onProgress] 进度回调
 * @returns {Promise<object>} 获取结果（含校验信息）
 */
export async function acquireDriver(options = {}) {
	ensureCacheDirs();
	const progress = typeof options.onProgress === "function" ? options.onProgress : () => {};
	const log = [];

	let installerPath = null;
	let installerOrigin = null;
	let cepackSource = null;

	// ── 首选路径：本机已装的 Cheat Engine ────────────────────────────────
	// 实测很多机器本来就装了 CE（本机就有 7.6）。直接从它目录取驱动
	// 最快、不联网、也不需要解包工具。CE 7.5+ 放的是 `dbk64.cepack`（需解包），
	// 老版本直接放 `DBK64.sys`。
	const local = options.localInstaller === undefined ? findLocalCheatEngineDriver() : null;
	if (local !== null) {
		log.push(`发现本机已安装的 Cheat Engine 驱动：${local.path}（${local.kind}）`);
		if (local.kind === "sys") {
			installerPath = local.path;
			installerOrigin = `本机 Cheat Engine 安装目录`;
		} else {
			cepackSource = local.path;
		}
	}

	if (cepackSource !== null) {
		// 直接解 .cepack，不需要安装包，也不需要任何外部工具
		const unpacked = path.join(CACHE_DIRS.extract, DBK64_FILE);
		progress("unpack", cepackSource);
		const result = unpackCepackToFile({ cepackPath: cepackSource, outPath: unpacked });
		log.push(`已解包 ${path.basename(cepackSource)} → ${unpacked}（${result.data.length} 字节）`);
		if (result.declaredSize !== 0 && result.data.length !== result.declaredSize) {
			throw new Error(
				`解包后大小 ${result.data.length} 与 cepack 头部声明的 ${result.declaredSize} 不一致。`
			);
		}
		return finishAcquire({
			driverCandidate: unpacked,
			sourceDescription: `本机 Cheat Engine 的 ${path.basename(cepackSource)}（已用内置 zlib 解包）`,
			installerPath: null,
			installerOrigin: null,
			installerSignature: null,
			installerSha256: null,
			log
		});
	}

	if (installerPath === null) {
		if (typeof options.localInstaller === "string" && options.localInstaller.trim() !== "") {
			installerPath = path.resolve(options.localInstaller.trim());
			if (!fs.existsSync(installerPath)) {
				throw new Error(`localInstaller 指向的文件不存在：${installerPath}`);
			}
			installerOrigin = "本地文件";
			log.push(`使用本地安装包：${installerPath}`);
		} else {
			const resolved = typeof options.installerUrl === "string" && options.installerUrl.trim() !== ""
				? { url: options.installerUrl.trim(), label: "" }
				: await resolveInstallerUrl();
			log.push(`Cheat Engine 安装包：${resolved.label || "(手动指定)"} → ${resolved.url}`);
			progress("download", resolved.url);
			// 缓存名：有版本号就用版本号，否则用 URL 里的文件名（CloudFront 的文件名是随机的，
			// 每次都不同，所以手动指定 URL 时不复用它也能接受 —— 但绝不能出现空名字）。
			const urlFileName = (() => {
				try {
					const base = new URL(resolved.url).pathname.split("/").pop() ?? "";
					return base.replace(/[^\w.-]/g, "");
				} catch {
					return "";
				}
			})();
			const cacheName = resolved.label !== "" ? `CheatEngine-${resolved.label}.exe` : urlFileName || "CheatEngine-installer.exe";
			installerPath = path.join(CACHE_DIRS.downloads, cacheName);
			if (fs.existsSync(installerPath) && fs.statSync(installerPath).size > 1024 * 1024) {
				log.push(`安装包已在缓存中，跳过下载：${installerPath}（${fs.statSync(installerPath).size} 字节）`);
			} else {
				const downloaded = await downloadTo(resolved.url, installerPath);
				log.push(`已下载 ${downloaded.bytes} 字节 → ${installerPath}`);
			}
			installerOrigin = resolved.url;
		}
	}

	progress("extract", installerPath);
	const extracted = extractDriver({
		installerPath,
		outDir: CACHE_DIRS.extract,
		allowSilentInstall: options.allowSilentInstall
	});
	log.push(`提取方式：${extracted.extractor}`);
	for (const attempt of extracted.attempts) log.push(`  提取尝试：${attempt}`);

	// 从安装包里取出来的可能是 `.cepack`（CE 7.5+ 就是如此），还要再解一层
	let driverCandidate = extracted.driverPath;
	if (path.extname(driverCandidate).toLowerCase() === ".cepack" || isCepackFile(driverCandidate)) {
		const unpacked = path.join(CACHE_DIRS.extract, DBK64_FILE);
		progress("unpack", driverCandidate);
		const result = unpackCepackToFile({ cepackPath: driverCandidate, outPath: unpacked });
		log.push(`安装包里是 cepack，已用内置 zlib 解包 → ${unpacked}（${result.data.length} 字节）`);
		driverCandidate = unpacked;
	}

	// 安装包自身的签名与哈希也留档：驱动是从它里面取的，链路的可信度取决于它。
	// 签名主体会在输出里显示，供人自行核对（CE 的安装包签名主体不是 "Cheat Engine"）。
	const installerSignature = probeSignature(installerPath);
	const installerSha256 = sha256Of(installerPath);
	log.push(`安装包：${fs.statSync(installerPath).size} 字节，签名 ${installerSignature.status}，主体 ${installerSignature.signer ?? "(读不到)"}`);

	return finishAcquire({
		driverCandidate,
		sourceDescription: path.basename(installerPath),
		installerPath,
		installerOrigin,
		installerSignature,
		installerSha256,
		log
	});
}

/** 探测文件是不是 cepack（读魔数，不改动任何东西）。 */
export function isCepackFile(filePath) {
	try {
		const fd = fs.openSync(filePath, "r");
		const head = Buffer.alloc(6);
		fs.readSync(fd, head, 0, 6, 0);
		fs.closeSync(fd);
		return head.toString("ascii") === CEPACK_MAGIC;
	} catch {
		return false;
	}
}

/**
 * 获取链路的收尾：校验候选驱动 + 落到 installed 目录。
 *
 * 抽成独立函数是因为「从本机 CE 取 cepack」与「从安装包取」两条路
 * 走到这里之后的校验必须**完全一致** —— 否则两条路的可信度就不一样了。
 */
function finishAcquire(context) {
	const { driverCandidate, log } = context;

	// 校验：必须是 64 位原生子系统 PE
	const pe = probePeHeaders(driverCandidate);
	if (!pe.isPe) throw new Error(`候选驱动不是合法的 PE 文件：${driverCandidate}`);
	if (!pe.isNativeDriver) {
		throw new Error(
			`候选驱动的子系统为 ${pe.subsystem}（期望 1 = IMAGE_SUBSYSTEM_NATIVE），` +
			"看起来不是内核驱动，已中止。"
		);
	}
	const signature = probeSignature(driverCandidate);
	const sizeBytes = fs.statSync(driverCandidate).size;

	// 没内嵌签名的内核驱动在 64 位 Windows 上**通常**加载不了（除测试签名模式），
	// 所以把这件事明确报出来，而不是让它到 install 时再神秘失败。
	//
	// 注意措辞：`present` 只说明 PE 里有没有**内嵌**证书表。
	// 有些文件的签名来自**目录文件（catalog）**而不是内嵌 —— 实测 `notepad.exe`
	// 的 Security 数据目录为 0，但 Authenticode 依然报 Valid。
	// 所以 `present=false` ≠ 未签名，真正的结论看 `signature.status`。
	if (signature.present) {
		log.push("驱动带内嵌 Authenticode 证书表。");
	} else {
		log.push(
			"警告：驱动 PE 里**没有内嵌** Authenticode 证书表（Security 数据目录为 0）。" +
				`签名状态：${signature.status}。` +
				"内核驱动一般要求内嵌签名，因此加载可能被系统拒绝；若 status 为 Valid 则说明签名来自目录文件。"
		);
	}

	// 落到 installed 目录作为「待安装」的规范副本
	const staged = path.join(CACHE_DIRS.installed, DBK64_FILE);
	fs.copyFileSync(driverCandidate, staged);
	const sha256 = sha256Of(staged);
	log.push(`校验通过：${pe.machine} 内核驱动，${sizeBytes} 字节，签名状态 ${signature.status}`);
	log.push(`SHA256：${sha256}`);

	return {
		installerPath: context.installerPath,
		installerOrigin: context.installerOrigin,
		installerSize: context.installerPath === null ? null : fs.statSync(context.installerPath).size,
		installerSignature: context.installerSignature,
		installerSha256: context.installerSha256,
		sourceDescription: context.sourceDescription,
		driverPath: staged,
		driverSize: sizeBytes,
		pe,
		signature,
		sha256,
		log
	};
}

/* ------------------------------------------------------------------ *
 * 安装与加载（需要管理员）
 * ------------------------------------------------------------------ */

/**
 * 「需要管理员权限」的专用错误。
 *
 * 为什么给它一个专门的类（而不是只靠错误文本）：调用方要据此决定
 * **是否走 UAC 提权**。文本匹配很脆 —— 实测 `elevation.js` 的
 * `isPermissionDenied()` 不认「需要管理员权限」这个措辞
 * （它只匹配 Win32 错误码 / 英文 / 「拒绝访问」），
 * 于是提权分支从来没被触发过。用类名做判断就不会有这个问题。
 */
export class KernelAdminRequiredError extends Error {
	constructor(message) {
		super(message);
		this.name = "KernelAdminRequiredError";
		/** 给上层的统一标记：这是权限问题，且**可以通过提权解决**。 */
		this.permissionDenied = true;
		this.adminRequired = true;
	}
}

/** 断言当前进程有管理员权限；没有就抛一条可执行的错误。 */
export function requireAdmin(action) {
	if (isElevated()) return;
	throw new KernelAdminRequiredError(
		`${action}需要管理员权限，而当前进程未提权。\n` +
		"Windows 不允许非管理员安装或加载内核驱动 —— 这是系统硬边界，无法绕过。\n" +
		"可选做法：\n" +
		"  1. 让插件自动提权（默认已开启 kernelElevate，会弹一次 UAC）；\n" +
		"  2. 以管理员身份重启 DSH（右键 → 以管理员身份运行），再调用本工具；\n" +
		"  3. 在管理员 PowerShell 里手动执行：\n" +
		`     sc.exe create ${DBK64_SERVICE} type= kernel start= demand binPath= "${DBK64_SYSTEM_PATH}"\n` +
		`     sc.exe start ${DBK64_SERVICE}`
	);
}

/**
 * 安装驱动为内核服务并加载。
 *
 * 步骤（与 DBK64.inf 声明的服务参数一致：`ServiceType=1` 内核驱动、`StartType=3` 按需启动）：
 *   1. 把 DBK64.sys 复制到 `System32\drivers\`（稳定路径，加载时按它读）；
 *   2. `sc create DBK64 type= kernel start= demand binPath= ...`；
 *   3. `sc start DBK64`。
 *
 * 已存在的服务不会被覆盖重建，而是直接尝试启动（避免把别人装好的配置改掉）。
 *
 * @param {object} options
 * @param {string} options.driverPath 要安装的驱动路径
 * @returns {object} 安装结果
 */
export function installDriver(options) {
	const driverPath = path.resolve(options.driverPath);
	const log = [];
	/** 把已完成的步骤日志挂到错误上，失败时调用方仍能看到"走到哪一步了"。 */
	const fail = (message) => {
		const error = new Error(message);
		error.log = [...log];
		throw error;
	};

	if (!fs.existsSync(driverPath)) fail(`驱动文件不存在：${driverPath}`);
	requireAdmin("安装内核驱动");

	const pe = probePeHeaders(driverPath);
	if (!pe.isNativeDriver) {
		fail(`拒绝安装：${driverPath} 不是原生子系统内核驱动（subsystem=${pe.subsystem}）。`);
	}

	const existing = queryServiceState();
	if (existing.installed) {
		log.push(`服务 ${DBK64_SERVICE} 已存在（状态 ${existing.state}），跳过创建。`);
		// 已存在但指向别处时也要把我们的驱动放到位，否则 start 会加载旧路径
		// （这里不删旧服务：那是破坏性操作，交给用户决定）
		log.push(`现有 ImagePath：${queryServicePath() ?? "(读不到)"}`);
	} else {
		log.push(`复制驱动 → ${DBK64_SYSTEM_PATH}`);
		fs.copyFileSync(driverPath, DBK64_SYSTEM_PATH);
		const created = run("sc.exe", [
			"create",
			DBK64_SERVICE,
			"type=", "kernel",
			"start=", "demand",
			"error=", "normal",
			"binPath=", DBK64_SYSTEM_PATH,
			"DisplayName=", "DBK64 Service"
		]);
		log.push(`sc create → 退出码 ${created.code}${created.stdout ? `：${created.stdout}` : ""}${created.stderr ? ` ${created.stderr}` : ""}`);
		if (created.code !== 0) {
			fail(
				`创建内核服务失败（退出码 ${created.code}）。\n  ${created.stdout}\n  ${created.stderr}\n` +
				"常见原因：未提权、驱动签名被策略拒绝、或同名的旧服务残留。"
			);
		}
	}
	return { log, driverPath };
}

/**
 * 启动（加载）内核驱动。
 *
 * `sc start` 的失败信息很有价值，原样带出去：1033/1275/577 等错误码分别对应
 * 「驱动被策略阻止」「签名无效」「映像损坏」等不同原因。
 *
 * @returns {object} 加载结果
 */
export function loadDriver() {
	requireAdmin("加载内核驱动");
	const before = queryServiceState();
	if (before.state === "RUNNING") {
		return { started: false, alreadyRunning: true, state: before.state, message: "驱动已在运行。" };
	}
	const started = run("sc.exe", ["start", DBK64_SERVICE], { timeoutMs: 60_000 });
	const after = queryServiceState();
	if (after.state === "RUNNING") {
		return {
			started: true,
			alreadyRunning: false,
			state: after.state,
			message: `驱动已加载（sc start 退出码 ${started.code}）。`,
			raw: started.stdout
		};
	}

	// 服务根本没安装时（Win32 1060）单独给一条明确指引 ——
	// 否则会被下面那串"签名/HVCI"的原因误导，让人往完全错误的方向排查。
	const notInstalled =
		after.state === "NOT_INSTALLED" || /1060/.test(`${started.stdout} ${started.stderr}`);
	if (notInstalled) {
		throw new Error(
			`加载内核驱动失败：服务 ${DBK64_SERVICE} **还没有安装**（sc start 1060）。\n` +
			"正确顺序是先装再加载：\n" +
			"  1. ce_kernel { action: \"acquire\" }   获取驱动到缓存；\n" +
			"  2. ce_kernel { action: \"install\", confirm: true }   安装为内核服务；\n" +
			"  3. ce_kernel { action: \"load\", confirm: true }   再加载（就是当前这步）。"
		);
	}

	throw new Error(
		`加载内核驱动失败（sc start 退出码 ${started.code}，服务状态 ${after.state}）。\n` +
		`  ${started.stdout}\n  ${started.stderr}\n` +
		"常见原因：\n" +
		"  - 驱动签名不被本机策略接受（Secure Boot + HVCI 下常见）；\n" +
		"  - 驱动文件被替换/损坏；\n" +
		"  - 同名的其他安全软件驱动冲突。"
	);
}

/**
 * 停止并删除内核服务（卸载驱动）。
 *
 * 做三件事，且每一步都**如实记录结果**（不假装成功）：
 *   1. `sc stop` 停止驱动；
 *   2. `sc delete` 删除服务注册；
 *   3. 删除 `System32\drivers\DBK64.sys`（驱动文件本体）。
 *
 * 注意：只删除**我们自己装的那份**（固定路径）。不会去动用户原有的 CE 安装目录，
 * 也不会碰别人的服务。缓存目录里的副本由 `cleanupDriverCache()` 单独处理 ——
 * 那是无害的文件，且删掉后还能重新获取，所以刻意分开，避免"卸载驱动"意外
 * 连带删掉用户可能还要用的东西。
 *
 * @returns {{ log: string[], state: string }}
 */
export function unloadDriver() {
	requireAdmin("卸载内核驱动");
	const log = [];

	const before = queryServiceState();
	if (!before.installed) {
		log.push(`服务 ${DBK64_SERVICE} 本来就不存在（状态 ${before.state}），无需停止/删除。`);
	} else {
		log.push(`卸载前状态：${before.state}`);
		if (before.state === "RUNNING") {
			const stopped = run("sc.exe", ["stop", DBK64_SERVICE], { timeoutMs: 60_000 });
			log.push(`sc stop → 退出码 ${stopped.code}${stopped.stdout ? `：${stopped.stdout}` : ""}`);
			const afterStop = queryServiceState();
			log.push(`停止后状态：${afterStop.state}`);
			if (afterStop.state !== "STOPPED") {
				log.push(
					`⚠️ 驱动没有进入 STOPPED（当前 ${afterStop.state}）—— ` +
						"可能还有进程持有设备句柄。此时删除服务可能失败，请先关掉占用它的程序。"
				);
			}
		} else {
			log.push("驱动未在运行，跳过 sc stop。");
		}

		const deleted = run("sc.exe", ["delete", DBK64_SERVICE]);
		log.push(`sc delete → 退出码 ${deleted.code}${deleted.stdout ? `：${deleted.stdout}` : ""}`);
	}

	// 驱动文件本体
	if (fs.existsSync(DBK64_SYSTEM_PATH)) {
		try {
			fs.unlinkSync(DBK64_SYSTEM_PATH);
			log.push(`已删除驱动文件 ${DBK64_SYSTEM_PATH}`);
		} catch (error) {
			log.push(`删除 ${DBK64_SYSTEM_PATH} 失败：${error.message}（驱动可能仍被占用或权限不足）`);
		}
	} else {
		log.push(`${DBK64_SYSTEM_PATH} 不存在，无需删除。`);
	}

	const finalState = queryServiceState();
	log.push(`最终状态：${finalState.state}`);
	return { log, state: finalState.state, deleted: !finalState.installed };
}

/**
 * 清理本插件的驱动缓存（**不需要管理员**）。
 *
 * 删的是可以随时重新获取的东西：下载的官方安装包、解出来的 DBK64.sys、
 * innoextract 解包工具、以及静默解包安装出来的临时 CE 目录。
 *
 * **不动** `System32\drivers\DBK64.sys`，也不动注册表 —— 那是 `unloadDriver()` 的职责。
 *
 * @param {object} [options]
 * @param {boolean} [options.keepExtractor] 保留 innoextract（默认 false）
 * @returns {{ log: string[], freedBytes: number }}
 */
export function cleanupDriverCache(options = {}) {
	const log = [];
	let freedBytes = 0;

	/** 递归统计并删除一个目录/文件；返回释放的字节数。 */
	const remove = (target, label) => {
		if (!fs.existsSync(target)) {
			log.push(`${label}：不存在，跳过`);
			return;
		}
		let size = 0;
		try {
			const stat = fs.statSync(target);
			if (stat.isFile()) size = stat.size;
			else {
				for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
					const full = path.join(target, entry.name);
					if (entry.isFile()) size += fs.statSync(full).size;
					else if (entry.isDirectory()) size += dirSize(full);
				}
			}
			fs.rmSync(target, { recursive: true, force: true });
			freedBytes += size;
			log.push(`${label}：已删除（释放 ${(size / 1048576).toFixed(1)} MB）`);
		} catch (error) {
			log.push(`${label}：删除失败 —— ${error.message}`);
		}
	};

	remove(CACHE_DIRS.downloads, "下载的安装包");
	remove(CACHE_DIRS.extract, "解出的驱动");
	remove(path.join(CACHE_ROOT, "ce-silent-install"), "静默解包安装的临时 CE 目录");
	if (options.keepExtractor === true) {
		log.push("innoextract 解包工具：按要求保留");
	} else {
		// 解包工具是个单独的文件，单独删
		for (const file of [
			path.join(CACHE_DIRS.installed, "innoextract.exe"),
			path.join(CACHE_ROOT, "innoextract.exe"),
			path.join(CACHE_ROOT, "innoextract-1.9-windows.zip")
		]) {
			remove(file, path.basename(file));
		}
	}

	// installed 目录里可能还有 staged 的 DBK64.sys（cleanup 时一并删掉，
	// 因为它随时能用 acquire 重新解出来）
	remove(path.join(CACHE_DIRS.installed, DBK64_FILE), `缓存的 ${DBK64_FILE}`);

	return { log, freedBytes };
}

/** 递归算目录大小（用于报告释放了多少空间）。 */
function dirSize(dir) {
	let total = 0;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		try {
			if (entry.isDirectory()) total += dirSize(full);
			else total += fs.statSync(full).size;
		} catch {
			/* 忽略读不到的项 */
		}
	}
	return total;
}

/**
 * 下载 innoextract（官方 GitHub release）。
 *
 * 只在需要解包又没有任何工具时才用。用 PowerShell 的 `Expand-Archive`
 * 解开 zip（避免再引一个解压依赖）。
 *
 * @param {object} [options]
 * @param {string} [options.url] 覆盖下载地址
 * @returns {Promise<object>}
 */
export async function fetchInnoextract(options = {}) {
	ensureCacheDirs();
	const url = options.url ?? "https://github.com/dscharrer/innoextract/releases/download/1.9/innoextract-1.9-windows.zip";
	const zipPath = path.join(CACHE_ROOT, "innoextract-1.9-windows.zip");
	const zip = await downloadTo(url, zipPath, { maxBytes: 32 * 1024 * 1024 });
	const script = [
		`$ErrorActionPreference = 'Stop'`,
		`Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${CACHE_DIRS.installed.replace(/'/g, "''")}' -Force`
	].join("\n");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const result = run(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
		{ timeoutMs: 120_000 }
	);
	if (result.code !== 0) {
		throw new Error(`解压 innoextract 失败（退出码 ${result.code}）：${result.stderr || result.stdout}`);
	}
	const exe = findFileRecursive(CACHE_DIRS.installed, "innoextract.exe");
	if (exe === null) throw new Error("解压后没有找到 innoextract.exe。");
	return { zipBytes: zip.bytes, extractorPath: exe, url };
}
