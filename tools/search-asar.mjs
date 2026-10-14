/**
 * 在 DSH 的 `app.asar` 里搜字符串，用来**取证**而不是猜。
 *
 * ## 为什么要搜
 *
 * 用户从开发者工具复制的 DOM 里有这样一条：
 *
 *     <style id="dsh-ce-progress-layer-style" data-plugin="dsh-get-admin">
 *
 * 但**两个插件的源码都只设置 `id` 和 `textContent`，从不设置 `data-plugin`**：
 *   · `dsh-get-admin/lib/client.js`      —— 只 `style.id = ...`
 *   · `dsh-ce-tools/lib/client.js`       —— 只 `style.id = ...`
 *
 * 而且这个属性的**内容是错标的**：id 是 ce-tools 的进度浮层，`data-plugin`
 * 却写着 get-admin。所以 `data-plugin` 必然是**宿主**加的。
 *
 * 如果宿主存在"按 `data-plugin` 归集 / 清理样式表"的机制，那它就是
 * `get-admin` 那张 `<style id="get-admin-layer-style">` 消失的真正原因 ——
 * 这决定了修复方向（内联 CSSOM）是否正确，也决定另一个插件是否有同样风险。
 *
 * ## asar 格式
 *
 *   8 字节（uint32 ×2：4 字节 pickle 头 + 4 字节索引长度）+ JSON 索引 + 文件数据。
 * 索引是嵌套对象，`files` 里每项要么是目录（有 `files`），要么是文件（有 `offset`/`size`）。
 *
 * 用法：
 *   node tools/search-asar.mjs data-plugin
 *   node tools/search-asar.mjs data-plugin --context 200
 */
import fs from "node:fs";
import path from "node:path";

const ASAR =
	process.argv[3] === undefined && process.argv[2]?.startsWith("C:")
		? process.argv[2]
		: "C:\\Users\\36376\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const NEEDLE = process.argv[2]?.startsWith("C:") ? process.argv[3] : process.argv[2];
const CONTEXT = (() => {
	const index = process.argv.indexOf("--context");
	return index >= 0 ? Number(process.argv[index + 1]) : 120;
})();

if (NEEDLE === undefined) {
	process.stderr.write("用法：node tools/search-asar.mjs <要找的字符串> [asar 路径] [--context N]\n");
	process.exit(1);
}
if (!fs.existsSync(ASAR)) {
	process.stderr.write(`找不到 asar：${ASAR}\n`);
	process.exit(1);
}

const fd = fs.openSync(ASAR, "r");
const header = Buffer.alloc(16);
fs.readSync(fd, header, 0, 16, 0);
const indexSize = header.readUInt32LE(12);
const indexBuffer = Buffer.alloc(indexSize);
fs.readSync(fd, indexBuffer, 0, indexSize, 16);
const index = JSON.parse(indexBuffer.toString("utf8"));
const dataStart = 16 + indexSize;

/** 展平成「文件路径 -> {offset,size}」。 */
function flatten(node, prefix, out) {
	for (const [name, entry] of Object.entries(node.files ?? {})) {
		const full = prefix === "" ? name : `${prefix}/${name}`;
		if (entry.files !== undefined) flatten(entry, full, out);
		else if (entry.size !== undefined) out.push({ path: full, offset: Number(entry.offset), size: entry.size });
	}
}

const files = [];
flatten(index, "", files);

const needle = Buffer.from(NEEDLE, "utf8");
let hits = 0;
/** 只关心文本文件（.js/.mjs/.cjs/.json/.ts/.css/.html）。 */
const textLike = /\.(m?[jt]s|cjs|json|css|html?|map)$/i;
const scanned = { files: 0, bytes: 0 };

for (const file of files) {
	if (!textLike.test(file.path)) continue;
	if (file.size > 40 * 1024 * 1024) continue; // 超大文件（sourcemap）跳过
	const buffer = Buffer.alloc(file.size);
	fs.readSync(fd, buffer, 0, file.size, dataStart + file.offset);
	scanned.files += 1;
	scanned.bytes += file.size;

	let from = 0;
	for (;;) {
		const at = buffer.indexOf(needle, from);
		if (at < 0) break;
		hits += 1;
		const start = Math.max(0, at - CONTEXT);
		const end = Math.min(buffer.length, at + needle.length + CONTEXT);
		const snippet = buffer
			.toString("utf8", start, end)
			.replace(/\r?\n/g, "⏎")
			.replace(/[^\x20-\x7e\u00a0-\uffff⏎]/g, "·");
		process.stdout.write(`\n── ${file.path} @ ${at} ──\n…${snippet}…\n`);
		from = at + needle.length;
		if (hits >= 40) break;
	}
	if (hits >= 40) break;
}

fs.closeSync(fd);
process.stdout.write(
	`\n扫描 ${scanned.files} 个文本文件（${(scanned.bytes / 1048576).toFixed(1)} MB），` +
		`命中 "${NEEDLE}" ${hits} 处${hits >= 40 ? "（已截断到 40）" : ""}\n`
);
