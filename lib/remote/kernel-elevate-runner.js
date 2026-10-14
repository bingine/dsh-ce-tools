/**
 * 被提权启动的**一次性**执行器（只做内核驱动动作，然后退出）。
 *
 * 由 `kernel-elevate.js` 通过 `Start-Process -Verb RunAs` 拉起。
 * 职责极窄，且刻意如此：
 *
 *   1. 读配置文件（含动作、参数、结果文件路径、nonce）；
 *   2. 按**白名单**调用 `kernel-driver.js` 的 install / load / unload；
 *   3. 把 `{ nonce, ok, log, result, error }` 写进结果文件；
 *   4. 退出。
 *
 * ## 为什么动作要用白名单而不是"跑任意函数"
 *
 * 这个进程以**管理员权限**运行。若它接受"任意模块 + 任意函数名"，
 * 就等于把提权通道敞开给任何能写配置文件的人。
 * 所以只认三个固定动作，参数也只有驱动路径一个。
 *
 * ## 为什么必须写结果文件
 *
 * `Start-Process -Verb RunAs` 拉起的进程与父进程没有继承关系：
 * 父进程拿不到它的 pid，也拿不到 stdout。所以结果只能落盘回传。
 *
 * @module dsh-cheat-engine/remote/kernel-elevate-runner
 */
import fs from "node:fs";

/** 允许执行的动作（与 kernel-elevate.js 的白名单保持一致）。 */
const ALLOWED = new Set(["install", "load", "unload"]);

/** 读 `--config=<path>` 参数。 */
function configPathFromArgv(argv) {
	for (const arg of argv) {
		if (arg.startsWith("--config=")) return arg.slice("--config=".length);
	}
	return null;
}

/**
 * 把结果写回文件。
 *
 * 用 `nonce` 标记这次请求：父进程据此确认读到的是**本次**的结果，
 * 而不是上一次残留的文件。
 */
function writeResult(resultFile, payload) {
	fs.writeFileSync(resultFile, JSON.stringify(payload), "utf8");
}

async function main() {
	const configPath = configPathFromArgv(process.argv.slice(2));
	if (configPath === null) {
		// 没有配置文件就没法回传结果，只能退出（父进程会报"没有写回结果"）
		process.exitCode = 2;
		return;
	}

	let config;
	try {
		config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error) {
		process.exitCode = 3;
		return;
	}

	const { nonce, resultFile, action, driverPath } = config;
	const log = [];
	const finish = (payload) => writeResult(resultFile, { nonce, ...payload });

	if (!ALLOWED.has(action)) {
		finish({ ok: false, log, result: null, error: `不允许的动作：${action}` });
		return;
	}

	// 动态 import：这是 ESM，且要避免在参数不合法时就去加载内核依赖。
	// 路径注意：本文件在 lib/remote/ 下，而 kernel-driver.js 在 lib/ 下
	// → 相对路径是**一级**向上（`../kernel-driver.js`）。
	const { installDriver, loadDriver, unloadDriver } = await import("../kernel-driver.js");

	try {
		let result;
		if (action === "install") {
			result = installDriver({ driverPath });
		} else if (action === "load") {
			result = loadDriver();
		} else {
			result = unloadDriver();
		}
		log.push(...(Array.isArray(result.log) ? result.log : []));
		finish({ ok: true, log, result, error: null });
	} catch (error) {
		finish({
			ok: false,
			log,
			result: null,
			error: error && error.message ? error.message : String(error)
		});
	}
}

await main();
