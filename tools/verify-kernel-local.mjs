/**
 * 用**本机已安装的 Cheat Engine** 验证完整获取链路。
 *
 * 这是比"下载安装包"更现实的路径：很多人机器上本来就装了 CE，
 * 直接解它的 dbk64.cepack 即可 —— 不联网、不需要任何外部解包工具。
 */
import fs from "node:fs";
import {
	DBK64_FILE,
	acquireDriver,
	driverStatus,
	findLocalCheatEngineDriver,
	isCepackFile,
	probePeHeaders,
	probeSignature,
	unpackCepack
} from "../lib/kernel-driver.js";

let bad = 0;
const check = (name, pass, detail = "") => {
	console.log(`  ${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!pass) bad += 1;
};

console.log("1) 找本机 Cheat Engine 的驱动");
const local = findLocalCheatEngineDriver();
console.log("   ", JSON.stringify(local));
if (local === null) {
	console.log("   本机没有 CE，跳过（下载路径由 verify-kernel-acquire.mjs 覆盖）");
	process.exit(0);
}
check("找到了本地驱动来源", true, `${local.kind} @ ${local.path}`);
check("文件存在", fs.existsSync(local.path));
check("是 cepack 格式", isCepackFile(local.path));

console.log("");
console.log("2) 用内置 zlib 解 cepack");
const { data, declaredSize } = unpackCepack(local.path);
check("解压成功", data.length > 0, `${data.length} 字节`);
check("大小与头部声明一致", data.length === declaredSize, `声明 ${declaredSize}`);
check("产物是 PE", data[0] === 0x4d && data[1] === 0x5a, `首字节 ${data[0].toString(16)} ${data[1].toString(16)}`);

// 写到临时位置用 PE 解析器判定
const tmp = ".cache/ce-kernel/extract/local-check.sys";
fs.mkdirSync(".cache/ce-kernel/extract", { recursive: true });
fs.writeFileSync(tmp, data);
const pe = probePeHeaders(tmp);
console.log("    PE:", JSON.stringify(pe));
check("是 PE32+", pe.isPe && pe.is64Bit);
check("是原生子系统内核驱动", pe.isNativeDriver, `subsystem=${pe.subsystem}`);
const sig = probeSignature(tmp);
console.log("    签名:", `status=${sig.status} present=${sig.present}`);
check("有签名", sig.status === "Valid" || sig.present, `status=${sig.status}`);

console.log("");
console.log("3) 跑完整 acquireDriver（应走本机 CE 路径，不联网）");
const result = await acquireDriver({
	onProgress: (phase, detail) => console.log(`    [${phase}] ${String(detail).slice(0, 90)}`)
});
console.log("    来源:", result.sourceDescription);
console.log("    驱动:", result.driverPath, `(${result.driverSize} 字节)`);
console.log("    SHA256:", result.sha256);
check("产出 DBK64.sys 并落在 installed 目录", result.driverPath.endsWith(DBK64_FILE) && fs.existsSync(result.driverPath));
check("产物是内核驱动", result.pe.isNativeDriver);
check("installerPath 为 null（没下载任何东西）", result.installerPath === null, String(result.installerPath));

console.log("");
console.log("4) driverStatus 现在应能看到缓存驱动");
const status = driverStatus();
console.log("    缓存数:", status.cachedDrivers.length, " 提权:", status.elevated, " 服务:", status.service.state);
check("缓存里能看到原生驱动", status.cachedDrivers.some((d) => d.pe.isNativeDriver));

console.log("");
console.log(bad === 0 ? "✅ 全部通过" : `❌ 有 ${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
