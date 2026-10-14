/**
 * 端到端测试：**真实跨进程**。
 *
 * 目标进程用 node-cheat-engine 自带的 `test/fixture-target.js`：它 VirtualAlloc 出一段
 * 可预测内存（已知基址、已知值、已知指针链、已知 AOB），思路与 CE 自带的 Tutorial 一致。
 * 我们通过插件的工具层去操作它 —— 也就是说，这里验证的是
 * 「模型看到的 14 个工具 → 会话层 → 内核 → Win32 → 另一个进程」的完整链路，
 * 而不是内核自己的测试（那些在内核仓库里）。
 *
 * 运行：node --test test/e2e.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { callTool, createHarness } from "./helpers/harness.mjs";
import { loadKernel } from "../lib/kernel.js";
import { isElevated } from "../lib/elevation.js";

// `node --test` 会把本文件跑在一个子进程里。子进程异常退出时，runner 只会留下一句
// "test failed"，现场信息（原因、退出码）全部丢失 —— 本套件确实出现过这种偶发失败，
// 排查时无从下手。所以这里显式把未捕获异常/未处理拒绝打到 stderr。
//
// 另外：**绝不要往 stdout 写东西**。runner 用 stdout 上的序列化通道回传结果，
// 任何杂散输出都会污染它、并表现成同样「无详情的 test failed」。
process.on("uncaughtException", (error) => {
	process.stderr.write(`[e2e] uncaughtException: ${error && error.stack ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
process.on("unhandledRejection", (reason) => {
	process.stderr.write(`[e2e] unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}\n`);
	process.exitCode = 1;
});

/**
 * 环境变量开关的 stderr 轨迹（`CE_E2E_TRACE=1`）。
 *
 * 用途：子进程被原生层/外部因素直接干掉时，JS 层的异常钩子一个都不会触发，
 * 只有「最后一条轨迹」能说明它死在哪一步。默认关闭，不污染正常输出。
 */
const trace = (message) => {
	if (process.env.CE_E2E_TRACE === "1") process.stderr.write(`[e2e] ${message}\n`);
};

// 退出码是排查「整文件 test failed 且无详情」的关键证据：
// 子进程正常退出（能打印这行）还是被原生层直接干掉（这行不会出现）。
// 只在打开轨迹开关时写，避免污染正常输出。
process.on("exit", (code) => {
	if (process.env.CE_E2E_TRACE === "1") {
		process.stderr.write(`[e2e] exit code=${code} signal=${process.exitCode === code ? "-" : process.exitCode}\n`);
	}
});

/** 内核目录（插件默认也会解析到这里）。 */
/**
 * 内核目录（插件根下的 `node-cheat-engine/`）。
 *
 * 刻意**不写死绝对路径**：从本测试文件的位置推导。
 * 本文件位于 `<插件根>/test/`，内核位于 `<插件根>/node-cheat-engine/`。
 */
// ⚠️ 这里是**目录名**，不是 npm 包名 —— 内核发布叫 `@bingine/cemem`，
// 但仓库里的目录仍然叫 `node-cheat-engine`（git 历史与所有路径引用都依赖它）。
// 改名时**不要**把这一处也换掉，否则测试会找不到内核。
const KERNEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node-cheat-engine");

/** 夹具进程 + 插件 harness，整个文件共用一份（测试按定义顺序串行执行）。 */
let fixture = null;
let info = null;
let harness = null;
let base = 0n;
let tempDir = "";

/**
 * 启动夹具并等它报告 ready。
 *
 * 夹具的 stderr 单独接管道收集：一旦它在报告 ready 之前退出（或一直不报告），
 * 就把退出码与它自己的报错一起抛出来。否则这里只会静默等到超时，
 * 现场信息全丢了 —— 测试脚本自身的可诊断性和被测代码一样重要。
 */
function startFixture() {
	const proc = spawn(process.execPath, [path.join(KERNEL_DIR, "test", "fixture-target.js")], {
		cwd: KERNEL_DIR,
		stdio: ["pipe", "pipe", "pipe"]
	});
	let stderr = "";
	proc.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	let settled = false;
	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			settled = true;
			reject(new Error(`夹具启动超时（30s 内没有报告 ready）。stderr=${stderr || "(空)"}`));
		}, 30_000);
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(value);
		};
		proc.on("error", (error) => settle(reject, error));
		proc.on("exit", (code, signal) => {
			settle(reject, new Error(`夹具在报告 ready 之前退出：code=${code} signal=${signal}。stderr=${stderr || "(空)"}`));
		});
		let buffer = "";
		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const nl = buffer.indexOf("\n");
			if (nl === -1) return;
			try {
				settle(resolve, JSON.parse(buffer.slice(0, nl)));
			} catch (error) {
				settle(reject, new Error(`夹具的 ready 行不是合法 JSON：${buffer.slice(0, 200)}（${error.message}）`));
			}
		});
	});
	/** 发一条指令并等一行回包（夹具用它来改自己的内存）。 */
	const command = (cmd) =>
		new Promise((resolve) => {
			let acc = "";
			const onData = (chunk) => {
				acc += chunk.toString();
				const nl = acc.indexOf("\n");
				if (nl === -1) return;
				proc.stdout.off("data", onData);
				resolve(acc.slice(0, nl));
			};
			proc.stdout.on("data", onData);
			proc.stdin.write(`${cmd}\n`);
		});
	return { proc, ready, command };
}

before(async () => {
	trace("before: 开始");
	assert.ok(fs.existsSync(KERNEL_DIR), `内核目录不存在：${KERNEL_DIR}`);
	trace("before: 内核目录存在");

	// 先把内核（koffi 原生扩展）加载完，再起夹具子进程。
	//
	// 动机：本套件在 `node --test` 下曾以 5~8% 的概率出现「整文件 test failed 且无详情」，
	// 位置恰好在第一个用例（也就是首次 require 内核）期间，且没有任何 JS 异常。
	// 把原生扩展加载与 spawn 子进程这两件事错开，一是消除时序竞争，
	// 二是万一加载真的出问题，它会变成 before 钩子的**明确报错**而不是一句 "test failed"。
	trace("before: 预加载内核（koffi 原生扩展在这里初始化）");
	const kernel = loadKernel({ kernelPath: "" });
	trace(`before: 内核已加载，导出 ${kernel.exports} 项`);

	fixture = startFixture();
	trace(`before: 夹具已 spawn，pid=${fixture.proc.pid}`);
	info = await fixture.ready;
	trace(`before: 夹具已 ready，pid=${info.pid} base=${info.base}`);
	base = BigInt(info.base);
	harness = createHarness({ backend: "self", allowWrite: true, allowLua: true });
	trace("before: harness 已建好（插件已注册 14 个工具）");
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheat-engine-e2e-"));
	trace("before: 完成");
});

after(async () => {
	trace("after: 开始");
	if (harness !== null) await harness.dispose();
	if (fixture !== null) {
		try {
			fixture.proc.stdin.write("quit\n");
		} catch { /* 已退出 */ }
		fixture.proc.kill();
	}
	if (tempDir !== "" && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

/** 便捷：夹具里某个字段的地址。 */
const at = (key) => base + BigInt(info.offsets[key]);

/* ─────────────────────── 目标发现与附加 ─────────────────────── */

test("ce_processes 能列出进程并按名字过滤", async () => {
	trace("test1: 开始");
	const all = await callTool(harness, "ce_processes", { limit: 5 });
	trace(`test1: 全量枚举完成 total=${all.data.total}`);
	assert.ok(all.data.total > 0, "应当至少枚举到一个进程");
	assert.ok(all.data.processes.length <= 5, "limit 应当生效");

	const filtered = await callTool(harness, "ce_processes", { filter: "node", limit: 30 });
	trace(`test1: 过滤完成 count=${filtered.data.count}`);
	const pids = filtered.data.processes.map((p) => p.pid);
	assert.ok(pids.includes(info.pid), `过滤 "node" 应包含夹具 pid ${info.pid}，实际：${pids.join(",")}`);
});

test("ce_processes 的线程数是真实读数（曾恒为 0）", async () => {
	// 缺陷：`ce_processes` 的输出里线程数恒为 `[线程 0]` —— 线程枚举接上了，
	// 但内核读 PROCESSENTRY32W 的字段偏移算错了（把 8 字节的 th32DefaultHeapID
	// 当成 4 字节），于是 cntThreads 读到的是恒 0 的对齐填充。
	const listed = await callTool(harness, "ce_processes", { filter: "node", limit: 40 });
	const fixtureRow = listed.data.processes.find((p) => p.pid === info.pid);
	assert.ok(fixtureRow !== undefined, `应能列出夹具进程 ${info.pid}：\n${listed.text}`);
	assert.ok(
		Number.isInteger(fixtureRow.threads) && fixtureRow.threads > 0,
		`夹具进程的线程数必须 > 0（实际 ${fixtureRow.threads}）`
	);
	assert.match(listed.text, /\[线程 [1-9]\d*\]/, `输出里应出现非 0 的线程数：\n${listed.text}`);

	// 整张表不能"全是 0"
	const alive = listed.data.processes.filter((p) => p.threads > 0);
	assert.ok(alive.length > 0, "至少要有进程报出非 0 线程数");
});

test("ce_attach 按 pid 附加并报告主模块与位数", async () => {
	const attached = await callTool(harness, "ce_attach", { pid: info.pid });
	assert.equal(attached.data.target.pid, info.pid);
	assert.equal(attached.data.target.bitness, 64);
	assert.equal(attached.data.target.backend, "self");
	assert.ok(attached.data.moduleCount > 0, "应当枚举到模块");
	assert.ok(attached.text.includes("主模块"), `输出应包含主模块信息：\n${attached.text}`);
});

test("ce_session status 反映已附加的目标与开关", async () => {
	const status = await callTool(harness, "ce_session", { action: "status" });
	assert.equal(status.data.attached, true);
	assert.equal(status.data.target.pid, info.pid);
	assert.ok(status.text.includes("allowWrite=true"));
	// 内核必须是「真的加载了」：一眼能看出加载来源与导出规模，
	// 而不是显示成「导出 undefined 项」（第一版就漏了 exports 字段，实时调用才发现）
	assert.match(status.text, /导出 \d+ 项/, `状态输出应当给出内核导出项数：\n${status.text}`);
	assert.ok(!status.text.includes("undefined"), `状态输出不该出现 undefined：\n${status.text}`);
	assert.match(status.data.kernelFrom, /node-cheat-engine/);
});

test("ce_modules 给出模块基址，且节点主模块基址是真实的", async () => {
	const modules = await callTool(harness, "ce_modules", { limit: 200 });
	assert.ok(modules.data.modules.length > 0);
	const node = modules.data.modules.find((m) => m.name.toLowerCase() === "node.exe");
	assert.ok(node !== undefined, "应当有 node.exe 模块");
	const nodeBase = BigInt(node.base);
	assert.ok(nodeBase > 0n);
	// 主模块基址必须落在夹具分配区之外（那是 VirtualAlloc 出来的私有内存）
	assert.ok(nodeBase !== base, "模块基址不应等于夹具的 VirtualAlloc 基址");
});

test("ce_regions 能用 near 定位到包含夹具基址的区域", async () => {
	const regions = await callTool(harness, "ce_regions", { near: `0x${base.toString(16)}` });
	assert.equal(regions.data.count, 1, `应当只有一个区域包含夹具基址：\n${regions.text}`);
	const region = regions.data.regions[0];
	assert.equal(region.base, `0x${base.toString(16)}`);
	assert.ok(BigInt(region.size) >= 0x4000n, "夹具区域应当至少有 0x4000 字节");
	assert.ok(region.protectText.includes("R"), `应当可读：${region.protectText}`);
});

/* ─────────────────────── 内存读写 ─────────────────────── */

test("ce_read 读出夹具的已知值（多种类型）", async () => {
	const health = await callTool(harness, "ce_read", { address: `0x${at("health").toString(16)}`, type: "dword" });
	assert.equal(health.data.values[0].value, "1000");

	const money = await callTool(harness, "ce_read", { address: `0x${at("money").toString(16)}`, type: "double" });
	assert.equal(money.data.values[0].value, "1234.5678");

	const big = await callTool(harness, "ce_read", { address: `0x${at("bigCounter").toString(16)}`, type: "qword" });
	assert.equal(big.data.values[0].value, "9007199254740993", "64 位整数不能丢精度");

	const name = await callTool(harness, "ce_read", {
		address: `0x${at("nameString").toString(16)}`,
		type: "string",
		size: 24
	});
	assert.match(name.data.values[0].value, /HELLO CHEAT ENGINE/);

	const wide = await callTool(harness, "ce_read", {
		address: `0x${at("wideString").toString(16)}`,
		type: "unicode",
		size: 32
	});
	assert.match(wide.data.values[0].value, /WideString测试/);

	const signed = await callTool(harness, "ce_read", {
		address: `0x${at("signedValue").toString(16)}`,
		type: "word",
		signed: true
	});
	assert.equal(signed.data.values[0].value, "-1234");
});

test("ce_read 用 count/stride 一次读多个连续值", async () => {
	// filler 区是 512 个连续的 1337（dword）
	const many = await callTool(harness, "ce_read", {
		address: `0x${at("fillerStart").toString(16)}`,
		type: "dword",
		count: 4
	});
	assert.equal(many.data.count, 4);
	for (const row of many.data.values) assert.equal(row.value, "1337");
	// 地址应当按 4 字节递增
	const addrs = many.data.values.map((row) => BigInt(row.address));
	assert.deepEqual(addrs.slice(1), addrs.slice(0, 3).map((a) => a + 4n));
});

test("ce_read 支持模块相对地址与解引用表达式", async () => {
	const modules = await callTool(harness, "ce_modules", { filter: "node.exe" });
	const nodeBase = BigInt(modules.data.modules[0].base);
	// 直接读模块基址处（PE 头 'MZ'）
	const mz = await callTool(harness, "ce_read", { address: "node.exe", type: "aob", size: 2 });
	assert.equal(mz.data.values[0].value, "4D 5A", `模块首字节应当是 MZ：${mz.text}`);
	assert.ok(nodeBase > 0n);

	// pointerToTarget 存着 targetValue 的地址；用 [expr] 解引用应当能读到 4242
	const deref = await callTool(harness, "ce_read", {
		address: `[0x${at("pointerToTarget").toString(16)}]`,
		type: "dword"
	});
	assert.equal(deref.data.values[0].value, "4242", `解引用应当读到 targetValue：${deref.text}`);
});

test("ce_write 写入后回读校验，并可恢复", async () => {
	const address = `0x${at("health").toString(16)}`;
	const written = await callTool(harness, "ce_write", { address, value: "999", type: "dword" });
	assert.equal(written.data.verified, true);
	assert.equal(written.data.before, "E8 03 00 00", "原值应当是 1000 的小端字节");
	assert.equal(written.data.after, "E7 03 00 00", "现值应当是 999 的小端字节");

	const readBack = await callTool(harness, "ce_read", { address, type: "dword" });
	assert.equal(readBack.data.values[0].value, "999");

	// 恢复，避免影响后续用例
	const restored = await callTool(harness, "ce_write", { address, value: "1000", type: "dword" });
	assert.equal(restored.data.verified, true);
});

test("ce_write 支持直接写原始字节（bytes）", async () => {
	const address = `0x${at("fillerStart").toString(16)}`;
	const written = await callTool(harness, "ce_write", { address, bytes: "44 43 42 41" });
	assert.equal(written.data.verified, true);
	const readBack = await callTool(harness, "ce_read", { address, type: "dword", hexadecimal: true });
	assert.equal(readBack.data.values[0].value, "0x41424344", "小端写入 44 43 42 41 应读回 0x41424344");
	// 恢复
	await callTool(harness, "ce_write", { address, value: "1337", type: "dword" });
});

test("ce_write 写不进去时明确失败并给出排查方向（不假装成功）", async () => {
	// 0x10 落在未映射的零页上，内核会抛 Win32 998 (ERROR_NOACCESS)。
	// 这是 ce_write 的负向路径：失败必须**抛错**（注册表据此判定 isError），
	// 而不是返回一个「成功但内容写着失败」的值。
	await assert.rejects(
		() => callTool(harness, "ce_write", { address: "0x10", value: "1", type: "dword" }),
		(error) => {
			assert.match(error.message, /写入 .* 失败/, `应当说明写入失败：${error.message}`);
			assert.match(error.message, /ce_regions/, "应当给出可操作的排查方向");
			assert.match(error.message, /998|访问/, "应当保留内核给出的 Win32 原因");
			return true;
		}
	);

	// 失败不能污染会话：夹具的 health 仍应正常可读
	const health = await callTool(harness, "ce_read", { address: `0x${at("health").toString(16)}`, type: "dword" });
	assert.ok(health.data.values[0].value.length > 0);
});

test("ce_write 的重试参数：一次成功时不产生多余重试，且如实报告尝试次数", async () => {
	const address = `0x${at("fillerStart").toString(16)}`;

	// 显式给重试参数，但写入会一次成功 → attempts 必须是 1、retryCount 必须是 0。
	// 这是「重试机制不能自己制造噪声」的契约：模型要能从输出判断值到底稳不稳。
	const written = await callTool(harness, "ce_write", {
		address,
		value: "2025",
		type: "dword",
		retry: 3,
		retryDelayMs: 10
	});
	assert.equal(written.data.verified, true);
	assert.equal(written.data.attempts, 1, `一次成功时 attempts 应为 1，实际 ${written.data.attempts}`);
	assert.equal(written.data.retryCount, 0, "一次成功时不应有重试记录");
	assert.deepEqual(written.data.retries, [], "重试历史应为空数组");
	// summary 里不该出现「第 N 次尝试成功」这种误导性措辞
	assert.doesNotMatch(
		written.value.summary,
		/次尝试成功/,
		`一次成功不应提到重试：${written.value.summary}`
	);

	// 真正读回来确认落盘
	const readBack = await callTool(harness, "ce_read", { address, type: "dword" });
	assert.equal(readBack.data.values[0].value, "2025");

	// 恢复原值
	await callTool(harness, "ce_write", { address, value: "1337", type: "dword" });
});

test("ce_write 的 retry 参数越界会被安全收敛（不报错、不无限重试）", async () => {
	const address = `0x${at("fillerStart").toString(16)}`;

	// 极大值 → 夹到 20；但这只是一次成功写入，所以仍然只尝试一次。
	// 重点验证「参数不会让工具崩或卡住」。
	const huge = await callTool(harness, "ce_write", {
		address,
		value: "777",
		type: "dword",
		retry: 999,
		retryDelayMs: 999999
	});
	assert.equal(huge.data.verified, true);
	assert.equal(huge.data.attempts, 1, "参数越界不应影响一次成功的写入");

	// retry: 0 表示「只写一次」，语义上仍应成功
	const zero = await callTool(harness, "ce_write", {
		address,
		value: "888",
		type: "dword",
		retry: 0
	});
	assert.equal(zero.data.verified, true);
	assert.equal(zero.data.retryCount, 0);

	await callTool(harness, "ce_write", { address, value: "1337", type: "dword" });
});

/* ─────────────────────── 扫描 ─────────────────────── */

test("ce_scan 首次扫描精确值，结果包含夹具的 targetValue", async () => {
	const first = await callTool(harness, "ce_scan", { action: "first", type: "dword", mode: "exact", value: "4242" });
	assert.ok(first.data.resultCount > 0, "应当命中一些地址");
	assert.ok(first.data.stats.regionsScanned > 0);

	const results = await callTool(harness, "ce_scan", { action: "results", limit: 400 });
	const addresses = results.data.items.map((item) => item.address);
	assert.ok(
		addresses.includes(`0x${at("targetValue").toString(16)}`),
		`结果应当包含 targetValue 的地址 0x${at("targetValue").toString(16)}`
	);
	// results 里带出来的值应当就是 4242
	const target = results.data.items.find((item) => item.address === `0x${at("targetValue").toString(16)}`);
	assert.equal(target.value, "4242");
});

test("ce_scan 再次扫描能缩小结果（未变动筛选）", async () => {
	const before = await callTool(harness, "ce_scan", { action: "status" });
	const beforeCount = before.data.resultCount;

	// 让夹具改自己的几个值（targetValue 不变，所以「未变动」应当保留它）
	await fixture.command("mutate");

	const next = await callTool(harness, "ce_scan", { action: "next", mode: "unchanged" });
	assert.ok(next.data.resultCount >= 1, `「未变动」筛选后应当仍有结果：${next.text}`);
	assert.ok(next.data.resultCount <= beforeCount, "再次扫描不应当让结果变多");

	const results = await callTool(harness, "ce_scan", { action: "results", limit: 400 });
	const addresses = results.data.items.map((item) => item.address);
	assert.ok(
		addresses.includes(`0x${at("targetValue").toString(16)}`),
		"targetValue 没变过，应当留在结果里"
	);
});

test("ce_scan AOB 扫描命中置入的特征码地址", async () => {
	const aob = await callTool(harness, "ce_scan", {
		action: "first",
		type: "aob",
		mode: "exact",
		value: "DE AD BE EF 90 90 11 7A"
	});
	assert.ok(aob.data.resultCount >= 1, "应当命中夹具写下的 AOB");

	const results = await callTool(harness, "ce_scan", { action: "results", limit: 50, readValues: false });
	const addresses = results.data.items.map((item) => item.address);
	assert.ok(
		addresses.includes(`0x${at("aobSignature").toString(16)}`),
		`AOB 应当命中 0x${at("aobSignature").toString(16)}：${addresses.slice(0, 5).join(", ")}`
	);
});

test("ce_scan 支持带通配符的 AOB", async () => {
	const aob = await callTool(harness, "ce_scan", {
		action: "first",
		type: "aob",
		mode: "exact",
		value: "DE AD ?? ?? 90 90"
	});
	assert.ok(aob.data.resultCount >= 1, "通配符 AOB 应当命中");
});

test("ce_scan reset 清空会话，status 如实反映", async () => {
	const reset = await callTool(harness, "ce_scan", { action: "reset" });
	const status = await callTool(harness, "ce_scan", { action: "status" });
	assert.equal(status.data.resultCount, 0);
});

test("ce_scan next 在没有首次扫描时明确报错并给出引导", async () => {
	await assert.rejects(
		() => callTool(harness, "ce_scan", { action: "next", mode: "unchanged" }),
		/没有可继续筛选的扫描会话/
	);
});

/* ─────────────────────── 指针扫描 ─────────────────────── */

test("ce_pointer_scan 找到指向 targetValue 的指针路径，且路径表达式能读回原值", async () => {
	const target = at("targetValue");
	// 故意给一个比真实层数更深的 maxLevel。
	//
	// 内核默认只在「恰好达到 maxLevel 深度」时返回路径：给深了，结果全是深层噪声，
	// 而那条又浅又稳的路径根本不在里面（实测：maxLevel=3 时静态路径被挤出前 200 条）。
	// 工具因此打开内核的 `preferShallow`，**一次扫描**汇总第 1..maxLevel 级的全部路径，
	// 由内核按「静态基址优先、层数浅优先」排序后截断。
	//
	// maxResults 给足，让汇总结果确定性地覆盖到请求深度。
	const scan = await callTool(harness, "ce_pointer_scan", {
		address: `0x${target.toString(16)}`,
		maxLevel: 3,
		maxOffset: 0x1000,
		maxResults: 200
	});
	assert.ok(scan.data.pathCount >= 1, `夹具写了指针链，应当至少找到一条路径：\n${scan.text}`);
	assert.equal(scan.data.requestedMaxLevel, 3);
	// 汇总模式：结果里应当同时出现多个层级的路径，而不是只有最深那一级
	const paths = scan.data.paths ?? [];
	const depths = new Set(paths.map((p) => p.depth).filter((d) => typeof d === "number"));
	assert.ok(
		depths.size > 1,
		`应当汇总出多个层级的路径（早先只返回恰好 maxLevel 那一级）：depths=${[...depths].join(",")}\n${scan.text}`
	);
	assert.ok(
		depths.has(1),
		`应当包含最浅的 1 级路径（夹具的 pointerToTarget 就是 1 级指向 targetValue）：depths=${[...depths].join(",")}\n${scan.text}`
	);
	// 排序规则：**层数浅优先**（越浅越稳），同层内静态基址优先。
	// 因此整体 depth 序列必须是**全局非递减**的，呈现为 1级…→2级…→3级… 的分组顺序。
	const depthSeq = paths.map((p) => p.depth).filter((d) => typeof d === "number");
	assert.ok(
		depthSeq.every((d, i) => i === 0 || d >= depthSeq[i - 1]),
		`结果必须按层数非递减排列：${depthSeq.slice(0, 20).join(",")}\n${scan.text}`
	);
	// 同层内：静态基址必须排在该层的前面
	for (let i = 1; i < paths.length; i += 1) {
		const prev = paths[i - 1];
		const cur = paths[i];
		if (prev.depth !== cur.depth) continue;
		if (cur.module !== undefined && prev.module === undefined) {
			assert.fail(`同层内静态基址应排在动态之前：第 ${i} 项\n${scan.text}`);
		}
	}

	// 用返回的表达式重新解析并读数 —— 这是对路径正确性的真正验证。
	//
	// ⚠️ 这里**不能**取 `paths[0]`（曾经就是这么写的，3 次里挂 2 次）。
	//
	// 理由（实测证据，别改回去）：
	//   排序规则是「层数浅优先」，而夹具的 targetValue 在 VirtualAlloc 出来的私有区里，
	//   那个区不属于任何模块映像，所以**不存在静态的 1 级路径**；于是 `paths[0]` 必然是
	//   「某块动态内存里恰好存着 targetValue 所在页基址」的 1 级路径 ——
	//   夹具算 `base + BigInt(...)`、`writeBigUInt64LE(base…)` 时会在动态内存里留下
	//   值为 base / base+4 / base+8 的裸 8 字节（实测 offset 就是 0x20 / 0x1c / 0x18），
	//   指针映射按值匹配自然会把它们当成指针槽。
	//   这类槽所在的区域**是会被回收的**：实测一次 e2e 扫描期间，夹具进程里有 12 个
	//   256KB（0x40000，正是 V8 的页粒度）PAGE_READWRITE PRIVATE 区域消失
	//   （`ce_regions` 前后对比：base=0x3ce36a80000 size=262144 …），而失败路径的基址
	//   正好落在这些区域里 —— `ce_regions near` 返回「无区域」，读它只能得到
	//   998 ERROR_NOACCESS。这是目标进程自己的 GC 回收页面导致的**结果过期**：
	//   同一表达式在区域还活着时读回的就是 4242，所以既不是序列化问题
	//   （表达式把基址写成了字面量 / 丢了括号层级），也不是排序问题。
	//
	//   因此断言必须落在**夹具特意造出来的那条真实指针链**上：
	//   `[base+pointerToTarget]` → targetValue。它的槽与目标同在夹具的 VirtualAlloc 区里，
	//   永不回收，所以能稳定复现；同时它仍然真正验证了「路径表达式 → ce_read」这条链路。
	const realBase = at("pointerToTarget");
	const realPath = paths.find(
		(p) => p.depth === 1 && BigInt(p.base) === realBase && p.offsets.length === 1 && p.offsets[0] === 0
	);
	assert.ok(
		realPath !== undefined,
		`结果里必须包含夹具真实指针槽（0x${realBase.toString(16)}，1 级、偏移 0）对应的路径：\n${scan.text}`
	);
	assert.equal(realPath.expression, `[0x${realBase.toString(16)}]`, "1 级路径应当序列化成 [基址]");
	const value = await callTool(harness, "ce_read", { address: realPath.expression, type: "dword" });
	assert.equal(value.data.values[0].value, "4242", `沿路径应当读到 targetValue=4242：${value.text}`);
});

test("ce_pointer_scan 在 maxLevel 与真实层数一致时直接命中", async () => {
	const target = at("targetValue");
	const scan = await callTool(harness, "ce_pointer_scan", {
		address: `0x${target.toString(16)}`,
		maxLevel: 2,
		maxOffset: 0x1000,
		maxResults: 10
	});
	assert.ok(scan.data.pathCount >= 1, scan.text);
	assert.equal(scan.data.requestedMaxLevel, 2);
	// 汇总模式返回 ≤ maxLevel 的路径，所以最深不会超过请求值
	assert.ok(scan.data.usedMaxLevel <= 2, `不应超过请求层数：${scan.text}`);
	// 未触及结果上限时不该出现"被截断"的说明
	if (scan.data.pathCount < 10) {
		assert.equal(scan.data.depthNote, undefined, "未被结果上限截断时不该出现说明");
	}
});

/* ─────────────────────── 反汇编 / 汇编 ─────────────────────── */

test("ce_disassemble 能反汇编模块代码并标出跳转目标", async () => {
	const modules = await callTool(harness, "ce_modules", { filter: "node.exe" });
	const nodeBase = BigInt(modules.data.modules[0].base);
	const dis = await callTool(harness, "ce_disassemble", {
		address: `0x${nodeBase.toString(16)}`,
		count: 8
	});
	assert.equal(dis.data.arch, "x64");
	assert.ok(dis.data.count >= 1, "应当反汇编出至少一条指令");
	assert.ok(dis.data.instructions[0].bytes.length > 0);
});

test("ce_assemble 汇编并写入，随后可恢复原字节", async () => {
	const target = base + 0x3000n;
	const address = `0x${target.toString(16)}`;

	// 先确认这块是零
	const before = await callTool(harness, "ce_read", { address, type: "aob", size: 6 });
	assert.equal(before.data.values[0].value, "00 00 00 00 00 00");

	const assembled = await callTool(harness, "ce_assemble", {
		source: "mov eax, 1\nret",
		address,
		write: true
	});
	assert.equal(assembled.data.verified, true, `写入应当校验通过：\n${assembled.text}`);
	assert.equal(assembled.data.bytes, "B8 01 00 00 00 C3");

	// 回读确认真的改到了目标进程
	const after = await callTool(harness, "ce_read", { address, type: "aob", size: 6 });
	assert.equal(after.data.values[0].value, "B8 01 00 00 00 C3");

	// 恢复
	const restored = await callTool(harness, "ce_write", { address, bytes: "00 00 00 00 00 00" });
	assert.equal(restored.data.verified, true);
});

/* ─────────────────────── AutoAssembler ─────────────────────── */

test("ce_auto_assemble check 能预演脚本而不写内存", async () => {
	const target = base + 0x3100n;
	const script = [
		"[ENABLE]",
		`0x${target.toString(16)}:`,
		"mov eax, 11223344",
		"ret",
		"[DISABLE]",
		`0x${target.toString(16)}:`,
		"db 00 00 00 00 00 00"
	].join("\n");
	const check = await callTool(harness, "ce_auto_assemble", { action: "check", script });
	assert.equal(check.data.syntaxCheckOnly, true);
	// 预演不能真的写进去
	const peek = await callTool(harness, "ce_read", { address: `0x${target.toString(16)}`, type: "aob", size: 6 });
	assert.equal(peek.data.values[0].value, "00 00 00 00 00 00", "check 模式不应修改内存");
});

test("ce_auto_assemble enable/disable 写入代码并精确还原", async () => {
	const target = base + 0x3200n;
	const address = `0x${target.toString(16)}`;
	// 立即数显式写 0x…：指令里的裸数字按十进制解析（见下一个用例），
	// 要十六进制必须带 0x 前缀或 h 后缀 —— 这与 CE 帮助文档一致。
	const script = [
		"[ENABLE]",
		`0x${target.toString(16)}:`,
		"mov eax, 0x11223344",
		"ret",
		"[DISABLE]",
		`0x${target.toString(16)}:`,
		"db 00 00 00 00 00 00"
	].join("\n");

	const enabled = await callTool(harness, "ce_auto_assemble", { action: "enable", script });
	assert.ok(enabled.data.bytesWritten > 0, `ENABLE 应当写入字节：\n${enabled.text}`);

	const patched = await callTool(harness, "ce_read", { address, type: "aob", size: 6 });
	assert.equal(patched.data.values[0].value, "B8 44 33 22 11 C3", "代码注入的字节应当可读回");

	const disabled = await callTool(harness, "ce_auto_assemble", { action: "disable", script });

	const restored = await callTool(harness, "ce_read", { address, type: "aob", size: 6 });
	assert.equal(restored.data.values[0].value, "00 00 00 00 00 00", "disable 应当精确还原原字节");
});

test("立即数进制被钉死：指令里裸数字是十进制，db 数据是十六进制", async () => {
	// 这条用例把内核（与 CE 帮助文档一致）的进制规则钉住，防止将来被「顺手改坏」。
	// 裸数字 11223344 十进制 = 0x00AB4130 → 小端 B8 30 41 AB 00
	const decimalScript = [
		"[ENABLE]",
		`0x${(base + 0x3300n).toString(16)}:`,
		"mov eax, 11223344",
		"ret",
		"[DISABLE]",
		`0x${(base + 0x3300n).toString(16)}:`,
		"db 00 00 00 00 00 00"
	].join("\n");
	const enabled = await callTool(harness, "ce_auto_assemble", { action: "enable", script: decimalScript });
	const bytes = await callTool(harness, "ce_read", {
		address: `0x${(base + 0x3300n).toString(16)}`,
		type: "aob",
		size: 6
	});
	assert.equal(
		bytes.data.values[0].value,
		"B8 30 41 AB 00 C3",
		"裸数字是十进制：11223344 → 0x00AB4130（要十六进制请写 0x11223344）"
	);
	await callTool(harness, "ce_auto_assemble", { action: "disable", script: decimalScript });

	// db 数据指令里的裸数字按 CE 习惯当十六进制：89 01 就是两个字节
	const dataScript = [
		"[ENABLE]",
		`0x${(base + 0x3310n).toString(16)}:`,
		"db 89 01",
		"[DISABLE]",
		`0x${(base + 0x3310n).toString(16)}:`,
		"db 00 00"
	].join("\n");
	const dataEnabled = await callTool(harness, "ce_auto_assemble", { action: "enable", script: dataScript });
	const dataBytes = await callTool(harness, "ce_read", {
		address: `0x${(base + 0x3310n).toString(16)}`,
		type: "aob",
		size: 2
	});
	assert.equal(dataBytes.data.values[0].value, "89 01", "db 的裸数字是十六进制");
	await callTool(harness, "ce_auto_assemble", { action: "disable", script: dataScript });
});

test("ce_auto_assemble 的语法错误被抛成带相位与行号的可读错误", async () => {
	const script = ["[ENABLE]", "this_is_not_an_instruction_xyz eax, ebx"].join("\n");
	await assert.rejects(
		() => callTool(harness, "ce_auto_assemble", { action: "check", script }),
		(error) => {
			assert.match(error.message, /阶段：|原因：/, `错误应当包含阶段与原因：${error.message}`);
			return true;
		}
	);
});

test("ce_assemble 把结果反汇编回来，立即数进制不再静默", async () => {
	// 裸数字 11223344 按十进制解析 → 0x00AB4130；写 0x11223344 才是十六进制。
	// 两者都不报错，所以必须把反汇编摊给调用方看，否则这个坑是隐形的。
	const target = base + 0x3400n;
	const address = `0x${target.toString(16)}`;

	const decimal = await callTool(harness, "ce_assemble", { source: "mov eax, 11223344", address });
	assert.equal(decimal.data.bytes, "B8 30 41 AB 00", "裸数字按十进制：11223344 → 0x00AB4130");
	assert.match(decimal.text, /反汇编/, `输出应当包含反汇编核对段：\n${decimal.text}`);
	assert.match(decimal.text, /ab4130/i, `反汇编应当显示十进制解释出的立即数：\n${decimal.text}`);

	const hex = await callTool(harness, "ce_assemble", { source: "mov eax, 0x11223344", address });
	assert.equal(hex.data.bytes, "B8 44 33 22 11", "0x 前缀按十六进制");
	assert.match(hex.text, /11223344/i, `反汇编应当显示十六进制立即数：\n${hex.text}`);
});

/* ─────────────────────── CE Lua ─────────────────────── */

test("ce_lua api 列出已注册的 CE Lua API", async () => {
	const api = await callTool(harness, "ce_lua", { action: "api" });
	assert.ok(api.data.count > 0, `应当注册了 CE Lua API 函数：\n${api.text}`);
	assert.ok(Array.isArray(api.data.functions));
});

test("ce_lua 能执行 Lua 并读取目标进程内存", async () => {
	const simple = await callTool(harness, "ce_lua", { code: "return 1+1" });
	assert.equal(simple.data.returns[0], "2");

	const read = await callTool(harness, "ce_lua", {
		code: `return readInteger(0x${at("health").toString(16)})`
	});
	// 与插件自己的读取结果对比，而不是硬编码 —— 前面的用例用夹具的 mutate 改过 health
	const direct = await callTool(harness, "ce_read", { address: `0x${at("health").toString(16)}`, type: "dword" });
	assert.equal(
		read.data.returns[0],
		direct.data.values[0].value,
		`Lua 读到的值应与 ce_read 一致：\n${read.text}`
	);

	const printing = await callTool(harness, "ce_lua", {
		code: 'print("hello from lua")\nreturn "done"'
	});
	assert.match(printing.text, /hello from lua/);
});

test("ce_lua 的脚本错误被抛成可读的 Lua 报错", async () => {
	await assert.rejects(
		() => callTool(harness, "ce_lua", { code: "return nonexistent_function_xyz()" }),
		/Lua 报错|原因/
	);
});

/* ─────────────────────── .CT 地址表 ─────────────────────── */

test("ce_cheat_table add/list 能解析地址并读出当前值", async () => {
	const list = await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [
			{ description: "生命值", address: `0x${at("health").toString(16)}`, type: "dword" },
			{ description: "金钱", address: `0x${at("money").toString(16)}`, type: "double" }
		]
	});
	assert.equal(list.data.count, 2);

	const shown = await callTool(harness, "ce_cheat_table", { action: "list" });
	const health = shown.data.records.find((row) => row.description === "生命值");
	assert.ok(health !== undefined);
	// 与直接读取对比，而不是硬编码（夹具的 mutate 改过 health）
	const direct = await callTool(harness, "ce_read", { address: `0x${at("health").toString(16)}`, type: "dword" });
	assert.equal(health.value, direct.data.values[0].value, `地址表读出的值应与 ce_read 一致：\n${shown.text}`);
});

test("ce_cheat_table save 写出标准 .CT，再 load 能读回", async () => {
	const ctPath = path.join(tempDir, "roundtrip.ct");
	const saved = await callTool(harness, "ce_cheat_table", { action: "save", path: ctPath });
	assert.ok(fs.existsSync(ctPath), "应当写出文件");

	const xml = fs.readFileSync(ctPath, "utf8");
	assert.match(xml, /<CheatTable/, "应当是 CE 的 .CT XML");
	assert.match(xml, /生命值/, "条目名应当被写进 XML");
	assert.match(xml, /4 Bytes/, "dword 应当写成 CE 的类型名 '4 Bytes'");

	const loaded = await callTool(harness, "ce_cheat_table", { action: "load", path: ctPath });
	assert.equal(loaded.data.count, 2, `读回应当有 2 条记录：\n${loaded.text}`);
});

test("ce_cheat_table add_scan 把扫描结果批量加入地址表", async () => {
	// 先做一次扫描（targetValue=4242 会命中夹具地址）
	const scan = await callTool(harness, "ce_scan", { action: "first", type: "dword", mode: "exact", value: "4242" });
	const added = await callTool(harness, "ce_cheat_table", {
		action: "add_scan",
		count: 3,
		descriptionPrefix: "hit"
	});
	assert.equal(added.data.added, 3);

	const shown = await callTool(harness, "ce_cheat_table", { action: "list" });
	assert.ok(shown.data.count >= 3);
});

test("ce_cheat_table remove 删除指定条目", async () => {
	const shown = await callTool(harness, "ce_cheat_table", { action: "list" });
	const victim = shown.data.records[0];
	const before = shown.data.count;
	const removed = await callTool(harness, "ce_cheat_table", { action: "remove", id: victim.id });
	assert.equal(removed.data.count, before - 1);

	await assert.rejects(
		() => callTool(harness, "ce_cheat_table", { action: "remove", id: 999999 }),
		/没有 id 为 999999 的记录/
	);
});

test("ce_cheat_table：list 显示的 #N 就是 remove 要传的 id（不允许差一位）", async () => {
	// 差一位是**删错条目**级的缺陷：用户照着 list 输出传 id，删掉的却是相邻那条。
	// 内核 `AddressList.add()` 的 id 从 1 开始，而 `remove(number)` 按下标（0 基），
	// 早先工具层直接透传 args.id 就把两者混在了一起。这条用例把它钉死。
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [
			{ description: "id校验-甲", address: `0x${at("health").toString(16)}`, type: "dword" },
			{ description: "id校验-乙", address: `0x${at("money").toString(16)}`, type: "double" },
			{ description: "id校验-丙", address: `0x${at("ammo").toString(16)}`, type: "dword" }
		]
	});

	const listed = await callTool(harness, "ce_cheat_table", { action: "list" });
	const ours = listed.data.records.filter((row) => String(row.description).startsWith("id校验-"));
	assert.equal(ours.length, 3, `应当能看到刚加的三条：\n${listed.text}`);

	// 1) list 文本里的 `#N` 与结构化 data.records[].id 必须一致
	const shownIds = ours.map((row) => {
		const line = listed.text.split("\n").find((text) => text.includes(row.description));
		assert.ok(line !== undefined, `list 文本里应有 ${row.description} 这一行：\n${listed.text}`);
		const parsed = Number(/^#\s*(\d+)/.exec(line.trim())?.[1]);
		assert.equal(Number.isInteger(parsed), true, `行首应是 #N 形式：${line}`);
		return parsed;
	});
	assert.deepEqual(shownIds, ours.map((row) => row.id), "显示的 #N 必须等于 data.records[].id");

	// 2) 拿 list 显示的编号直接 remove，必须**删掉这一条**（而不是相邻那条）
	const victim = ours[1];
	const before = listed.data.count;
	const removed = await callTool(harness, "ce_cheat_table", { action: "remove", id: victim.id });
	assert.equal(removed.data.removedId, victim.id);
	assert.equal(removed.data.count, before - 1);

	const after = await callTool(harness, "ce_cheat_table", { action: "list" });
	const remaining = after.data.records.map((row) => row.description);
	assert.ok(!remaining.includes(victim.description), `被删的应是 ${victim.description}：\n${after.text}`);
	assert.ok(remaining.includes(ours[0].description), "相邻的上一条必须还在");
	assert.ok(remaining.includes(ours[2].description), "相邻的下一条必须还在");
});

test("ce_cheat_table：entries 支持 size（AOB/变长类型需要显式长度）", async () => {
	// schema 早先是 additionalProperties: false 且没有 size 字段，
	// 于是 AOB / 字符串这类**变长类型没法指定字节长度**，直接被参数校验拒掉。
	const added = await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [
			{
				description: "AOB长度校验",
				address: `0x${at("aobSignature").toString(16)}`,
				type: "aob",
				size: 8
			}
		]
	});
	assert.equal(added.data.added, 1, `传 size 必须被接受：\n${added.text}`);

	const listed = await callTool(harness, "ce_cheat_table", { action: "list" });
	const row = listed.data.records.find((item) => item.description === "AOB长度校验");
	assert.ok(row !== undefined);
	// 夹具里那段特征码是 DE AD BE EF 90 90 ?? 7*，前 6 字节是确定的
	assert.match(String(row.value).toUpperCase(), /^DE ?AD ?BE ?EF ?90 ?90/, `读出的字节数组：${row.value}`);
	assert.equal(row.error ?? null, null, `带 size 的 AOB 条目不该报错：${row.error}`);

	// ⚠️ 还要证明 size **真的落进了 .CT 文件**，而且用的是 CE 认的元素名。
	//
	// 为什么必须补这条（独立查证过的证据，`tmp-probe/prove-ct-length.mjs` 可复现）：
	//
	// | 输入 XML 用的是        | 解析出的 stringLength | 写回时用哪个元素  |
	// | `<Length>8</Length>`   | **8**                | `<Length>`       |
	// | `<StringLength>8</…>`  | **未设置**            | `<StringLength>` |
	//
	// 也就是说：写端曾用 `<StringLength>`，而**读端只认 `<Length>`**（CE 本体也只认后者）。
	// 后果是 `add` 出来的 AOB/字符串条目 save→load 之后**长度归零、内容读不出来**，
	// 而且**一声不响**（旧元素被当"未知元素"原样保留，所以文件里看起来"还在"）。
	//
	// 上面几条断言（size 被接受、list 读得出值）**全都通过**，抓不到这个 bug ——
	// 必须看文件内容 + 真正往返一次。这正是"上一轮把 `<StringLength>` 谎报为已修"那一处。
	const ctTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-aob-size-"));
	try {
		const ctPath = path.join(ctTempDir, "aob-size.CT");
		await callTool(harness, "ce_cheat_table", { action: "save", path: ctPath });
		const xml = fs.readFileSync(ctPath, "utf8");
		assert.match(
			xml,
			/<Length>8<\/Length>/,
			`AOB 条目的长度必须写成 CE 认识的 <Length>（不是 <StringLength>）：\n${xml}`
		);
		assert.doesNotMatch(xml, /<StringLength>/, "不得写出 CE 不认识的 <StringLength> 元素");

		// 真正往返一次，并且**从解析结果本身**断言长度还在 ——
		// 只比对 XML 文本不够：`<StringLength>` 会被当未知元素原样保留，
		// 文本"看起来还在"，但读端完全不认它。
		const reloadedPath = path.join(ctTempDir, "aob-size-roundtrip.CT");
		await callTool(harness, "ce_cheat_table", { action: "load", path: ctPath });
		await callTool(harness, "ce_cheat_table", { action: "save", path: reloadedPath });
		const roundTrip = fs.readFileSync(reloadedPath, "utf8");
		assert.match(roundTrip, /<Length>8<\/Length>/, `load→save 往返后长度不能丢：\n${roundTrip}`);
		assert.doesNotMatch(roundTrip, /<StringLength>/, "往返后也不该冒出 <StringLength>");

		const relisted = await callTool(harness, "ce_cheat_table", { action: "list" });
		const relistedRow = relisted.data.records.find((item) => item.description === "AOB长度校验");
		assert.match(
			String(relistedRow.value).toUpperCase(),
			/^DE ?AD ?BE ?EF ?90 ?90/,
			`往返后仍然要读得出字节数组（长度丢了就会读成空/报错）：${relistedRow.value}`
		);
		assert.equal(relistedRow.error ?? null, null, `往返后不该报错：${relistedRow.error}`);
	} finally {
		fs.rmSync(ctTempDir, { recursive: true, force: true });
	}
});

test("ce_cheat_table：相对路径基于**会话工作目录**（不是进程 cwd）", async () => {
	// 实测：插件跑在 DSH 宿主进程里，process.cwd() 是 DSH 的启动目录
	// （例如 C:\Users\<用户>\.dsh\profiles\desktop\），与用户当前会话的工作区无关。
	// 传相对路径 `ce-smoke-test.CT` 会把文件悄悄写到那里去。
	// 基准必须是 exec.agent.session.header.cwd（DSH 里所有文件工具用的都是它）。
	const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-session-cwd-"));
	const exec = { agent: { session: { header: { cwd: sessionDir } } } };
	try {
		const saved = await callTool(harness, "ce_cheat_table", { action: "save", path: "session-relative.CT" }, exec);
		const expected = path.join(sessionDir, "session-relative.CT");
		assert.equal(saved.data.path, expected, `相对路径应解析到会话工作目录：${saved.text}`);
		assert.ok(fs.existsSync(expected), "文件应写在会话工作目录里");

		// 再 load 回来：同一个基准，绝对能读回
		const loaded = await callTool(harness, "ce_cheat_table", { action: "load", path: "session-relative.CT" }, exec);
		assert.equal(loaded.data.path, expected);
		assert.ok(loaded.data.count > 0, `读回的表不该是空的：\n${loaded.text}`);
	} finally {
		fs.rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("目标进程退出后，读内存与扫描明确报错而不是静默返回空结果", async () => {
	// 这是独立复核时发现的真实缺陷：进程死掉后句柄仍然「打开」，
	// 每次都读回 0 字节，于是 ce_read 报「读取 1 处」、ce_scan 报「命中 0 个」——
	// 调用看起来完全正常，模型会以为目标还活着。
	const solo = startFixture();
	const soloInfo = await solo.ready;
	const soloHarness = createHarness();
	try {
		await callTool(soloHarness, "ce_attach", { pid: soloInfo.pid });
		const address = `0x${(BigInt(soloInfo.base) + BigInt(soloInfo.offsets.health)).toString(16)}`;
		const alive = await callTool(soloHarness, "ce_read", { address, type: "dword" });
		assert.equal(alive.data.values[0].value, "1000", "活着时应当能读到夹具的值");

		// 干掉目标进程，等句柄失效
		solo.proc.kill();
		await new Promise((resolve) => setTimeout(resolve, 400));

		await assert.rejects(
			() => callTool(soloHarness, "ce_read", { address, type: "dword" }),
			/都读不到|已经退出|已退出|无效/,
			"目标已退出时 ce_read 必须报错"
		);
		await assert.rejects(
			() => callTool(soloHarness, "ce_scan", { action: "first", type: "dword", value: "1000" }),
			/0 个内存区域|已经退出|已退出|无效/,
			"目标已退出时 ce_scan 必须报错"
		);	} finally {
		await soloHarness.dispose();
		try {
			solo.proc.kill();
		} catch { /* 已退出 */ }
	}
});

test("目标进程退出后，ce_modules / ce_regions / ce_session 都不能退化成空结果", async () => {
	// 独立复核发现的**误导性**表现（比报错更糟）：
	//   · ce_modules / ce_regions 返回「0 个」且**不报错** —— 看起来像"这进程真没模块"；
	//   · ce_session status 依旧报告着那个已经死掉的目标，只有 detach + 重新 attach 才恢复。
	// 根因：Windows 上**进程退出后句柄依然有效**，`process.isOpen` 一直是 true。
	const solo = startFixture();
	const soloInfo = await solo.ready;
	const soloHarness = createHarness();
	try {
		const attached = await callTool(soloHarness, "ce_attach", { pid: soloInfo.pid });
		assert.equal(attached.data.target.pid, soloInfo.pid);

		solo.proc.kill();
		await new Promise((resolve) => setTimeout(resolve, 600));

		for (const [name, args] of [
			["ce_modules", {}],
			["ce_regions", {}],
			["ce_cheat_table", { action: "add_scan" }]
		]) {
			await assert.rejects(
				() => callTool(soloHarness, name, args),
				/已经退出|已退出/,
				`目标已退出时 ${name} 必须明确报"目标进程已退出"，而不是返回空结果`
			);
		}

		// ce_session status 不看 liveness 的话会继续报着死目标 —— 这里必须标出来
		const status = await callTool(soloHarness, "ce_session", { action: "status" });
		assert.equal(status.data.targetAlive, false, `status 必须如实报告目标已退出：\n${status.text}`);
		assert.match(status.text, /已退出/, `文案应明确说明目标已退出：\n${status.text}`);
		assert.equal(status.data.attached, true, "句柄还在时 attached 仍为 true（但已标注退出）");

		// detach 之后必须干净地回到"未附加"
		await callTool(soloHarness, "ce_session", { action: "detach" });
		const after = await callTool(soloHarness, "ce_session", { action: "status" });
		assert.equal(after.data.attached, false, "detach 后不应再报告目标");
	} finally {
		await soloHarness.dispose();
		try {
			solo.proc.kill();
		} catch { /* 已退出 */ }
	}
});

test("ce_auto_assemble action=check：含 alloc 与块标签的脚本能通过，且绝不写内存", async () => {
	// 外部实测发现的**纯误报**：任何含代码块标签（`newmem:` / `mz:` / `"cmd.exe":`）的脚本
	// 在 check 下都报「第 N 行定义了标签 "newmem"，但此前没有任何地址定义行」——
	// 而它建议的写法恰恰就是用户已经写的；纯指令脚本却能过。
	const addrHex = (key) => `0x${at(key).toString(16)}`;
	const before = await callTool(harness, "ce_read", { address: addrHex("health"), type: "dword" });

	const script = [
		"[ENABLE]",
		"alloc(newmem,$1000)",
		"label(returnhere)",
		"label(originalcode)",
		"newmem:",
		"originalcode:",
		"  mov eax, 1234",
		"  jmp returnhere",
		"returnhere:",
		"  nop",
		"[DISABLE]",
		"dealloc(newmem)"
	].join("\n");
	const checked = await callTool(harness, "ce_auto_assemble", { action: "check", script });
	assert.equal(checked.data.syntaxCheckOnly, true);
	assert.match(checked.value.summary, /语法检查通过/, `含 alloc + 块标签的脚本必须能通过 check：\n${checked.text}`);
	assert.ok(checked.data.entryCount > 0, "check 必须真的把指令汇编出来（否则等于没检查）");
	assert.deepEqual(checked.data.allocations, [], "check 不允许真的分配内存");

	// 模块地址定义行（裸模块名 / 带引号 + 十六进制偏移）同样必须能过。
	// 用目标进程里**真实存在**的模块名，避免把"模块不存在"的正当报错当成误报。
	const modules = await callTool(harness, "ce_modules", {});
	const mainModule = modules.data.modules.find((m) => /\.exe$/i.test(m.name)) ?? modules.data.modules[0];
	assert.ok(mainModule !== undefined, "应当能枚举到一个模块");
	const bareName = mainModule.name.replace(/\.(exe|dll)$/i, "");
	for (const line of [`${bareName}+0:`, `"${mainModule.name}"+1000:`]) {
		const one = await callTool(harness, "ce_auto_assemble", {
			action: "check",
			script: `[ENABLE]\n${line}\n  nop\n`
		});
		assert.match(one.value.summary, /语法检查通过/, `模块地址定义行 ${line} 必须能过：\n${one.text}`);
	}
	// 但**真正的错**不能被兜底掩盖
	await assert.rejects(
		() => callTool(harness, "ce_auto_assemble", { action: "check", script: "[ENABLE]\n这个模块根本不存在.exe+0:\n  nop\n" }),
		/无法求值地址表达式/,
		"不存在的模块必须照旧报错"
	);
	// 少一个右引号的畸形表达式也不能被兜底掩盖
	await assert.rejects(
		() => callTool(harness, "ce_auto_assemble", { action: "check", script: "[ENABLE]\n\"这个模块根本不存在.exe+0:\n  nop\n" }),
		/无法求值地址表达式/,
		"畸形表达式必须照旧报错"
	);

	// 关键：check 之后目标内存一个字节都没变
	const after = await callTool(harness, "ce_read", { address: addrHex("health"), type: "dword" });
	assert.equal(after.data.values[0].value, before.data.values[0].value, "check 不允许改动目标内存");
});

test("ce_auto_assemble disable 会确认 dealloc 真的释放了 alloc 的内存", async () => {
	// 缺陷：disable 只报「还原 0 处 / 0 字节」，看不出 alloc 的内存有没有还回去
	// （它其实真的还了，符号也确实消失了）。输出里必须有一句明确确认。
	const script = [
		"[ENABLE]",
		"alloc(freed_block,$1000)",
		"freed_block:",
		"  nop",
		"registersymbol(freed_block)",
		"[DISABLE]",
		"unregistersymbol(freed_block)",
		"dealloc(freed_block)"
	].join("\n");

	const enabled = await callTool(harness, "ce_auto_assemble", { action: "enable", script });
	assert.equal(enabled.data.allocations.length, 1, `ENABLE 应报告一次分配：\n${enabled.text}`);
	const allocatedAddress = enabled.data.allocations[0].address;

	const disabled = await callTool(harness, "ce_auto_assemble", { action: "disable", script });
	assert.deepEqual(disabled.data.deallocated, [
		{ name: "freed_block", address: allocatedAddress, size: 4096 }
	], `disable 必须报告真的释放了哪一块：\n${disabled.text}`);
	assert.match(disabled.value.summary, /已释放 alloc 的内存 1 块/, `摘要要明确确认释放：${disabled.value.summary}`);
	assert.match(disabled.text, /已释放/, `输出里要有释放确认：\n${disabled.text}`);
	assert.equal(disabled.data.allocations.length, 0, "释放后不该再有该分配");

	// 释放掉的内存必须真的还给了系统：用 ce_regions 的 near 看该地址已不在已提交区域里
	await assert.rejects(
		() => callTool(harness, "ce_read", { address: allocatedAddress, type: "dword" }),
		/都读不到|已经退出|无效/,
		"dealloc 之后那块内存不该还能读到"
	);
});

test("附加到高权限进程时先询问用户，且不自动提权", async (t) => {
	if (isElevated()) {
		t.skip("当前 DSH 进程已提权，复现不出「权限不足」");
		return;
	}
	// pid 4 是 System（受保护）：普通权限下 OpenProcess 会以 Win32 5 失败。
	// 这条用例验证的是完整链路：识别权限不足 → 增强成可执行建议 → **先问用户** → 不自动提权。
	const asked = [];
	const userQuestions = {
		ask: async (request) => {
			asked.push(request.questions[0].question);
			return { answers: [{ selected: ["不继续（推荐先用只读/换目标）"] }] };
		}
	};

	// (1) 没有 agent 会话时**不许问、也不许提权**（子代理/PTC 调用拿不到人机交互）
	const silent = createHarness({}, { userQuestions });
	try {
		await assert.rejects(
			() => callTool(silent, "ce_attach", { pid: 4 }),
			/无法向你确认|不作任何提权|不做任何提权|权限不足/
		);
		assert.equal(asked.length, 0, "没有 agent 时不应发起询问");
	} finally {
		await silent.dispose();
	}

	// (2) 有 agent 会话时询问用户，并按用户的选择行事
	const guard = createHarness({}, { userQuestions });
	try {
		let message = "";
		await assert.rejects(
			() => callTool(guard, "ce_attach", { pid: 4 }, { agent: { session: { id: "e2e-elevation" } } }),
			(error) => {
				message = error.message;
				return true;
			}
		);
		assert.equal(asked.length, 1, `应当恰好询问用户一次，实际 ${asked.length} 次`);
		assert.match(asked[0], /更高权限|提权|权限/);
		assert.match(message, /未获同意/, `用户选择不继续时不得提权：\n${message}`);
		assert.match(message, /以管理员身份重启 DSH|native-ce/, `应当给出可执行的下一步：\n${message}`);
	} finally {
		await guard.dispose();
	}
});

/* ───────────────── 远程（提权助手）后端的插件层集成 ───────────────── */

test("backend: 'remote' 时插件工具全部经提权助手执行", async () => {
	// 这一条把「远程后端」从组件层提到**工具层**：证明模型看到的 ce_* 工具在
	// 助手后端下同样可用（读/写回读校验/扫描都在），而不只是后端接口能跑通。
	// 这里不提权启动助手（remoteElevate: false）—— 提权只是换个令牌启动同一个助手。
	const remote = createHarness({ backend: "remote", remoteElevate: false });
	try {
		const attached = await callTool(remote, "ce_attach", { pid: info.pid });
		assert.match(attached.text, /remote-elevated/, `应当报告走的是助手后端：\n${attached.text}`);

		const health = `0x${at("health").toString(16)}`;
		const direct = await callTool(harness, "ce_read", { address: health, type: "dword" });
		const viaHelper = await callTool(remote, "ce_read", { address: health, type: "dword" });
		assert.equal(
			viaHelper.data.values[0].value,
			direct.data.values[0].value,
			"经助手读到的值必须与直连一致"
		);

		// 扫描必须自动走单线程（内核的并行扫描 worker 不走这条通道）
		const scan = await callTool(remote, "ce_scan", { action: "first", type: "dword", mode: "exact", value: "4242" });
		assert.ok(scan.data.resultCount > 0, `经助手扫描应当命中：\n${scan.text}`);
		const results = await callTool(remote, "ce_scan", { action: "results", limit: 400, readValues: false });
		assert.ok(
			results.data.items.map((item) => item.address).includes(`0x${at("targetValue").toString(16)}`),
			"结果里应当有夹具的 targetValue"
		);

		// 写 + 回读校验（写回原值，避免影响后续用例）
		const ammo = `0x${at("ammo").toString(16)}`;
		const before = await callTool(remote, "ce_read", { address: ammo, type: "dword" });
		const written = await callTool(remote, "ce_write", {
			address: ammo,
			value: before.data.values[0].value,
			type: "dword"
		});
		assert.equal(written.data.verified, true, `经助手写入并回读校验应当通过：\n${written.text}`);
	} finally {
		await remote.dispose();
	}
});

/* ─────────────────────── 配置开关与清理 ─────────────────────── */

test("allowWrite=false 时写入与 AutoAssembler 被拒绝，读仍可用", async () => {
	const locked = createHarness({ allowWrite: false, allowLua: true });
	try {
		await callTool(locked, "ce_attach", { pid: info.pid });

		await assert.rejects(
			() => callTool(locked, "ce_write", { address: `0x${at("health").toString(16)}`, value: "1", type: "dword" }),
			/allowWrite: false/
		);
		await assert.rejects(
			() => callTool(locked, "ce_auto_assemble", { action: "enable", script: `[ENABLE]\n0x${base.toString(16)}:\nnop` }),
			/allowWrite: false/
		);

		// 读仍然可用，且值没被改
		const read = await callTool(locked, "ce_read", { address: `0x${at("health").toString(16)}`, type: "dword" });
		assert.equal(read.data.values[0].value, "1100", "health 应当仍是夹具 mutate 后的 1100");
	} finally {
		await locked.dispose();
	}
});

test("allowLua=false 时 ce_lua 被拒绝", async () => {
	const locked = createHarness({ allowLua: false });
	try {
		await callTool(locked, "ce_attach", { pid: info.pid });
		await assert.rejects(
			() => callTool(locked, "ce_lua", { code: "return 1" }),
			/allowLua: false/
		);
	} finally {
		await locked.dispose();
	}
});

test("未附加目标时读写/扫描明确报错并给出引导", async () => {
	const bare = createHarness();
	try {
		await assert.rejects(
			() => callTool(bare, "ce_read", { address: "0x1000", type: "dword" }),
			/还没有附加到任何进程/
		);
		await assert.rejects(
			() => callTool(bare, "ce_scan", { action: "first", type: "dword", value: "1" }),
			/还没有附加到任何进程/
		);
	} finally {
		await bare.dispose();
	}
});

test("ce_session detach 释放句柄，之后读写被引导重新附加", async () => {
	const solo = createHarness();
	try {
		await callTool(solo, "ce_attach", { pid: info.pid });
		const detached = await callTool(solo, "ce_session", { action: "detach" });
		assert.ok(detached.value.summary.includes("已摘下"));

		const status = await callTool(solo, "ce_session", { action: "status" });
		assert.equal(status.data.attached, false);

		await assert.rejects(
			() => callTool(solo, "ce_read", { address: "0x1000", type: "dword" }),
			/还没有附加到任何进程/
		);
	} finally {
		await solo.dispose();
	}
});

test("附加到不存在的 pid 抛出可读错误", async () => {
	const bad = createHarness();
	try {
		await assert.rejects(
			() => callTool(bad, "ce_attach", { pid: 999_999_999 }),
			(error) => {
				assert.ok(error.message.length > 0, "错误信息不能为空");
				return true;
			}
		);
	} finally {
		await bad.dispose();
	}
});

test("ce_attach 按名字也能附加，且 index 越界时报出候选列表", async () => {
	await callTool(harness, "ce_attach", { name: "node", index: 1 });

	await assert.rejects(
		() => callTool(harness, "ce_attach", { name: "node", index: 9999 }),
		/取不到第 9999 个/
	);
	await assert.rejects(
		() => callTool(harness, "ce_attach", { name: "definitely_not_a_real_process_name" }),
		/没有找到名字含/
	);
});
