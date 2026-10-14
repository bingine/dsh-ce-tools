/**
 * retry.js 的行为验证（不依赖插件宿主，直接单测模块）。
 *
 * 覆盖四种形态：
 * 1. 一次就成功 → 不应有任何重试
 * 2. 校验连续失败 → 应按「递增间隔」重试指定次数，然后返回最后一次结果
 * 3. 写系统调用抛「不可重试」错误（权限不足）→ 必须立刻抛出，不做无谓重试
 * 4. 写系统调用抛「可重试」错误（998）→ 应重试并在成功后返回
 */
import {
	DEFAULT_WRITE_RETRY,
	isRetriableWriteError,
	normalizeRetryOptions,
	withWriteRetry
} from "../lib/retry.js";

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
	checks += 1;
	if (condition) {
		console.log(`  ✅ ${label}`);
	} else {
		failures += 1;
		console.log(`  ❌ ${label}${detail === "" ? "" : `  → ${detail}`}`);
	}
}

/* ---------- 1. 参数规范化 ---------- */
console.log("1) 参数规范化");
{
	const d = normalizeRetryOptions({});
	check("默认重试次数", d.retry === DEFAULT_WRITE_RETRY, `实际 ${d.retry}`);
	check("默认间隔 120ms", d.retryDelayMs === 120, `实际 ${d.retryDelayMs}`);
	check("负数夹成 0", normalizeRetryOptions({ retry: -5 }).retry === 0);
	check("超上限夹到 20", normalizeRetryOptions({ retry: 999 }).retry === 20);
	check("非整数退回默认", normalizeRetryOptions({ retry: 1.5 }).retry === DEFAULT_WRITE_RETRY);
	check("间隔上限夹到 5000", normalizeRetryOptions({ retryDelayMs: 99999 }).retryDelayMs === 5000);
}

/* ---------- 2. 可重试错误的判定 ---------- */
console.log("2) 可重试错误判定");
{
	check("998 ERROR_NOACCESS 可重试", isRetriableWriteError(new Error("Win32 错误 998: ERROR_NOACCESS")));
	check("299 ERROR_PARTIAL_COPY 可重试", isRetriableWriteError(new Error("Win32 error 299")));
	check("权限不足不可重试", !isRetriableWriteError(new Error("Win32 错误 5: 拒绝访问")));
	check("0x80070005 不可重试", !isRetriableWriteError(new Error("0x80070005")));
	check("无关错误不可重试", !isRetriableWriteError(new Error("随便什么错")));
	check("null 不可重试", !isRetriableWriteError(null));
}

/* ---------- 3. 一次成功 ---------- */
console.log("3) 一次成功不应重试");
{
	let calls = 0;
	const r = await withWriteRetry({
		retry: 3,
		retryDelayMs: 1,
		async attempt() {
			calls += 1;
			return { ok: true, value: "done" };
		}
	});
	check("只调用一次", calls === 1, `实际 ${calls}`);
	check("attempts === 1", r.attempts === 1);
	check("无重试记录", r.retries.length === 0);
	check("exhausted === false", r.exhausted === false);
}

/* ---------- 4. 校验持续失败 → 重试到上限 ---------- */
console.log("4) 校验持续失败应重试到上限");
{
	let calls = 0;
	const waited = [];
	const r = await withWriteRetry({
		retry: 3,
		retryDelayMs: 5,
		async attempt() {
			calls += 1;
			return { ok: false, reason: "verify", after: "00" };
		},
		onRetry: (rec) => waited.push(rec.waitedMs)
	});
	check("共尝试 4 次（1 次 + 3 次重试）", calls === 4, `实际 ${calls}`);
	check("attempts === 4", r.attempts === 4);
	check("记录 3 次重试", r.retries.length === 3, `实际 ${r.retries.length}`);
	check("间隔递增 5,10,15", waited.join(",") === "5,10,15", `实际 ${waited.join(",")}`);
	check("exhausted === true", r.exhausted === true);
	check("失败原因是 verify", r.retries.every((x) => x.reason === "verify"));
}

/* ---------- 5. 第 3 次才成功 ---------- */
console.log("5) 重试后成功");
{
	let calls = 0;
	const r = await withWriteRetry({
		retry: 5,
		retryDelayMs: 2,
		async attempt() {
			calls += 1;
			return calls < 3 ? { ok: false } : { ok: true, value: `第${calls}次` };
		}
	});
	check("调用了 3 次", calls === 3, `实际 ${calls}`);
	check("结果来自第 3 次", r.result.value === "第3次");
	check("attempts === 3", r.attempts === 3);
	check("记录 2 次重试", r.retries.length === 2);
}

/* ---------- 6. 不可重试错误立刻抛出 ---------- */
console.log("6) 不可重试错误必须立刻抛出（不浪费重试）");
{
	let calls = 0;
	let caught = null;
	try {
		await withWriteRetry({
			retry: 5,
			retryDelayMs: 1,
			async attempt() {
				calls += 1;
				throw new Error("Win32 错误 5: 拒绝访问");
			}
		});
	} catch (error) {
		caught = error;
	}
	check("只尝试 1 次就放弃", calls === 1, `实际 ${calls}`);
	check("抛出了原错误", caught !== null && /拒绝访问/.test(caught.message));
}

/* ---------- 7. 可重试错误 → 重试后成功 ---------- */
console.log("7) 可重试的写失败应重试");
{
	let calls = 0;
	const r = await withWriteRetry({
		retry: 4,
		retryDelayMs: 2,
		async attempt() {
			calls += 1;
			if (calls === 1) throw new Error("Win32 错误 998: ERROR_NOACCESS");
			return { ok: true, value: "ok" };
		}
	});
	check("调用了 2 次", calls === 2, `实际 ${calls}`);
	check("记录 1 次 error 重试", r.retries.length === 1 && r.retries[0].reason === "error");
	check("成功返回", r.result.value === "ok");
}

/* ---------- 8. 可重试错误耗尽 → 抛原错并附重试历史 ---------- */
console.log("8) 可重试错误耗尽后抛错并带历史");
{
	let caught = null;
	try {
		await withWriteRetry({
			retry: 2,
			retryDelayMs: 1,
			async attempt() {
				throw new Error("Win32 错误 998: ERROR_NOACCESS");
			}
		});
	} catch (error) {
		caught = error;
	}
	check("抛出了错误", caught !== null);
	check("错误里带重试历史", caught !== null && /已重试 2 次/.test(caught.message), caught?.message ?? "");
}

/* ---------- 9. retry=0 时不做任何重试 ---------- */
console.log("9) retry=0 不重试");
{
	let calls = 0;
	const r = await withWriteRetry({
		retry: 0,
		retryDelayMs: 0,
		async attempt() {
			calls += 1;
			return { ok: false };
		}
	});
	check("只调用 1 次", calls === 1, `实际 ${calls}`);
	check("无重试记录", r.retries.length === 0);
	check("exhausted === true", r.exhausted === true);
}

console.log(`\n${failures === 0 ? "✅ 全部通过" : "❌ 有失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
