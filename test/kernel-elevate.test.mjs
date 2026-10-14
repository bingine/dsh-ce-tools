/**
 * `ce_kernel` 的**自动提权**测试。
 *
 * ## 能测什么
 *
 * 真提权会弹 UAC（安全桌面），自动化里不能指望有人去点，所以这里**不测真实 UAC**，
 * 测的是**提权链路的决策与数据通路**：
 *
 *   1. 权限判定用的是**结构化标记**而不是文本匹配
 *      （`elevation.js` 的 isPermissionDenied 不认「需要管理员权限」——
 *      只靠文本会让提权分支永远进不去，这是踩过的 bug）；
 *   2. `kernelElevate: false` 时**绝不**尝试提权（保留原错，走手工命令）；
 *   3. runner 一次性能正确执行「读配置 → 动作 → 写结果文件」，
 *      且只认白名单动作（提权进程不能被当成任意代码执行器）；
 *   4. 结果文件带 nonce 校验，避免读到残留文件。
 *
 * ## 真实 UAC 路径
 *
 * 手工验证过：在未提权环境里调 `ce_kernel { action: "load", confirm: true }`
 * 会真的拉起 UAC；确认后 `sc start` 以管理员权限执行并返回了 1060
 * （服务未安装）—— 这证明提权链路是通的（见 README 的说明）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	ELEVATED_KERNEL_ACTIONS,
	ELEVATION_DECLINE_COOLDOWN_MS,
	clearElevationDeclined,
	decideElevationPath,
	isElevationCoolingDown,
	normalizeKernelAction,
	noteElevationDeclined,
	runElevatedKernelAction
} from "../lib/remote/kernel-elevate.js";
import { KernelAdminRequiredError, requireAdmin } from "../lib/kernel-driver.js";
import { isPermissionDenied } from "../lib/elevation.js";
import { callTool, createHarness } from "./helpers/harness.mjs";

/* ---------- 1. 权限判定必须是结构化标记 ---------- */

test("requireAdmin 抛的是带结构化标记的 KernelAdminRequiredError", () => {
	// 本机未提权；若在管理员下跑，这个用例自然跳过（requireAdmin 不抛）
	let error = null;
	try {
		requireAdmin("测试动作");
	} catch (e) {
		error = e;
	}
	if (error === null) return; // 已提权环境

	assert.equal(error.name, "KernelAdminRequiredError");
	assert.equal(error.adminRequired, true, "必须带 adminRequired 标记（提权分支靠它判断）");
	assert.equal(error.permissionDenied, true, "也要带 permissionDenied 标记（给通用权限处理用）");
	assert.match(error.message, /kernelElevate|UAC|管理员/, "错误里应提到自动提权这条出路");
});

test("回归：isPermissionDenied 不认「需要管理员权限」，所以判断必须用结构化标记", () => {
	// 这条把当初的 bug 钉死：如果哪天有人改成 `if (!isPermissionDenied(e)) throw e`，
	// 提权分支就会静默失效 —— 这个断言让那种改动立刻暴露。
	const error = new KernelAdminRequiredError("加载内核驱动需要管理员权限，而当前进程未提权。");
	assert.equal(
		isPermissionDenied(error),
		false,
		"isPermissionDenied 基于文本，不认这句措辞（所以不能用它做提权判断）"
	);
	assert.equal(error.adminRequired, true, "结构化标记才是可靠依据");
});

/* ---------- 2. kernelElevate 关闭时绝不提权 ---------- */

test("kernelElevate=false 时不尝试提权，保留原始错误（含手工命令）", async () => {
	const harness = createHarness({ kernelElevate: false });
	try {
		await assert.rejects(
			() => callTool(harness, "ce_kernel", { action: "load", confirm: true }),
			(error) => {
				// 关键：错误必须落在**"没提权/不能提权"**这一类，
				// 而不是"提权执行失败/超时"那一类。
				//
				// 注意消息可能是两种之一，都算正确：
				//   a) 「需要管理员权限…」（走到了内核驱动那一步才发现权限不足）；
				//   b) 「没有可用的 agent 会话，无法向你确认是否提权…」（被**同意闸门**拦下）。
				//
				// (b) 是后来的正确行为：同意闸门现在**无条件**先跑（早先在没有
				// `userQuestions` 服务时会整段跳过，直接进提权分支 —— 那是缺陷）。
				// 测试桩没有 agent，所以闸门 fail-closed、给出 (b)。
				assert.match(error.message, /需要管理员权限|无法向你确认是否提权/, "应保留原始/权限类错误");
				assert.doesNotMatch(error.message, /提权执行 .* 失败/, "不应出现提权尝试的痕迹");
				assert.doesNotMatch(error.message, /UAC 弹窗|Start-Process/, "不应发起 UAC");
				return true;
			}
		);
	} finally {
		await harness.dispose();
	}
});

/* ---------- 3. 提权执行器的白名单 ---------- */

test("提权执行器只接受白名单动作（不能被当成任意代码执行器）", async () => {
	assert.deepEqual([...ELEVATED_KERNEL_ACTIONS].sort(), ["install", "load", "unload"]);
	// 注意：**不要**把 "INSTALL "（带空格）放进这个列表 ——
	// trim 之后它是合法动作，会真的去弹 UAC（早先就这么把测试跑成 90 秒）。
	// 大小写/空格的处理由纯函数用例覆盖。
	for (const bad of ["format", "../../evil", "shell", "", null, undefined, "install2"]) {
		await assert.rejects(
			() => runElevatedKernelAction({ action: bad }),
			/不允许提权执行的动作/,
			`动作 "${bad}" 必须被拒绝`
		);
	}
});

test("动作名大小写不敏感（纯函数，不弹 UAC）", () => {
	assert.equal(normalizeKernelAction("LOAD"), "load");
	assert.equal(normalizeKernelAction("install"), "install");
	assert.equal(normalizeKernelAction(" Unload "), "unload");
	assert.throws(() => normalizeKernelAction("evil"), /不允许提权执行的动作/);
});

test("回归：UAC 启动失败后**不再兜底弹第二次**（注入启动器，不弹真 UAC）", async () => {
	// 背景：早先的实现在「启动提权助手失败」后会落到一次性执行器，
	// 于是同一个动作连弹两次 UAC —— 被用户直接感知为「一直弹，很烦」。
	// 现在改成直接抛出可执行的错误。
	//
	// 用注入的启动器模拟"UAC 被拒"，这样既能精确验证调用次数，又不必真弹窗
	// （早先这条用例真的弹 UAC，单条 40+ 秒）。
	clearElevationDeclined();
	let launchCalls = 0;
	let thrown = null;
	try {
		await runElevatedKernelAction({
			action: "load",
			preferPersistentHelper: true,
			launchHelper: async () => {
				launchCalls += 1;
				throw new Error("提权助手没有就绪：可能 UAC 被取消、被策略拦截，或助手启动失败。");
			}
		});
	} catch (error) {
		thrown = error;
	}
	assert.equal(launchCalls, 1, `只应尝试启动一次，实际 ${launchCalls} 次（不能兜底弹第二次）`);
	assert.ok(thrown !== null, "应当抛出错误");
	assert.match(thrown.message, /无法以管理员权限执行 load/, `应给出结论：${thrown.message}`);
	assert.match(thrown.message, /UAC 被拒绝/, "应点明最可能的原因");
	assert.match(thrown.message, /管理员身份重启/, "应给出替代做法");
});

test("启动器失败会进入冷却期，之后的调用不再尝试启动", async () => {
	clearElevationDeclined();
	let launchCalls = 0;
	const failingLauncher = async () => {
		launchCalls += 1;
		throw new Error("提权助手没有就绪：可能 UAC 被取消。");
	};
	// 第一次：失败 → 记录冷却
	await assert.rejects(
		() => runElevatedKernelAction({ action: "load", launchHelper: failingLauncher }),
		/无法以管理员权限执行/
	);
	assert.equal(launchCalls, 1);
	assert.equal(isElevationCoolingDown(), true, "启动失败后应进入冷却期");

	// 第二次：冷却期内，**连启动器都不该被调用**
	await assert.rejects(
		() => runElevatedKernelAction({ action: "load", launchHelper: failingLauncher }),
		/不会再自动弹窗/
	);
	assert.equal(launchCalls, 1, "冷却期内不应再次尝试启动（即不再弹 UAC）");
	clearElevationDeclined();
});

test("提权路径决策是纯函数（覆盖全部 4 种组合，不弹 UAC）", () => {
	// 这条替代了早先"直接调用整个 runElevatedKernelAction"的写法 ——
	// 那种写法每次跑都会真的弹 UAC（单条用例 90 秒），既慢又打扰人。
	assert.equal(
		decideElevationPath({ hasElevatedHelper: true }),
		"reuse",
		"已有提权助手 → 复用（不再弹 UAC）"
	);
	assert.equal(
		decideElevationPath({ hasElevatedHelper: false }),
		"launch-persistent",
		"无助手 → 启动常驻助手（弹一次，之后复用）"
	);
	assert.equal(
		decideElevationPath({ hasElevatedHelper: false, preferPersistentHelper: false }),
		"oneshot",
		"显式不要常驻 → 一次性执行器"
	);
	assert.equal(
		decideElevationPath({ hasElevatedHelper: true, reuseHelper: false }),
		"launch-persistent",
		"禁用复用 → 走常驻助手路径"
	);
});

/* ---------- 4. runner 的数据通路 ---------- */

test("runner 能在不进 UAC 的情况下跑通「读配置 → 执行 → 写结果文件」", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-kernel-elevate-"));
	const configFile = path.join(dir, "cfg.json");
	const resultFile = path.join(dir, "result.json");
	const nonce = "deadbeefcafe";

	try {
		fs.writeFileSync(
			configFile,
			JSON.stringify({ nonce, resultFile, action: "load" }),
			"utf8"
		);
		const run = spawnSync(
			process.execPath,
			[path.join(import.meta.dirname, "..", "lib", "remote", "kernel-elevate-runner.js"), `--config=${configFile}`],
			{ encoding: "utf8", timeout: 60_000 }
		);
		assert.equal(run.status, 0, `runner 应正常退出：${run.stderr ?? ""}`);
		assert.equal(fs.existsSync(resultFile), true, "runner 必须写出结果文件");

		const payload = JSON.parse(fs.readFileSync(resultFile, "utf8"));
		assert.equal(payload.nonce, nonce, "nonce 必须回传（父进程据此确认是本次结果）");
		assert.equal(typeof payload.ok, "boolean");
		assert.ok(Array.isArray(payload.log));
		// 本机未提权 → runner 里的 loadDriver 会因权限失败，这才是预期
		if (payload.ok === false) {
			assert.match(String(payload.error), /管理员权限/, `应报告权限原因：${payload.error}`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner 拒绝白名单外的动作，并把拒绝写进结果文件", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-kernel-elevate2-"));
	const configFile = path.join(dir, "cfg.json");
	const resultFile = path.join(dir, "result.json");
	try {
		fs.writeFileSync(
			configFile,
			JSON.stringify({ nonce: "x1", resultFile, action: "rm -rf /" }),
			"utf8"
		);
		const run = spawnSync(
			process.execPath,
			[path.join(import.meta.dirname, "..", "lib", "remote", "kernel-elevate-runner.js"), `--config=${configFile}`],
			{ encoding: "utf8", timeout: 60_000 }
		);
		assert.equal(run.status, 0);
		const payload = JSON.parse(fs.readFileSync(resultFile, "utf8"));
		assert.equal(payload.ok, false, "非法动作必须是失败结果");
		assert.match(String(payload.error), /不允许的动作/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner 缺配置文件时不崩（只是无法回传结果）", () => {
	const run = spawnSync(
		process.execPath,
		[path.join(import.meta.dirname, "..", "lib", "remote", "kernel-elevate-runner.js")],
		{ encoding: "utf8", timeout: 30_000 }
	);
	assert.notEqual(run.status, 0, "没有配置文件应以非零码退出");
	assert.doesNotMatch(run.stderr ?? "", /Unhandled|uncaught/, "不应抛未捕获异常");
});

/* ---------- 5. 不重复弹 UAC（用户体验的硬约束） ---------- */

/* ---------- 6. 拒绝后的冷却（避免"一直弹"） ---------- */

test("回归：拒绝 UAC 后进入冷却期，不再反复弹窗（且立刻返回，不空等超时）", async () => {
	// 用户点「否」之后最糟的两件事：① 下一次动作又弹一次；② 当前这次干等 90 秒。
	// 这条用例把两件都钉死。
	clearElevationDeclined();
	assert.equal(isElevationCoolingDown(), false, "初始不应处于冷却期");

	noteElevationDeclined();
	assert.equal(isElevationCoolingDown(), true, "刚拒绝后应处于冷却期");

	const started = Date.now();
	await assert.rejects(
		() => runElevatedKernelAction({ action: "load", timeoutMs: 30_000 }),
		(error) => {
			assert.match(error.message, /不会再自动弹窗|冷却/, "应说明进入冷却期");
			assert.match(error.message, /force: true/, "应告诉用户怎么立刻重试");
			assert.match(error.message, /管理员身份重启/, "应给出替代做法");
			return true;
		}
	);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 1500, `冷却期应立刻返回，实际耗时 ${elapsed}ms`);

	assert.equal(
		isElevationCoolingDown(Date.now() + ELEVATION_DECLINE_COOLDOWN_MS + 1),
		false,
		"冷却过期后应恢复"
	);
	clearElevationDeclined();
	assert.equal(isElevationCoolingDown(), false, "显式清除后应恢复");
});

test("冷却时长为 120 秒，且边界判定精确", () => {
	assert.equal(ELEVATION_DECLINE_COOLDOWN_MS, 120_000, "太长会导致无法及时重试");
	noteElevationDeclined(1000);
	assert.equal(isElevationCoolingDown(1000 + ELEVATION_DECLINE_COOLDOWN_MS - 1), true, "差 1ms 仍在冷却");
	assert.equal(isElevationCoolingDown(1000 + ELEVATION_DECLINE_COOLDOWN_MS), false, "到点即恢复");
	clearElevationDeclined();
});

test("拒绝记录跨进程/跨重启生效（否则 DSH 一重启就又弹）", () => {
	clearElevationDeclined();
	try {
		// 子进程里记一次拒绝 —— 模拟"用户点了否，然后 DSH 重启"
		const record = spawnSync(
			process.execPath,
			[
				"-e",
				"import('./lib/remote/kernel-elevate.js').then((m) => { m.clearElevationDeclined(); m.noteElevationDeclined(); process.exit(m.isElevationCoolingDown() ? 0 : 1); });"
			],
			{ encoding: "utf8", cwd: path.join(import.meta.dirname, ".."), timeout: 30_000 }
		);
		assert.equal(record.status, 0, `子进程记录失败：${record.stderr ?? ""}`);

		// 本进程（相当于新启动的 DSH）应当读到那份拒绝记录
		assert.equal(
			isElevationCoolingDown(),
			true,
			"新进程必须能读到拒绝记录，否则重启后又会弹 UAC"
		);
	} finally {
		clearElevationDeclined();
	}
	assert.equal(isElevationCoolingDown(), false, "清理后必须恢复");
});

test("clearElevationDeclined 同时清掉进程内与落盘记录", () => {
	clearElevationDeclined();
	noteElevationDeclined();
	assert.equal(isElevationCoolingDown(), true);
	clearElevationDeclined();
	assert.equal(isElevationCoolingDown(), false, "清理后进程内应恢复");
	// 再换个子进程确认落盘记录也没了
	const check = spawnSync(
		process.execPath,
		[
			"-e",
			"import('./lib/remote/kernel-elevate.js').then((m) => process.exit(m.isElevationCoolingDown() ? 1 : 0));"
		],
		{ encoding: "utf8", cwd: path.join(import.meta.dirname, ".."), timeout: 30_000 }
	);
	assert.equal(check.status, 0, "落盘记录也应被清掉");
});
