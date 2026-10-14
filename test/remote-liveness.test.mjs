/**
 * A（最高优先 · 闭环生产路径）：**remote（提权助手）后端**下「目标进程是否还活着」。
 *
 * ## 这条测试为什么必须存在
 *
 * Windows 上**进程退出后句柄依然有效**，所以「目标死了」这件事不会自己浮出来。
 * 判据只有一个：`Process.isProcessAlive()`（内核 `win/process.ts`），而它在
 * `backend.isProcessAlive` **不是函数**时如实返回 `undefined`，会话层把 `undefined`
 * 当「未知」放行 —— 于是目标一退出，远程后端下所有工具都退化成**静默错值**：
 *   · `ce_modules` / `ce_regions` → **静默返回 0 个**，不报错；
 *   · `ce_read` → 报「…但目标进程（…）**仍在运行**」，与事实相反；
 *   · `ce_write` → 被包装成误导性的「权限不足」。
 * 而 self 后端在同样场景下会明确报「目标进程已退出」。
 *
 * ## 为什么必须打在**生产路径**上
 *
 * 本插件的 `lib/elevation-backend.js` **优先用 `dsh-get-admin` 的助手**
 * （本机实测 `shared: true, via: 兄弟目录 …\dsh-get-admin\lib\launch.js`）。
 * 也就是说真正跑在生产环境里的是 get-admin 的 `lib/backend.js` + `lib/helper.js`，
 * 只给本插件自带的 `lib/remote/backend.js` 加方法是**修不到生产路径**的。
 * 所以这里同时验证两件事：
 *   1. `elevationBackendStatus().shared === true`（确认真的走 get-admin）；
 *   2. 在这种配置下 attach → 杀目标 → 四个工具都明确报「目标进程已退出」。
 * 回退路径（get-admin 不存在）由 `remote-liveness-fallback.test.mjs` 单独覆盖。
 *
 * 运行：node --test test/remote-liveness.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

import {
	disposeElevationHelper,
	elevationBackendStatus,
	startElevationBackend
} from "../lib/elevation-backend.js";
import { callTool, createHarness } from "./helpers/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
/** 内核目录（目录名，不是 npm 包名）。 */
const KERNEL_DIR = path.join(ROOT, "node-cheat-engine");
/** 生产路径用的 get-admin 仓库（与 elevation-backend 的默认推断保持一致）。 */
const GET_ADMIN_DIR = process.env.CE_GET_ADMIN_DIR ?? path.join(path.dirname(ROOT), "dsh-get-admin");

let ce = null;

/**
 * 启动内核自带的夹具目标进程并等它报告 ready。
 * @returns {{ proc: import("node:child_process").ChildProcess, ready: Promise<object> }}
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

/** 杀掉夹具并等它真的消失（进程退出与句柄 signaled 之间有竞态）。 */
function killAndWait(proc) {
	try {
		proc.kill();
	} catch {
		/* 已退出 */
	}
}

/** 反复问"还活着吗"直到报 false 或超时；返回最后一次答案。 */
async function pollUntilDead(ask, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let last = undefined;
	for (;;) {
		try {
			last = await ask();
		} catch (error) {
			last = `throw:${error && error.message ? String(error.message).split("\n")[0] : String(error)}`;
		}
		if (last === false) return last;
		if (Date.now() > deadline) return last;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

before(async () => {
	// 清掉可能残留的助手。
	//
	// ⚠️ 这一步不是可选的：如果系统里还跑着一个**改动之前启动的** get-admin 助手，
	// 它没有 `isProcessAlive` 方法，本文件的断言会以极具误导性的方式失败
	// （看起来像"代码没生效"，实际是连到了旧进程）。
	//
	// 刻意**直接按路径**调用 get-admin 的 `disposeHelper()`，而不是经过
	// `elevation-backend.js`：后者会把解析结果缓存下来，导致下面
	// `elevationBackendStatus()` 的断言失去意义。
	const sharedLaunch = path.join(GET_ADMIN_DIR, "lib", "launch.js");
	if (fs.existsSync(sharedLaunch)) {
		try {
			const mod = await import(pathToFileURL(sharedLaunch).href);
			mod.disposeHelper?.();
		} catch {
			/* 清不掉就继续：下面会连一个新启动的助手 */
		}
	}
	disposeElevationHelper();

	ce = (await import(pathToFileURL(path.join(KERNEL_DIR, "dist", "cjs", "index.js")).href)).default
		?? (await import(pathToFileURL(path.join(KERNEL_DIR, "dist", "cjs", "index.js")).href));
});

after(async () => {
	disposeElevationHelper();
});

test("生产路径确认：elevation-backend 确实在用 dsh-get-admin 的助手实现", () => {
	const status = elevationBackendStatus();
	assert.equal(
		status.shared,
		true,
		`生产路径必须解析到 dsh-get-admin（否则下面的断言测的是自带副本，不是真实环境）：${JSON.stringify(status)}`
	);
	assert.match(
		String(status.via),
		/get-admin/,
		`via 应当指向 get-admin（缓存命中时是「已解析（get-admin）」）：${status.via}`
	);
});

test("生产路径 · 后端层：助手暴露 isProcessAlive，且目标退出后如实报 false", async () => {
	const fixture = startFixture();
	const info = await fixture.ready;
	const backend = await startElevationBackend({
		elevate: false,
		// 刻意不复用发现记录里的助手：本用例要测的就是"新启动的助手具备该方法"
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
			"get-admin 的 RemoteMemoryBackend 必须实现 isProcessAlive —— 缺了它上层全部退化成静默错值"
		);

		proc = ce.Process.open(info.pid, { backend });
		assert.equal(proc.isProcessAlive(), true, "夹具还活着时必须报 true");

		killAndWait(fixture.proc);
		const dead = await pollUntilDead(() => proc.isProcessAlive());
		assert.equal(
			dead,
			false,
			`目标退出后必须报 false（而不是 true/undefined）—— 实际 ${JSON.stringify(dead)}`
		);
	} finally {
		try {
			proc?.close();
		} catch {
			/* 忽略 */
		}
		killAndWait(fixture.proc);
		disposeElevationHelper();
	}
});

test("生产路径 · 工具层闭环：目标退出后 ce_modules/ce_regions/ce_read/ce_write 都明确报「目标进程已退出」", async () => {
	const fixture = startFixture();
	const info = await fixture.ready;
	const base = BigInt(info.base);
	const health = `0x${(base + BigInt(info.offsets.health)).toString(16)}`;

	// backend: remote + remoteElevate: false —— 与真实使用唯一的差别只是不弹 UAC
	// （提权只是换个令牌启动同一个助手，链路完全相同）。
	const remote = createHarness({ backend: "remote", remoteElevate: false, allowWrite: true, allowLua: true });
	try {
		const attached = await callTool(remote, "ce_attach", { pid: info.pid });
		assert.match(attached.text, /remote-elevated/, `应当走助手后端：\n${attached.text}`);

		// 先确认活着时一切正常（否则"报错"可能只是别的原因）
		const alive = await callTool(remote, "ce_read", { address: health, type: "dword" });
		assert.equal(alive.data.values[0].value, String(info.values.health), "活着时必须能读到夹具的值");
		const modulesAlive = await callTool(remote, "ce_modules", { limit: 5 });
		assert.ok(modulesAlive.data.total > 0, "活着时应当能枚举到模块");
		const regionsAlive = await callTool(remote, "ce_regions", { limit: 5 });
		assert.ok(regionsAlive.data.total > 0, "活着时应当能枚举到区域");

		// 干掉目标
		killAndWait(fixture.proc);

		// 等"目标已退出"这件事在助手侧稳定可见（进程退出与句柄 signaled 之间有竞态）
		const settled = await pollUntilDead(async () => {
			try {
				await callTool(remote, "ce_modules", { limit: 5 });
				return "still-alive";
			} catch (error) {
				return /已经退出|已退出/.test(String(error && error.message)) ? false : `other:${error.message}`;
			}
		});
		assert.equal(
			settled,
			false,
			`目标退出后 ce_modules 必须明确报「目标进程已退出」而不是静默返回 0 个模块：${JSON.stringify(settled)}`
		);

		// 四个工具都必须给出同一句可执行的结论
		for (const [name, args] of [
			["ce_modules", { limit: 5 }],
			["ce_regions", { limit: 5 }],
			["ce_read", { address: health, type: "dword" }],
			["ce_write", { address: health, value: "1234", type: "dword" }]
		]) {
			await assert.rejects(
				() => callTool(remote, name, args),
				/已经退出|已退出/,
				`远程后端下目标已退出时 ${name} 必须明确报「目标进程已退出」，而不是空结果/误导性错误`
			);
		}

		// 而且**不能**再出现与事实相反的「仍在运行」
		await assert.rejects(
			() => callTool(remote, "ce_read", { address: health, type: "dword" }),
			(error) => {
				assert.doesNotMatch(String(error.message), /仍在运行/, "绝不能报「目标仍在运行」——那与事实相反");
				return true;
			}
		);

		// ce_session 也必须如实标注
		const status = await callTool(remote, "ce_session", { action: "status" });
		assert.equal(status.data.targetAlive, false, `ce_session 必须如实报告 targetAlive=false：\n${status.text}`);
		assert.match(status.text, /已退出/, `ce_session 文案应明确说明目标已退出：\n${status.text}`);
	} finally {
		await remote.dispose();
		killAndWait(fixture.proc);
		disposeElevationHelper();
	}
});
