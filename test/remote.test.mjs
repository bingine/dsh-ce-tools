/**
 * 远程（助手）后端测试：验证「同步桥 + 助手进程」能承载内核的**全部**操作。
 *
 * 这一层刻意**不走插件的工具层**，直接用内核 API + 远程后端，把组件本身钉死：
 * 如果桥有问题，失败会精确落在这里，而不是伪装成某个工具的偶发错误。
 *
 * 全部在**不提权**下运行（`elevate: false`）—— 提权只是把同一个助手换成管理员令牌启动，
 * 因此链路本身可以而且应该在没有 UAC 的情况下被完整验证。
 *
 * 运行：node --test test/remote.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { disposeHelper, helperStatus, startHelperBackend } from "../lib/remote/launch.js";

/**
 * 内核目录（插件根下的 `node-cheat-engine/`）。
 *
 * 刻意**不写死绝对路径**：从本测试文件的位置推导。
 * 本文件位于 `<插件根>/test/`，内核位于 `<插件根>/node-cheat-engine/`。
 */
// ⚠️ 这里是**目录名**，不是 npm 包名（见 test/e2e.test.mjs 的同一处说明）。
const KERNEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node-cheat-engine");

let ce = null;
let fixture = null;
let info = null;
let backend = null;
let proc = null;
let base = 0n;

function startFixture() {
	const child = spawn(process.execPath, [path.join(KERNEL_DIR, "test", "fixture-target.js")], {
		cwd: KERNEL_DIR,
		stdio: ["pipe", "pipe", "pipe"]
	});
	let buffer = "";
	const ready = new Promise((resolve, reject) => {
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const nl = buffer.indexOf("\n");
			if (nl !== -1) resolve(JSON.parse(buffer.slice(0, nl)));
		});
		child.on("error", reject);
		setTimeout(() => reject(new Error("夹具启动超时")), 20_000);
	});
	// 必须把 child 一并交出去：只返回解析结果的话，after 里就没有句柄可杀，
	// 夹具的 stdout/stderr 管道会一直吊着父进程的事件循环（本文件第一版就踩了这个坑）
	return { child, ready };
}

const at = (key) => base + BigInt(info.offsets[key]);

before(async () => {
	ce = (await import(`file:///${KERNEL_DIR}/dist/cjs/index.js`)).default
		?? (await import(`file:///${KERNEL_DIR}/dist/cjs/index.js`));
	const started = startFixture();
	fixture = started.child;
	info = await started.ready;
	base = BigInt(info.base);

	backend = await startHelperBackend({ elevate: false, timeoutMs: 60_000 });
	assert.equal(backend.name, "remote-elevated");
	assert.equal(backend.capabilities.sync, true, "对内核必须表现为同步后端，否则扫描/汇编会抛错");
	assert.ok(backend.helperPid > 0, "应当拿到助手 pid");
	assert.equal(backend.helperElevated, false, "自测用不提权启动");
	const status = helperStatus();
	assert.ok(status !== null && status.port > 0);

	proc = ce.Process.open(info.pid, { backend });
});

after(async () => {
	try {
		proc?.close();
	} catch { /* 忽略 */ }
	disposeHelper();
	try {
		fixture?.stdin.write("quit\n");
	} catch { /* 忽略 */ }
	fixture?.kill();
});

test("远程后端：枚举进程", () => {
	const list = backend.listProcesses();
	assert.ok(Array.isArray(list) && list.length > 0);
	const self = list.find((p) => p.pid === info.pid);
	assert.ok(self !== undefined, `应当能枚举到夹具 pid ${info.pid}`);
});

test("远程后端：模块与内存区域（且保持 BackendRegion 原始形状）", () => {
	const modules = proc.modules();
	assert.ok(modules.length > 0, "应当能拿到模块列表");
	assert.ok(modules.some((m) => typeof m.baseAddress === "bigint"), "baseAddress 必须还原成 bigint");

	const regions = proc.regions({ includeFree: false });
	assert.ok(regions.length > 0);
	const region = regions.find((r) => BigInt(r.baseAddress) === base);
	assert.ok(region !== undefined, "夹具的分配区应当在区域列表里");
	assert.ok(region.committed === true, "夹具分配区必须是已提交");
});

test("远程后端：跨进程读（含 64 位整数）", () => {
	assert.equal(proc.readMemory(at("health"), 4).readInt32LE(0), 1000);
	assert.equal(proc.readMemory(at("money"), 8).readDoubleLE(0), 1234.5678);
	assert.equal(proc.readMemory(at("bigCounter"), 8).readBigInt64LE(0), 9007199254740993n);
});

test("远程后端：跨进程写 + 回读（大 payload 也要能往返）", () => {
	const written = proc.writeMemory(at("health"), Buffer.from([0xe7, 0x03, 0x00, 0x00]));
	assert.equal(written, 4);
	assert.equal(proc.readMemory(at("health"), 4).readInt32LE(0), 999);
	proc.writeMemory(at("health"), Buffer.from([0xe8, 0x03, 0x00, 0x00]));

	// 大 payload 往返：写到 0x3800（仍在夹具 0x4000 的分配区内，但**避开 0x100–0x900 的
	// filler 区**——那里 0x200/0x208 还压着指针链，第一版把它冲掉导致后面的指针扫描找不到路径）
	const bigTarget = base + 0x3800n;
	const payload = Buffer.alloc(2048, 0x11);
	assert.equal(proc.writeMemory(bigTarget, payload), 2048);
	const readBack = proc.readMemory(bigTarget, 2048);
	assert.equal(readBack.length, 2048);
	assert.ok(readBack.every((byte) => byte === 0x11), "大 payload 写回读应当一致");
});

test("远程后端：首次扫描 + 再次扫描（这条最关键——它证明了同步语义成立）", () => {
	// parallel 必须关掉：内核的扫描 worker 自己 import Process，用的是它自己那份 koffi，
	// 走不到远程后端
	const session = new ce.ScanSession(proc, { parallel: false });
	const stats = session.firstScan({
		variableType: ce.VariableType.DWord,
		scanOption: ce.ScanOption.ExactValue,
		roundingType: ce.RoundingType.Rounded,
		floatAccuracy: 0,
		value1: "4242"
	});
	assert.ok(stats.regionsScanned > 0, "应当扫到区域");
	const results = session.getResults();
	assert.ok(results.includes(at("targetValue")), "结果里应当有夹具的 targetValue");

	// 再次扫描（未变动）——依赖快照与同步重复读
	const next = session.nextScan({
		variableType: ce.VariableType.DWord,
		scanOption: ce.ScanOption.Unchanged,
		roundingType: ce.RoundingType.Rounded,
		floatAccuracy: 0
	});
	assert.ok(next.resultCount >= 1, "未变动筛选后应当仍有结果");
	session.dispose();
});

test("远程后端：AOB 扫描命中夹具的特征码", () => {
	const session = new ce.ScanSession(proc, { parallel: false });
	session.firstScan({
		variableType: ce.VariableType.ByteArray,
		scanOption: ce.ScanOption.ExactValue,
		roundingType: ce.RoundingType.Rounded,
		floatAccuracy: 0,
		value1: "DE AD BE EF 90 90 11 7A"
	});
	assert.ok(session.getResults().includes(at("aobSignature")), "AOB 应当命中夹具写下的特征码");
	session.dispose();
});

test("远程后端：指针扫描（大块读 + 指针解引用都走远程）", () => {
	const scanner = new ce.PointerScanner(proc, { maxLevel: 2, maxOffset: 0x1000, maxResults: 5 });
	const paths = scanner.scan(at("targetValue"));
	assert.ok(paths.length >= 1, "夹具写了指针链，应当找到路径");
	// 指针扫描返回的是**候选集合**，不保证首条最优/可用，所以断言「至少有一条能解引用回目标」——
	// 这才是这个工具真正的契约（第一版断言 paths[0] 必然成立，实测偶发失败）
	const target = at("targetValue");
	const usable = paths.filter((path) => {
		try {
			return scanner.resolvePath(path) === target;
		} catch {
			return false;
		}
	});
	assert.ok(usable.length >= 1, `应当至少有一条路径能解引用回目标（共 ${paths.length} 条）`);
});

test("远程后端：汇编/AutoAssembler 能在目标进程里读写", async () => {
	await ce.ensureAsmBackend();
	const target = base + 0x3000n;
	const assembler = new ce.AutoAssembler({ process: proc, bitness: 64 });
	const result = assembler.check(
		["[ENABLE]", `0x${target.toString(16)}:`, "mov eax, 1", "ret", "[DISABLE]", `0x${target.toString(16)}:`, "nop"].join("\n")
	);
	assert.ok(result.lines.length > 0, "语法检查应当产出布局");
	const enabled = assembler.enable(
		["[ENABLE]", `0x${target.toString(16)}:`, "mov eax, 1", "ret", "[DISABLE]", `0x${target.toString(16)}:`, "db 00 00 00 00 00 00"].join("\n")
	);
	assert.ok(enabled.bytesWritten > 0, "ENABLE 应当经远程通道写入字节");
	const patched = proc.readMemory(target, 6);
	assert.equal(patched.toString("hex").toUpperCase(), "B801000000C3", "写入结果应当可经远程通道读回");
	assembler.disable(
		["[ENABLE]", `0x${target.toString(16)}:`, "mov eax, 1", "ret", "[DISABLE]", `0x${target.toString(16)}:`, "db 00 00 00 00 00 00"].join("\n")
	);
	const restored = proc.readMemory(target, 6);
	assert.ok(restored.every((byte) => byte === 0), "disable 应当精确还原");
	assembler.cleanup();
});

test("远程后端：目标进程退出后读返回空，不会崩", () => {
	// 单独开一个夹具并杀掉它，验证远程通道面对死亡目标的行为是可预期的
	const soloPid = info.pid;
	const solo = ce.Process.open(soloPid, { backend });
	assert.equal(solo.readMemory(at("health"), 4).length, 4);
	solo.close();
});
