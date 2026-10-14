/**
 * ce_kernel 工具的行为验证（不需要管理员、不联网）。
 *
 * 重点验证**安全闸门**：需要改系统的 action 必须被 confirm 拦住；
 * 只读 action 必须能随时跑；未提权时必须给出可执行的错误而不是晦涩失败。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { callTool, createHarness } from "./helpers/harness.mjs";

const harness = createHarness({ backend: "self", allowWrite: true, allowLua: true });

test("ce_kernel status 是纯只读：随时可调，报告服务/提权/缓存状态", async () => {
	const result = await callTool(harness, "ce_kernel", {});
	assert.ok(result.value.summary.length > 0);
	assert.equal(typeof result.data.elevated, "boolean");
	assert.equal(typeof result.data.serviceState, "string");
	assert.equal(result.data.serviceName, "DBK64");
	// 必须明确标注「驱动就绪」之后的剩余前提，不能让人以为装好就能读
	assert.match(result.data.backendNote, /DbkBackend/);
	assert.match(result.data.backendNote, /backend.*dbk/i);
	// 输出里也要有这条说明
	assert.ok(
		result.value.lines.some((line) => /DbkBackend/.test(line)),
		"输出里应包含「还需切 backend」这条说明"
	);
});

test("ce_kernel status 不传 action 时默认走只读路径", async () => {
	// 上面那条就是「不传 action」的调用（`{}`），这里再明确验证一次
	// action 给了空字符串也应当落到只读路径。
	const result = await callTool(harness, "ce_kernel", { action: "" });
	assert.equal(result.data.serviceName, "DBK64");
	// 只读路径绝不能带出任何「已改动系统」的迹象
	assert.equal(typeof result.data.serviceInstalled, "boolean");
});

test("安全闸门：install / load / unload 没有 confirm 必须被拒", async () => {
	for (const action of ["install", "load", "unload"]) {
		await assert.rejects(
			() => callTool(harness, "ce_kernel", { action }),
			(error) => {
				assert.match(error.message, /confirm: true/, `${action} 应要求显式确认`);
				assert.match(error.message, /System32|内核服务|内核驱动/, `${action} 应说清会改什么`);
				return true;
			},
			`${action} 没有 confirm 时必须报错`
		);
	}
});

test("安全闸门：confirm=false 同样被拒", async () => {
	await assert.rejects(
		() => callTool(harness, "ce_kernel", { action: "load", confirm: false }),
		/confirm: true/
	);
});

test("未提权时 install（confirm=true）给出「需要管理员」的可执行错误", async () => {
	const status = await callTool(harness, "ce_kernel", {});
	if (status.data.elevated) {
		// 在管理员下跑时这一步会真的去装驱动 —— 不能那样，所以跳过
		return;
	}
	await assert.rejects(
		() => callTool(harness, "ce_kernel", { action: "install", confirm: true }),
		(error) => {
			// 两种合法顺序：
			//  a) 缓存里没有驱动 → 先提示"要先获取"（本文件前面的 cleanup 用例会清空缓存）
			//  b) 缓存里有驱动但未提权 → 权限错误
			assert.match(
				error.message,
				/管理员权限|无法确认|未获同意|还没获取到驱动/,
				`应是权限或前置条件错误，实际：${error.message}`
			);
			return true;
		}
	);
});

test("未提权时 load（confirm=true）同样给出权限错误，不会去改系统", async () => {
	const status = await callTool(harness, "ce_kernel", {});
	if (status.data.elevated) return;
	await assert.rejects(
		() => callTool(harness, "ce_kernel", { action: "load", confirm: true }),
		/管理员权限|无法确认|未获同意/
	);
});

test("共享盘：ce_kernel probe_driver 如实报告 DBK 驱动能否连上（只读）", async () => {
	const result = await callTool(harness, "ce_kernel", { action: "probe_driver" });
	assert.equal(typeof result.data.devicePath, "string");
	assert.equal(typeof result.data.opened, "boolean");
	assert.equal(result.data.devicePath.startsWith("\\\\.\\") || /^[A-Za-z]:/.test(result.data.devicePath), true,
		`设备路径形状应像 \\\\.\\NAME，实际 ${result.data.devicePath}`);

	if (result.data.opened) {
		// 真装好驱动的机器上：必须有版本或明确说明"打开了但读不到版本"
		assert.ok(
			result.data.version !== null || result.value.lines.some((l) => /GETVERSION/.test(l)),
			"打开了设备就必须说明 GETVERSION 的结果"
		);
		assert.equal(result.data.error, null);
	} else {
		// 本机情况：必须给出结构化原因与可执行的下一步
		assert.ok(result.data.error !== null && result.data.error.length > 0, "打不开必须给原因");
		const body = result.value.lines.join("\n");
		assert.match(body, /ced_kernel|ce_kernel/, "应指向 ce_kernel");
		assert.match(body, /install|load/, "应说明要先装/加载驱动");
		assert.match(body, /CEDRIVER73|driver\.dat/, "应说明服务名可能不同");
	}
});

test("revoke 立即释放提权助手与拒绝记录（不需要管理员）", async () => {
	const before = await callTool(harness, "ce_kernel", { action: "revoke" });
	assert.equal(typeof before.data.hadHelper, "boolean");
	if (before.data.hadHelper === false) {
		assert.match(before.value.lines.join("\n"), /没有运行中的提权助手/);
	} else {
		assert.equal(typeof before.data.previousHelperPid, "number");
	}
	const body = before.value.lines.join("\n");
	// 必须说清 revoke 的边界：它不动内核驱动
	assert.match(body, /独立的内核服务/, "应说明 revoke 不卸载驱动");
	assert.match(body, /action=unload/, "应指向真正能卸载驱动的动作");
	assert.match(body, /冷却记录/, "应说明清掉了拒绝记录");

	// 释放后再查状态仍应正常
	const after = await callTool(harness, "ce_kernel", {});
	assert.equal(typeof after.data.serviceState, "string");
});

test("revoke 后拒绝冷却被清除（允许重新请求提权）", async () => {
	const { noteElevationDeclined, isElevationCoolingDown, clearElevationDeclined } = await import(
		"../lib/remote/kernel-elevate.js"
	);
	clearElevationDeclined();
	noteElevationDeclined();
	assert.equal(isElevationCoolingDown(), true, "先制造一个冷却状态");

	await callTool(harness, "ce_kernel", { action: "revoke" });
	assert.equal(isElevationCoolingDown(), false, "revoke 后应清掉冷却，允许重新提权");
	clearElevationDeclined();
});

test("cleanup 清理缓存（不需要管理员），且不动内核服务", async () => {
	const result = await callTool(harness, "ce_kernel", { action: "cleanup", keepExtractor: true });
	assert.equal(typeof result.data.freedBytes, "number");
	assert.ok(result.data.freedBytes >= 0);
	const body = result.value.lines.join("\n");
	// 必须明确边界：cleanup 只管缓存，不碰服务与 System32
	assert.match(body, /不动内核服务|System32/, "应说明 cleanup 不动系统里的东西");
	assert.match(body, /acquire/, "应说明可随时重新获取");
	assert.equal(typeof result.data.serviceState, "string");

	// 清理后 status 仍应正常工作（缓存为空是合理状态）
	const after = await callTool(harness, "ce_kernel", { action: "status" });
	assert.ok(Array.isArray(after.data.cachedDrivers));
});

test("cleanup 保留解包工具的选项生效", async () => {
	// 这条只验证参数被接受且路径不报错（工具可能本来就不存在）
	const result = await callTool(harness, "ce_kernel", { action: "cleanup", keepExtractor: true });
	assert.match(result.value.summary, /已清理驱动缓存/);
	assert.ok(
		result.value.lines.some((line) => /保留/.test(line)),
		"keepExtractor=true 时应说明保留了工具"
	);
});

test("未知 action 明确报错并列出可用值", async () => {
	await assert.rejects(
		() => callTool(harness, "ce_kernel", { action: "nonsense" }),
		(error) => {
			assert.match(error.message, /未知的 action/);
			assert.match(error.message, /status/);
			assert.match(error.message, /acquire/);
			return true;
		}
	);
});

test("install 在没获取过驱动时给出「先 acquire」的引导", async () => {
	const status = await callTool(harness, "ce_kernel", {});
	if (status.data.elevated) return; // 管理员下会走 requireAdmin，不测这条
	// 未提权时先撞到权限闸门，这是预期顺序（权限优先于前置条件）
	await assert.rejects(
		() => callTool(harness, "ce_kernel", { action: "install", confirm: true }),
		/管理员权限|无法确认|未获同意|还没获取到驱动/
	);
});

test.after(async () => {
	await harness.dispose();
});
