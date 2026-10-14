/**
 * `dsh-ce-tools` 的**客户端（浏览器）部分** —— 长任务进度条。
 *
 * ## ⚠️ 这个文件必须是 `__ModuleLoader__` 包装，不能写 ESM 的 `export`
 *
 * 客户端插件由浏览器**直接执行**（没有模块系统），DSH 约定的入口形状是：
 *     window.__ModuleLoader__.load({ id, factory: (require) => { … exports.apply … } });
 * 而服务端插件（`lib/index.js`）才用 `export function apply` / `export const inject`。
 *
 * 我重构这个文件时曾误用 ESM `export`，结果宿主报 `dsh-cheat-engine: import failed`、
 * 浏览器报 `Unexpected token 'export'`，**整个应用起不来**。
 * 两种入口形状不能混，改这里时务必保持包装，`test/client-entry.test.mjs` 会拦住这种错。
 *
 * ## 为什么需要这个界面
 *
 * `ce_kernel action=acquire` 要下载约 100–200MB 的官方安装包，耗时几十秒到几分钟。
 * 而工具调用期间**没有标准的进度回传通道**，所以早先用户看到的就是**"卡住"**：
 * 不知道在干什么、还要多久、是不是死了。
 *
 * 现在宿主把进度写进 `/cheat-engine/status` 的 `progress` 字段
 * （见服务端 `lib/progress.js`），这里轮询它并画一个进度条。
 *
 * ## 设计取舍
 *
 *   · **纯 DOM，不用 React**：浮层是固定定位的独立元素，用 React 反而要处理
 *     portal 与生命周期；DSH 的 slot 注册只是"触发挂载"，挂载后自己管 DOM 最省事。
 *     （`dsh-get-admin` 的右下角图标是同一套做法，这里沿用。）
 *   · **底部居中**：`dsh-get-admin` 的状态图标占了右下角（`right:16px; bottom:18px`），
 *     这个进度条放底部居中，两者**不重叠**。
 *   · **不做假百分比**：宿主目前只报"阶段"，不报总字节数。画一个假的百分比
 *     比不画更糟 —— 用户会据此判断还要多久。所以用不确定进度的滑动条。
 *   · **失败要显眼且停留更久**，否则用户会以为没发生过。
 */
window.__ModuleLoader__.load({
	// ⚠️ 这个 id **必须等于 npm 包名**，否则客户端模块会**重复注册**并让整个 web boot 失败：
	//   `client-modules: duplicate factory registration for "dsh-cheat-engine"
	//    (bundle executed twice without invalidate?)`
	// 这里曾写死 `dsh-cheat-engine`，而发布时因 npm 封禁 "cheat-engine" 一词，
	// 包名改成了 `dsh-ce-tools` —— 不一致就导致**应用打不开**。
	// 改包名时务必同步这里；`test/client-entry.test.mjs` 会检查 id 与 package.json 一致。
	id: "dsh-ce-tools",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 状态路由（只读）。与服务端 lib/index.js 的 STATUS_PATH 成对维护。 */
		const STATUS_API = "/cheat-engine/status";
		/** 轮询间隔：仅在页面可见时按此间隔轮询。 */
		const POLL_MS = 2000;
		/** 完成后继续显示多久（让用户看到"刚完成"）；失败停留更久。 */
		const HIDE_AFTER_MS = 5000;
		const HIDE_AFTER_FAIL_MS = 15000;
		const LAYER_ID = "dsh-ce-progress-layer";

		/** 挂载点槽位（与 get-admin 用同一个 dock 槽位，但元素定位不同、不重叠）。 */
		const SLOT = "conversation.input.dock";

		/** 统一记录并吞掉装配期异常：客户端插件抛错会让整个界面白屏。 */
		const guard = (what, run) => {
			try {
				return run();
			} catch (error) {
				console.warn(`[cheat-engine] ${what} 失败：`, error);
				return undefined;
			}
		};

		/** 把宿主的英文阶段名映射成中文。 */
		const PHASE_LABEL = {
			unpack: "解包工具",
			download: "下载安装包",
			extract: "解出驱动",
			开始时: "准备中",
			已完成: "已完成",
			失败: "失败"
		};

		/** 把毫秒格式化成"1分23秒"。 */
		function formatElapsed(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
			const total = Math.floor(ms / 1000);
			const minutes = Math.floor(total / 60);
			const seconds = total % 60;
			return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
		}

		/**
		 * 读宿主的进度。
		 *
		 * 失败一律返回 `null`：界面据此隐藏，而不是显示一个假的进度。
		 */
		async function fetchProgress(signal) {
			try {
				const response = await fetch(STATUS_API, { method: "GET", signal, headers: { accept: "application/json" } });
				if (!response.ok) return null;
				const body = await response.json();
				return body?.progress ?? null;
			} catch {
				return null;
			}
		}

		//#region 样式与 DOM
		/**
		 * 把浮层的全部关键样式**内联**写死在元素上（CSSOM），不依赖任何样式表。
		 *
		 * ## 为什么不用 `<style>`（真实踩过的坑，与 `dsh-get-admin` 同根因）
		 *
		 * 这里原本把 CSS 插进 `<head>`（`ensureStyle()`）。那张表**不归我们掌控**：
		 * 宿主的客户端模块系统（`@deepseek-ai/dsh-client-modules`）在**物化插件**时
		 * 会把文档里所有**没有 `data-plugin` 标记**的 `<style>` 认领给这个插件，
		 * 再在它卸载时按 `data-plugin` **批量删除**：
		 *
		 *     removeOwnedStyles(id) {
		 *       for (const el of document.querySelectorAll("style[data-plugin]"))
		 *         if (el.getAttribute("data-plugin") === id) el.remove();
		 *     }
		 *     const claimStyles = (id) => {
		 *       // "…any untagged tag is claimed for the materializing plugin"
		 *       for (const el of document.querySelectorAll("style:not([data-plugin])"))
		 *         el.setAttribute("data-plugin", id);
		 *     };
		 *
		 * **本插件正是受害者，且证据就在用户实测的 DOM 里**：
		 *     <style id="dsh-ce-progress-layer-style" data-plugin="dsh-get-admin">
		 * 这张表装的是**本插件的进度浮层 CSS**，却被标成了 `dsh-get-admin` ——
		 * 而两个插件的源码都只设 `id`、**从不设 `data-plugin`**，所以这个标记
		 * 只可能是宿主认领时打上的，且认领错了对象。
		 * 后果：**`dsh-get-admin` 被热重载时会连带删掉本插件的样式表。**
		 *
		 * 而浮层容器是 `document.body` 上的 `<div>`，**不归宿主 HMR 管**、
		 * 也不会被一起删掉 —— 于是"表没了、元素还在"：
		 *   · `position:fixed;left:50%;bottom:18px` 丢失 → 掉到普通流里（左下角）；
		 *   · 内层 `.ce-row/.ce-title` 布局全乱；
		 *   · **`display:none` 也失效** → 没有任务时浮层也一直挂在屏幕上；
		 *   · `@keyframes` 丢失 → 进度条不动。
		 *
		 * ## 代价（两处，都已处理）
		 *
		 *   · `@keyframes` **无法内联** → 滑动动画改用 **Web Animations API**
		 *     （`el.animate()`，纯 JS，同样不依赖样式表）；
		 *   · 状态相关外观（终态边框色、进度条在终态隐藏、整体显隐）
		 *     原本是 CSS 选择器 → 改由 `applyState()` 显式设置。
		 *
		 * 注意本函数是**幂等**的，且对"上一版代码建的旧节点"同样有效 ——
		 * 热重载后旧节点可能还在（没有内联样式），必须能重新套一遍。
		 */
		function applyLayerStyles(root) {
			// 容器：底部居中（右下角被 get-admin 的状态图标占了，两者不重叠）。
			// 丢了 position/left/bottom/transform 就会掉到左下角。
			Object.assign(root.style, {
				position: "fixed",
				left: "50%",
				bottom: "18px",
				transform: "translateX(-50%)",
				zIndex: "2147483000",
				// ⚠️ 显隐开关：原本是 CSS 里的 `display:none` + `[data-state=…]{display:block}`，
				// 现在由 `applyState()` 按状态显式设置（默认先收起）。
				display: "none",
				minWidth: "280px",
				maxWidth: "min(520px, 92vw)",
				padding: "10px 14px",
				borderRadius: "10px",
				boxSizing: "border-box",
				fontSize: "12px",
				lineHeight: "1.5",
				fontFamily: "inherit",
				background: "var(--dsw-alias-bg-elevated, #1f2430)",
				color: "var(--dsw-alias-label-primary, #e8eaed)",
				border: "1px solid var(--dsw-alias-border-secondary, #3a4150)",
				boxShadow: "0 6px 24px rgba(0,0,0,.28)"
			});

			const row = root.querySelector(".ce-row");
			if (row !== null) Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px" });

			const title = root.querySelector(".ce-title");
			if (title !== null) {
				Object.assign(title.style, {
					fontWeight: "600",
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap"
				});
			}

			const spacer = root.querySelector(".ce-spacer");
			if (spacer !== null) spacer.style.flex = "1";

			const elapsed = root.querySelector(".ce-elapsed");
			if (elapsed !== null) Object.assign(elapsed.style, { opacity: "0.72", whiteSpace: "nowrap" });

			const detail = root.querySelector(".ce-detail");
			if (detail !== null) {
				Object.assign(detail.style, {
					marginTop: "4px",
					fontSize: "11px",
					opacity: "0.72",
					wordBreak: "break-all"
				});
			}

			const bar = root.querySelector(".ce-bar");
			if (bar !== null) {
				Object.assign(bar.style, {
					marginTop: "8px",
					height: "4px",
					borderRadius: "2px",
					overflow: "hidden",
					background: "rgba(128,128,128,.28)"
				});
			}

			const fill = bar === null ? null : bar.querySelector("i");
			if (fill !== null) {
				Object.assign(fill.style, {
					display: "block",
					height: "100%",
					width: "40%",
					borderRadius: "2px",
					background: "var(--dsw-alias-label-secondary, #8ab4f8)"
				});
				// `@keyframes ce-slide` 没法内联 —— 用 Web Animations API 替代。
				// 老浏览器没有 `animate` 就退化成静止的条：动画只是装饰，
				// **不影响定位/显隐这些关键不变量**，所以这里刻意不做兜底。
				if (typeof fill.animate === "function") {
					// ⚠️ 幂等：本函数对同一个元素可能被调用多次（复用旧节点、热重载），
					// 而 `animate()` 每调一次就**新建**一条动画、旧的那条仍在跑 ——
					// 同一个进度条上会叠出多条无限动画。所以先清掉已存在的。
					// 用 `getAnimations()` 而不是自己记引用：状态在元素上，
					// 跨模块实例（热重载后是新的模块作用域）依然正确。
					if (typeof fill.getAnimations === "function") {
						for (const running of fill.getAnimations()) running.cancel();
					}
					fill.animate(
						[{ transform: "translateX(-110%)" }, { transform: "translateX(260%)" }],
						{ duration: 1250, iterations: Number.POSITIVE_INFINITY, easing: "ease-in-out" }
					);
				}
			}
		}

		/**
		 * 把 `state` 落到 DOM 上：整体显隐 + 终态边框色 + 进度条显隐。
		 *
		 * 这三样原本都是 CSS 选择器（`#id{display:none}`、
		 * `[data-state="ok"]{border-color:…}`、`[data-state="ok"] .ce-bar{display:none}`）。
		 * 因为样式表不归我们掌控（见 `applyLayerStyles()` 的注释），必须显式设置。
		 *
		 * `root.dataset.state` 仍然照写：它不再是渲染依据，但对调试有用
		 * （开发者工具里一眼能看出当前处于哪个状态），也便于测试断言。
		 *
		 * @param {HTMLElement} root 浮层容器
		 * @param {"hidden"|"active"|"ok"|"fail"} state 目标状态
		 */
		function applyState(root, state) {
			root.dataset.state = state;
			// ⚠️ 关键：没有任务时必须真的收起来。
			// 这一行如果缺失，浮层会在空闲时一直挂在屏幕中间。
			root.style.display = state === "hidden" ? "none" : "block";
			root.style.borderColor =
				state === "ok"
					? "var(--dsw-alias-state-success, #2e9e5b)"
					: state === "fail"
						? "var(--dsw-alias-state-error, #d9453d)"
						: "var(--dsw-alias-border-secondary, #3a4150)";
			const bar = root.querySelector(".ce-bar");
			if (bar !== null) bar.style.display = state === "ok" || state === "fail" ? "none" : "block";
		}

		/**
		 * 创建**不经过 React** 的固定定位浮层，挂在 `document.body` 上。
		 *
		 * 用原生 DOM 的原因见文件头：它是独立浮层，不需要参与 React 树。
		 */
		function createLayer() {
			if (typeof document === "undefined" || document.body === null) return null;

			// 幂等：已有节点就复用 —— 但**必须重新套一遍内联样式**。
			// 那个节点可能是上一版代码建的（那时候样式还在 `<style>` 里、它身上没有内联样式），
			// 也可能是宿主删掉样式表之后遗留下来的。只复用、不补样式，
			// 恰好就是"热重载之后浮层继续坏着"的成因。
			const existing = document.getElementById(LAYER_ID);
			if (existing !== null) {
				applyLayerStyles(existing);
				applyState(existing, existing.dataset.state || "hidden");
				return existing;
			}

			const root = document.createElement("div");
			root.id = LAYER_ID;
			root.setAttribute("role", "status");
			root.setAttribute("aria-live", "polite");
			// 初始收起；真正的显隐由末尾的 `applyState()` 内联落实
			root.dataset.state = "hidden";

			const row = document.createElement("div");
			row.className = "ce-row";
			const title = document.createElement("span");
			title.className = "ce-title";
			const spacer = document.createElement("span");
			spacer.className = "ce-spacer";
			const elapsed = document.createElement("span");
			elapsed.className = "ce-elapsed";
			row.append(title, spacer, elapsed);

			const detail = document.createElement("div");
			detail.className = "ce-detail";

			// 不确定进度（拿不到总字节数）→ 用滑动条表示"在进行"，而不是假百分比
			const bar = document.createElement("div");
			bar.className = "ce-bar";
			bar.appendChild(document.createElement("i"));

			root.append(row, detail, bar);
			document.body.appendChild(root);
			// 外观随元素内联写死（不走 `<style>`）：因此不存在"样式表被谁删掉了"
			// 这种会让浮层掉到左下角、并且空闲时也不收起的失败模式。
			applyLayerStyles(root);
			applyState(root, "hidden");
			return root;
		}

		/** 把一份进度快照画到浮层上。`snapshot` 为 null 表示没有任务。 */
		function render(root, snapshot) {
			if (root === null) return;
			if (snapshot === null) {
				applyState(root, "hidden");
				return;
			}
			const phase = PHASE_LABEL[snapshot.phase] ?? snapshot.phase ?? "进行中";
			root.querySelector(".ce-title").textContent = snapshot.active
				? `Cheat Engine 内核：${phase}`
				: String(snapshot.message ?? phase);
			root.querySelector(".ce-elapsed").textContent = formatElapsed(snapshot.elapsedMs);

			const parts = [];
			if (typeof snapshot.detail === "string" && snapshot.detail !== "") parts.push(snapshot.detail);
			const stepCount = Array.isArray(snapshot.steps) ? snapshot.steps.length : 0;
			if (stepCount > 0) parts.push(`已完成 ${stepCount} 个阶段`);
			root.querySelector(".ce-detail").textContent = parts.join("　·　");

			applyState(root, snapshot.active ? "active" : snapshot.ok === true ? "ok" : "fail");
		}
		//#endregion

		//#region 轮询
		/**
		 * 轮询宿主进度并渲染。
		 *
		 * @returns {() => void} 停止函数
		 */
		function startPolling() {
			const root = createLayer();
			if (root === null) return () => {};

			let stopped = false;
			let timer = null;
			/** 任务刚结束的时间（用于决定何时隐藏）。 */
			let finishedAt = null;
			let finishedOk = true;

			const schedule = () => {
				if (stopped) return;
				// 页面不可见时拉长间隔（省电、省请求），不是完全停 —— 用户切回来要立刻看到
				const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
				timer = setTimeout(() => void tick(), hidden ? POLL_MS * 3 : POLL_MS);
			};

			const tick = async () => {
				if (stopped) return;
				let snapshot = null;
				try {
					snapshot = await fetchProgress();
				} catch {
					snapshot = null;
				}
				if (stopped) return;

				if (snapshot !== null && snapshot.active === true) {
					finishedAt = null;
					render(root, snapshot);
				} else if (snapshot !== null && (snapshot.ok === true || snapshot.ok === false)) {
					if (finishedAt === null) {
						finishedAt = Date.now();
						finishedOk = snapshot.ok === true;
					}
					const hideAfter = finishedOk ? HIDE_AFTER_MS : HIDE_AFTER_FAIL_MS;
					if (Date.now() - finishedAt > hideAfter) applyState(root, "hidden");
					else render(root, snapshot);
				} else {
					applyState(root, "hidden");
				}
				schedule();
			};

			void tick();
			return () => {
				stopped = true;
				if (timer !== null) clearTimeout(timer);
				guard("移除进度浮层", () => root.remove());
			};
		}
		//#endregion

		const inject = ["slots"];

		function apply(ctx) {
			if (typeof document === "undefined") return;

			// 不用 React 组件，只借 slot 注册**触发挂载**；挂载后自己管 DOM。
			// `ctx.slots.inject()` 在订阅时不执行回调，所以 try/catch 必须放进回调里。
			ctx.slots.inject(SLOT, () =>
				guard("注册进度浮层", () => {
					let stop = null;
					ctx.effect(
						() => {
							stop = startPolling();
							return () => {
								if (typeof stop === "function") stop();
								stop = null;
							};
						},
						"cheat-engine: 长任务进度浮层"
					);
					return () => {
						if (typeof stop === "function") stop();
					};
				})
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
