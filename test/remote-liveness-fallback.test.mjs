/**
 * A（回退分支）：`CE_GET_ADMIN_DIR` 指向不存在的目录时，提权后端必须回退到
 * **本插件自带**的 `lib/remote/{launch,backend,helper}.js`，且那条路上的
 * 「目标进程是否还活着」同样要成立。
 *
 * ## 为什么单独一个文件
 *
 * `elevation-backend.js` 会把**成功**的解析结果缓存起来，所以"回退"与"共享"
 * 两条路无法在同一个进程里先后验证 —— 先跑共享再跑回退时，回退分支会被缓存短路。
 * `node --test` 每个测试文件跑在**独立进程**里，于是这里把环境变量设在文件顶部，
 * 整个文件都只在回退路径下运行。
 *
 * 运行：node --test test/remote-liveness-fallback.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

// ⚠️ 必须在**任何解析发生之前**设置：整个文件强制走回退实现。
// 这个环境变量正是 elevation-backend 为"让回退分支可被实测"而留的开关。
process.env.CE_GET_ADMIN_DIR = path.join(os.tmpdir(), `no-such-get-admin-${Date.now()}`);

import {
	disposeElevationHelper,
	elevationBackendStatus,
	startElevationBackend
} from "../lib/elevation-backend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const KERNEL_DIR = path.join(ROOT, "node-cheat-engine");

let ce = null;

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
			if (settled) return;
			settled = true;
			reject(new Error(`夹具启动超时。stderr=${stderr || "(空)"}`));
		}, 30_000);
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(value);
		};
		proc.on("error", (error) => settle(reject, error));
		proc.on("exit", (code, signal) =>
			settle(reject, new Error(`夹具在报告 ready 前退出：code=${code} signal=${signal}。stderr=${stderr || "(空)"}`))
		);
		let buffer = "";
		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const nl = buffer.indexOf("\n");
			if (nl === -1) return;
			try {
				settle(resolve, JSON.parse(buffer.slice(0, nl)));
			} catch (error) {
				settle(reject, error);
			}
		});
	});
	return { proc, ready };
}

before(async () => {
	disposeElevationHelper();
	ce = (await import(pathToFileURL(path.join(KERNEL_DIR, "dist", "cjs", "index.js")).href)).default
		?? (await import(pathToFileURL(path.join(KERNEL_DIR, "dist", "cjs", "index.js")).href));
});

after(() => {
	disposeElevationHelper();
});

test("回退分支：CE_GET_ADMIN_DIR 指向不存在的目录时确实回退到自带实现", () => {
	const status = elevationBackendStatus();
	assert.equal(
		status.shared,
		false,
		`CE_GET_ADMIN_DIR 指向不存在的目录时必须回退，实际：${JSON.stringify(status)}`
	);
	assert.ok(status.error !== null && status.error !== "", "回退原因必须如实记录，便于诊断");
});

test("回退分支：自带 remote 后端同样暴露 isProcessAlive，目标退出后报 false", async () => {
	const fixture = startFixture();
	const info = await fixture.ready;
	const backend = await startElevationBackend({
		elevate: false,
		discoverExisting: false,
		kernelPath: KERNEL_DIR,
		timeoutMs: 30_000,
		launchTimeoutMs: 30_000
	});
	let proc = null;
	try {
		assert.equal(
			typeof backend.isProcessAlive,
			"function",
			"自带 lib/remote/backend.js 也必须实现 isProcessAlive（回退环境同样是生产环境）"
		);
		proc = ce.Process.open(info.pid, { backend });
		assert.equal(proc.isProcessAlive(), true, "夹具还活着时必须报 true");

		try {
			fixture.proc.kill();
		} catch {
			/* 已退出 */
		}
		const deadline = Date.now() + 15_000;
		let dead = undefined;
		for (;;) {
			dead = proc.isProcessAlive();
			if (dead === false || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		assert.equal(dead, false, `目标退出后必须报 false —— 实际 ${JSON.stringify(dead)}`);
	} finally {
		try {
			proc?.close();
		} catch {
			/* 忽略 */
		}
		try {
			fixture.proc.kill();
		} catch {
			/* 已退出 */
		}
		disposeElevationHelper();
	}
});

/**
 * 桩内核：只实现 `Process.open`，用 pid 选择要构造的分支。
 *
 * pid 1001 = 后端**没有** `isProcessAlive`（助手会如实回 `undefined`）。
 */
function makeStubKernel() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-stub-kernel-"));
	fs.writeFileSync(
		path.join(dir, "index.js"),
		[
			"module.exports = {",
			"  Process: {",
			"    open(pid) {",
			"      return { pid, name: 'stub-' + pid, isOpen: true, backend: { name: 'stub-no-liveness' },",
			"        backendHandle: { id: 1 }, close() { this.isOpen = false; } };",
			"    }",
			"  }",
			"};",
			""
		].join("\n"),
		"utf8"
	);
	return dir;
}

test("回退分支：「后端判断不了」必须原样传成 undefined，不能被通道改写成 null", async () => {
	// ⚠️ 这条钉的是一个**被通道抹掉的语义**。
	//
	// 助手在后端不支持 `isProcessAlive` 时如实回 `undefined`（= 我判断不了），
	// 而消费方（内核 `Process.isProcessAlive` / 会话层 `isTargetAlive`）用**严格比较**
	// 区分 `false`（已退出）与 `undefined`（未知）。
	//
	// `lib/remote/worker.js` 里曾经写着 `result: header.result ?? null`，把缺键的
	// `undefined` 改写成 `null` —— `null` 两个分支都不命中，于是目标真的没了的时候
	// 又会退回旧行为，报出与事实相反的「目标进程**仍在运行**」。
	// 这是 `undefined` 与 `null` 必须可区分的**唯一**理由，所以必须钉住。
	const stubDir = makeStubKernel();
	let backend = null;
	try {
		backend = await startElevationBackend({
			elevate: false,
			discoverExisting: false,
			kernelPath: stubDir,
			timeoutMs: 30_000,
			launchTimeoutMs: 30_000
		});
		const handle = backend.openProcess(1001);
		assert.equal(
			backend.isProcessAlive(handle),
			undefined,
			"后端判断不了时必须原样回 undefined（未知），不能被通道改写成 null 或猜成 false"
		);
	} finally {
		disposeElevationHelper();
		fs.rmSync(stubDir, { recursive: true, force: true });
	}
});
