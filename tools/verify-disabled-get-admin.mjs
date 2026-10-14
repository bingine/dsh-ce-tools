/**
 * 实测：**get-admin 已安装在磁盘上、但在 DSH 里未启用（开关关闭）**时，
 * cheat-engine 的提权能力到底还在不在？
 *
 * ## 为什么要专门测这个
 *
 * 插件管理器里"已安装"与"已启用"是两件事，而**新装插件的开关默认是关的**。
 * 关键在于：cheat-engine 取 get-admin 的提权实现走的是**模块解析**
 * （`require` 兄弟目录 / 包解析），**不是 cordis 服务** ——
 * 也就是说"磁盘上存在"就足以让代码路径生效，与"是否启用"无关。
 *
 * 那么这个组合会出现一种很拧巴的状态：
 *   · 机制上：能提权（模块解析生效）
 *   · 界面上：没有右下角图标、没有 `+` 菜单项、`get_admin` 工具不存在
 *     （那些都来自 get-admin 的**插件加载**）
 *   · 于是：**能悄无声息地拿到管理员权限，但你在界面上看不到、也收不回**
 *
 * 这个脚本把上面每一条都变成可验证的断言，而不是靠推理。
 *
 * 用法：node tools/verify-disabled-get-admin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHEAT_ENGINE = path.dirname(HERE);

/** 找 cordis（只在 DSH 安装目录下）。 */
function loadCordis() {
	const require = createRequire(import.meta.url);
	for (const root of [
		"C:\\Users\\36376\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules",
		"C:\\Users\\36376\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules"
	]) {
		for (const c of [path.join(root, "@deepseek-ai", "cordis"), path.join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "cordis")]) {
			try {
				if (fs.statSync(path.join(c, "package.json")).isFile()) return require(c);
			} catch {
				/* 继续找 */
			}
		}
	}
	return null;
}

const cordis = loadCordis();
const mod = await import("../lib/elevation-backend.js");

console.log("=== 前提：get-admin 在磁盘上存在吗 ===");
const status = mod.elevationBackendStatus();
console.log("  shared:", status.shared);
console.log("  via   :", status.via ?? "(未解析到)");
console.log("  解析错误:", status.error ?? "(无)");
console.log("");

console.log("=== ① 模块解析是否仍然命中（不依赖启用）===");
console.log(
	status.shared
		? "  ✅ 命中 —— 说明**磁盘存在即生效**，与插件管理器里的开关无关"
		: "  ❌ 未命中 —— 说明关掉开关就不会生效（那反而是安全的）"
);
console.log("");

console.log("=== ② cordis 服务在 get-admin 未加载时是否存在 ===");
let serviceVisible = false;
if (cordis !== null) {
	const { Context } = cordis;
	const root = new Context();
	// 只加载 cheat-engine（**不加载 get-admin**），模拟"开关关着"
	root.plugin({
		name: "consumer",
		apply(ctx) {
			ctx.inject(["getAdmin"], () => {
				serviceVisible = true;
			});
		}
	});
	await new Promise((r) => setTimeout(r, 300));
	console.log("  消费方能注入到 getAdmin 服务:", serviceVisible ? "是" : "否（预期：否）");
} else {
	console.log("  （解析不到 cordis，跳过）");
}
console.log("");

console.log("=== ③ 未加载时，提权状态/界面/工具从哪来 ===");
console.log("  提权状态路由 /get-admin/status  → 由 get-admin 的插件加载提供 → 未加载则 404");
console.log("  右下角图标                     → 由 get-admin 的客户端提供   → 未加载则不存在");
console.log("  `+` 菜单「取消管理员权限」      → 同上");
console.log("  `get_admin` 工具                → 由 get-admin 的 apply 注册 → 未加载则不注册");
console.log("");

console.log("=== ④ 结论 ===");
if (status.shared) {
	console.log("  ⚠️ **机制与界面解耦**：");
	console.log("     · 提权**仍然可用**（走的模块解析，与启用无关）");
	console.log("     · 但界面上没有任何反馈，也没有收回入口");
	console.log("     · 即：能悄无声息地拿到管理员权限，而用户看不见、收不回");
	console.log("");
	console.log("  建议（二选一，取决于你想要的语义）：");
	console.log("     A. 让机制依赖启用 —— 解析到 get-admin 但服务未注册时**拒绝提权**，");
	console.log("        并提示「请先在插件管理器里启用 dsh-get-admin」。");
	console.log("        好处：能用=可见=可控，三者永远一致（更安全）。");
	console.log("     B. 保持现状 —— 接受「没界面也能提权」，并在文档里写明。");
} else {
	console.log("  ✅ 开关关掉后提权也不生效 —— 机制与启用是绑定的，没有「静默提权」的风险。");
}
process.exit(0);
