/**
 * **A**：下载同意闸门（`lib/download-consent.js`）
 * **B**：长任务实时进度（`lib/progress.js`）
 *
 * 这两件事是一起做的，因为都源自同一个观察：
 * `ce_kernel action=acquire` 早先**既没有确认、也没有进度**，
 * 模型可以自主发起一次 100–200MB 的外部下载，而用户全程只看到"卡住"。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DOWNLOAD_OPTIONS, askToDownload, resolveDownloadChoice } from "../lib/download-consent.js";
import { beginKernelProgress, kernelProgressSnapshot, resetKernelProgress } from "../lib/progress.js";

/* ──────────────────────── A：下载同意闸门 ──────────────────────── */

test("A：没有 agent 会话时拒绝下载（fail-closed）", async () => {
	const result = await askToDownload({ ask: async () => ({}) }, {}, {});
	assert.equal(result.approved, false, "拿不到 agent 会话时必须拒绝");
	assert.match(result.reason, /不发起任何下载/, "应当如实说明不会下载");
});

test("A：没有 user-questions 服务时拒绝下载（fail-closed）", async () => {
	const result = await askToDownload(undefined, { agent: {} }, {});
	assert.equal(result.approved, false);
	assert.match(result.reason, /不发起任何下载/);
});

test("A：用户选 approve 才放行，且选项 id 是稳定契约", async () => {
	assert.deepEqual(
		DOWNLOAD_OPTIONS.map((o) => o.id),
		["decline", "approve"],
		"选项 id 是判定依据，不能随意改名"
	);
	const result = await askToDownload(
		{ ask: async () => ({ answers: [{ id: "download", selected: ["同意下载"] }] }) },
		{ agent: {} },
		{}
	);
	assert.equal(result.approved, true);
});

test("A：用户选 decline 时拒绝", async () => {
	const result = await askToDownload(
		{ ask: async () => ({ answers: [{ id: "download", selected: ["不下载（推荐）"] }] }) },
		{ agent: {} },
		{}
	);
	assert.equal(result.approved, false);
});

test("A：判定只认已知选项，不能被文案或畸形返回带成同意", async () => {
	// 这一条是真踩过的坑：早先的实现按"选项文案"推导同意，
	// 结果回退版把"告诉我如何提权"当成了同意、直接弹 UAC。
	// 下载这边沿用同一套严格判定。
	//
	// ⚠️ 形状来自 `dsh-user-questions` 的**真实契约**（见下面那条专门的回归）：
	//   `{ answers: [{ id, selected: string[], custom? }] }`
	const cases = [
		[{ answers: [] }, false, "空 answers 数组"],
		[{}, false, "空返回"],
		[undefined, false, "undefined"],
		[null, false, "null"],
		[{ answers: [{ id: "download", selected: ["同意下载"] }] }, true, "选中「同意下载」"],
		[{ answers: [{ id: "download", selected: [{ id: "approve" }] }] }, true, "selected 装对象（取 id）"],
		[{ answers: [{ id: "download", selected: ["不下载（推荐）"] }] }, false, "选中「不下载」"],
		[{ answers: [{ id: "download", selected: ["随便写的"] }] }, false, "未知识别不了必须拒绝"]
	];
	for (const [answer, expected, label] of cases) {
		const result = await askToDownload({ ask: async () => answer }, { agent: {} }, {});
		assert.equal(result.approved, expected, `${label}：期望 approved=${expected}`);
	}
});

test("回归：必须认识 dsh-user-questions 的**真实**返回形状（曾整条认不出来）", () => {
	// 这个 bug 是真发生过的：我按 `answers.download.id` 这种**臆想**的结构去解析，
	// 而真实契约是 `answers: [{ id, selected: string[], custom? }]`，
	// 且 `selected` 里装的是**选项标签**、不是 id。
	// 后果：三个分支全不命中 → 永远走 fail-closed 的"拒绝"。
	//
	// 安全上没错（没下载），但**实测时用户明明选了自定义项，却被告知
	// "你选择了不下载"** —— 他根本没做过那个选择。这是纯粹的错误陈述。
	//
	// 这条测试把真实契约钉住，防止再退回臆想的形状。
	const answer = { answers: [{ id: "download", selected: ["同意下载"] }] };
	assert.equal(resolveDownloadChoice(answer).id, "approve", "真实形状：label 在 selected 数组里");
	assert.equal(
		resolveDownloadChoice({ answers: { download: { id: "approve" } } }).id,
		"decline",
		"臆想的旧形状**不应**被当成同意（宁可拒绝）"
	);
	// 自定义输入不能自动当成同意（自由文本无法可靠判定意图）
	const custom = resolveDownloadChoice({ answers: [{ id: "download", selected: [], custom: "我自己输入的内容" }] });
	assert.equal(custom.id, "decline", "自定义输入不该被自动当成同意");
	assert.match(custom.label, /自定义内容/, "应当如实说明是因为看不懂自定义输入");
	// 但自定义输入也要被**如实回显**，让用户知道我们读到了什么
	assert.equal(custom.custom, "我自己输入的内容");
});

test("A：问的是**下载**，不是提权（文案不能误导）", async () => {
	let asked = null;
	await askToDownload(
		{
			ask: async (payload) => {
				asked = payload;
				return { answers: [{ id: "download", selected: ["不下载（推荐）"] }] };
			}
		},
		{ agent: {} },
		{ what: "Cheat Engine 安装包" }
	);
	assert.ok(asked !== null, "应当真的问了");
	assert.equal(asked.questions[0].id, "download");
	assert.match(asked.questions[0].question, /下载/, "应当问的是下载");
	assert.doesNotMatch(asked.questions[0].header, /管理员|权限/, "不该说成需要管理员权限（这一步不需要）");
	assert.match(asked.questions[0].question, /不会改动你的系统/, "应当讲清这一步不改系统");
});

/* ──────────────────────── B：实时进度 ──────────────────────── */

test("B：没有任务时快照为 null（界面据此不显示任何东西）", () => {
	resetKernelProgress();
	assert.equal(kernelProgressSnapshot(), null);
});

test("B：能记录阶段流水，并如实报告进行中", () => {
	resetKernelProgress();
	const tracker = beginKernelProgress("acquire");
	tracker.step("download", "https://example.invalid/ce.exe");

	const snap = kernelProgressSnapshot();
	assert.ok(snap !== null, "进行中应当有快照");
	assert.equal(snap.active, true, "应当标记为进行中");
	assert.equal(snap.task, "acquire");
	assert.equal(snap.phase, "download");
	assert.equal(snap.steps.length, 1);
	assert.ok(snap.elapsedMs >= 0, "应当有时间流逝");
	assert.equal(snap.ok, null, "未结束时不该有结论");
});

test("B：完成后保留快照（界面要能显示刚完成），且 ok=true", () => {
	resetKernelProgress();
	const tracker = beginKernelProgress("acquire");
	tracker.step("extract", "x");
	tracker.done("已获取并校验 DBK64.sys");

	const snap = kernelProgressSnapshot();
	assert.ok(snap !== null, "刚完成时快照应当还在（否则界面一闪而过）");
	assert.equal(snap.active, false);
	assert.equal(snap.ok, true);
	assert.equal(snap.phase, "已完成");
	assert.match(String(snap.message), /DBK64/);
});

test("B：失败要如实标记，否则界面会一直显示进行中", () => {
	resetKernelProgress();
	const tracker = beginKernelProgress("acquire");
	tracker.fail("下载失败：HTTP 403");

	const snap = kernelProgressSnapshot();
	assert.ok(snap !== null);
	assert.equal(snap.active, false, "失败后不该还显示进行中");
	assert.equal(snap.ok, false);
	assert.equal(snap.phase, "失败");
	assert.match(String(snap.message), /403/);
});

test("B：旧任务不能覆盖新任务的进度（并发保护）", () => {
	resetKernelProgress();
	const old = beginKernelProgress("old");
	const fresh = beginKernelProgress("new");
	// 旧任务在被取代之后才报告 —— 不该写进新任务的快照
	old.step("late", "来自旧任务");
	old.done("旧任务完成");

	const snap = kernelProgressSnapshot();
	assert.equal(snap.task, "new", "当前快照应当是新的任务");
	assert.equal(snap.active, true, "新任务不该被旧任务的 done 结束掉");
	assert.equal(snap.steps.length, 0, "旧任务的阶段不该混进新任务");
});

test("B：detail 会被截断，避免把超长内容塞进状态", () => {
	resetKernelProgress();
	const tracker = beginKernelProgress("acquire");
	tracker.step("download", "x".repeat(5000));
	const snap = kernelProgressSnapshot();
	assert.ok(snap.detail.length <= 200, `detail 应当被截断，实际 ${snap.detail.length}`);
});

test("B：快照是**副本**，外部改动不会影响内部状态", () => {
	resetKernelProgress();
	const tracker = beginKernelProgress("acquire");
	tracker.step("a", "1");
	const first = kernelProgressSnapshot();
	first.steps.push({ at: 0, phase: "伪造", detail: null });
	first.phase = "伪造";
	const second = kernelProgressSnapshot();
	assert.equal(second.steps.length, 1, "外部改副本不该影响内部");
	assert.equal(second.phase, "a");
});
