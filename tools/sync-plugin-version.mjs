/**
 * 同步 `PLUGIN_VERSION` 常量与 `package.json` 的 version。
 *
 * ## 为什么需要
 *
 * 这两个值必须一致 —— 状态路由用 `PLUGIN_VERSION` 自报版本，
 * 而 npm/插件管理器用的是 `package.json` 的 version。
 *
 * 实测发现它们不同步：发布时只升了 `package.json`，忘了改常量，
 * 于是 `/cheat-engine/status` 报 0.1.1 而实际装的是 0.1.4 —— 让人以为装错了版本。
 *
 * ## 还要管的第二处：出站 user-agent 里的版本
 *
 * `lib/kernel-driver.js` 有一条 `PACKAGE_NAME/PACKAGE_VERSION` 的 user-agent
 * （访问 cheatengine.org 下载页时用）。它也是一处**硬编码版本**，
 * 早先同样是手工跟的 —— 升版本时漏掉它就会对外自报一个不存在的版本。
 * 那类漏改**不会让任何测试变红**，只会让外部日志里的身份失真。
 * 所以这里一并同步；`test/startup.test.mjs` 也有一条交叉校验盯着它。
 *
 * 用法：node tools/sync-plugin-version.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 要检查的仓库（相对本仓库的父目录）。 */
const REPOS = [
	path.dirname(HERE), // 本仓库：dsh-cheat-engine
	path.join(path.dirname(path.dirname(HERE)), "dsh-get-admin") // 兄弟仓库
];

/** 在某个文件里替换一处版本常量；找不到就报错（**不要静默通过**）。 */
function syncConstant(file, pattern, want, label, counters) {
	if (!fs.existsSync(file)) {
		console.log(`  （跳过，文件不存在）${path.relative(process.cwd(), file)}`);
		return;
	}
	const before = fs.readFileSync(file, "utf8");
	const match = before.match(pattern);
	if (match === null) {
		console.log(`  ❌ ${label}：找不到版本常量声明`);
		counters.failed += 1;
		return;
	}
	const current = match[0].match(/"([^"]*)"/)[1];
	if (current === want) {
		console.log(`  ✅ ${label}：已一致（${want}）`);
		return;
	}
	fs.writeFileSync(file, before.replace(pattern, `const ${match[0].match(/const (\w+)/)[1]} = "${want}";`), "utf8");
	console.log(`  🔧 ${label}：${current} → ${want}`);
	counters.changed += 1;
}

const counters = { changed: 0, failed: 0 };

for (const repo of REPOS) {
	const pkgPath = path.join(repo, "package.json");
	const indexPath = path.join(repo, "lib", "index.js");
	if (!fs.existsSync(pkgPath) || !fs.existsSync(indexPath)) {
		console.log(`  （跳过，文件不全）${repo}`);
		continue;
	}
	const want = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
	const name = path.basename(repo);

	// ① 主常量：lib/index.js 的 PLUGIN_VERSION（状态路由自报版本）
	syncConstant(indexPath, /const PLUGIN_VERSION = "[^"]*";/, want, `${name}：PLUGIN_VERSION`, counters);

	// ② 出站 user-agent 的版本（只有本仓库有；get-admin 没有这条）
	const driverPath = path.join(repo, "lib", "kernel-driver.js");
	if (fs.existsSync(driverPath)) {
		syncConstant(
			driverPath,
			/const PACKAGE_VERSION = "[^"]*";/,
			want,
			`${name}：kernel-driver 的 PACKAGE_VERSION（出站 user-agent）`,
			counters
		);
	}
}

console.log("");
console.log(`  改动 ${counters.changed} 个，失败 ${counters.failed} 个`);
process.exit(counters.failed === 0 ? 0 : 1);
