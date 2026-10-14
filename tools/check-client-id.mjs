/**
 * 校验 `lib/client.js` 的 `id` 与 npm 包名一致。
 *
 * ## 为什么需要
 *
 * 这个 id **必须等于包名**，否则客户端模块会**重复注册**，报
 *   `client-modules: duplicate factory registration for "<old-id>"
 *    (bundle executed twice without invalidate?)`
 * 并让**整个 web boot 失败、应用打不开**。
 *
 * 实际踩过：npm 封禁了 "cheat-engine" 这个词，包名从 `dsh-cheat-engine`
 * 改成 `dsh-ce-tools`，但 client.js 里的 id 没跟着改 → 应用起不来。
 *
 * 用法：node tools/check-client-id.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.dirname(HERE);
const pkg = JSON.parse(fs.readFileSync(path.join(MAIN, "package.json"), "utf8"));
const clientPath = path.join(MAIN, "lib", "client.js");

if (!fs.existsSync(clientPath)) {
	console.log("  （没有 lib/client.js，跳过）");
	process.exit(0);
}
const source = fs.readFileSync(clientPath, "utf8");
const match = source.match(/id:\s*"([^"]+)"/);

console.log(`  package.json name : ${pkg.name}`);
console.log(`  lib/client.js id  : ${match === null ? "(未找到)" : match[1]}`);

if (match === null) {
	console.log("  ❌ 在 lib/client.js 里找不到 `id: \"...\"`");
	process.exit(1);
}
if (match[1] !== pkg.name) {
	console.log(`  ❌ 不一致！id 必须等于包名（${pkg.name}），否则客户端模块会重复注册、应用起不来。`);
	process.exit(1);
}
console.log("  ✅ 一致");
process.exit(0);
