/**
 * 写入重试：给目标进程的写入操作加「重试次数 + 间隔」参数。
 *
 * ## 为什么需要它
 *
 * 往**运行中的程序**写内存，失败是常态而不是异常：
 *
 * 1. **目标自己把值改回去**：游戏的伤害/血量/金钱每帧由逻辑重算，写进去的值
 *    下一帧就没了 —— 写入调用成功、回读校验却失败。等一下再写往往能成功
 *    （命中两帧之间的空隙），或者成功保持到下一次逻辑更新。
 * 2. **页保护是暂时的**：某些程序会把页临时改成只读（写时复制、反作弊校验），
 *    这一刻写不进去，下一刻就可以了。
 * 3. **目标正在启动/加载**：模块还没映射完时写入会拿到 `ERROR_NOACCESS`(998)
 *    或 `ERROR_PARTIAL_COPY`(299)，进程跑起来后同样的地址就能写。
 *
 * 所以「写 → 回读校验 → 不合格就等一会儿再试」是这里最自然的重试语义，
 * 而不是简单地把一次失败重发一遍。
 *
 * ## 一段要留意的区别：重试「写失败」还是「校验失败」
 *
 * - **写系统调用失败**（抛错）：只对**可重试**的错误码重试（见 `isRetriableWriteError`），
 *   权限不足、地址未映射这类错误重试再多次也没用，会立刻放弃并保留原始建议
 *   （权限错误还会被 `enrichPermissionError` 补上提权/内核驱动的排查方向）。
 * - **写成功但回读不一致**：这是本模块的主要场景，**总是**重试 —— 因为值被目标
 *   改回去恰恰说明「等一下再写就有机会」。
 *
 * ## 默认值为什么是「重试 2 次、间隔 120ms」
 *
 * 体感上「写不进去」多发生在 60fps 游戏里（约 16ms 一帧），几次 120ms 的间隔
 * 足以跨过若干帧；总耗时上限约 0.5 秒，不会让工具调用变得难以忍受。
 * 需要长时间僵持时把 `retry` 调大（上限 20 次，约 6 秒）。
 *
 * @module dsh-cheat-engine/retry
 */

import { setTimeout as sleep } from "node:timers/promises";

/** 重试次数上限（再大也只是让调用卡住，收益很低）。 */
export const MAX_WRITE_RETRY = 20;

/** 默认重试次数（首次之外的额外尝试次数）。 */
export const DEFAULT_WRITE_RETRY = 2;

/** 默认重试间隔（毫秒）。 */
export const DEFAULT_WRITE_RETRY_DELAY_MS = 120;

/** 重试间隔上限（毫秒），防止把宿主卡太久。 */
export const MAX_WRITE_RETRY_DELAY_MS = 5_000;

/**
 * 判断一个写入错误是否**值得重试**。
 *
 * 只放「等一下可能就好了」的错误码，避免对必然失败的写入做无谓重试：
 *
 * | 码 | 含义 | 为什么值得重试 |
 * | --- | --- | --- |
 * | 5 | ERROR_ACCESS_DENIED | 页保护/权限可能只是暂时的 |
 * | 6 | ERROR_INVALID_HANDLE | 目标可能正在重启，句柄短暂失效 |
 * | 998 | ERROR_NOACCESS | 页临时的保护属性不允许写 |
 * | 299 | ERROR_PARTIAL_COPY | 目标正在被换页/加载 |
 * | 487 | ERROR_INVALID_ADDRESS | 地址处在尚未提交的边界，目标继续加载后可用 |
 *
 * 明确**不**重试：`ERROR_NOT_ENOUGH_MEMORY`、参数错误、目标已退出（进程不存在）
 * 这类重试也无解的情况 —— 由「错误码不在表内」自然排除。
 *
 * @param {unknown} error 抛出的错误
 * @returns {boolean}
 */
export function isRetriableWriteError(error) {
	if (error === null || error === undefined) return false;
	const text = String((error && error.message) || error);
	// 已明确判定为权限不足时不再重试：resize 不了权限边界，重试只是浪费时间。
	// （权限问题的出路是提权或内核驱动，由调用方基于 enriched.permissionDenied 给出建议。）
	if (/\bWin32\s*(错误|error)?\s*[:：]?\s*5\b/i.test(text) && /拒绝|denied/i.test(text)) return false;
	if (/0x0*80070005/i.test(text)) return false;
	const codes = [6, 299, 487, 998];
	for (const code of codes) {
		if (new RegExp(`\\bWin32\\s*(错误|error)?\\s*[:：]?\\s*${code}\\b`, "i").test(text)) return true;
	}
	return false;
}

/** 把重试相关的参数规范化（越界值夹到合法区间）。 */
export function normalizeRetryOptions(args = {}) {
	const retryRaw = args.retry;
	let retry;
	if (retryRaw === undefined || retryRaw === null) {
		// 没给 → 用默认（额外重试 2 次）
		retry = DEFAULT_WRITE_RETRY;
	} else if (!Number.isFinite(retryRaw) || !Number.isInteger(retryRaw)) {
		// 给了但不是整数（例如 1.5、"abc"）→ 退回默认，并让人能看出参数没被采纳
		retry = DEFAULT_WRITE_RETRY;
	} else {
		// 给了整数：负数夹成 0。
		// 这里刻意**不**退回默认值 —— `retry: -1` 的意图显然是「少重试」，
		// 退回默认 2 次会拧成「多试两次」，方向正好相反（踩过）。
		retry = Math.max(0, Math.min(retryRaw, MAX_WRITE_RETRY));
	}

	const delayRaw = args.retryDelayMs;
	const retryDelayMs = Number.isFinite(delayRaw) && delayRaw >= 0
		? Math.min(Math.floor(delayRaw), MAX_WRITE_RETRY_DELAY_MS)
		: DEFAULT_WRITE_RETRY_DELAY_MS;
	return { retry, retryDelayMs };
}

/**
 * 带重试的「写 + 回读校验」。
 *
 * `attempt` 每次调用都要**自己完成写入与回读校验**，并按下面的约定返回：
 * - 校验通过 → `{ ok: true, ... }`，循环立即结束；
 * - 写成功但校验不通过 → `{ ok: false, reason: "verify", ... }`，必重试；
 * - 写系统调用失败 → 直接**抛错**，是否重试由 `isRetriableWriteError` 决定。
 *
 * @template T
 * @param {object} options
 * @param {(attemptIndex: number) => Promise<T & { ok: boolean }>} options.attempt 单次尝试
 * @param {number} options.retry 额外重试次数
 * @param {number} options.retryDelayMs 重试间隔（毫秒）
 * @param {(attemptIndex: number, total: number, delayMs: number, last: object|Error) => string} [options.describeRetry]
 *        生成「这次为什么重试」的一行说明（会进工具输出，便于排查）
 * @param {(error: unknown, attemptIndex: number) => boolean} [options.retriableError]
 *        自定义「这个错误是否值得重试」；默认用 `isRetriableWriteError`
 * @param {(record: object) => void} [options.onRetry] 每次决定重试时回调（用于实时记录）
 * @returns {Promise<{ result: T, attempts: number, retries: Array<object> }>}
 */
export async function withWriteRetry(options) {
	const retry = Number.isInteger(options.retry) && options.retry > 0 ? options.retry : 0;
	const delayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : 0;
	const retriableError = options.retriableError ?? ((error) => isRetriableWriteError(error));

	/** @type {Array<object>} */
	const retries = [];
	/** 最后一次失败的形态：Error（写失败）或 attempt 的返回值（校验失败）。 */
	let lastFailure = null;

	for (let attemptIndex = 0; attemptIndex <= retry; attemptIndex += 1) {
		let outcome = null;
		let thrown = null;
		try {
			outcome = await options.attempt(attemptIndex);
		} catch (error) {
			thrown = error;
		}

		if (thrown === null && outcome !== null && outcome.ok === true) {
			return { result: outcome, attempts: attemptIndex + 1, retries, exhausted: false };
		}

		lastFailure = thrown ?? outcome;
		const isLast = attemptIndex === retry;
		if (isLast) break;

		// 写系统调用失败时，先判断是否值得重试；不值得就立刻把原错抛出去
		// （例如权限不足 —— 重试不会让权限变大，反而掩盖真正的原因）
		if (thrown !== null && !retriableError(thrown, attemptIndex)) {
			throw thrown;
		}

		// 递增间隔：第 n 次重试等 n×delayMs。目标每帧改回值时，
		// 固定间隔容易恰好踩在同一个相位上反复失败。
		const wait = delayMs * (attemptIndex + 1);
		const record = {
			attempt: attemptIndex + 1,
			reason: thrown !== null ? "error" : "verify",
			message: thrown !== null ? String(thrown.message ?? thrown) : "回读校验不一致",
			waitedMs: wait
		};
		if (options.describeRetry !== undefined) record.note = options.describeRetry(attemptIndex + 1, retry, wait, lastFailure);
		retries.push(record);
		if (options.onRetry !== undefined) options.onRetry(record);
		if (wait > 0) await sleep(wait);
	}

	// 全部尝试都没成功。
	// - 写系统调用失败 → 沿用原错抛出去（调用方可能还要做 enrichPermissionError 之类处理）
	// - 写成功但校验始终不一致 → 把最后一次的 attempt 结果交给调用方，由它决定怎么报
	if (lastFailure instanceof Error) {
		if (retries.length > 0) {
			lastFailure.message +=
				`\n（已重试 ${retries.length} 次，间隔递增：${retries.map((r) => `${r.waitedMs}ms`).join(" → ")}）`;
		}
		throw lastFailure;
	}
	if (lastFailure === null || lastFailure === undefined) {
		throw new Error("写入重试失败：没有任何一次尝试产生结果（这是插件内部错误，请报告）。");
	}
	return { result: lastFailure, attempts: retry + 1, retries, exhausted: true };
}
