/**
 * 验证 F1 修复：**共享助手（dsh-get-admin）下 `kernelAction` 是否可用**。
 *
 * 背景：`kernelAction` 原本硬编码在 cheat-engine 自己的 helper.js 里。
 * 提权助手通用化之后，助手进程跑的是 get-admin 的 helper.js，
 * 于是 `ce_kernel install/load/unload` 会在**用户点过一次 UAC 之后**
 * 抛 `helper 不支持的方法：kernelAction`，还误报成"启动助手失败"。
 *
 * 修法：cheat-engine 提供 `lib/remote/kernel-extension.js`，由
 * `elevation-backend.startElevationBackend` 默认作为 `extensions` 传给助手。
 *
 * 本脚本用**不提权**助手（`elevate:false`，不会弹 UAC）验证扩展确实被加载：
 * 用一个**白名单外**的动作去探测方法存在性 ——
 *   报"不允许的动作" → 方法存在（白名单生效，符合预期）
 *   报"不支持的方法" → 方法不存在（F1 未修复）
 *
 * 用法：node tools/verify-kernel-extension.mjs
 */
import { disposeElevationHelper, elevationBackendStatus, startElevationBackend } from "../lib/elevation-backend.js";

const status = elevationBackendStatus();
console.log("=== 适配层解析结果 ===");
console.log("  共享实现:", status.shared, " via:", status.via ?? "(未解析到)");
console.log("  解析错误:", status.error ?? "(无)");

let backend = null;
let code = 0;
try {
	console.log("");
	console.log("=== 启动不提权助手（带上内核动作扩展）===");
	backend = await startElevationBackend({
		elevate: false,
		timeoutMs: 20_000,
		launchTimeoutMs: 25_000,
		discoverExisting: false,
		log: (m) => console.log("  [launch]", m)
	});
	console.log("  助手 pid:", backend.helperPid, " 提权:", backend.helperElevated);

	console.log("");
	console.log("=== 探测 kernelAction 是否存在 ===");
	try {
		backend.kernelRpc("kernelAction", { action: "bogus-probe" });
		console.log("  ❌ 竟然没有报错 —— 不应该发生");
		code = 1;
	} catch (error) {
		const message = String(error.message);
		if (message.includes("不支持的方法")) {
			console.log("  ❌ kernelAction 仍不存在（F1 未修复）:", message);
			code = 1;
		} else if (message.includes("不允许的动作")) {
			console.log("  ✅ kernelAction 已可用，且白名单生效:", message);
		} else {
			console.log("  ？ 其它错误:", message);
			code = 1;
		}
	}

	console.log("");
	console.log("=== 顺带验证白名单确实挡住越权动作 ===");
	for (const action of ["install", "load", "unload", "rm -rf", ""]) {
		try {
			backend.kernelRpc("kernelAction", { action });
			console.log(`  ${action || "(空)"}: 未报错（未提权时 install/load/unload 本应失败并回传 ok:false）`);
		} catch (error) {
			console.log(`  ${action || "(空)"}: ${String(error.message).slice(0, 60)}`);
		}
	}
} catch (error) {
	console.log("");
	console.log("❌ 验证过程失败:", error.message);
	code = 1;
} finally {
	disposeElevationHelper();
}

process.exit(code);
