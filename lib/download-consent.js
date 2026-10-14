/**
 * **下载**的同意闸门。
 *
 * ## 为什么下载也要问
 *
 * 提权有闸门（`askToElevate`），但 `ce_kernel action=acquire` 早先**没有任何确认**：
 * 模型可以自主发起一次外部网络下载（从 cheatengine.org 抓页面 → 解析直链 →
 * 下载一个约 100–200MB 的安装包 → 解包出驱动到插件缓存）。
 *
 * 它**不碰系统**（不写 System32、不建内核服务），所以不像提权那样危险；
 * 但它仍然会：消耗带宽、在磁盘上留下大文件、产生外部网络请求 ——
 * 这些都不该由模型单方面决定。
 *
 * 所以这里补一道与提权同规格的闸门：**问一次，明确同意才下**。
 *
 * ## 与 `askToElevate` 的关系（刻意保持一致）
 *
 *   · 同样 fail-closed：拿不到 `agent` 会话或 `user-questions` 服务 → **拒绝**；
 *   · 同样用**选项 id** 判定（`approve` / `decline`），**绝不看文案** ——
 *     "靠文案判断同意"是这个项目真实踩过的坑（回退版把"只讲解"当成了同意）；
 *   · 默认选 `decline`。
 *
 * 差别只在措辞与选项集：这里不下"权限边界"的结论，而是讲清**会发生什么**。
 *
 * @module dsh-cheat-engine/download-consent
 */

/** 同意 / 不同意两个选项。id 稳定，判定只看 id。 */
export const DOWNLOAD_OPTIONS = Object.freeze([
	Object.freeze({
		id: "decline",
		label: "不下载（推荐）",
		description: "不发起任何下载。已有缓存时会直接复用缓存里的文件。"
	}),
	Object.freeze({
		id: "approve",
		label: "同意下载",
		description: "从 cheatengine.org 解析官方安装包直链并下载（约 100–200MB），解包出 DBK64.sys 到插件缓存。不改动系统。"
	})
]);

/**
 * 从 `userQuestions.ask` 的返回里解出用户的选择。
 *
 * 只认 **id**；取不到 id 时再退回按 label 匹配（兼容不同 DSH 版本的返回形状），
 * 但**绝不**因为"返回了任何东西"就当成同意。
 *
 * @param {unknown} answer `userQuestions.ask` 的返回
 * @returns {{ id: string, label: string }}
 */
export function resolveDownloadChoice(answer) {
	// 真实形状（dsh-user-questions 的契约）：
	//   { answers: [{ id: string, selected: string[], custom?: string }] }
	// 要点：**`answers` 是数组**，**`selected` 里装的是"选项标签"**（不是 id），
	// 用户自己输入的内容在 `custom`。
	//
	// ⚠️ 早先我按 `answers.download.id` 这种形状取，三个分支全不命中，
	// 于是**永远走兜底的"拒绝"** —— 安全上没错（fail-closed），
	// 但实测时用户明明选了自定义项，却被告知"你选择了不下载"，
	// 而他根本没做过这个选择。这就是那个 bug。
	//
	// 兼容性：`answers` 也可能被某些实现换成以 id 为键的对象，所以两种都收。
	const list = Array.isArray(answer?.answers)
		? answer.answers
		: answer?.answers !== null && typeof answer?.answers === "object"
			? Object.values(answer.answers)
			: [];
	const first =
		list.find((item) => item !== null && typeof item === "object" && item.id === "download") ??
		list.find((item) => item !== null && typeof item === "object" && item.selected !== undefined) ??
		list[0];
	const selected = Array.isArray(first?.selected) ? first.selected[0] : first?.selected;

	// 取出用于比对的原始值：对象取 id 优先、其次 label；标量直接用
	// （与 get-admin 的 resolveChoice 同一套判断顺序，避免两处再次漂移）
	const rawId = selected !== null && typeof selected === "object" ? selected.id : selected;
	const rawLabel = selected !== null && typeof selected === "object" ? selected.label : selected;

	for (const option of DOWNLOAD_OPTIONS) {
		if (rawId !== undefined && rawId !== null && String(rawId) === option.id) return { id: option.id, label: option.label };
	}
	for (const option of DOWNLOAD_OPTIONS) {
		if (rawLabel !== undefined && rawLabel !== null && String(rawLabel) === option.label) return { id: option.id, label: option.label };
	}

	// 用户自己输入了内容（`custom`）——**不自动当成同意**。
	//
	// 刻意这样做：自由文本无法可靠判定意图（"别下" 与 "可以下" 都是中文），
	// 而这是一个会产生外部网络请求与磁盘占用的动作，宁可让他重选一次，
	// 也不能凭关键词猜。如实说明"没看懂你的输入"比猜错安全得多。
	if (typeof first?.custom === "string" && first.custom.trim() !== "") {
		return {
			id: "decline",
			label: "不下载（你输入了自定义内容，但无法据此判断是否同意）",
			custom: first.custom.trim().slice(0, 120)
		};
	}

	// 认不出来 → 一律按**不同意**处理（fail-closed）
	return { id: "decline", label: "不下载（未能识别你的选择）" };
}

/**
 * 询问是否允许下载。
 *
 * @param {object|undefined} userQuestions `ctx.userQuestions`
 * @param {object} exec 工具执行上下文（需要 `exec.agent`）
 * @param {{ what?: string, bytes?: number|null }} [context] 说明这次要下什么
 * @returns {Promise<{ approved: boolean, reason: string }>}
 */
export async function askToDownload(userQuestions, exec, context = {}) {
	const what = context.what ?? "Cheat Engine 官方安装包";
	if (exec === undefined || exec.agent === undefined) {
		return {
			approved: false,
			reason:
				"当前调用没有可用的 agent 会话，无法向你确认是否下载，因此**不发起任何下载**。\n" +
				"（这是刻意设计：下载会产生外部网络请求与磁盘占用，不该在无人确认时自动进行。）"
		};
	}
	if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
		return {
			approved: false,
			reason:
				"当前 profile 没有 user-questions 服务，无法征求同意，因此**不发起任何下载**。\n" +
				"如需下载，请在有交互会话的界面里重试，或改为提供一个本地安装包（参数 localInstaller）。"
		};
	}

	const answer = await userQuestions.ask({
		questions: [
			{
				id: "download",
				header: "需要下载文件",
				question:
					`要获取内核驱动，需要先从 cheatengine.org 下载${what}（约 100–200MB）并解包。\n` +
					"这一步**不会改动你的系统**（不写 System32、不创建内核服务），只会在插件缓存目录留下文件。\n" +
					`${context.bytes === undefined || context.bytes === null ? "" : `当前网络已声明大小约 ${context.bytes} 字节。\n`}` +
					"是否允许这次下载？",
				options: DOWNLOAD_OPTIONS.map((o) => ({ id: o.id, label: o.label, description: o.description }))
			}
		],
		agent: exec.agent,
		signal: exec.signal
	});

	const choice = resolveDownloadChoice(answer);
	const approved = choice.id === "approve";
	return {
		approved,
		reason: approved
			? `已获同意（你选择了「${choice.label}」），开始下载。`
			: `未获同意（你选择了「${choice.label}」），未发起任何下载。\n` +
				"如果本机已有缓存或本地安装包，可以改用 localInstaller 参数，或先手动下载后再来。"
	};
}
