/**
 * **启动层面**的端到端验证 —— 本项目唯一能抓住「应用打不开」那类 bug 的手段。
 *
 * ## 为什么必须有这个文件（这是真实事故的回归）
 *
 * 包名从 `dsh-cheat-engine` 改成 `dsh-ce-tools`（npm 封禁了 "cheat-engine"）时，
 * `lib/client.js` 里硬编码的 `id` 没跟着改。后果是：
 *
 *   - `client-modules: duplicate factory registration for "dsh-cheat-engine"`
 *   - `web boot: 1 entry did not activate`
 *   - `dsh-ce-tools: import failed`
 *   - **整个应用起不来**
 *
 * 而下面这些检查**全部通过**，一个都没拦住：
 *   · `node --check lib/client.js`（只查语法）
 *   · 真实 `import()` 加载 `lib/index.js`（服务端模块本来就没问题）
 *   · 三套测试全绿（193/193）
 *
 * 唯一暴露它的方式是**真的走一遍 DSH 的客户端模块加载**。所以本文件做两件事：
 *
 * ### A. 用**真实的** DSH 客户端模块系统跑一遍（不是手写的假 loader）
 *
 * 从 DSH 安装目录的 `app.asar` 里取出真实产物
 * `@deepseek-ai/dsh-client-modules/lib/client.js`（浏览器半，零 node 依赖），
 * 在 `vm` 里执行它，拿到真实的 `ClientModuleSystem` ——
 * 于是 `register()` 里的重复注册检测、`materialize()`、`import()` 全是**真代码**。
 * 再把插件的 `lib/client.js` 作为**一个 bundle** 交给它，
 * 按 boot manifest 的粒度注册，然后 `import("dsh-ce-tools")`。
 *
 * ⚠️ 这个测试钉住的是**加载期**行为，与 `test/client-entry.test.mjs`（只做语法/形状）互补：
 * 那个测试在 id 写错时**依然全绿**，这个不会。
 *
 * ### B. 在**干净临时目录里真实安装**打包产物，再按 DSH 的方式加载
 *
 * `npm pack` 出 tarball → 装进一个空目录（连同 `@bingine/cemem` 与 `dsh-get-admin`）
 * → 从**安装后的布局**里 import，确认：
 *   · 服务端 `apply` 能跑起来并注册 16 个工具
 *   · 客户端 `client.js` 的 id 与包名一致
 *   · 依赖能解析（`@bingine/cemem`、`dsh-get-admin/launch`）
 *   · `resolveKernelDir()` 在已安装布局下能定位内核
 *
 * 这一步是「安装后才知道」的那类问题的唯一防线：仓库里 `node_modules/node-cheat-engine`
 * 是一个 junction，掩盖了「按包名查 `node_modules/@bingine/cemem`」这条真实路径。
 *
 * 运行：node --test test/startup.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const KERNEL_DIR = path.join(REPO, "node-cheat-engine");
const GET_ADMIN_DIR = path.join(path.dirname(REPO), "dsh-get-admin");

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

/** DSH 的安装目录候选（不同安装方式略有差别；找不到就跳过 A 组）。 */
const ASAR_CANDIDATES = [
	process.env.CE_DSH_ASAR,
	path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar")
].filter((candidate) => typeof candidate === "string" && candidate !== "");

/** `@deepseek-ai/dsh-client-modules` 的浏览器半路径（asar 内部）。 */
const CLIENT_MODULES_BROWSER_ENTRY = "dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js";
/** 同一个包的**包名**（boot manifest 里的 bootstrap 行就是这个 id）。 */
const CLIENT_MODULES_ID = "@deepseek-ai/dsh-client-modules";

/* ───────────────────────── asar 只读读取（只取一个文件） ───────────────────────── */

/**
 * 从 asar 里读出一个文件（不整体解包 —— 那是 121MB）。
 *
 * asar 的格式：`uint32` 头长度 + pickle 头 + JSON 目录树 + 文件数据。
 * 偏移基准是 `16 + 头长度`。
 *
 * @param {string} asarPath asar 路径
 * @param {string} innerPath asar 内部路径（`/` 分隔）
 * @returns {Buffer|null} 文件内容；找不到返回 null
 */
function readFromAsar(asarPath, innerPath) {
	const fd = fs.openSync(asarPath, "r");
	try {
		const head = Buffer.alloc(16);
		fs.readSync(fd, head, 0, 16, 0);
		const headerSize = head.readUInt32LE(12);
		const headerBuf = Buffer.alloc(headerSize);
		fs.readSync(fd, headerBuf, 0, headerSize, 16);
		const tree = JSON.parse(headerBuf.toString("utf8"));
		const base = 16 + headerSize;

		let node = tree;
		for (const segment of innerPath.split("/")) {
			node = node?.files?.[segment];
			if (node === undefined) return null;
		}
		if (node.files !== undefined) return null; // 是目录，不是文件
		const buf = Buffer.alloc(node.size);
		fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
		return buf;
	} finally {
		fs.closeSync(fd);
	}
}

/** 找出第一个能找到且能取出真实客户端模块系统的 asar。 */
function findDshClientModules() {
	for (const candidate of ASAR_CANDIDATES) {
		if (candidate === undefined || !fs.existsSync(candidate)) continue;
		try {
			const source = readFromAsar(candidate, CLIENT_MODULES_BROWSER_ENTRY);
			if (source !== null && source.length > 0) return { asar: candidate, source: source.toString("utf8") };
		} catch {
			/* 换下一个候选 */
		}
	}
	return null;
}

const CLIENT_MODULES = findDshClientModules();

/* ───────────────────── A. 真实客户端模块系统 ───────────────────── */

/**
 * 造一个与 DSH 页面**同形**的 `window.__ModuleLoader__`，并执行真实的浏览器半产物，
 * 拿到真实的 `ClientModuleSystem`。
 *
 * 队列脚本来自 `@deepseek-ai/dsh-client-modules` 的 `bootInjections()`：
 * 它先装一个 `{mode:"queue"}` 门面，页面里的 bundle 执行时只把 `{id, factory}` 推进
 * `pendingQueue`；随后 `create(options)` 从队列里**摘掉** bootstrap 那一行、
 * 物化它、调用它的 `createClientModuleSystem` —— 门面就此切到 live 模式。
 *
 * @param {string} source 真实的 `@deepseek-ai/dsh-client-modules/lib/client.js`
 * @returns {{ sandbox: object, bootstrapExports: object }} 沙箱（含 `__ModuleLoader__`）与 bootstrap 导出
 */
function createRealModuleLoaderSandbox(source) {
	/** 与 DSH 的队列脚本**逐字同形**（见 asar 里的 bootInjections）。 */
	const queueScript = `(()=>{
const pendingQueue=[];
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot");
    const index=pendingQueue.findIndex(registration=>registration.id===${JSON.stringify(CLIENT_MODULES_ID)});
    const registration=pendingQueue[index];
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js");
    pendingQueue.splice(index,1);
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed');
    });
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face");
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options);
  }
};
})()`;

	const sandbox = { window: {}, console, setTimeout, clearTimeout, queueMicrotask };
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;
	// 刻意**不提供 document**：与浏览器无关的样式逻辑会自己跳过（`typeof document === "undefined"`），
	// 这样断言只落在模块系统上，不被 DOM 噪声干扰。
	vm.createContext(sandbox);
	vm.runInContext(queueScript, sandbox, { filename: "dsh-module-loader-queue.js" });

	// bootstrap 行必须先于其它行进入队列 —— 顺序与 DSH 的 HTML 一致。
	//
	// ⚠️ 这里**原样执行真实的 client.js 产物**，不裁剪、不包装：
	// 它的顶层就是 `window.__ModuleLoader__.load({ id, factory })`，
	// 所以执行一次就等于 DSH 页面加载了这个 `<script src>`，工厂原封不动进了队列。
	// （早先想用字符串切出 factory 体再重包一层 —— 那是错的，正则切不干净嵌套的大括号。）
	vm.runInContext(source, sandbox, { filename: CLIENT_MODULES_BROWSER_ENTRY });

	return { sandbox, loader: sandbox.window.__ModuleLoader__ };
}

/**
 * 从队列门面物化 bootstrap 并**建出真实的模块系统**。
 *
 * `create(options)` 的返回值就是 `ClientModuleSystem` —— DSH 的队列脚本把它交给页面
 * （`__ModuleLoader__.create` 的返回值在真实页面里被赋给框架内部使用），
 * 所以测试可以直接拿它当系统对象。
 *
 * @param {object} options
 * @param {object} options.boot boot manifest（`window.__DSH_BOOT__` 的形状）
 * @param {(url: string) => Promise<void>} options.loadBundle bundle 传输钩子
 * @returns {{ sandbox: object, system: object }} 沙箱与真实的 `ClientModuleSystem`
 */
async function bootRealSystem({ boot, loadBundle }) {
	assert.ok(CLIENT_MODULES !== null, "调用方应当先确认找到了 asar");
	const { sandbox, loader } = createRealModuleLoaderSandbox(CLIENT_MODULES.source);
	const system = loader.create({ boot, staticModules: {}, loadBundle });
	assert.equal(typeof system.import, "function", "ClientModuleSystem 应当有 import()");
	assert.equal(typeof system.register, "function", "ClientModuleSystem 应当有 register()");
	return { sandbox, system };
}

/**
 * 按 DSH 的粒度把**一个 bundle 源码**交给真实模块系统，然后 import 它。
 *
 * 这里刻意复刻 DSH 的两个关键细节，因为那正是事故的成因：
 *   1. boot manifest 里的 entry id 取自**包名**（DSH 的 `record.entry.id` 就是包名）；
 *   2. 注册 id 取自 bundle 自己的 `__ModuleLoader__.load({ id })`。
 * 两者不一致时，`import()` 就会以「这个包没注册」失败 —— 与线上现象一致。
 *
 * @param {object} options
 * @param {string} options.bundleSource bundle 源码（就是插件的 `lib/client.js`）
 * @param {string} options.manifestId boot manifest 里的 entry id（= 包名）
 * @param {boolean} [options.loadTwice] 是否把同一个 bundle 执行两次（复现「重复注册」）
 * @returns {Promise<{ exports: object, executedUrls: string[] }>}
 */
async function bootOneBundle({ bundleSource, manifestId, loadTwice = false }) {
	const url = `/${manifestId}/client.js?rev=1`;
	const bundleUrls = new Map([[url, bundleSource]]);

	const { sandbox, system } = await bootRealSystem({
		boot: {
			rev: "rev-1",
			entries: [{ id: manifestId, url, rev: "1" }],
			batches: [{ phase: "application", url, rev: "1", entries: [manifestId] }]
		},
		loadBundle: async (requested) => {
			const code = bundleUrls.get(requested);
			if (code === undefined) throw new Error(`测试没有为 ${requested} 准备源码`);
			vm.runInContext(code, sandbox, { filename: requested });
			if (loadTwice) {
				// 复现「同一个 bundle 被执行两次」：DSH 会走这条路径来暴露重复注册。
				// 这是真事故的现象 —— 报错必须来自真实的 register()，不是我们伪造的。
				vm.runInContext(code, sandbox, { filename: `${requested}#second` });
			}
		}
	});

	const exports = await system.import(manifestId);
	return { exports, system };
}

test(
	"A：把 lib/client.js 交给**真实的 DSH 客户端模块系统**，以包名注册必须成功",
	{ skip: CLIENT_MODULES === null ? "找不到 DSH 的 app.asar（设 CE_DSH_ASAR 可指定），跳过真实加载器验证" : false },
	async () => {
		const source = fs.readFileSync(path.join(REPO, "lib", "client.js"), "utf8");
		const { exports, system } = await bootOneBundle({ bundleSource: source, manifestId: pkg.name });

		// ① 最直接的钉法：真实模块表里的**键必须就是包名**。
		// 这一条比 import() 成功更贴近根因 —— 事故的报错正是「以旧包名注册了」。
		assert.ok(
			system.factories.has(pkg.name),
			`真实的客户端模块表里必须以包名（${pkg.name}）注册；实际键：${[...system.factories.keys()].join(", ")}`
		);
		assert.ok(
			!system.factories.has("dsh-cheat-engine"),
			"客户端模块表里绝不能再出现旧包名 dsh-cheat-engine（那正是让应用起不来的注册）"
		);

		// ② 走到这里也说明 import() 成功：若 id 写错，import 会以
		//    `client-modules: could not load "<包名>": ... loaded without registering "<包名>"` 失败。
		assert.equal(typeof exports?.apply, "function", "客户端插件必须导出 apply");
		assert.ok(Array.isArray(exports?.inject), "客户端插件必须导出 inject 数组");
		assert.ok(exports.inject.includes("slots"), `inject 应当包含 slots，实际：${JSON.stringify(exports.inject)}`);
	}
);

test(
	"A：id 与包名不一致时，真实模块系统必须**加载失败**（反向验证这条守卫有效）",
	{ skip: CLIENT_MODULES === null ? "找不到 DSH 的 app.asar，跳过" : false },
	async () => {
		const source = fs.readFileSync(path.join(REPO, "lib", "client.js"), "utf8");
		// 把 id 换成旧包名 —— 这正是把应用弄挂的那次改动。
		const broken = source.replace(`id: "${pkg.name}"`, 'id: "dsh-cheat-engine"');
		assert.notEqual(broken, source, "反向验证的前提：确实替换到了 id 那一行");

		await assert.rejects(
			() => bootOneBundle({ bundleSource: broken, manifestId: pkg.name }),
			(error) => {
				const message = String(error?.message ?? error);
				assert.match(
					message,
					/loaded without registering|could not load/,
					`id 不匹配时真实加载器应当明确报「没注册成」；实际：${message}`
				);
				return true;
			},
			"id 与包名不一致时 import 必须失败 —— 这条断言就是那次「应用打不开」的回归"
		);
	}
);

test(
	"A：同一个 bundle 执行两次必须被真实模块系统拒绝（重复工厂注册）",
	{ skip: CLIENT_MODULES === null ? "找不到 DSH 的 app.asar，跳过" : false },
	async () => {
		const source = fs.readFileSync(path.join(REPO, "lib", "client.js"), "utf8");
		await assert.rejects(
			() =>
				bootOneBundle({
					bundleSource: source,
					manifestId: pkg.name,
					loadTwice: true
				}),
			(error) => {
				const message = String(error?.message ?? error);
				assert.match(
					message,
					/duplicate factory registration/,
					`两次执行同一个 bundle 必须报重复注册；实际：${message}`
				);
				return true;
			}
		);
	}
);

/* ───────────────── B. 干净目录里真实安装打包产物 ───────────────── */

/**
 * 安装来源模式：
 *
 *   · 默认（`CE_STARTUP_SOURCE=local`）——依赖用**本地目录**
 *     （`file:<仓库>/node-cheat-engine`、`file:<兄弟仓库>/dsh-get-admin`）。
 *     快、离线、可重复，仍然完整覆盖"安装后的布局"这一层
 *     （`<site>/node_modules/<包名>` 目录名、依赖解析、`resolveKernelDir`）。
 *
 *   · `CE_STARTUP_SOURCE=registry` ——用**真实 registry 版本**
 *     （`dsh-ce-tools@<工作区版本>` + `@bingine/cemem@^x` + `dsh-get-admin@^x`）。
 *     这是"用户实际拿到的东西"，但需要联网、几分钟。
 *     发布后应当跑一次；不要放进每次 `npm test`。
 */
const STARTUP_SOURCE = process.env.CE_STARTUP_SOURCE === "registry" ? "registry" : "local";

test(
	`B：干净临时目录里 npm install 打包产物（来源 ${STARTUP_SOURCE}），服务端 apply 注册 16 个工具且内核可解析`,
	{ timeout: 300_000 },
	async (t) => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-startup-"));
		const tarballDir = path.join(tempDir, "tarball");
		const installDir = path.join(tempDir, "site");
		fs.mkdirSync(tarballDir, { recursive: true });
		fs.mkdirSync(installDir, { recursive: true });

		/** 跑一个命令，失败时把 stdout/stderr 一起抛出来（否则排查不了）。 */
		const run = (command, args, cwd) => {
			const result = spawnSync(command, args, {
				cwd,
				encoding: "utf8",
				shell: process.platform === "win32",
				env: { ...process.env, GET_ADMIN_NO_ELEVATE: "1" },
				timeout: 240_000
			});
			if (result.status !== 0) {
				throw new Error(
					`命令失败：${command} ${args.join(" ")}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
				);
			}
			return result.stdout ?? "";
		};

		t.after(() => {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* Windows 上偶尔有句柄没放掉，不影响结论 */
			}
		});

		// ① 打包（用当前工作区，即待发布的产物）
		const packOutput = spawnSync("npm", ["pack", "--pack-destination", tarballDir, "--json"], {
			cwd: REPO,
			encoding: "utf8",
			shell: process.platform === "win32",
			env: { ...process.env, GET_ADMIN_NO_ELEVATE: "1" },
			timeout: 120_000
		});
		assert.equal(packOutput.status, 0, `npm pack 失败：${packOutput.stderr}`);
		const tarballName = fs.readdirSync(tarballDir).find((name) => name.endsWith(".tgz"));
		assert.ok(tarballName !== undefined, `npm pack 没有产出 .tgz：${fs.readdirSync(tarballDir).join(", ")}`);
		const tarball = path.join(tarballDir, tarballName);

		// 打包产物里的 package.json 必须自报正确的包名/版本 —— 否则装出来的目录名都是错的
		run("tar", ["-xzf", tarball, "-C", tarballDir]);
		const packedPkg = JSON.parse(fs.readFileSync(path.join(tarballDir, "package", "package.json"), "utf8"));
		assert.equal(packedPkg.name, pkg.name, "tarball 里的包名必须与工作区一致");
		assert.equal(packedPkg.version, pkg.version, "tarball 里的版本必须与工作区一致");

		// ② 装进一个**空**目录。
		//
		// 安装布局与从 registry 装完全一致（`<site>/node_modules/<包名>`），
		// 差别只在依赖来源：local 用本地目录（离线、快），registry 用真实发布的版本。
		fs.writeFileSync(
			path.join(installDir, "package.json"),
			JSON.stringify({ name: "ce-startup-verify", private: true, version: "1.0.0" }, null, 2),
			"utf8"
		);
		const dependencies =
			STARTUP_SOURCE === "registry"
				? [
					// 用**真实发布版本**：这是用户实际会拿到的东西。
					// 版本范围取自工作区 package.json 的 dependencies。
					`${pkg.name}@${pkg.version}`,
					`${"@bingine/cemem"}@${pkg.dependencies["@bingine/cemem"]}`,
					`${"dsh-get-admin"}@${pkg.dependencies["dsh-get-admin"]}`
				]
				: [tarball, `file:${KERNEL_DIR}`, `file:${GET_ADMIN_DIR}`];
		run("npm", ["install", ...dependencies, "--no-audit", "--no-fund", "--ignore-scripts"], installDir);

		const installedPlugin = path.join(installDir, "node_modules", pkg.name);
		assert.ok(fs.existsSync(installedPlugin), `应当装到 node_modules/${pkg.name}`);
		const installedPkg = JSON.parse(fs.readFileSync(path.join(installedPlugin, "package.json"), "utf8"));
		assert.equal(installedPkg.name, pkg.name, "安装后的目录名必须等于包名");

		// ③ 依赖必须能从**安装后的插件**解析出来（这是 junction 布局掩盖掉的那条真实路径）
		const { createRequire } = await import("node:module");
		/** npm 包名 → 该包根目录（`pkg/package.json` 的 `main` 只保证入口，根目录本身才是包）。 */
		const packageRootOf = (requireFn, name) => path.dirname(requireFn.resolve(`${name}/package.json`));

		const requireFromInstalled = createRequire(path.join(installedPlugin, "lib", "index.js"));
		requireFromInstalled.resolve("@bingine/cemem");
		const resolvedKernelRoot = packageRootOf(requireFromInstalled, "@bingine/cemem");
		// ⚠️ 刻意**不**断言路径里含 `node_modules/@bingine/cemem`：
		// 本地安装是用 junction 链到仓库的，realpath 会解析回 `node-cheat-engine/`。
		// 真正要验证的是「解析到的确实是我们那个内核包」，所以读它的 package.json。
		const resolvedKernelPkg = JSON.parse(fs.readFileSync(path.join(resolvedKernelRoot, "package.json"), "utf8"));
		assert.equal(
			resolvedKernelPkg.name,
			"@bingine/cemem",
			`@bingine/cemem 必须解析到内核包；实际解析到 ${resolvedKernelRoot}（包名 ${resolvedKernelPkg.name}）`
		);
		assert.doesNotThrow(
			() => requireFromInstalled.resolve("dsh-get-admin/launch"),
			"dsh-get-admin/launch 必须可解析（提权后端靠它）"
		);

		// ④ 从**安装后的布局**加载服务端入口，真的跑一遍 apply
		const toUrl = (file) => new URL(`file:///${file.replaceAll("\\", "/")}`).href;
		const kernelPaths = await import(toUrl(path.join(installedPlugin, "lib", "kernel-paths.js")));
		const resolvedKernelDir = kernelPaths.resolveKernelDir();
		assert.notEqual(resolvedKernelDir, null, "在已安装布局下 resolveKernelDir() 必须能定位内核");
		// 同样按「包名」而不是「路径形状」断言 —— junction 安装会把 realpath 解析回仓库。
		const resolvedDirPkg = JSON.parse(fs.readFileSync(path.join(resolvedKernelDir, "package.json"), "utf8"));
		assert.equal(
			resolvedDirPkg.name,
			"@bingine/cemem",
			`resolveKernelDir() 应当解析到内核包；实际 ${resolvedKernelDir}（包名 ${resolvedDirPkg.name}）`
		);
		// 而且它必须与依赖解析**指向同一份**内核，不能是两个不同版本
		assert.equal(
			fs.realpathSync(resolvedKernelDir),
			fs.realpathSync(resolvedKernelRoot),
			`resolveKernelDir()（${resolvedKernelDir}）与 require('@bingine/cemem')（${resolvedKernelRoot}）必须指向同一个内核目录`
		);

		const installedIndex = await import(toUrl(path.join(installedPlugin, "lib", "index.js")));
		assert.equal(installedIndex.name, "cheat-engine", "服务端入口的 loader 名");
		assert.deepEqual(installedIndex.inject, ["tools"], "服务端入口只注入 tools");

		// ⑤ 用最小假 cordis 上下文跑 apply（与 test/helpers/harness.mjs 同构，但**不 import 工作区**）
		const registered = new Map();
		const fakeCtx = {
			logger: { info() {}, warn() {}, error() {}, debug() {} },
			tools: {
				register(definition) {
					if (registered.has(definition.name)) throw new Error(`工具名重复注册：${definition.name}`);
					registered.set(definition.name, definition);
					return () => registered.delete(definition.name);
				}
			},
			effect() {
				return () => {};
			},
			inject(_dependencies, callback) {
				return callback(fakeCtx);
			},
			get(name, strict = true) {
				if (fakeCtx[name] === undefined && strict !== false) throw new Error(`服务 ${name} 不存在`);
				return fakeCtx[name];
			}
		};
		installedIndex.apply(fakeCtx, {});
		assert.equal(registered.size, 16, `安装后的服务端入口应当注册 16 个工具，实际 ${registered.size}`);
		for (const tool of registered.values()) {
			assert.equal(typeof tool.execute, "function", `${tool.name} 必须有 execute`);
			assert.equal(typeof tool.output?.render, "function", `${tool.name} 必须有 output.render`);
		}

		// ⑥ 客户端 bundle 也在包里，且 id 与包名一致
		const installedClient = fs.readFileSync(path.join(installedPlugin, "lib", "client.js"), "utf8");
		const idMatch = installedClient.match(/id:\s*"([^"]+)"/);
		assert.ok(idMatch !== null, "安装后的 lib/client.js 里必须能找到 id");
		assert.equal(idMatch[1], installedPkg.name, "安装后的客户端 id 必须等于包名");

		// ⑦ 版本标记必须在**安装后的每一处**都等于这个包的版本。
		//
		//    registry 上"latest 指向哪个版本"与"装到的那个版本自报什么版本"必须一致，
		//    否则用户会以为装错了版本 —— 这正是 `tools/sync-plugin-version.mjs` 存在的理由。
		//    这里把**安装产物**里所有自报版本的地方一次钉住（含最容易被漏的 user-agent）。
		assert.equal(installedPkg.version, pkg.version, "安装后的 package.json 版本必须与工作区一致");
		const installedIndexSource = fs.readFileSync(path.join(installedPlugin, "lib", "index.js"), "utf8");
		const installedPluginVersion = installedIndexSource.match(/const PLUGIN_VERSION = "([^"]+)";/);
		assert.ok(installedPluginVersion !== null, "安装后的 lib/index.js 里必须有 PLUGIN_VERSION");
		assert.equal(
			installedPluginVersion[1],
			installedPkg.version,
			`安装后的 PLUGIN_VERSION（${installedPluginVersion[1]}）必须等于 package.json 的 version（${installedPkg.version}）`
		);
		const installedDriverSource = fs.readFileSync(path.join(installedPlugin, "lib", "kernel-driver.js"), "utf8");
		const installedDriverName = installedDriverSource.match(/const PACKAGE_NAME = "([^"]+)";/);
		const installedDriverVersion = installedDriverSource.match(/const PACKAGE_VERSION = "([^"]+)";/);
		assert.equal(installedDriverName?.[1], installedPkg.name, "安装后的出站 user-agent 包名必须等于包名");
		assert.equal(installedDriverVersion?.[1], installedPkg.version, "安装后的出站 user-agent 版本必须等于版本");
	});

/* ───────────────── C. 交叉一致性（不需要 asar / 不需要网络） ───────────────── */

test("C：包名 / 客户端 id / cordis.patch.yml 的加载行 / 内核解析链 四者必须一致", () => {
	// ① 客户端 id
	const client = fs.readFileSync(path.join(REPO, "lib", "client.js"), "utf8");
	const idMatch = client.match(/id:\s*"([^"]+)"/);
	assert.ok(idMatch !== null, "lib/client.js 里必须有 id");
	assert.equal(
		idMatch[1],
		pkg.name,
		`lib/client.js 的 id（${idMatch[1]}）必须等于包名（${pkg.name}）—— ` +
			"不一致会让客户端模块重复注册、整个 web boot 失败（实测踩过）"
	);
	// 恰好**一次** `__ModuleLoader__.load(...)`：两次意味着这个 bundle 会注册两个 id，
	// 而其中至少一个不是包名（真事故的报错正是"以旧 id 重复注册"）。
	//
	// ⚠️ 必须先剥掉注释再数：文件头的说明里就有一句
	// `window.__ModuleLoader__.load({ id, factory: … })` 作为形状示例。
	const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const loadCalls = clientCode.match(/__ModuleLoader__\.load\s*\(/g) ?? [];
	assert.equal(
		loadCalls.length,
		1,
		`lib/client.js 里应当只有一次 __ModuleLoader__.load(...)（注释不计），实际 ${loadCalls.length} 次 —— ` +
			"多次注册会让 web boot 失败"
	);

	// ② 服务端自报的包名
	const index = fs.readFileSync(path.join(REPO, "lib", "index.js"), "utf8");
	const packageNameMatch = index.match(/const PACKAGE_NAME = "([^"]+)";/);
	assert.ok(packageNameMatch !== null, "lib/index.js 里必须有 PACKAGE_NAME");
	assert.equal(packageNameMatch[1], pkg.name, "lib/index.js 的 PACKAGE_NAME 必须等于包名");

	// ③ PLUGIN_VERSION 必须等于 package.json 的 version（tools/sync-plugin-version.mjs 管的也是这条）
	const versionMatch = index.match(/const PLUGIN_VERSION = "([^"]+)";/);
	assert.ok(versionMatch !== null, "lib/index.js 里必须有 PLUGIN_VERSION");
	assert.equal(versionMatch[1], pkg.version, "PLUGIN_VERSION 必须等于 package.json 的 version");

	// ④ dsh.client 声明与 exports 子路径：客户端 bundle 要能被解析到
	assert.equal(pkg.dsh?.client?.platform, "web", "dsh.client.platform 必须是 web");
	assert.equal(
		pkg.exports?.["./client"]?.default,
		"./lib/client.js",
		"package.json 的 exports 必须导出 ./client → ./lib/client.js"
	);
	assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "dsh.bundle.patch 必须指向 cordis.patch.yml");
	assert.ok((pkg.files ?? []).includes("lib"), "files 必须包含 lib（否则 bundle 不会进 tarball）");

	// ⑤ cordis.patch.yml 里 insert 的 name 必须等于包名（写成旧包名会让加载行解析不到）
	const patch = fs.readFileSync(path.join(REPO, "cordis.patch.yml"), "utf8");
	const names = [...patch.matchAll(/^\s+name:\s*'?"?([^'"\n]+)'?"?\s*$/gm)].map((match) => match[1].trim());
	assert.ok(names.includes(pkg.name), `cordis.patch.yml 的 insert 行里必须有 name: ${pkg.name}；实际：${names.join(", ")}`);
	assert.ok(
		!names.some((name) => name.startsWith("dsh-ce-tools-")),
		"cordis.patch.yml 里的 name 不能带版本号"
	);

	// ⑥ 内核解析链必须认当前内核包名（改内核名时漏掉这里 = 内核找不到）
	const kernelPaths = fs.readFileSync(path.join(REPO, "lib", "kernel-paths.js"), "utf8");
	const kernelPkg = JSON.parse(fs.readFileSync(path.join(KERNEL_DIR, "package.json"), "utf8"));
	assert.match(
		kernelPaths,
		new RegExp(`"${kernelPkg.name.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}"`),
		`lib/kernel-paths.js 的解析链必须包含内核包名 ${kernelPkg.name}`
	);

	// ⑦ 依赖版本范围必须覆盖**实际装的那一份**内核（否则用户拿到的内核版本与代码假定不符）
	const declaredKernelRange = pkg.dependencies?.[kernelPkg.name];
	assert.ok(typeof declaredKernelRange === "string", `package.json 必须声明 ${kernelPkg.name} 依赖`);
	assert.equal(
		declaredKernelRange,
		`^${kernelPkg.version}`,
		`依赖范围应当与本地内核版本一致（本地 ${kernelPkg.version}，声明 ${declaredKernelRange}）`
	);

	// ⑧ wire.mjs 的接入脚本必须用**当前包名**（用旧名会把加载行插成解析不到的名字）
	const wire = fs.readFileSync(path.join(REPO, "wire.mjs"), "utf8");
	const wirePackageName = wire.match(/const PACKAGE_NAME = "([^"]+)";/);
	assert.ok(wirePackageName !== null, "wire.mjs 里必须有 PACKAGE_NAME");
	assert.equal(
		wirePackageName[1],
		pkg.name,
		`wire.mjs 的 PACKAGE_NAME（${wirePackageName[1]}）必须等于包名（${pkg.name}）—— ` +
			"写错会把 profile 的 cordis.patch.yml 插进一个不存在的包名"
	);
});

test("C：出站 user-agent 自报的包名与版本必须与 package.json 一致", async () => {
	// 这类"改包名/改版本时漏掉一处"的问题不会让应用挂，但会在外部留下错误身份，
	// 也让排查时"这个请求是谁发的"这条线索失效。所以钉住它。
	const { OUTBOUND_USER_AGENT } = await import("../lib/kernel-driver.js");
	const match = OUTBOUND_USER_AGENT.match(/^([^/]+)\/([^\s]+)/);
	assert.ok(match !== null, `user-agent 形状应当是可解析的 name/version；实际：${OUTBOUND_USER_AGENT}`);
	assert.equal(match[1], pkg.name, `user-agent 里的包名应当是 ${pkg.name}；实际：${match[1]}`);
	assert.equal(
		match[2],
		pkg.version,
		`user-agent 里的版本应当是 ${pkg.version}；实际：${match[2]}（改版本时同步 lib/kernel-driver.js 的 PACKAGE_VERSION）`
	);
});

test("C：同一组指针扫描选项必须复用同一个 PointerScanner 实例（否则整张指针映射被重建）", async () => {
	// ## 这条为什么重要（真实缺陷）
	//
	// 内核的指针映射是**实例字段**（`PointerScanner.pointerMap`，按进程全量建索引，
	// 秒级~数十秒级），而 `CeSession.pointerScannerFor` 早先的判据是
	// `Object.keys(options).length > 0` —— 工具**每次都传选项**，所以条件恒真：
	// 每取一次扫描器就 new 一个，映射也重建一遍。
	// 更糟的是 `ce_pointer_scan` 内部取**两次**扫描器（普通 + 汇总），
	// 于是单次工具调用把映射建了两遍（实测：改掉后 e2e 从 11.4s 降到 7.0s）。
	//
	// 这里用假内核把"实例数"钉死 —— 纯逻辑，不需要真目标进程。
	const { createSessionStore } = await import("../lib/session.js");

	/** 记录被 new 了几次的最小 PointerScanner 假体。 */
	let constructed = 0;
	class FakePointerScanner {
		constructor(process, options) {
			constructed += 1;
			this.process = process;
			this.options = options;
			this.cleared = 0;
		}
		clearPointerMap() {
			this.cleared += 1;
		}
		scan() {
			return [];
		}
	}
	const fakeCe = { PointerScanner: FakePointerScanner };
	const store = createSessionStore({ idleTimeoutMs: 0 }, { info() {}, warn() {}, error() {} });
	const session = store.get("startup-pointer-scanner");
	// 直接塞一个"已打开"的假进程，绕开真实 attach（这条测试只关心扫描器复用）
	session.process = { isOpen: true, backendName: "self" };
	session.target = { pid: 1, name: "fake", path: "", bitness: 64, backend: "self" };

	const optionsA = { maxLevel: 5, maxOffset: 2048, maxResults: 20 };
	const first = session.pointerScannerFor(fakeCe, optionsA);
	const second = session.pointerScannerFor(fakeCe, { ...optionsA });
	assert.equal(second, first, "同一组选项必须复用同一个实例（否则整张指针映射会重建）");
	assert.equal(constructed, 1, `同一组选项只应构造一次，实际构造了 ${constructed} 次`);

	// 键顺序不同也必须视为同一组（选项来自对象字面量，顺序不该影响复用）
	const reordered = session.pointerScannerFor(fakeCe, { maxResults: 20, maxLevel: 5, maxOffset: 2048 });
	assert.equal(reordered, first, "键顺序不同但取值相同的选项必须复用同一个实例");
	assert.equal(constructed, 1, "键顺序不该导致重建");

	// 假值归一：`preferShallow: false` 与"不传"在内核构造器里是同一个默认值
	assert.equal(
		session.pointerScannerFor(fakeCe, { ...optionsA, preferShallow: false }),
		first,
		"preferShallow: false 应当与不传等价（内核构造器对两者的处理相同）"
	);
	assert.equal(constructed, 1, "假值归一后不该多构造实例");

	// 汇总模式确实会换实例（preferShallow 改变 scan() 的收集语义），但只换一次
	const aggregated = session.pointerScannerFor(fakeCe, { ...optionsA, preferShallow: true });
	assert.notEqual(aggregated, first, "preferShallow 是不同选项，应当另建实例");
	assert.equal(constructed, 2, `换一组选项只应多构造一次，实际 ${constructed} 次`);
	assert.equal(
		session.pointerScannerFor(fakeCe, { ...optionsA, preferShallow: true }),
		aggregated,
		"同一组选项（含 preferShallow）再次获取必须复用"
	);
	assert.equal(constructed, 2, "重复获取不该再构造");

	// ⚠️ **两组选项必须各自留住自己的实例**（这是"只留最新一个"版本的缺陷）：
	// `ce_pointer_scan` 在"汇总为空"时会退回普通组，若普通组已被汇总组踢掉，
	// 那次退回就会**重建一次整张指针映射**。两组都是常量级的存在，必须都缓存。
	assert.equal(
		session.pointerScannerFor(fakeCe, optionsA),
		first,
		"切回普通组必须命中第一次建的那个实例（否则映射被重建）"
	);
	assert.equal(constructed, 2, "两组选项来回切不该产生新的构造");
	assert.equal(
		session.pointerScannerFor(fakeCe, { ...optionsA, preferShallow: true }),
		aggregated,
		"再切回汇总组也必须命中已缓存的实例"
	);
	assert.equal(constructed, 2, "来回切换任意多次都只应有两次构造");

	// detach 之后必须重建（进程已换，旧映射对新进程毫无意义）
	await session.detach();
	session.process = { isOpen: true, backendName: "self" };
	session.target = { pid: 1, name: "fake", path: "", bitness: 64, backend: "self" };
	const afterDetach = session.pointerScannerFor(fakeCe, optionsA);
	assert.notEqual(afterDetach, first, "detach 之后必须重建扫描器（旧指针映射对新进程无效）");
	assert.equal(constructed, 3, `detach 后应当重建一次，实际 ${constructed} 次`);

	await store.disposeAll();
});

test("C：README 与代码注释里**声称的工具数**必须等于真实注册数", async () => {
	// 声称的数字漂了不会让应用挂，但会让人（和模型）对能力做错判断 —— 属于"文档 vs 实际"契约。
	const { createHarness } = await import("./helpers/harness.mjs");
	const harness = createHarness();
	const actual = harness.tools.size;
	await harness.dispose();
	assert.equal(actual, 16, `真实注册数应当是 16，实际 ${actual}`);

	/** 抓「注册 N 个」/「toolCount: N」/「注册 N 个模型可直接调用的工具」这些说法。 */
	const claims = [];
	const scan = (file, label) => {
		const text = fs.readFileSync(file, "utf8");
		for (const match of text.matchAll(/(?:注册|toolCount[:：]\s*|全部)\s*(\d+)\s*个/g)) {
			claims.push({ label, line: text.slice(0, match.index).split("\n").length, count: Number(match[1]) });
		}
		for (const match of text.matchAll(/toolCount=(\d+)/g)) {
			claims.push({ label, line: text.slice(0, match.index).split("\n").length, count: Number(match[1]) });
		}
	};
	scan(path.join(REPO, "README.md"), "README.md");
	scan(path.join(REPO, "lib", "index.js"), "lib/index.js");
	scan(path.join(REPO, "wire.mjs"), "wire.mjs");

	const wrong = claims.filter((claim) => claim.count !== 16);
	assert.deepEqual(
		wrong,
		[],
		`这些地方声称的工具数不是 ${actual}：\n${wrong.map((c) => `  ${c.label}:${c.line} → ${c.count}`).join("\n")}`
	);
});

/** 备注：`test/client-entry.test.mjs` 负责"能作为脚本解析 + 形状"，本文件负责"真的能加载"。 */
