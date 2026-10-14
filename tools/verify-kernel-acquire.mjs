/**
 * 真实获取链路验证：解析官方直链 → 下载安装包 → 解包 → 校验 PE/签名。
 *
 * 这一步**不需要管理员**（不安装、不加载），用来证明 acquireDriver 真的能跑通。
 * 需要联网，安装包约 50MB，因此放在后台任务里跑。
 */
import { acquireDriver, driverStatus } from "../lib/kernel-driver.js";

const t0 = Date.now();
const step = (name, detail) => {
	console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
	step("开始获取");
	const result = await acquireDriver({
		onProgress: (phase, detail) => step(`进度 ${phase}`, String(detail).slice(0, 120))
	});

	step("完成");
	console.log("");
	console.log("安装包：", result.installerPath, `(${(await import("node:fs")).statSync(result.installerPath).size} 字节)`);
	console.log("驱动：", result.driverPath, `(${result.driverSize} 字节)`);
	console.log("PE：", JSON.stringify(result.pe));
	console.log("签名：", JSON.stringify(result.signature));
	console.log("SHA256：", result.sha256);
	console.log("");
	console.log("--- 过程 ---");
	for (const line of result.log) console.log("  " + line);

	// 结论判定
	const checks = [];
	checks.push(["解出 DBK64.sys", result.driverSize > 10_000]);
	checks.push(["是 PE32+ 内核驱动", result.pe.is64Bit && result.pe.isNativeDriver]);
	checks.push(["签名状态可读", result.signature.checked]);
	checks.push(["签名有效或被信任", /Valid|UnknownError|NotTrusted|NotSigned/i.test(result.signature.status)]);

	console.log("");
	console.log("--- 判定 ---");
	let bad = 0;
	for (const [name, pass] of checks) {
		console.log(`  ${pass ? "✅" : "❌"} ${name}`);
		if (!pass) bad += 1;
	}
	const status = driverStatus();
	console.log("");
	console.log("获取后的缓存状态：", JSON.stringify({
		cached: status.cachedDrivers.map((d) => ({ file: d.path.split(/[\\/]/).pop(), size: d.sizeBytes, native: d.pe.isNativeDriver })),
		elevated: status.elevated,
		service: status.service.state
	}));
	process.exit(bad === 0 ? 0 : 1);
} catch (error) {
	console.error("获取失败：", error.message);
	process.exit(1);
}
