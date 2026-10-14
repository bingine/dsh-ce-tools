/**
 * 工具层契约回归：AOB 宽泛度防护（B）、.CT 备注/冻结持久化（D/E）、写入超范围提示（F）。
 *
 * 这四条都曾经是「工具报告成功、但结果与你以为的不一样」的**静默错值**，
 * 所以断言必须落在**真实读数**上（文件内容、返回值字段、输出文本），
 * 而不是"调用了没抛错"。
 *
 * 夹具用内核自带的 `test/fixture-target.js`：它有已知基址与已知值，是天然 oracle。
 *
 * 运行：node --test test/tool-contracts.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { callTool, createHarness } from "./helpers/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const KERNEL_DIR = path.join(ROOT, "node-cheat-engine");

let harness = null;
let fixture = null;
let info = null;
let base = 0n;
let tempDir = "";

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
	fixture = startFixture();
	info = await fixture.ready;
	base = BigInt(info.base);
	harness = createHarness({ backend: "self", allowWrite: true, allowLua: true });
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-tool-contracts-"));
	await callTool(harness, "ce_attach", { pid: info.pid });
});

after(async () => {
	if (harness !== null) await harness.dispose();
	if (fixture !== null) {
		try {
			fixture.proc.stdin.write("quit\n");
		} catch {
			/* 已退出 */
		}
		fixture.proc.kill();
	}
	if (tempDir !== "" && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

/** 夹具里某个字段的地址（0x 表达式）。 */
const addr = (key) => `0x${(base + BigInt(info.offsets[key])).toString(16)}`;

/* ───────────────────────── B：AOB 宽泛度防护 ───────────────────────── */

test("B：全通配 AOB（`?? ?? ??`）在真正扫描之前就被拒绝，并给出可行替代", async () => {
	// 实测：这个模式命中 62,221,896 个地址、耗时 4.8s、**宿主 heap +2956 MiB**。
	// 拒绝必须发生在扫描**之前** —— 所以要同时验证"没有留下任何扫描结果"。
	await assert.rejects(
		() => callTool(harness, "ce_scan", { action: "first", type: "aob", mode: "exact", value: "?? ?? ??" }),
		(error) => {
			const message = String(error.message);
			assert.match(message, /宽泛|通配/, `错误信息要说明原因：${message}`);
			assert.match(message, /allowBroadAob/, `必须告诉使用者如何显式放行：${message}`);
			return true;
		}
	);
	const status = await callTool(harness, "ce_scan", { action: "status" });
	assert.equal(status.data.resultCount, 0, "被拒绝的扫描不能留下任何结果（必须拒绝在扫描之前）");
});

test("B：短到没有约束力的 AOB（`90`）同样被拒绝", async () => {
	// `90` 的命中密度是 1/256：4GB 上约 1600 万条。判据是"具体度"而不只是"通配占比"。
	await assert.rejects(
		() => callTool(harness, "ce_scan", { action: "first", type: "aob", mode: "exact", value: "90" }),
		/宽泛|通配|65536|命中/
	);
	await assert.rejects(
		() => callTool(harness, "ce_scan", { action: "first", type: "aob", mode: "exact", value: "?? 90" }),
		/宽泛|通配|65536|命中/
	);
});

test("B：正常带通配的特征码不受影响（单个 `??` 完全合法）", async () => {
	const ok = await callTool(harness, "ce_scan", {
		action: "first",
		type: "aob",
		mode: "exact",
		value: "DE AD ?? ?? 90 90"
	});
	assert.ok(ok.data.resultCount >= 1, `带通配的特征码应当正常扫到：\n${ok.text}`);
	assert.doesNotMatch(ok.text, /宽泛/, `正常特征码不该出现宽泛警告：\n${ok.text}`);
	// 夹具里 0x0080 处正是 DE AD BE EF 90 90 …，必须命中
	const results = await callTool(harness, "ce_scan", { action: "results", limit: 200, readValues: false });
	assert.ok(
		results.data.items.map((item) => item.address).includes(addr("aobSignature")),
		`应当命中夹具的 aobSignature：${addr("aobSignature")}`
	);
	await callTool(harness, "ce_scan", { action: "reset" });
});

test("B：奇数长度片段（`DE AD B`）实际按通配处理，必须明确提示", async () => {
	// 内核按**两字符一字节**切分，落单的 `B` 会成为通配符 —— 此前是静默接受。
	// 实测 `DE AD B` ⇒ 按 `DE AD ??` 扫，用户却以为在精确匹配 0x0B。
	const scan = await callTool(harness, "ce_scan", {
		action: "first",
		type: "aob",
		mode: "exact",
		value: "DE AD B"
	});
	assert.match(scan.text, /奇数/, `必须提示片段长度是奇数：\n${scan.text}`);
	assert.match(scan.text, /通配/, `必须说明落单字符被当成通配符：\n${scan.text}`);
	// 而且它确实按 `DE AD ??` 命中夹具的特征码（证明提示与真实行为一致）
	const results = await callTool(harness, "ce_scan", { action: "results", limit: 200, readValues: false });
	assert.ok(
		results.data.items.map((item) => item.address).includes(addr("aobSignature")),
		"`DE AD B` 应当按 `DE AD ??` 命中 aobSignature"
	);
	await callTool(harness, "ce_scan", { action: "reset" });
});

test("B：显式 allowBroadAob: true 时放行，并在输出里写明代价", async () => {
	// `90 ??` 被判定为宽泛（密度 1/256），但在这个小夹具上代价可接受 ——
	// 正好用来验证"显式确认可以放行"这条出口真的通。
	const scan = await callTool(harness, "ce_scan", {
		action: "first",
		type: "aob",
		mode: "exact",
		value: "90 ??",
		allowBroadAob: true
	});
	assert.match(scan.text, /宽泛|allowBroadAob/, `放行时也必须明示代价：\n${scan.text}`);
	assert.ok(scan.data.resultCount > 0, "放行后确实执行了扫描");
	await callTool(harness, "ce_scan", { action: "reset" });
});

/* ─────────────────── D/E：.CT 备注 + 冻结的一致性 ─────────────────── */

test("D/E：add 的 comment / frozen 在 list 里可见，且 save→load 能持久化", async () => {
	const added = await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [
			{
				description: "带备注与冻结",
				address: addr("health"),
				type: "dword",
				comment: "这是我的备注 X",
				frozen: true
			},
			{ description: "只有备注", address: addr("ammo"), type: "dword", comment: "备注 Y" }
		]
	});
	assert.equal(added.data.added, 2);

	// ① list 里必须看得到（此前 `frozen` 是 undefined、comment 完全没有）
	const listed = await callTool(harness, "ce_cheat_table", { action: "list" });
	const withComment = listed.data.records.find((r) => r.description === "带备注与冻结");
	assert.ok(withComment !== undefined, "应当能在 list 里找到该条目");
	assert.equal(withComment.comment, "这是我的备注 X", `list 必须显示备注：\n${listed.text}`);
	assert.equal(withComment.frozen, true, "list 必须显示冻结标记（此前是 undefined）");
	assert.match(listed.text, /这是我的备注 X/, `备注应当出现在文本输出里：\n${listed.text}`);

	const plain = listed.data.records.find((r) => r.description === "只有备注");
	assert.equal(plain.comment, "备注 Y");
	assert.equal(plain.frozen, false, "没冻结的条目必须是 false（而不是 undefined/true）");

	// ② save 出的 .CT 里必须真的有（此前 XML 里搜不到）
	const ctPath = path.join(tempDir, "comment-frozen.CT");
	await callTool(harness, "ce_cheat_table", { action: "save", path: ctPath });
	const xml = fs.readFileSync(ctPath, "utf8");
	assert.match(xml, /<Comment>这是我的备注 X<\/Comment>/, `备注必须写进 .CT：\n${xml}`);
	assert.match(xml, /<Comment>备注 Y<\/Comment>/, "第二条备注也要写进去");
	assert.match(xml, /Activated="1"/, `冻结必须按 CE 的写法持久化：\n${xml}`);

	// ③ load 回来仍然一致（往返不丢）
	await callTool(harness, "ce_cheat_table", { action: "load", path: ctPath });
	const reloaded = await callTool(harness, "ce_cheat_table", { action: "list" });
	const back = reloaded.data.records.find((r) => r.description === "带备注与冻结");
	assert.equal(back.comment, "这是我的备注 X", "load 回来备注不能丢");
	assert.equal(back.frozen, true, "load 回来冻结不能丢");
	const backPlain = reloaded.data.records.find((r) => r.description === "只有备注");
	assert.equal(backPlain.comment, "备注 Y");
	assert.equal(backPlain.frozen, false);
});

test("D/E：不认识的元素仍然原样保留（.CT 往返不丢信息这条没有被破坏）", async () => {
	// 在 .CT 里塞一个本移植不建模的元素，load→save 之后它必须还在。
	const custom = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="46">
  <CheatEntries>
    <CheatEntry>
      <ID>1</ID>
      <Description>"自定义元素"</Description>
      <VariableType>4 Bytes</VariableType>
      <Address>"fake.exe"+10</Address>
      <MyOwnElement>keep-me</MyOwnElement>
    </CheatEntry>
  </CheatEntries>
</CheatTable>
`;
	const inPath = path.join(tempDir, "custom.CT");
	const outPath = path.join(tempDir, "custom-out.CT");
	fs.writeFileSync(inPath, custom, "utf8");
	await callTool(harness, "ce_cheat_table", { action: "load", path: inPath });
	await callTool(harness, "ce_cheat_table", { action: "save", path: outPath });
	const out = fs.readFileSync(outPath, "utf8");
	assert.match(out, /<MyOwnElement>keep-me<\/MyOwnElement>/, `未知元素必须原样写回：\n${out}`);

	// 恢复成夹具的表，免得影响后续用例
	await callTool(harness, "ce_cheat_table", {
		action: "add",
		entries: [{ description: "恢复用", address: addr("health"), type: "dword" }]
	});
});

/* ───────────────────── F：写入超范围的明确提示 ───────────────────── */

test("F：byte ← 999 / 256 保留 CE 的截断行为，但必须明确说明已按位宽截断", async () => {
	// 用的是一段**空闲草稿区**（夹具分配了 0x4000，0x3800 之后没被任何字段使用）
	const scratch = `0x${(base + 0x3800n).toString(16)}`;

	const big = await callTool(harness, "ce_write", { address: scratch, value: "999", type: "byte" });
	assert.equal(big.data.verified, true, "截断后写入仍然成功（保留 CE 行为，不改失败）");
	assert.equal(big.data.truncated, true, `必须标记为已截断：\n${big.text}`);
	assert.equal(big.data.truncation.effectiveHex, "0xE7", "999 按 8 位截断 = 0xE7");
	assert.match(big.text, /截断/, `输出必须写明截断：\n${big.text}`);
	assert.equal(big.data.bytes, "E7", "实际写入的字节必须是 E7");

	const wrap = await callTool(harness, "ce_write", { address: scratch, value: "256", type: "byte" });
	assert.equal(wrap.data.truncated, true);
	assert.equal(wrap.data.truncation.effectiveHex, "0x00", "256 按 8 位截断 = 0x00");
	assert.equal(wrap.data.bytes, "00");

	const huge = await callTool(harness, "ce_write", {
		address: scratch,
		value: "99999999999999999999",
		type: "dword"
	});
	assert.equal(huge.data.truncated, true, `dword 超大值必须提示截断：\n${huge.text}`);
});

test("F：范围内（含 -1 这种写法）不得误报截断", async () => {
	const scratch = `0x${(base + 0x3800n).toString(16)}`;

	const maxByte = await callTool(harness, "ce_write", { address: scratch, value: "255", type: "byte" });
	assert.equal(maxByte.data.truncated, false, `255 是 byte 的合法上界，不该报截断：\n${maxByte.text}`);
	assert.equal(maxByte.data.bytes, "FF");

	// `byte ← -1` 是写 0xFF 的标准写法，属于正常用法，**不能**误报
	const minusOne = await callTool(harness, "ce_write", { address: scratch, value: "-1", type: "byte" });
	assert.equal(minusOne.data.truncated, false, `-1 写 byte 是标准写法，不该报截断：\n${minusOne.text}`);
	assert.equal(minusOne.data.bytes, "FF");

	const maxDword = await callTool(harness, "ce_write", {
		address: scratch,
		value: "4294967295",
		type: "dword"
	});
	assert.equal(maxDword.data.truncated, false, "4294967295 是 dword 的合法上界");
});
