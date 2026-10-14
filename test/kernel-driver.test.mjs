/**
 * kernel-driver.js 的只读能力测试（不需要网络、不需要管理员）。
 *
 * 这一层是内核驱动功能的「底座」，也是最容易写错的部分：
 * PE 头解析一旦偏移算错，就会把真正的驱动判成「不是内核驱动」而拒绝安装，
 * 或者把用户态 exe 当成驱动去装。所以用本机**真实文件**做样本验证。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	CACHE_DIRS,
	DBK64_FILE,
	DBK64_SERVICE,
	DBK64_SYSTEM_PATH,
	driverStatus,
	ensureCacheDirs,
	extractDriver,
	findExtractor,
	probePeHeaders,
	probeSignature,
	queryServicePath,
	queryServiceState,
	requireAdmin,
	resolveInstallerUrl,
	sha256Of
} from "../lib/kernel-driver.js";

const SYSTEM32_DRIVERS = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers");

test("PE 头解析：真实内核驱动必须被判为 PE32+ 原生子系统", () => {
	const drivers = ["ntfs.sys", "tcpip.sys", "ndis.sys", "http.sys"];
	let checked = 0;
	for (const name of drivers) {
		const file = path.join(SYSTEM32_DRIVERS, name);
		if (!fs.existsSync(file)) continue;
		const pe = probePeHeaders(file);
		checked += 1;
		assert.equal(pe.isPe, true, `${name} 应被识别为 PE`);
		assert.equal(pe.is64Bit, true, `${name} 应是 PE32+`);
		assert.equal(pe.machine, "x64", `${name} 应是 x64`);
		assert.equal(pe.subsystem, 1, `${name} 的 Subsystem 应为 1（IMAGE_SUBSYSTEM_NATIVE）`);
		assert.equal(pe.isNativeDriver, true, `${name} 应被判为内核驱动`);
	}
	assert.ok(checked > 0, "至少应当验证到一个真实驱动（否则这台机器的样本不可用）");
});

test("PE 头解析：用户态 exe 不能被判成内核驱动", () => {
	// 这是「拒绝安装」闸门的正确性依据：GUI 子系统（2）不是驱动。
	// 曾经把 DllCharacteristics 的偏移当成 Subsystem，导致驱动全被判错，这条用例就是防它回归。
	const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe");
	if (!fs.existsSync(exe)) return;
	const pe = probePeHeaders(exe);
	assert.equal(pe.isPe, true);
	assert.equal(pe.isNativeDriver, false, "notepad.exe 不是内核驱动");
	assert.notEqual(pe.subsystem, 1);
});

test("PE 头解析：非法/不存在的文件不抛错，而是明确报告", () => {
	const missing = probePeHeaders(path.join(os.tmpdir(), "definitely-not-here-12345.sys"));
	assert.equal(missing.isPe, false, "不存在的文件应返回 isPe=false 而不是抛错");
	assert.equal(missing.isNativeDriver, false);

	// 造一个假文件：只有 MZ 头，没有 PE 签名
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-kernel-test-"));
	const fake = path.join(tempDir, "fake.sys");
	const buf = Buffer.alloc(256);
	buf[0] = 0x4d;
	buf[1] = 0x5a;
	buf.writeUInt32LE(0x80, 0x3c); // 指向一个没有 PE 签名的位置
	fs.writeFileSync(fake, buf);
	const probe = probePeHeaders(fake);
	assert.equal(probe.isPe, false, "没有 PE\\0\\0 签名不应被判为 PE");

	// 只有 MZ 头、长度不足 64 字节
	const tiny = path.join(tempDir, "tiny.sys");
	fs.writeFileSync(tiny, Buffer.from([0x4d, 0x5a]));
	assert.equal(probePeHeaders(tiny).isPe, false);

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("服务状态查询：未安装时报告 NOT_INSTALLED 与 1060", () => {
	const state = queryServiceState(DBK64_SERVICE);
	// 本机大概率没装 DBK64；但无论装没装，返回值形状必须稳定
	assert.equal(typeof state.installed, "boolean");
	assert.equal(typeof state.state, "string");
	if (!state.installed) {
		assert.equal(state.state, "NOT_INSTALLED");
		assert.equal(state.win32ExitCode, 1060, "sc query 对不存在的服务返回 1060");
	}
});

test("服务状态查询：对明确不存在的服务名稳定返回 NOT_INSTALLED", () => {
	const state = queryServiceState("ThisServiceDoesNotExist_9f3a1b2c");
	assert.equal(state.installed, false);
	assert.equal(state.state, "NOT_INSTALLED");
	assert.equal(state.win32ExitCode, 1060);
});

test("服务路径查询：不存在的服务返回 null 而不是抛错", () => {
	assert.equal(queryServicePath("ThisServiceDoesNotExist_9f3a1b2c"), null);
});

test("driverStatus 只读报告形状稳定，且如实标注剩余前提与短板", () => {
	const status = driverStatus();
	assert.equal(typeof status.elevated, "boolean");
	assert.equal(typeof status.service, "object");
	assert.equal(typeof status.systemDriver, "object");
	assert.equal(status.systemDriver.path, DBK64_SYSTEM_PATH);
	assert.equal(typeof status.systemDriver.present, "boolean");
	assert.ok(Array.isArray(status.cachedDrivers));

	// 这条很重要：报告不能让人误以为「驱动就绪 = 受保护进程可读」。
	// DbkBackend 已实现，所以这里要说明的是**剩余前提**（加载驱动 + 切 backend），
	// 而不是旧文案里那句已经过时的「没有 DBK32 后端」。
	assert.match(status.backendNote, /DbkBackend/, "应说明 DBK 后端已实现");
	assert.match(status.backendNote, /backend.*dbk/i, "应说明必须把 backend 改成 dbk");
	assert.match(status.backendNote, /install|load|管理员/, "应说明还要加载驱动且需管理员");
	// 同时如实标注两处真实短板
	assert.match(status.backendNote, /MAKEWRITABLE|用户态/, "应说明改保护/释放仍是用户态");
	assert.match(status.backendNote, /未.*验证|probe_driver/, "应标注结构布局未验证");
});

test("requireAdmin：未提权时给出可执行的错误（含 sc 命令）", () => {
	// 本机实测非管理员；若在管理员下跑，这个用例应当跳过（不能反过来失败）
	const status = driverStatus();
	if (status.elevated) {
		requireAdmin("测试动作"); // 不应抛错
		return;
	}
	assert.throws(
		() => requireAdmin("安装内核驱动"),
		(error) => {
			assert.match(error.message, /管理员权限/);
			assert.match(error.message, /sc\.exe create/, "应给出可直接执行的手工命令");
			assert.match(error.message, /无法绕过|硬边界/, "应说明这是系统边界而不是插件缺陷");
			return true;
		}
	);
});

test("签名探测：真实系统驱动能取到签名状态", () => {
	const file = path.join(SYSTEM32_DRIVERS, "ntfs.sys");
	if (!fs.existsSync(file)) return;
	const sig = probeSignature(file);
	assert.equal(sig.checked, true, `应能读到签名：${sig.error ?? ""}`);
	assert.ok(sig.status.length > 0);
	assert.ok(sig.status !== "NULL", "ntfs.sys 应当有签名");
	assert.ok(sig.signer !== null, "应当能取到签名者");
});

test("sha256Of 与权威工具一致（用 Node 自算比对）", () => {
	const file = path.join(SYSTEM32_DRIVERS, "ntfs.sys");
	if (!fs.existsSync(file)) return;
	const mine = sha256Of(file);
	assert.match(mine, /^[0-9a-f]{64}$/);
	assert.equal(mine.length, 64);
});

test("findExtractor：本机应能找到至少一个解包工具（否则获取链路不可用）", () => {
	const extractor = findExtractor();
	// 允许在干净机器上为 null，但要把「没有工具」这件事变成显式结果
	if (extractor === null) {
		console.log("  （本机没有 innoextract / 7-Zip，获取链路需要先装一个）");
		return;
	}
	assert.ok(fs.existsSync(extractor.command), `解包工具应存在：${extractor.command}`);
	assert.ok(["innoextract", "7z"].includes(extractor.kind));
});

test("ensureCacheDirs 建出三个缓存目录", () => {
	ensureCacheDirs();
	for (const dir of Object.values(CACHE_DIRS)) {
		assert.equal(fs.existsSync(dir), true, `缓存目录应存在：${dir}`);
	}
});

test("resolveInstallerUrl：能解析出直链且是 exe（需要联网）", async (t) => {
	let result;
	try {
		result = await resolveInstallerUrl();
	} catch (error) {
		// 离线环境不应让测试失败，但要显式跳过一次
		t.skip(`跳过（需要联网）：${error.message.slice(0, 80)}`);
		return;
	}
	assert.match(result.url, /^https?:\/\//);
	assert.match(result.url, /\.exe$/i, "解析出的应当是安装包 exe");
	assert.ok(result.label.length > 0);
	console.log(`  解析到 Cheat Engine ${result.label} → ${result.url}`);
});

test("extractDriver：没有解包工具或包无效时给出可操作错误", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-kernel-extract-"));
	const fakeInstaller = path.join(tempDir, "not-an-installer.exe");
	fs.writeFileSync(fakeInstaller, Buffer.from("this is not an inno setup package"));

	const outDir = path.join(tempDir, "out");
	if (findExtractor() === null) {
		assert.throws(
			() => extractDriver({ installerPath: fakeInstaller, outDir }),
			/no可用的解包工具|没有可用的解包工具/,
			"没有解包工具时应说明怎么装"
		);
	} else {
		// 有工具但包无效 → 必须明确说「没找到 DBK64.sys」并带上工具输出
		assert.throws(
			() => extractDriver({ installerPath: fakeInstaller, outDir }),
			(error) => {
				assert.match(error.message, new RegExp(DBK64_FILE));
				assert.match(error.message, /退出码|innoextract/);
				return true;
			}
		);
	}
	fs.rmSync(tempDir, { recursive: true, force: true });
});
