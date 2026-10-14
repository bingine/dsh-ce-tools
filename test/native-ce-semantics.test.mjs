/**
 * C：`ce_processes` 在**两个后端下的语义必须都如实**。
 *
 * ## 曾经的契约违背
 *
 * `ce_processes` 的 description 承诺「pid / 名字 / 线程数」，self 后端给的是**真实线程数**；
 * 而 `native-ce-backend.ts` 的 `listProcesses` 把 `parentPid`/`threadCount` **硬编码成 0** ——
 * ceserver 的 `PROCESS32NEXT` 响应（`{int result; int pid; int processnamesize; char name[]}`）
 * 里确实只有 pid + 名字，根本没有这两个字段。
 *
 * 于是同一个工具在两个后端下语义不一致，而且 native-ce 侧给出的是
 * **看起来像真值的假值**（"每个进程都恰好 0 个线程"），调用方完全看不出是"后端不支持"。
 *
 * 现在改成如实报"未知"，所以这里钉三件事：
 *   1. native-ce：`threads` / `parentPid` 是 `null`（**不是 0**），输出显示「未知」；
 *   2. self：仍然是真实值（> 0），输出不出现「未知」；
 *   3. description 明确写出这条后端差异。
 *
 * ## 怎么在没有真 ceserver 的情况下测
 *
 * 起一个**假 ceserver**：只实现进程枚举要用的两条命令
 * （`CREATETOOLHELP32SNAPSHOT`=4、`PROCESS32NEXT`=6），
 * 用真实的 `NativeCeBackend` 连它。这样被测代码路径是**真的**，
 * 只有"对端"是假的 —— 比断言源码里没有 `0` 有力得多。
 *
 * 运行：node --test test/native-ce-semantics.test.mjs
 */
import assert from "node:assert/strict";
import net from "node:net";
import test, { after } from "node:test";

import { callTool, createHarness } from "./helpers/harness.mjs";

/** 假 ceserver 里"进程表"的内容。 */
const FAKE_PROCESSES = [
	{ pid: 111, name: "alpha.exe" },
	{ pid: 222, name: "beta.exe" }
];

/**
 * 起一个只支持进程枚举的假 ceserver。
 *
 * 协议要点（严格对齐 `ceserver.h` / 后端的读取顺序）：
 *   - **每条命令一个独立连接**，服务端写完就关；
 *   - `CREATETOOLHELP32SNAPSHOT`(4)：请求 1+4+4 字节，回 4 字节 int32 句柄；
 *   - `PROCESS32NEXT`(6)：请求 1+4 字节，回 `{result, pid, processnamesize}`（12 字节）；
 *     `result === 0` 表示枚举结束；`result !== 0` 且 `processnamesize > 0` 时，
 *     调用方会**用同一条命令再发一次**来取名字，所以服务端要按调用次序交替应答。
 *
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startFakeCeserver() {
	const server = net.createServer();
	/** PROCESS32NEXT 的全局调用序号（跨连接累积，因为每条命令都是新连接）。 */
	let nextCall = 0;

	server.on("connection", (socket) => {
		let buffer = Buffer.alloc(0);
		let answered = false;
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (answered) return;
			const cmd = buffer[0];
			if (cmd === 4) {
				if (buffer.length < 9) return;
				answered = true;
				const out = Buffer.alloc(4);
				out.writeInt32LE(0x7f, 0); // 随便给一个非零句柄
				socket.end(out);
				return;
			}
			if (cmd === 6) {
				if (buffer.length < 5) return;
				answered = true;
				const entryIndex = Math.floor(nextCall / 2);
				const isHead = nextCall % 2 === 0;
				nextCall += 1;

				const entry = FAKE_PROCESSES[entryIndex];
				if (entry === undefined) {
					// 枚举结束：result = 0
					const out = Buffer.alloc(12);
					out.writeInt32LE(0, 0);
					socket.end(out);
					return;
				}
				const nameBytes = Buffer.from(entry.name, "utf8");
				if (isHead) {
					const out = Buffer.alloc(12);
					out.writeInt32LE(1, 0);
					out.writeInt32LE(entry.pid, 4);
					out.writeInt32LE(nameBytes.length, 8);
					socket.end(out);
					return;
				}
				const out = Buffer.alloc(12 + nameBytes.length);
				out.writeInt32LE(1, 0);
				out.writeInt32LE(entry.pid, 4);
				out.writeInt32LE(nameBytes.length, 8);
				nameBytes.copy(out, 12);
				socket.end(out);
				return;
			}
			// 其它命令本测试不涉及：直接关闭，让调用方明确失败
			answered = true;
			socket.end(Buffer.alloc(0));
		});
		socket.on("error", () => socket.destroy());
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: server.address().port,
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					})
			});
		});
	});
}

const cleanups = [];
after(async () => {
	for (const fn of cleanups.reverse()) {
		try {
			await fn();
		} catch {
			/* 忽略 */
		}
	}
});

test("ce_processes 的 description 必须写明 native-ce 不提供线程数/父进程 pid", () => {
	const harness = createHarness({});
	cleanups.push(() => harness.dispose());
	const definition = harness.tools.get("ce_processes");
	assert.ok(definition !== undefined, "应当注册了 ce_processes");
	assert.match(
		definition.description,
		/native-ce|ceserver/,
		`description 必须说明后端差异：${definition.description}`
	);
	assert.match(
		definition.description,
		/未知|threadsKnown/,
		`description 必须说明该后端下这些字段是"未知"：${definition.description}`
	);
});

test("native-ce 后端：threads / parentPid 如实标为未知（键缺失 + known:false），绝不是 0", async () => {
	const fake = await startFakeCeserver();
	cleanups.push(() => fake.close());
	const harness = createHarness({ backend: "native-ce", ceserverPort: fake.port });
	cleanups.push(() => harness.dispose());

	const all = await callTool(harness, "ce_processes", { limit: 50 });
	assert.equal(all.data.total, FAKE_PROCESSES.length, `应当枚举到假 ceserver 的进程：\n${all.text}`);
	assert.deepEqual(
		all.data.processes.map((p) => p.pid),
		[111, 222]
	);
	for (const process of all.data.processes) {
		// ⚠️ 「未知」在本插件的信封里表达为**键缺失 + 显式 known 标志**，不是 `null`。
		// 原因：`lib/toolkit.js` 的 `toJsonSafe`（工具出口统一走它）会把 `null` 当成
		// "没有值"一并丢掉，这是全插件范围的既定契约（见该文件里的说明），
		// 改它会波及所有工具的 data 形状，不该为一个字段去做。
		// 关键点是：**绝不能出现 0**（那是"看起来像真值的假值"）。
		assert.equal(
			"threads" in process,
			false,
			`native-ce 不提供线程数，该键必须缺失（绝不能是 0）。实际 ${JSON.stringify(process)}`
		);
		assert.equal(
			"parentPid" in process,
			false,
			`native-ce 不提供父进程 pid，该键必须缺失。实际 ${JSON.stringify(process)}`
		);
		assert.equal(process.threadsKnown, false, `必须显式标注线程数未知：${JSON.stringify(process)}`);
		assert.equal(process.parentPidKnown, false, `必须显式标注父 pid 未知：${JSON.stringify(process)}`);
	}
	// 输出里不能出现"线程 0"这种伪真值，必须写"未知"
	assert.doesNotMatch(all.text, /线程\s*0/, `不能报「线程 0」这种伪真值：\n${all.text}`);
	assert.match(all.text, /未知/, `必须显示「未知」：\n${all.text}`);
	assert.equal(all.data.threadsKnown, false, "应当明确标注线程数未知");
});

test("self 后端：同一工具给的是真实值（> 0），且不出现「未知」", async () => {
	const harness = createHarness({ backend: "self" });
	cleanups.push(() => harness.dispose());

	const all = await callTool(harness, "ce_processes", { limit: 200 });
	assert.ok(all.data.total > 0, "self 后端应当能枚举到本机进程");
	assert.equal(all.data.threadsKnown, true, "self 后端提供真实线程数");

	const self = all.data.processes.find((p) => p.pid === process.pid);
	if (self !== undefined) {
		assert.ok(
			typeof self.threads === "number" && self.threads > 0,
			`本进程线程数必须是真实的正数：${JSON.stringify(self)}`
		);
		assert.ok(
			typeof self.parentPid === "number" && self.parentPid > 0,
			`本进程父 pid 必须是真实的正数：${JSON.stringify(self)}`
		);
	}
	assert.doesNotMatch(all.text, /未知/, `self 后端不该出现「未知」：\n${all.text}`);
});
