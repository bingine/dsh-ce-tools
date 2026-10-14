/**
 * 用**真实的 cordis** 加载 `dsh-cheat-engine`，验证它的 DSH 集成面。
 *
 * ## 为什么需要这一层
 *
 * `npm test` 里的 135 条用例覆盖的是**工具逻辑**（读写内存、扫描、汇编…），
 * 但"插件能不能被 DSH 正确装配"取决于另一套契约：
 *   - `apply(ctx, config)` 在真实 cordis 上下文里能否跑完不抛错；
 *   - 15 个工具能否**全部**注册成功（少一个就是功能缺失，而逻辑测试看不出来）；
 *   - web 路由能否注册，且**前缀不带结尾斜杠**
 *     （DSH 的前缀匹配是 `pathname === prefix || pathname.startsWith(prefix + "/")`，
 *      前缀自带斜杠时子路径恒不匹配 —— 这个坑实际踩过，图标 404）；
 *   - 卸载时能否释放资源（目标句柄、扫描 worker、提权助手进程）。
 *
 * ## cordis 解析
 *
 * `@deepseek-ai/cordis` 只在 DSH 安装目录下，插件目录解析不到，
 * 所以按候选路径找，找不到就 skip（不含 DSH 的机器仍可跑其余测试）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

function loadCordis() {
	const require = createRequire(import.meta.url);
	const roots = [
		"C:\\Users\\36376\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules",
		"C:\\Users\\36376\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules"
	];
	for (const root of roots) {
		for (const candidate of [
			path.join(root, "@deepseek-ai", "cordis"),
			path.join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "cordis")
		]) {
			try {
				if (fs.statSync(path.join(candidate, "package.json")).isFile()) return require(candidate);
			} catch {
				/* 继续找 */
			}
		}
	}
	try {
		return require("@deepseek-ai/cordis");
	} catch {
		return null;
	}
}

const cordis = loadCordis();

/** 在真实 cordis 里装配 cheat-engine，返回观察到的注册结果。 */
async function loadPlugin(t, config = {}) {
	const { Context } = cordis;
	const tools = [];
	const routes = [];
	const disposers = [];

	const root = new Context();
	let applyError = null;

	// 用真实的 ctx.plugin 加载，但把 tools / webServer 换成假的记录器，
	// 这样既不碰真进程、又能看到插件究竟注册了什么。
	root.plugin({
		name: "cheat-engine-under-test",
		apply(ctx) {
			ctx.provide("tools", {
				register(definition) {
					tools.push(definition);
					return () => {};
				}
			});
			ctx.provide("webServer", {
				register(route) {
					routes.push(route);
					return () => {};
				}
			});
			// 捕获 effect 注册的 dispose 回调，便于断言"卸载会释放资源"
			const realEffect = ctx.effect.bind(ctx);
			ctx.effect = (fn, label) => {
				const disposer = realEffect(fn, label);
				if (typeof disposer === "function") disposers.push({ label, disposer });
				return disposer;
			};
			const mod = cheatEngine;
			try {
				mod.apply(ctx, config);
			} catch (error) {
				applyError = error;
			}
		}
	});

	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(applyError, null, `apply 不应抛错：${applyError?.stack ?? ""}`);
	return { tools, routes, disposers, root };
}

const cheatEngine = await import("../lib/index.js");

test("真实 cordis：cheat-engine 的 apply 跑通并注册全部 16 个工具", async (t) => {
	if (cordis === null) {
		t.skip("本机解析不到 @deepseek-ai/cordis");
		return;
	}

	const { tools } = await loadPlugin(t);

	// 15 个工具一个都不能少 —— 少一个就是功能缺失
	assert.equal(tools.length, 16, `应当注册 16 个工具（含 ce_elevation 兜底），实际 ${tools.length}：${tools.map((x) => x.name).join(", ")}`);

	const names = tools.map((x) => x.name).sort();
	for (const expected of [
		"ce_assemble",
		"ce_attach",
		"ce_auto_assemble",
		"ce_cheat_table",
		"ce_disassemble",
		"ce_kernel",
		"ce_lua",
		"ce_modules",
		"ce_pointer_scan",
		"ce_processes",
		"ce_read",
		"ce_regions",
		"ce_scan",
		"ce_session",
		"ce_write"
	]) {
		assert.ok(names.includes(expected), `应当注册 ${expected}`);
	}

	// 每个工具都必须满足注册表的硬要求，否则 DSH 会拒绝注册。
	//
	// 注意形状：工具的执行入口是 **`execute`**，不是 `run`
	// （`makeEnvelopeTool` 产出的对象用 `execute(args, exec)`，
	//   `output` 负责渲染、`isConcurrencySafe` 声明能否并行）。
	// 我第一版这里写成断言 `run`，被测出来才发现——这也正是这条测试的价值。
	for (const tool of tools) {
		assert.equal(typeof tool.name, "string", `${tool.name} 应当有名字`);
		assert.ok(tool.name.length > 0);
		assert.equal(typeof tool.description, "string", `${tool.name} 应当有 description`);
		assert.ok(tool.description.length > 0, `${tool.name} 的 description 不能为空`);
		assert.ok(tool.parameters !== undefined, `${tool.name} 应当有 parameters`);
		assert.equal(typeof tool.execute, "function", `${tool.name} 应当有 execute`);
		assert.ok(tool.output !== undefined, `${tool.name} 应当有 output（负责把结果渲染给模型）`);
		// 内存操作共享目标进程与扫描状态，必须声明为不可并行，否则会互相踩
		assert.equal(tool.isConcurrencySafe?.(), false, `${tool.name} 应当声明不可并行执行`);
	}
});

test("真实 cordis：3 条 web 路由都注册，且前缀不带结尾斜杠", async (t) => {
	if (cordis === null) {
		t.skip("本机解析不到 @deepseek-ai/cordis");
		return;
	}

	const { routes } = await loadPlugin(t);

	// 该测试的载荷**没有** getAdmin 服务 → 本插件应当**接管**提权界面。
	// 两种情形（启用/未启用）都钉在 unit.test.mjs 的
	// 「提权界面按需接管」那条测试里，这里只确认"接管时有这三条"。
	assert.deepEqual(
		routes.map((r) => r.path).sort(),
		["/cheat-engine/elevation", "/cheat-engine/icon", "/cheat-engine/status"],
		"get-admin 未启用时应当接管提权界面（状态 + 提权控制 + 图标）"
	);
	for (const route of routes) {
		assert.equal(route.kind, "prefix", `${route.path} 应当是 prefix 路由`);
		// 这条断言值钱：前缀带结尾斜杠时，DSH 对子路径**永远匹配不到**
		// （match = pathname === prefix || pathname.startsWith(prefix + "/")），
		// 表现为图标/状态全部 404。实际踩过，所以固化成断言。
		assert.ok(!String(route.path).endsWith("/"), `前缀路由不能以斜杠结尾：${route.path}`);
		assert.equal(typeof route.handler, "function", `${route.path} 应当有 handler`);
	}
});

test("真实 cordis：apply 不抛错即注册了资源释放用的 effect", async (t) => {
	if (cordis === null) {
		t.skip("本机解析不到 @deepseek-ai/cordis");
		return;
	}

	const { disposers } = await loadPlugin(t);

	// 卸载时必须能释放：目标进程句柄、扫描 worker 池、指针映射、Lua state，
	// 以及**提权助手进程**（提权进程绝不该在插件卸载后继续留在用户机器上）。
	assert.ok(disposers.length >= 1, "应当至少注册 1 个 effect 用于卸载清理");
	const labels = disposers.map((d) => String(d.label ?? "")).join(" | ");
	assert.match(labels, /提权助手|释放|dispose/, `卸载 effect 的说明应当表明它释放资源：${labels}`);

	// 调用所有 disposer 不应抛错（不真的起助手，应当安全）
	for (const { label, disposer } of disposers) {
		try {
			await disposer();
		} catch (error) {
			assert.fail(`卸载 effect「${label}」抛错了：${error.message}`);
		}
	}
});
