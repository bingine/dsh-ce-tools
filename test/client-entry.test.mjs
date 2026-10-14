/**
 * 客户端入口形状的回归测试 —— **这条测试的由来是一次真实事故**。
 *
 * ## 事故
 *
 * 我把 `lib/client.js` 重写成"无界面"的占位实现时，顺手用了 ESM 的
 * `export const inject = []` / `export function apply()` —— 因为服务端入口
 * （`lib/index.js`）就是那么写的。
 *
 * 结果整个应用起不来：
 *   - 宿主弹窗：`web boot: 1 entry did not activate`
 *               `dsh-cheat-engine: import failed`
 *   - 浏览器控制台：`Uncaught SyntaxError: Unexpected token 'export'`
 *
 * 原因是**两种入口的形状不同**：
 *   - 服务端插件：ESM 模块，`export function apply` / `export const inject`；
 *   - 客户端插件：浏览器**直接执行**的脚本，必须是
 *     `window.__ModuleLoader__.load({ id, factory })` 包装，
 *     在里面把 `apply` / `inject` 挂到 `exports` 上。
 *
 * 客户端文件里出现顶层 `export` 在 Node 里"看起来没问题"
 * （`node --check` 对 .js 默认按脚本解析，其实会报错 —— 但我当时改完没跑 check），
 * 在浏览器里则是**致命语法错误**。
 *
 * ## 这条测试做什么
 *
 * 用 `vm.Script` 把客户端源码**按脚本（非模块）解析**：
 * 只要里面有顶层 `import`/`export`，编译就会抛 SyntaxError。
 * 再断言它确实调用了 `__ModuleLoader__.load`、并导出了 `apply` 与 `inject`。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

/** 收集要检查的客户端入口（本仓库 + 兄弟仓库 get-admin，后者是正确形状的参照）。 */
function clientEntries() {
	const entries = [{ label: "dsh-cheat-engine", file: path.join(REPO, "lib", "client.js") }];
	const sibling = path.join(path.dirname(REPO), "dsh-get-admin", "lib", "client.js");
	if (fs.existsSync(sibling)) entries.push({ label: "dsh-get-admin（参照）", file: sibling });
	return entries;
}

for (const { label, file } of clientEntries()) {
	test(`客户端入口形状：${label} 必须按**脚本**可解析（不能有顶层 import/export）`, () => {
		assert.ok(fs.existsSync(file), `找不到客户端入口：${file}`);
		const source = fs.readFileSync(file, "utf8");

		// ① 按脚本解析 —— 有顶层 import/export 会在这里抛 SyntaxError
		let compileError = null;
		try {
			// 只编译不执行：可以捕获语法错误，且不会真的去碰 window
			new vm.Script(source, { filename: file });
		} catch (error) {
			compileError = error;
		}
		assert.equal(
			compileError,
			null,
			`${label} 的客户端入口必须是浏览器可直接执行的**脚本**（用 __ModuleLoader__ 包装），` +
				`不能写 ESM 的顶层 import/export —— 否则应用会起不来（实测过）。` +
				`\n解析错误：${compileError?.message}`
		);

		// ② 必须用约定的加载包装
		assert.match(
			source,
			/window\.__ModuleLoader__\.load\(/,
			`${label} 的客户端入口应当调用 window.__ModuleLoader__.load(...)`
		);
		// ③ 必须把 apply / inject 挂到 exports 上（而不是 export 出去）
		assert.match(source, /exports\.apply\s*=/, `${label} 应当设置 exports.apply`);
		assert.match(source, /exports\.inject\s*=/, `${label} 应当设置 exports.inject`);
	});
}
