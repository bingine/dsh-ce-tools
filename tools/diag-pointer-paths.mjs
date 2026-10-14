/**
 * 诊断脚本（非测试）：查看 `ce_pointer_scan` 返回的路径，以及每条路径**当下**是否还能读。
 *
 * 用途（本次定位 e2e 偶发失败就是靠它）：
 *   1. 打印 `scan.data.paths` 前 N 条的 expression / depth / base / offsets / module；
 *   2. 对每条路径的基址查一次 `ce_regions`，并真的 `ce_read` 一次 ——
 *      于是能一眼看出「路径的基址所在区域已经不存在了」（`无区域` + 998 ERROR_NOACCESS）；
 *   3. `--diff` 在扫描前后各拍一次区域快照，列出**扫描期间消失的区域**。
 *
 * 实测背景：夹具进程的 V8 会在空闲时回收堆页（页粒度 0x40000 = 256KB），
 *   一次扫描期间可以消失十几个 256KB 的 PAGE_READWRITE PRIVATE 区域；
 *   这些区域里恰好可能存着夹具分配区的基址（BigInt 数字位 / 栈残留），
 *   指针映射按值匹配就会把它们当成指针槽，于是返回一条**基址马上要失效**的 1 级路径。
 *
 * 运行（**先设 `GET_ADMIN_NO_ELEVATE=1`，避免任何提权路径弹 UAC**）：
 *   $env:GET_ADMIN_NO_ELEVATE="1"; node tools/diag-pointer-paths.mjs [轮数] [--diff]
 *
 * 注意：本文件不叫 `*.test.mjs`，不会被 `node --test` 收集。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool, createHarness } from "../test/helpers/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KERNEL_DIR = path.join(ROOT, "node-cheat-engine");
const args = process.argv.slice(2);
const ROUNDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 1);
const SHOW_DIFF = args.includes("--diff");
const SHOW = 12;

function startFixture() {
	const proc = spawn(process.execPath, [path.join(KERNEL_DIR, "test", "fixture-target.js")], {
		cwd: KERNEL_DIR,
		stdio: ["pipe", "pipe", "pipe"]
	});
	const ready = new Promise((resolve, reject) => {
		let buffer = "";
		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const nl = buffer.indexOf("\n");
			if (nl === -1) return;
			resolve(JSON.parse(buffer.slice(0, nl)));
		});
		proc.on("exit", (code) => reject(new Error(`夹具在 ready 之前退出：code=${code}`)));
	});
	return { proc, ready };
}

/** 拍一次区域快照（base → size/protect/type）。 */
async function snapshotRegions(harness) {
	const regions = await callTool(harness, "ce_regions", { limit: 500 });
	return new Map(regions.data.regions.map((r) => [r.base, r]));
}

/**
 * 区域快照 diff：消失 / 尺寸变化 / 新增。
 *
 * ⚠️ MEM_IMAGE 的变动几乎全是**写时复制噪声**：模块页初始是 PAGE_WRITECOPY(0x8)，
 * 被写过之后变 PAGE_READWRITE(0x4)，VirtualQueryEx 报告的粒度随之变化，
 * 于是同一块模块内存会表现成「老区域消失 + 邻区变大」。这类条目单独计数，
 * 不跟真正有意义的 PRIVATE/MAPPED 变动混在一起。
 */
function diffRegions(before, after) {
	const lines = [];
	let imageChurn = 0;
	for (const [base, r] of before) {
		const now = after.get(base);
		const changed =
			now === undefined
				? `消失 base=${base} size=${r.size} protect=${r.protect} type=${r.type}`
				: now.size !== r.size
					? `尺寸变化 base=${base} ${r.size}→${now.size} protect=${r.protect} type=${r.type}`
					: null;
		if (changed === null) continue;
		if (r.type === "IMAGE") imageChurn += 1;
		else lines.push(changed);
	}
	for (const [base, r] of after) {
		if (before.has(base)) continue;
		if (r.type === "IMAGE") imageChurn += 1;
		else lines.push(`新增 base=${base} size=${r.size} protect=${r.protect} type=${r.type}`);
	}
	if (imageChurn > 0) lines.push(`（另有 ${imageChurn} 项模块映像变动，属写时复制噪声，已折叠）`);
	return lines;
}

for (let round = 1; round <= ROUNDS; round += 1) {
	const fixture = startFixture();
	const info = await fixture.ready;
	const base = BigInt(info.base);
	const harness = createHarness({ backend: "self", allowWrite: true, allowLua: true });
	await callTool(harness, "ce_attach", { pid: info.pid });
	const target = base + BigInt(info.offsets.targetValue);
	const pointerSlot = base + BigInt(info.offsets.pointerToTarget);

	console.log(
		`\n===== 轮 ${round}：靶进程 pid=${info.pid} 夹具 base=${info.base} ` +
			`targetValue=0x${target.toString(16)} 真实指针槽=0x${pointerSlot.toString(16)} =====`
	);

	const before = SHOW_DIFF ? await snapshotRegions(harness) : null;
	const started = Date.now();
	const scan = await callTool(harness, "ce_pointer_scan", {
		address: `0x${target.toString(16)}`,
		maxLevel: 3,
		maxOffset: 0x1000,
		maxResults: 200
	});
	const elapsed = Date.now() - started;

	const paths = scan.data.paths ?? [];
	console.log(
		`扫描耗时 ${elapsed}ms：pathCount=${scan.data.pathCount} usedMaxLevel=${scan.data.usedMaxLevel} ` +
			`requested=${scan.data.requestedMaxLevel}`
	);
	console.log(`depth 序列（前 20）：${paths.slice(0, 20).map((p) => p.depth).join(",")}`);

	if (SHOW_DIFF) {
		const after = await snapshotRegions(harness);
		const lines = diffRegions(before, after);
		console.log(`扫描前后区域数：${before.size} → ${after.size}；变动 ${lines.length} 项`);
		for (const line of lines.slice(0, 40)) console.log(`    [区域] ${line}`);
	}

	console.log(`── 前 ${SHOW} 条路径（含"现在还能不能读"）──`);
	for (let i = 0; i < Math.min(SHOW, paths.length); i += 1) {
		const p = paths[i];
		let read;
		try {
			const value = await callTool(harness, "ce_read", { address: p.expression, type: "dword" });
			read = `读到 ${value.data.values[0].value}`;
		} catch (error) {
			const code = String(error.message).match(/Win32 错误 \d+/)?.[0] ?? "?";
			read = `读失败（${code}）`;
		}
		let region = "无区域包含它";
		try {
			const regions = await callTool(harness, "ce_regions", { near: p.base });
			if (regions.data.count > 0) {
				region = regions.data.regions
					.map((r) => `size=${r.size} protect=${r.protect} type=${r.type}`)
					.join(" ");
			}
		} catch (error) {
			region = `查询失败：${error.message}`;
		}
		const isRealChainSlot = BigInt(p.base) === pointerSlot;
		console.log(
			`[${i}] depth=${p.depth} base=${p.base} offsets=[${p.offsets.map((o) => "0x" + o.toString(16)).join(",")}] ` +
				`module=${p.module ?? "(动态)"}${isRealChainSlot ? " ← 夹具真实指针槽" : ""}\n` +
				`      ${p.expression}  →  ${read}  |  ${region}`
		);
	}
	// 夹具真实指针链那条路径（稳定、可复现）单独指出来
	const real = paths.find((p) => BigInt(p.base) === pointerSlot);
	console.log(
		real === undefined
			? "⚠️ 结果里没有夹具真实指针槽对应的路径"
			: `夹具真实指针槽那条路径：depth=${real.depth} ${real.expression}`
	);

	await harness.dispose();
	try {
		fixture.proc.stdin.write("quit\n");
	} catch { /* 已退出 */ }
	fixture.proc.kill();
}
