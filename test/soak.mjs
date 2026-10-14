#!/usr/bin/env node
/**
 * 端到端套件的「浸泡测试」：反复运行，统计**原生崩溃**。
 *
 * 存在的原因：本套件偶发整文件失败，退出码是 `0xC0000005`（访问冲突）。这类崩溃
 * **无法在进程内捕获**（退出钩子都不会跑），所以唯一的定位手段就是反复跑、把退出码
 * 与「最后到达的测试」对照起来看。这个脚本把这件事做成一条命令。
 *
 * 用法：
 *   node test/soak.mjs            # 默认跑 30 次
 *   node test/soak.mjs 100        # 跑 100 次
 *   node test/soak.mjs 100 1      # 第 2 个参数为 1 时开启测试内轨迹（CE_E2E_TRACE=1）
 *
 * 退出码：0 = 全部通过；1 = 出现过失败（会按退出码归类打印）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const runs = Number.parseInt(process.argv[2] ?? "30", 10) || 30;
const withTrace = process.argv[3] === "1";

/** Windows 上把退出码翻译成人能读的名字。 */
function explainExitCode(code) {
	if (code === 0) return "0 (通过)";
	// 注意：`node --test` 的子进程被原生层干掉时，**父进程也返回 1**，
	// 所以退出码 1 不等于「断言失败」——必须结合输出里有没有 AssertionError 才能区分。
	if (code === 1) return "1（断言失败，或子进程被原生层干掉 —— 见下方输出判据）";
	// Windows NTSTATUS：-1073741819 = 0xC0000005
	const unsigned = code < 0 ? code + 0x1_0000_0000 : code;
	const table = {
		0xc0000005: "0xC0000005 STATUS_ACCESS_VIOLATION（原生访问冲突）",
		0xc0000006: "0xC0000006 STATUS_IN_PAGE_ERROR",
		0xc00000fd: "0xC00000FD STATUS_STACK_OVERFLOW",
		0xc0000374: "0xC0000374 STATUS_HEAP_CORRUPTION",
		0xc0000409: "0xC0000409 STATUS_STACK_BUFFER_OVERRUN"
	};
	return `${code} (0x${unsigned.toString(16).toUpperCase()}) ${table[unsigned] ?? "未知原生退出码"}`;
}

/** 从一次运行的输出里判断到底是断言失败还是原生崩溃。 */
function classifyOutput(stdout) {
	if (/AssertionError|✖ [^\\]/.test(stdout) && /failing tests/.test(stdout)) {
		// 有具体断言信息 = 真的断言失败
		if (/AssertionError/.test(stdout)) return "断言失败";
	}
	if (/failing tests/.test(stdout) && !/AssertionError/.test(stdout)) {
		return "整文件失败且无断言详情 → 子进程被原生层干掉（0xC0000005 那一类）";
	}
	return "未知失败形态";
}

const buckets = new Map();
let passes = 0;

for (let index = 1; index <= runs; index += 1) {
	const result = spawnSync(process.execPath, ["--test", path.join(HERE, "e2e.test.mjs")], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, ...(withTrace ? { CE_E2E_TRACE: "1" } : {}) },
		maxBuffer: 64 * 1024 * 1024
	});
	const code = result.status ?? -1;
	if (code === 0) {
		passes += 1;
		process.stdout.write(".");
		continue;
	}
	process.stdout.write("X");
	// 崩溃时进程收不到正常输出，所以把「最后一条轨迹」当作定位线索
	const trace = withTrace
		? (result.stderr ?? "").split("\n").filter((line) => line.startsWith("[e2e]")).slice(-1)[0] ?? "(无轨迹)"
		: "(未开启轨迹，用第 2 个参数 1 打开)";
	const key = `${explainExitCode(code)}  [${classifyOutput(result.stdout ?? "")}]  ← 最后到达：${trace}`;
	buckets.set(key, (buckets.get(key) ?? 0) + 1);
}

process.stdout.write("\n\n");
console.log(`运行 ${runs} 次：通过 ${passes}，失败 ${runs - passes}`);
if (buckets.size > 0) {
	console.log("\n失败分布：");
	for (const [key, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ×${count}  ${key}`);
	}
	console.log(
		"\n若出现 0xC0000005：那是内核（koffi 原生扩展）路径上的访问冲突，不是插件的 JS 逻辑 —— " +
		"详见 README「已知问题」。"
	);
}
process.exit(buckets.size === 0 ? 0 : 1);
