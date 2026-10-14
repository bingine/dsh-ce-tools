/**
 * **长任务的实时进度**（目前用于 `ce_kernel acquire` 的下载/解包）。
 *
 * ## 为什么需要
 *
 * 早先 `acquireDriver` 会把阶段回调攒进数组，**全部结束**才随返回值给出。
 * 而下载官方安装包要几十秒到几分钟 —— 期间用户看到的是**"卡住"**：
 * 既不知道在干什么，也不知道还要多久，更无法判断是不是死了。
 *
 * 这里把进度写进一个**进程内状态**，由宿主路由暴露出去，
 * 界面（或下一次工具调用）可以随时读到"当前在哪个阶段、进度多少"。
 *
 * ## 设计取舍
 *
 *   · **进程内、单槽位**：内核驱动的获取是一个独占的长操作，
 *     同时跑两个没有意义。所以只保留"最近一次"的进度，不建任务表。
 *   · **不落盘**：进度是瞬时的，重启后没有意义；落盘反而多一处要清理的状态。
 *   · **只读暴露**：宿主路由只能读，不能改 —— 防止外部把进度改成假的。
 *   · **完成/失败后保留一小段时间**：让界面能显示"刚刚完成"，
 *     而不是一瞬间就消失（否则用户会以为没发生过）。
 *
 * @module dsh-ce-tools/progress
 */

/**
 * 当前进度快照的形状：
 * `{ active, task, phase, detail, steps, startedAt, finishedAt, ok, message }`
 */
let current = null;

/** 完成后保留多久（毫秒）——让界面有机会显示"刚完成"。 */
const KEEP_FINISHED_MS = 60 * 1000;

/** 取当前进度快照（只读；没有则返回 `null`）。 */
export function kernelProgressSnapshot() {
	if (current === null) return null;
	// 完成很久了就丢掉，免得界面一直显示一条陈旧的"已完成"
	if (current.active !== true && typeof current.finishedAt === "number" && Date.now() - current.finishedAt > KEEP_FINISHED_MS) {
		current = null;
		return null;
	}
	return {
		active: current.active,
		task: current.task,
		phase: current.phase,
		detail: current.detail,
		steps: [...current.steps],
		startedAt: current.startedAt,
		finishedAt: current.finishedAt,
		elapsedMs: (current.finishedAt ?? Date.now()) - current.startedAt,
		ok: current.ok,
		message: current.message
	};
}

/**
 * 开始跟踪一个长任务。
 *
 * @param {string} task 任务名（例如 `acquire`）
 * @returns {{ step: (phase: string, detail?: unknown) => void, done: (message?: string) => void, fail: (message: string) => void }}
 */
export function beginKernelProgress(task) {
	current = {
		active: true,
		task,
		phase: "开始时",
		detail: null,
		steps: [],
		startedAt: Date.now(),
		finishedAt: null,
		ok: null,
		message: null
	};
	const started = current;

	return {
		/** 报告一个阶段。`detail` 会被截断，避免把整条 URL 塞进状态。 */
		step(phase, detail) {
			if (current !== started) return; // 已被更新的任务取代，别再改
			started.phase = String(phase);
			started.detail = detail === undefined || detail === null ? null : String(detail).slice(0, 200);
			started.steps.push({ at: Date.now(), phase: started.phase, detail: started.detail });
		},
		/** 标记成功完成。 */
		done(message) {
			if (current !== started) return;
			started.active = false;
			started.ok = true;
			started.phase = "已完成";
			started.message = message === undefined ? null : String(message).slice(0, 200);
			started.finishedAt = Date.now();
		},
		/** 标记失败。 */
		fail(message) {
			if (current !== started) return;
			started.active = false;
			started.ok = false;
			started.phase = "失败";
			started.message = String(message).slice(0, 200);
			started.finishedAt = Date.now();
		}
	};
}

/** 清掉进度状态（测试用；也便于将来加一个"清除"入口）。 */
export function resetKernelProgress() {
	current = null;
}
