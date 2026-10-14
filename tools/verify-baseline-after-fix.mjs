/**
 * 独立验证：用**自己建立的基线样本**复跑，核对修复是否真的生效。
 *
 * 这不是复用被审代码的测试，而是拿 `tmp-verify/BASELINE-before-fix.md` 里
 * 修复前实测到的错值，逐条对照修复后的结果 —— 走**真实工具路径**（harness 的
 * `callTool`），用 `CheatTestWindow.exe` 当 oracle。
 *
 * 用法：node tools/verify-baseline-after-fix.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool, createHarness } from "../test/helpers/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ORACLE = path.join(ROOT, "CheatTestWindow.exe");
const SAMPLES = path.join(ROOT, "tmp-verify");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const oracle = spawn(ORACLE, [], { cwd: ROOT, stdio: "ignore" });
const harness = createHarness({ backend: "self" });

let base = 0n;
const hex = (v) => "0x" + BigInt(v).toString(16);

/** 等 oracle 就绪并取基址。 */
async function waitReady() {
	const deadline = Date.now() + 30_000;
	let last = "尚未尝试";
	while (Date.now() < deadline) {
		try {
			await callTool(harness, "ce_attach", { pid: oracle.pid });
			const modules = await callTool(harness, "ce_modules", { filter: "CheatTestWindow" });
			const main = modules.data.modules.find((m) => /^CheatTestWindow\.exe$/i.test(m.name));
			if (main === undefined) throw new Error("没有主模块");
			base = BigInt(main.base);
			// 哨兵：&g_pStats 处存放 &g_stats
			const probe = await callTool(harness, "ce_read", { address: hex(base + 0x9000n), type: "qword" });
			if (BigInt(probe.data.values[0].value) === base + 0x9010n) return;
			last = "哨兵不符";
		} catch (error) {
			last = error.message;
		}
		await sleep(500);
	}
	throw new Error(`oracle 未就绪：${last}`);
}

/** 取地址表的记录（含子项），拍平成 [{id, description, addr}]。 */
async function rows() {
	const list = await callTool(harness, "ce_cheat_table", { action: "list", limit: 50 });
	const out = [];
	const push = (r) => {
		out.push({
			id: r.id,
			// ⚠️ 字段名必须是 description —— 上一版这里写成 desc，而查找时用
			// `x.description`，于是**永远匹配不到**、B2 全部误报为失败。
			description: r.description,
			addr: r.address === null || r.address === undefined ? null : hex(r.address)
		});
	};
	for (const r of list.data.records) {
		push(r);
		for (const c of r.children ?? []) push(c);
	}
	return out;
}

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
	const ok = String(got) === String(want);
	if (ok) pass += 1;
	else fail += 1;
	console.log(`    ${ok ? "✅" : "❌"} ${label}: 实际 ${got}${ok ? "" : `  期望 ${want}`}`);
};

try {
	await waitReady();
	console.log(`  oracle pid=${oracle.pid}  基址=${hex(base)}`);
	console.log("");

	// ── 样本 1：4 个后门 + 对照组 ──────────────────────────────
	console.log("=== 样本 1: ct-backdoors.CT ===");
	await callTool(harness, "ce_cheat_table", { action: "load", path: path.join(SAMPLES, "ct-backdoors.CT") });
	let r = await rows();
	// 基线里：1→+0x2332(垃圾) / 2→0x2b9c... / 3,4→0x61e68；5 正确
	check("1 多级 + 裸偏移 → 应为 +0x9010", r[0].addr, hex(base + 0x9010n));
	check("2 指针链 + 裸偏移 → 应为 +0x9020", r[1].addr, hex(base + 0x9020n));
	check("3 引号包住的裸数字 → 应为 0x401000", r[2].addr, "0x401000");
	check("4 数字实体前缀 → 应为 0x401000", r[3].addr, "0x401000");
	check("5 对照组（本来就对）→ +0x9010", r[4].addr, hex(base + 0x9010n));
	// 读值：第 1 条应读出 777（基线里是 1418283008）
	const v1 = await callTool(harness, "ce_read", { address: hex(base + 0x9010n), type: "dword" });
	check("1 的地址处真实值（oracle hp）", v1.data.values[0].value, "777");
	const v2 = await callTool(harness, "ce_read", { address: hex(base + 0x9020n), type: "float" });
	check("2 的地址处真实值（oracle y）", v2.data.values[0].value, "34.5");
	console.log("");

	// ── 样本 2：add vs load + 子项相对 ──────────────────────────
	console.log("=== 样本 2: ct-add-vs-load.CT ===");
	await callTool(harness, "ce_cheat_table", { action: "load", path: path.join(SAMPLES, "ct-add-vs-load.CT") });
	r = await rows();
	// 基线里：1,2→+0x2332 / 3→+0x2328 / 4→0x12 / 5→0x8
	check("1 无引号模块+裸偏移 → +0x9010", r[0].addr, hex(base + 0x9010n));
	check("2 带引号模块+裸偏移 → +0x9010", r[1].addr, hex(base + 0x9010n));
	check("3 父项 +9000 → +0x9000", r[2].addr, hex(base + 0x9000n));
	check("4 子项相对 +18 → 父+0x18", r[3].addr, hex(base + 0x9018n));
	check("5 子项相对 +8 → 父+0x8", r[4].addr, hex(base + 0x9008n));
	// 子项 +18 应读出 g_stats.gold = 9999（基线里子项地址是 0x12，读不出来）
	const vg = await callTool(harness, "ce_read", { address: hex(base + 0x9018n), type: "dword" });
	check("子项 +18 处真实值（oracle gold）", vg.data.values[0].value, "9999");
	console.log("");

	// ⚠️ 保存样本 2 的**第一条**（`CheatTestWindow.exe+9010`，走 load 路径），
	// 供后面与 `add` 路径对照 —— 不要把 `r` 留到之后再读，它会被样本 3 覆盖
	// （我第一版就因为重用了 `r` 而误报）。
	const sample2First = r[0].addr;

	// ── 样本 3：B1 空白形态 + B2 往返 ──────────────────────────
	console.log("=== 样本 3: ct-whitespace.CT（B1 空白）===");
	const w = await callTool(harness, "ce_cheat_table", { action: "load", path: path.join(SAMPLES, "ct-whitespace.CT") });
	r = await rows();
	// 审计基线（0.1.8）：1→+0x233A、2→+0x233A、3→+0x901A、4→30(十进制)
	check("B1-1 模块名与偏移间有空格 → 父+0x9018", r[0].addr, hex(base + 0x9018n));
	check("B1-2 加号后紧邻空格 → +0x9010", r[1].addr, hex(base + 0x9010n));
	check("B1-3 指针链 + 空格 → +0x9020", r[2].addr, hex(base + 0x9020n));
	check("B1-4 纯算术带空格 1000+10 → 0x1000+0x10", r[3].addr, "0x1010");
	// 值也要对（B1-1 是 g_stats.gold = 9999）
	const wv = await callTool(harness, "ce_read", { address: hex(base + 0x9018n), type: "dword" });
	check("B1-1 处真实值（oracle gold）", wv.data.values[0].value, "9999");
	// 原表注释必须保留（B6）：信封结构是 {value, text, data}，**没有 lines** ——
	// 上一版用了 `w.lines` 导致误报。这里查渲染文本 `text`。
	const wtext = String(w.text ?? "") + JSON.stringify(w.data ?? {});
	check("B6 原表注释被保留", wtext.includes("原表注释：务必保留"), true);
	check("B6 注释未被插件那句覆盖", wtext.includes("由 DSH cheat-engine 导出"), false);
	console.log("");

	console.log("=== B2: add → save → load 地址必须逐位不变 ===");
	for (const text of ["1000", "1000+1000", "0x400000+20", "0x10+20"]) {
		await callTool(harness, "ce_cheat_table", {
			action: "add",
			entries: [{ description: "B2-" + text, address: text, type: "dword" }]
		});
		const l1 = await callTool(harness, "ce_cheat_table", { action: "list", limit: 50 });
		const row1 = l1.data.records.find((x) => x.description === "B2-" + text);
		const a1 = row1 === undefined || row1.address == null ? null : hex(row1.address);
		const f = path.join(SAMPLES, "roundtrip-" + text.replace(/[^0-9a-z]/gi, "_") + ".CT");
		await callTool(harness, "ce_cheat_table", { action: "save", path: f });
		await callTool(harness, "ce_cheat_table", { action: "load", path: f });
		const after = await rows();
		const row2 = after.find((x) => x.description === "B2-" + text);
		const a2 = row2 === undefined || row2.addr == null ? null : row2.addr;
		check(`B2「${text}」往返`, a2, a1);
	}
	console.log("");

	console.log("=== add 与 load 一致性（基线里它们是矛盾的）===");
	// ⚠️ 用**唯一描述**定位新增记录，不要用 id：
	// 样本 2 里的子项 id 可能与 `add` 生成的新 id 撞车，`find(x => x.id === …)`
	// 会匹配到错的记录（我第一版就因此误报过一次）。
	const add = await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [{ description: "DIAG-ADD-UNIQUE", address: "CheatTestWindow.exe+9010", type: "dword" }]
	});
	const lr = await callTool(harness, "ce_cheat_table", { action: "list", limit: 50 });
	const addedRow = lr.data.records.find((x) => x.description === "DIAG-ADD-UNIQUE");
	assert.ok(addedRow !== undefined, `list 里找不到刚 add 的记录（add 返回 ${JSON.stringify(add.data)}）`);
	check("add 的解析地址", hex(addedRow.address), hex(base + 0x9010n));
	// 与样本 2 第 1 条（同样的文本、走 load）比
	check("add 与 load 对同一文本给出同一地址", hex(addedRow.address), sample2First);
	console.log("");
} finally {
	try {
		await harness.dispose();
	} catch {
		/* 忽略 */
	}
	if (oracle.exitCode === null) oracle.kill();
}

console.log(`=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
