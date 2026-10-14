/**
 * 测试入口：**强制开启无人值守提权闸门**后运行测试。
 *
 * ## 为什么所有测试都必须经这里跑
 *
 * 无人值守时（CI、批量跑、让模型自己验证）UAC 可能被自动批准 ——
 * 那就等于**没经人确认就拿到了管理员权限**。
 * 所以测试**一律**带 `GET_ADMIN_NO_ELEVATE=1`：任何试图走 UAC 的代码
 * （提权助手、内核驱动动作）都会**明确报错**而不是弹窗。
 *
 * 这道闸门覆盖**三条**提权路径：本插件的 `remote/launch.js`、
 * `remote/kernel-elevate.js`，以及共享实现 `dsh-get-admin/lib/launch.js`。
 *
 * 用法：
 *   node test/run-tests.mjs                    # 跑全部
 *   node test/run-tests.mjs test/unit.test.mjs # 只跑指定文件
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const args = process.argv.slice(2);
// 刻意不用 shell 通配：Windows 上行为不一致，且容易把辅助模块也塞进去。
const files =
	args.length > 0
		? args
		: fs
				.readdirSync(HERE)
				.filter((name) => name.endsWith(".test.mjs"))
				.sort()
				.map((name) => path.join(HERE, name));

if (files.length === 0) {
	process.stderr.write("没有找到任何 *.test.mjs\n");
	process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files], {
	cwd: ROOT,
	stdio: "inherit",
	env: {
		...process.env,
		// ⚠️ 核心：无人值守保护
		GET_ADMIN_NO_ELEVATE: "1"
	}
});
child.on("exit", (code, signal) => {
	if (signal !== null) process.exit(1);
	process.exit(code ?? 1);
});
