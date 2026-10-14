/**
 * 诊断：B2（add→save→load 往返）与 B6（原表注释保留）到底是不是真失败。
 * 先把真实数据打出来，再判断 —— 避免又一次"验证脚本自己有 bug"。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool, createHarness } from "../test/helpers/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SAMPLES = path.join(ROOT, "tmp-verify");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const oracle = spawn(path.join(ROOT, "CheatTestWindow.exe"), [], { cwd: ROOT, stdio: "ignore" });
const h = createHarness({ backend: "self" });

try {
	await sleep(2500);
	await callTool(h, "ce_attach", { pid: oracle.pid });
	const mods = await callTool(h, "ce_modules", { filter: "CheatTestWindow" });
	const base = BigInt(mods.data.modules.find((m) => /^CheatTestWindow\.exe$/i.test(m.name)).base);
	const hex = (v) => "0x" + BigInt(v).toString(16);
	console.log("  base =", hex(base));

	// ── B6：载入带表级注释的样本，看 load 的**完整返回结构** ──
	console.log("");
	console.log("=== B6: load 返回值结构 ===");
	const w = await callTool(h, "ce_cheat_table", { action: "load", path: path.join(SAMPLES, "ct-whitespace.CT") });
	console.log("  顶层键:", Object.keys(w).join(", "));
	console.log("  data 键:", Object.keys(w.data ?? {}).join(", "));
	console.log("  data.comment =", JSON.stringify(w.data?.comment));
	console.log("  lines 类型:", Array.isArray(w.lines) ? "数组(" + w.lines.length + ")" : typeof w.lines);
	console.log("  含『原表注释』? ", JSON.stringify(w).includes("原表注释"));
	console.log("  文本渲染:", typeof w.text === "string" ? JSON.stringify(w.text.slice(0, 160)) : "(无 text 字段)");
	for (const k of Object.keys(w)) {
		if (typeof w[k] === "string" && w[k].includes("注释")) console.log(`  字段 ${k} 含注释:`, JSON.stringify(w[k].slice(0, 160)));
	}

	// ── B2：add→save→load 往返，打印每一步的真实数据 ──
	console.log("");
	console.log("=== B2: add → save → load ===");
	for (const text of ["1000", "1000+1000"]) {
		const desc = "B2-" + text;
		const a = await callTool(h, "ce_cheat_table", { action: "add", entries: [{ description: desc, address: text, type: "dword" }] });
		console.log(`  add「${text}」→ ids=${JSON.stringify(a.data.ids)} count=${a.data.count}`);
		let l = await callTool(h, "ce_cheat_table", { action: "list", limit: 50 });
		const r1 = l.data.records.find((x) => x.description === desc);
		console.log(`     list 找到: ${r1 === undefined ? "❌ 没找到" : "addr=" + (r1.address == null ? "null" : hex(r1.address))}`);
		console.log(`     list 里所有描述: ${l.data.records.map((x) => x.description).join(" | ")}`);
		const f = path.join(SAMPLES, "b2-" + text.replace(/\+/g, "_") + ".CT");
		await callTool(h, "ce_cheat_table", { action: "save", path: f });
		const xml = fs.readFileSync(f, "utf8");
		const addrTags = [...xml.matchAll(/<Address>([\s\S]*?)<\/Address>/g)].map((m) => m[1]);
		console.log(`     save 后 <Address> = ${JSON.stringify(addrTags)}`);
		const ld = await callTool(h, "ce_cheat_table", { action: "load", path: f });
		console.log(`     load → ${ld.data.count} 条`);
		l = await callTool(h, "ce_cheat_table", { action: "list", limit: 50 });
		const r2 = l.data.records.find((x) => x.description === desc);
		console.log(`     load 后 list 找到: ${r2 === undefined ? "❌ 没找到" : "addr=" + (r2.address == null ? "null" : hex(r2.address))}`);
		console.log(`     load 后所有描述: ${l.data.records.map((x) => x.description).join(" | ")}`);
		console.log("");
	}
} finally {
	try {
		await h.dispose();
	} catch {
		/* 忽略 */
	}
	if (oracle.exitCode === null) oracle.kill();
}
