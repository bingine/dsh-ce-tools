/**
 * 提权能力的**来源与一致性**测试。
 *
 * ## 为什么需要它
 *
 * 提权原本在 cheat-engine 与 get-admin 里**各有一份** `elevation.js`。
 * 重复实现的代价很快就出现了：两份的 `permissionDeniedAdvice` 文案开始漂移，
 * 其中一份还把"用助手提权"写成不可行 —— 用户照着做会白白重启一次会话。
 *
 * 现在改成「get-admin 为权威 + 本插件 `elevation-impl.js` 作回退」，
 * 所以这条测试要钉住两件事：
 *   1. 权威那份的建议里**必须**包含助手提权这条可行通道（防止文案再退回旧版）；
 *   2. 回退实现与权威实现在**关键行为**上一致（否则"回退"就成了另一套语义）。
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import * as forwarded from "../lib/elevation.js";
import * as impl from "../lib/elevation-impl.js";

/** 找 get-admin 的 elevation.js（真权威实现）。 */
function loadSharedElevation() {
	const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
	const candidates = [
		path.join(path.dirname(here), "..", "dsh-get-admin", "lib", "elevation.js"),
		path.join(here, "..", "node_modules", "dsh-get-admin", "lib", "elevation.js")
	];
	const require = createRequire(import.meta.url);
	for (const candidate of candidates) {
		try {
			return { module: require(candidate), path: candidate };
		} catch {
			/* 继续找 */
		}
	}
	return null;
}

const shared = loadSharedElevation();

test("对外入口导出完整接口（转发层不能漏方法）", () => {
	for (const name of [
		"isElevated",
		"resetElevationCache",
		"isPermissionDenied",
		"permissionDeniedAdvice",
		"enrichPermissionError",
		"askToElevate"
	]) {
		assert.equal(typeof forwarded[name], "function", `elevation.js 应当导出 ${name}`);
	}
});

test("权威实现（get-admin）的建议里必须包含「用助手提权」这条可行通道", (t) => {
	if (shared === null) {
		t.skip("解析不到 dsh-get-admin 的 elevation.js");
		return;
	}
	// 未提权的前提下生成建议
	//
	// ⚠️ 必须**显式清掉** `GET_ADMIN_NO_ELEVATE`：UAC 被禁用时建议会换成
	// 「这条路走不通」的版本（那才是正确行为），而这条用例要验的是
	// 「UAC 允许时必须推荐助手通道」。前提不声明清楚，用例之间就会互相污染 ——
	// 环境变量是进程级的，后跑的用例会看到前一个用例留下的值。
	const before = process.env.GET_ADMIN_NO_ELEVATE;
	delete process.env.GET_ADMIN_NO_ELEVATE;
	try {
		const advice = shared.module.permissionDeniedAdvice({ elevated: false });
		const text = advice.join("\n");

		// 这条是本次修复的核心：助手提权是**真实支持的**通道，
		// 旧文案只说"重启 DSH / 用 ceserver"，属于误导。
		assert.match(text, /助手/, "建议里必须提到「提权助手」这条通道");
		assert.match(text, /remoteElevate|get_admin/, "应当说明怎么启用（配置项或工具）");
		assert.match(text, /不需要重启|不.*中断/, "应当说明这条路不需要重启会话");

		// 另外两条兜底通道也应当保留
		assert.match(text, /重启/, "应当保留「以管理员重启 DSH」这条兜底");
		assert.match(text, /ceserver/, "应当保留 ceserver 这条兜底");
	} finally {
		if (before !== undefined) process.env.GET_ADMIN_NO_ELEVATE = before;
	}
});

test("转发层实际取到的是权威实现（而不是偷偷用了本地那份）", (t) => {
	if (shared === null) {
		t.skip("解析不到 dsh-get-admin 的 elevation.js");
		return;
	}
	// 用同一输入比对：转发层的结果应当与权威实现**逐行相同**
	const context = { elevated: false, target: { pid: 4321, name: "game.exe" }, action: "ce_read" };
	const viaForward = forwarded.permissionDeniedAdvice(context);
	const direct = shared.module.permissionDeniedAdvice(context);
	assert.deepEqual(viaForward, direct, "转发层应当与权威实现给出完全一致的建议");

	// 本地回退那份**故意**与权威实现不同（文案未更新），借此确认转发层没走回退。
	// 如果哪天两者一致了，说明回退也同步更新过，这条断言可以改成"允许一致"。
	const local = impl.permissionDeniedAdvice(context);
	assert.notDeepEqual(viaForward, local, "转发层不应走本地回退实现（回退文案尚未更新）");
});

test("回退实现与权威实现在**权限判定**上一致（这是最要紧的行为）", (t) => {
	if (shared === null) {
		t.skip("解析不到 dsh-get-admin 的 elevation.js");
		return;
	}
	// 判定逻辑若不一致，同一错误在一处被当作权限问题、在另一处不是 —— 后果很难查。
	const cases = [
		"OpenProcess 失败：Win32 错误 5",
		"拒绝访问。",
		"Access is denied",
		"0x80070005",
		"EPERM: operation not permitted",
		"EACCES",
		// 以下都不该被判成权限问题（避免误报）
		"Win32 错误 50",
		"Win32 错误 500",
		"内存位置访问无效 (Win32 错误 998)",
		"找不到模块",
		""
	];
	for (const text of cases) {
		const a = shared.module.isPermissionDenied(new Error(text));
		const b = impl.isPermissionDenied(new Error(text));
		assert.equal(b, a, `两份实现对「${text || "(空)"}」的判定应当一致（权威=${a}，回退=${b}）`);
	}
});

test("回退实现与权威实现在**错误增强**上一致", (t) => {
	if (shared === null) {
		t.skip("解析不到 dsh-get-admin 的 elevation.js");
		return;
	}
	const denied = new Error("OpenProcess 失败：Win32 错误 5");
	const context = { target: { pid: 99, name: "t.exe" }, action: "ce_attach" };

	const a = shared.module.enrichPermissionError(denied, context);
	const b = impl.enrichPermissionError(denied, context);
	assert.equal(a.permissionDenied, true);
	assert.equal(b.permissionDenied, true);
	assert.equal(a.permissionDenied, b.permissionDenied, "两份实现都应当标记 permissionDenied");
	assert.ok(a.cause === denied && b.cause === denied, "都应当保留 cause");

	// 非权限错误必须**原样返回**，不能被说成权限问题
	const other = new Error("内存位置访问无效 (Win32 错误 998)");
	assert.equal(shared.module.enrichPermissionError(other, context), other);
	assert.equal(impl.enrichPermissionError(other, context), other);
});

test("askToElevate 拿不到人机交互时一律拒绝（绝不默默提权）", async (t) => {
	if (shared === null) {
		t.skip("解析不到 dsh-get-admin 的 elevation.js");
		return;
	}
	// 三种"拿不到交互能力"的情形，都必须是 approved=false
	const noAgent = await shared.module.askToElevate({ ask: async () => ({}) }, {}, {});
	assert.equal(noAgent.approved, false, "没有 agent 时应当拒绝");

	const noService = await shared.module.askToElevate(undefined, { agent: {} }, {});
	assert.equal(noService.approved, false, "没有 userQuestions 服务时应当拒绝");

	const emptyExec = await shared.module.askToElevate(undefined, undefined, {});
	assert.equal(emptyExec.approved, false, "连 exec 都没有时应当拒绝");

	// 拒绝时必须把"为什么"说清楚，而不是一句无信息的失败
	for (const r of [noAgent, noService, emptyExec]) {
		assert.ok(r.reason.length > 20, "拒绝理由应当有实质内容");
		assert.match(r.reason, /不做任何提权|无法/, "拒绝理由应当说明未做提权动作");
	}
});

test("askToElevate：用户选择「不继续」时不批准，选择继续时批准", async (t) => {
	if (shared === null) {
		t.skip("解析不到 dsh-get-admin 的 elevation.js");
		return;
	}
	const makeQuestions = (choice) => ({
		ask: async () => ({ answers: [{ selected: [choice] }] })
	});
	const exec = { agent: {}, signal: undefined };

	const declined = await shared.module.askToElevate(
		makeQuestions("不继续（推荐先用只读/换目标）"),
		exec,
		{}
	);
	assert.equal(declined.approved, false, "选择不继续时不应批准");
	assert.match(declined.reason, /未获同意/);

	const approved = await shared.module.askToElevate(makeQuestions("同意提权（弹 UAC 确认）"), exec, {});
	assert.equal(approved.approved, true, "选择同意时应当批准");
	assert.match(approved.reason, /已获同意/);

	// 用户没作答（answers 缺失）时按「不继续」处理，绝不能默认批准
	const silent = await shared.module.askToElevate({ ask: async () => ({}) }, exec, {});
	assert.equal(silent.approved, false, "没有作答时应当按未获同意处理");
});

/* ------------------------------------------------------------------ *
 * 回归：用户不介入 UAC 时，同意闸门必须 fail-closed
 *
 * 曾经的 bug：`askToElevate` 里是裸的 `await userQuestions.ask(...)`。
 * 而**用户不介入是常态**（关掉弹窗 / 点取消 / 会话超时 / profile 没有可交互的
 * user-questions 前端 / signal 提前 abort），每一种都会让 `ask` 抛异常 ——
 * 于是异常直接穿透到工具层：调用失败、真正原因（"没拿到同意"）被吞掉，
 * 而闸门也从 fail-closed 退化成了"抛错"这种不确定状态。
 *
 * 现在两份实现（权威 + 回退）都把 `ask` 包进 try/catch，任何异常一律视为未获同意。
 * ------------------------------------------------------------------ */

const AGENT_EXEC = { agent: { id: "test" }, signal: undefined };

/** 各种"用户没回应"的形态，全部都必须 fail-closed 且不抛错。 */
const NO_RESPONSE_SHAPES = [
	["提问被取消", async () => { throw new Error("用户取消了提问"); }],
	["超时", async () => { throw new Error("question timed out"); }],
	["无可交互前端", async () => { throw new Error("no interactive frontend"); }],
	["signal 中断", async () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }],
	["抛非 Error 值", async () => { throw "plain string failure"; }]
];

for (const [name, sharedMod] of [["权威实现", shared?.module], ["回退实现", impl]]) {
	test(`${name}：用户不介入时 askToElevate 一律拒绝且不抛错`, async () => {
		if (sharedMod === null || sharedMod === undefined) return;
		for (const [shape, ask] of NO_RESPONSE_SHAPES) {
			const userQuestions = { ask };
			let result;
			// 关键断言：**不能抛错**。抛错就意味着异常穿透到工具层。
			await assert.doesNotReject(
				async () => { result = await sharedMod.askToElevate(userQuestions, AGENT_EXEC); },
				`${shape} 不应让异常穿透`
			);
			assert.equal(result.approved, false, `${shape} 必须按未获同意处理`);
			assert.match(result.reason, /不做任何提权动作/, `${shape} 应说明没有做任何提权动作`);
		}
	});
}

test("两份实现在「用户不介入」时行为一致（都是拒绝）", async () => {
	if (shared?.module === null || shared?.module === undefined) return;
	const boom = { ask: async () => { throw new Error("用户没有响应"); } };
	const [a, b] = await Promise.all([
		shared.module.askToElevate(boom, AGENT_EXEC),
		impl.askToElevate(boom, AGENT_EXEC)
	]);
	assert.equal(a.approved, b.approved, "两份实现的 approved 必须一致");
	assert.equal(a.approved, false);
});

/* ------------------------------------------------------------------ *
 * UAC 被禁用时，建议文案不能再推荐"会弹 UAC"的做法
 *
 * 否则用户（和模型）会照着一条**必然被拒**的路走 —— 推荐一条走不通的路
 * 比不推荐更糟。
 * ------------------------------------------------------------------ */

test("GET_ADMIN_NO_ELEVATE=1 时建议不再推荐会弹 UAC 的做法", () => {
	if (shared?.module === null || shared?.module === undefined) return;
	const before = process.env.GET_ADMIN_NO_ELEVATE;
	process.env.GET_ADMIN_NO_ELEVATE = "1";
	try {
		for (const [name, mod] of [["权威实现", shared.module], ["回退实现", impl]]) {
			const lines = mod.permissionDeniedAdvice({ elevated: false }).join("\n");
			assert.match(lines, /GET_ADMIN_NO_ELEVATE=1/, `${name} 应说明 UAC 已被禁用`);
			assert.match(lines, /不会弹窗|禁用/, `${name} 应说明这些做法不会弹窗`);
			// 不该再把"点同意"当成可行出路推荐
			assert.doesNotMatch(
				lines,
				/action=request —— 会弹一次 UAC/,
				`${name} 不该再推荐 action=request（已被禁用）`
			);
		}
	} finally {
		if (before === undefined) delete process.env.GET_ADMIN_NO_ELEVATE;
		else process.env.GET_ADMIN_NO_ELEVATE = before;
	}
});

test("未禁用 UAC 时建议仍然推荐助手通道（防止文案退化）", () => {
	if (shared?.module === null || shared?.module === undefined) return;
	const before = process.env.GET_ADMIN_NO_ELEVATE;
	delete process.env.GET_ADMIN_NO_ELEVATE;
	try {
		const lines = shared.module.permissionDeniedAdvice({ elevated: false }).join("\n");
		assert.match(lines, /remoteElevate/, "应仍给出 remoteElevate 这条可行通道");
	} finally {
		if (before !== undefined) process.env.GET_ADMIN_NO_ELEVATE = before;
	}
});
