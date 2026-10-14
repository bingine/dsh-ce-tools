/**
 * 进度浮层（`lib/client.js`）的**真实 DOM 回归测试**。
 *
 * ## 这条测试的由来（用户实测的 bug + 取证）
 *
 * `dsh-get-admin` 的右下角状态图标被报"跑到左下角、而且没有样式"。追下去发现
 * 根因**不在**那个插件，而在宿主的客户端模块系统：`@deepseek-ai/dsh-client-modules`
 * 在**物化插件**时会把文档里所有**没有 `data-plugin` 标记**的 `<style>` 认领给
 * 这个插件，再在它卸载时按 `data-plugin` **批量删除**：
 *
 *     removeOwnedStyles(id) {
 *       for (const el of document.querySelectorAll("style[data-plugin]"))
 *         if (el.getAttribute("data-plugin") === id) el.remove();
 *     }
 *     const claimStyles = (id) => {
 *       for (const el of document.querySelectorAll("style:not([data-plugin])"))
 *         el.setAttribute("data-plugin", id);
 *     };
 *
 * **本插件是同一个根因的另一个受害者，而且证据就在用户实测的 DOM 里**：
 *
 *     <style id="dsh-ce-progress-layer-style" data-plugin="dsh-get-admin">
 *
 * 这张表装的是**本插件的进度浮层 CSS**，却被标成了 `dsh-get-admin` ——
 * 而两个插件的源码都只设 `id`、**从不设 `data-plugin`**，所以这个标记只能是
 * 宿主认领时打上的，且认领错了对象。也就是说：**get-admin 被热重载时，
 * 会连带删掉本插件的样式表。**
 *
 * 而浮层容器是 `document.body` 上的 `<div>`，**不归宿主 HMR 管**、不会被一起删 ——
 * 于是"表没了、元素还在"，后果全都很难看：
 *   · `position:fixed;left:50%;bottom:18px` 丢失 → 掉到普通流（左下角）；
 *   · 内层 `.ce-row/.ce-title` 布局全乱；
 *   · **`display:none` 也失效** → 没有任务时浮层也一直挂在屏幕上；
 *   · `@keyframes` 丢失 → 进度条不动。
 *
 * ## 修复与这条测试要钉住的不变量
 *
 * 关键样式全部改成**用 CSSOM 内联**（`applyLayerStyles()`），显隐改由
 * `applyState()` 显式设置；`@keyframes` 无法内联，滑动动画改用
 * **Web Animations API**（`el.animate()`，同样是纯 JS）。
 *
 * 于是本文件的断言就是这些不变量：
 *   1. 定位/尺寸/显隐**内联在元素自己身上**，文档里**一个 `<style>` 都不需要**；
 *   2. 把文档里所有 `<style>` 删光（重演事故现场），这些仍然成立；
 *   3. 状态切换（hidden/active/ok/fail）真的落到 DOM 上 —— 尤其 `hidden` 必须收起；
 *   4. 复用"上一版代码留下的旧节点"时会**补上内联样式**（否则热重载后继续坏）；
 *   5. 动画走 Web Animations API，不再依赖 `@keyframes`。
 *
 * ## 为什么必须是"真的把组件跑起来"的测试
 *
 * 此前只有 `test/client-entry.test.mjs` 那种**静态**检查（按脚本能否解析、
 * `id` 与包名是否一致）。它永远不执行 `createLayer()`，也就永远看不到
 * "样式表没插进去 / 被删掉"。这个 bug 正是这样溜过全部测试的。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CLIENT = path.join(ROOT, "lib", "client.js");

//#region 最小 DOM 桩
/**
 * 只实现 `lib/client.js` 真正用到的能力，但**语义要正确**：
 * ① `style` 是普通对象（`Object.assign(el.style, …)` 与 `el.style.x = y` 等价）；
 * ② `remove()` 真的从父节点摘掉；
 * ③ `querySelector` 支持产品代码用到的两种选择器：`.class` 与标签名。
 */
function createDom() {
	const matches = (element, selector) => {
		if (selector.startsWith(".")) {
			return String(element.className)
				.split(/\s+/)
				.includes(selector.slice(1));
		}
		return element.tagName === String(selector).toUpperCase();
	};

	/** 深度优先遍历**后代**（不含自身，与真实 `querySelector` 语义一致）。 */
	const walkDescendants = (element, visit) => {
		for (const child of element.children) {
			visit(child);
			walkDescendants(child, visit);
		}
	};

	const findAll = (root, selector) => {
		const found = [];
		walkDescendants(root, (el) => {
			if (matches(el, selector)) found.push(el);
		});
		return found;
	};

	const makeElement = (tagName) => {
		const element = {
			tagName: String(tagName).toUpperCase(),
			id: "",
			className: "",
			style: {},
			dataset: {},
			attributes: {},
			children: [],
			parentNode: null,
			textContent: "",
			/** Web Animations API 的调用记录（`el.animate()`）。 */
			animations: [],
			appendChild(child) {
				if (child.parentNode !== null) child.remove();
				child.parentNode = element;
				element.children.push(child);
				return child;
			},
			append(...nodes) {
				for (const node of nodes) element.appendChild(node);
			},
			remove() {
				const parent = element.parentNode;
				if (parent === null) return;
				const at = parent.children.indexOf(element);
				if (at >= 0) parent.children.splice(at, 1);
				element.parentNode = null;
			},
			setAttribute(name, value) {
				element.attributes[name] = String(value);
			},
			getAttribute(name) {
				return name in element.attributes ? element.attributes[name] : null;
			},
			addEventListener() {},
			removeEventListener() {},
			animate(keyframes, options) {
				const animation = {
					keyframes,
					options,
					cancelled: false,
					cancel() {
						animation.cancelled = true;
					},
					play() {},
					pause() {}
				};
				element.animations.push(animation);
				return animation;
			},
			/** 与真实 `Element.getAnimations()` 语义一致：被 `cancel()` 的不再返回。 */
			getAnimations() {
				return element.animations.filter((animation) => !animation.cancelled);
			},
			querySelector(selector) {
				const all = findAll(element, selector);
				return all.length > 0 ? all[0] : null;
			},
			querySelectorAll(selector) {
				return findAll(element, selector);
			}
		};
		return element;
	};

	const head = makeElement("head");
	const body = makeElement("body");

	/** 整棵树（含容器自身）。 */
	const everyElement = () => {
		const all = [head, body];
		for (const root of [head, body]) walkDescendants(root, (el) => all.push(el));
		return all;
	};

	const document = {
		head,
		body,
		visibilityState: "visible",
		createElement: (tagName) => makeElement(tagName),
		getElementById(id) {
			return everyElement().find((el) => el.id === id) ?? null;
		},
		querySelectorAll(selector) {
			return everyElement().filter((el) => matches(el, selector));
		}
	};

	return { document, head, body, everyElement };
}
//#endregion

//#region 挂载脚手架
/**
 * 造一个"上一版代码留下的"浮层节点：结构齐全，但**身上没有任何内联样式**
 * （那时候样式还在被宿主认领的 `<style>` 里）。
 *
 * @param {object} dom `createDom()` 的返回值
 * @param {boolean} [withAnimation] 是否预置一条"上一轮已经在跑"的滑动动画
 *   —— 用于验证 `applyLayerStyles()` 的**幂等性**（不能把无限动画叠起来）
 */
function seedStaleLayer(dom, withAnimation = false) {
	const stale = dom.document.createElement("div");
	stale.id = "dsh-ce-progress-layer";
	stale.dataset.state = "active";
	const row = dom.document.createElement("div");
	row.className = "ce-row";
	const title = dom.document.createElement("span");
	title.className = "ce-title";
	const spacer = dom.document.createElement("span");
	spacer.className = "ce-spacer";
	const elapsed = dom.document.createElement("span");
	elapsed.className = "ce-elapsed";
	row.append(title, spacer, elapsed);
	const detail = dom.document.createElement("div");
	detail.className = "ce-detail";
	const bar = dom.document.createElement("div");
	bar.className = "ce-bar";
	const fill = dom.document.createElement("i");
	if (withAnimation) {
		fill.animate([{ transform: "translateX(-110%)" }], {
			duration: 1250,
			iterations: Number.POSITIVE_INFINITY
		});
	}
	bar.appendChild(fill);
	stale.append(row, detail, bar);
	dom.body.appendChild(stale);
	return stale;
}

/**
 * 把 `lib/client.js` 真的跑起来：按**脚本**在 vm 里加载，用桩 ctx 调 `apply()`，
 * 它会注册 slot 并 `startPolling()` —— 于是浮层真的被建到 `document.body` 上。
 *
 * @param {object} [options]
 * @param {object|null} [options.progress] `/cheat-engine/status` 里 `progress` 字段的返回值
 * @param {(dom: object) => any} [options.setup] 在加载插件**之前**预置 DOM（用于模拟旧节点）
 */
async function mount(options = {}) {
	const dom = createDom();
	const seeded = options.setup === undefined ? undefined : options.setup(dom);

	const source = fs.readFileSync(CLIENT, "utf8");
	const timers = [];
	const fetchCalls = [];
	let progress = options.progress ?? null;

	let moduleExports = null;
	const loader = {
		load(entry) {
			moduleExports = entry.factory(() => {
				throw new Error("本测试不需要 require");
			});
		}
	};

	const sandbox = {
		window: { __ModuleLoader__: loader },
		document: dom.document,
		console,
		// 定时器桩：一个都不真的跑，测试想看下一轮 tick 就自己把回调取出来调。
		setTimeout: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimeout: (id) => {
			if (typeof id === "number" && id > 0) timers[id - 1] = null;
		},
		fetch: async (url, init) => {
			fetchCalls.push({ url, init });
			return { ok: true, status: 200, json: async () => ({ progress }) };
		}
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	new vm.Script(source, { filename: CLIENT }).runInContext(sandbox);

	assert.ok(moduleExports !== null, "lib/client.js 必须调用 window.__ModuleLoader__.load 注册模块");
	assert.deepEqual([...moduleExports.inject], ["slots"], "客户端只依赖 slots 服务");

	const disposers = [];
	const ctx = {
		slots: {
			// 宿主在槽位可用时**订阅即回调**（产品代码依赖这个语义）
			inject(_name, cb) {
				cb();
			}
		},
		effect(fn, _label) {
			disposers.push(fn());
		}
	};

	moduleExports.apply(ctx);

	const root = dom.document.getElementById("dsh-ce-progress-layer");
	assert.ok(root !== null, "挂载后 document 里应当有 #dsh-ce-progress-layer");

	/** 让挂起的异步 tick（fetch → render）跑完。 */
	const drain = async () => {
		for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
	};
	await drain();

	return {
		dom,
		root,
		seeded,
		fetchCalls,
		timers,
		drain,
		/** 换掉下一次 `fetch` 要返回的 `progress`。 */
		setProgress(next) {
			progress = next;
		},
		/** 手动驱动一轮「到点了」的轮询。 */
		async tickAgain() {
			const pending = timers.filter((fn) => typeof fn === "function");
			timers.length = 0;
			for (const fn of pending) await fn();
			await drain();
		},
		/** 卸载（模拟插件被停用 / 热重载）。 */
		unmount() {
			for (const dispose of disposers) if (typeof dispose === "function") dispose();
		}
	};
}
//#endregion

test("挂载后：底部居中定位必须**内联**在容器上，且空闲时收起", async () => {
	const m = await mount();
	try {
		// 这几行就是"掉到左下角"那个故障的核心：
		// 丢了 position/left/bottom/transform，容器就退回普通流。
		assert.equal(m.root.style.position, "fixed", "容器必须是固定定位");
		assert.equal(m.root.style.left, "50%", "必须水平居中（而非落到普通流）");
		assert.equal(m.root.style.bottom, "18px", "必须贴底部");
		assert.equal(m.root.style.transform, "translateX(-50%)", "居中的必须是自己宽度的一半");
		assert.ok(
			Number(m.root.style.zIndex) > 0,
			`必须有正的 z-index（否则会被界面盖住），实际：${m.root.style.zIndex}`
		);

		// ⚠️ 显隐开关：原本是 CSS 里的 `display:none`。没有任务时必须真的收起，
		//    否则浮层会在空闲时一直挂在屏幕中间。
		assert.equal(m.root.style.display, "none", "没有任务时浮层必须收起");
		assert.equal(m.root.dataset.state, "hidden");
	} finally {
		m.unmount();
	}
});

test("用户场景重演：文档里**一个 `<style>` 都没有**时，定位与显隐依然成立", async () => {
	const m = await mount({ progress: { active: true, phase: "download" } });
	try {
		// ① 修复后压根不插入样式表 —— 外观随元素本身生灭。
		const styles = m.dom.document.querySelectorAll("style");
		assert.deepEqual(
			styles.map((el) => el.id),
			[],
			`修复后不应再往文档里插 <style>，实际有：${styles.map((el) => el.id).join(", ")}`
		);

		// ② 重演事故现场：把样式表全删掉（用户实测的 DOM 就是这样）
		for (const style of styles) style.remove();
		for (const style of m.dom.document.querySelectorAll("style")) style.remove();
		assert.equal(m.dom.document.querySelectorAll("style").length, 0, "事故现场应当没有任何样式表");

		// ③ 定位、尺寸、显隐**不受影响** —— 这正是修复要保证的不变量
		assert.equal(m.root.style.position, "fixed");
		assert.equal(m.root.style.left, "50%");
		assert.equal(m.root.style.bottom, "18px");
		assert.equal(m.root.style.transform, "translateX(-50%)");
		assert.equal(m.root.style.display, "block", "有任务在跑时应当显示");
	} finally {
		m.unmount();
	}
});

test("内层元素的关键布局也必须内联（丢了会整块乱掉）", async () => {
	const m = await mount({ progress: { active: true, phase: "download" } });
	try {
		const row = m.root.querySelector(".ce-row");
		const title = m.root.querySelector(".ce-title");
		const spacer = m.root.querySelector(".ce-spacer");
		const elapsed = m.root.querySelector(".ce-elapsed");
		const detail = m.root.querySelector(".ce-detail");
		const bar = m.root.querySelector(".ce-bar");
		const fill = bar.querySelector("i");

		assert.ok(row !== null && title !== null && spacer !== null, "浮层结构应当完整");
		assert.equal(row.style.display, "flex", "行内布局靠 flex，丢了会堆成一列");
		assert.equal(row.style.alignItems, "center");
		assert.equal(row.style.gap, "8px");
		assert.equal(title.style.textOverflow, "ellipsis", "标题过长要省略号，否则会撑破浮层");
		assert.equal(title.style.overflow, "hidden");
		assert.equal(spacer.style.flex, "1", "撑开中缝，否则右侧耗时不会靠右");
		assert.equal(elapsed.style.opacity, "0.72");
		assert.equal(detail.style.wordBreak, "break-all", "长详情要能断行");
		assert.equal(bar.style.height, "4px");
		assert.equal(bar.style.overflow, "hidden");
		assert.equal(fill.style.width, "40%");
		assert.equal(fill.style.display, "block");
	} finally {
		m.unmount();
	}
});

test("状态切换真的落到 DOM：完成/失败变边框色并收起进度条，空闲收起整块", async () => {
	const m = await mount({ progress: { active: true, phase: "download" } });
	try {
		assert.equal(m.root.style.display, "block");
		const bar = m.root.querySelector(".ce-bar");
		assert.equal(bar.style.display, "block", "进行中时进度条可见");

		// ① 成功：绿色边框 + 进度条收起
		m.setProgress({ active: false, ok: true, phase: "已完成" });
		await m.tickAgain();
		assert.equal(m.root.dataset.state, "ok");
		assert.match(m.root.style.borderColor, /state-success/, "成功应换成成功色边框");
		assert.equal(bar.style.display, "none", "终态不应再显示滑动条");

		// ② 失败：错误色边框
		m.setProgress({ active: false, ok: false, phase: "失败" });
		await m.tickAgain();
		assert.equal(m.root.dataset.state, "fail");
		assert.match(m.root.style.borderColor, /state-error/, "失败应换成错误色边框");

		// ③ 没有任务：整块收起（这是"空闲时浮层还挂在屏幕上"那个故障的防线）
		m.setProgress(null);
		await m.tickAgain();
		assert.equal(m.root.dataset.state, "hidden");
		assert.equal(m.root.style.display, "none", "没有任务时必须收起");
	} finally {
		m.unmount();
	}
});

test("进度内容真的画到 DOM 上（阶段、耗时、详情）", async () => {
	const m = await mount({
		progress: { active: true, phase: "download", elapsedMs: 83000, detail: "官方安装包 128MB", steps: ["a", "b"] }
	});
	try {
		assert.match(m.root.querySelector(".ce-title").textContent, /下载安装包/, "阶段名应映射成中文");
		assert.equal(m.root.querySelector(".ce-elapsed").textContent, "1分23秒");
		assert.match(m.root.querySelector(".ce-detail").textContent, /官方安装包 128MB/);
		assert.match(m.root.querySelector(".ce-detail").textContent, /已完成 2 个阶段/);
	} finally {
		m.unmount();
	}
});

test("滑动动画走 Web Animations API，不再依赖 `@keyframes`", async () => {
	const m = await mount({ progress: { active: true, phase: "download" } });
	try {
		const fill = m.root.querySelector(".ce-bar").querySelector("i");
		assert.equal(fill.animations.length, 1, "进度条应当启动了一次动画");
		const [animation] = fill.animations;
		assert.equal(animation.keyframes.length, 2, "两帧：左出 → 右出");
		assert.equal(animation.keyframes[0].transform, "translateX(-110%)");
		assert.equal(animation.keyframes[1].transform, "translateX(260%)");
		assert.equal(animation.options.iterations, Number.POSITIVE_INFINITY, "不确定进度要无限循环");
	} finally {
		m.unmount();
	}
});

test("复用上一版代码留下的旧节点时，会**补上**内联样式（否则热重载后继续坏着）", async () => {
	const m = await mount({
		progress: { active: true, phase: "download" },
		setup: (dom) => seedStaleLayer(dom)
	});
	try {
		assert.equal(m.root, m.seeded, "应当**复用**既有节点，而不是再叠一个");
		const layers = m.dom.body.children.filter((el) => el.id === "dsh-ce-progress-layer");
		assert.equal(layers.length, 1, `body 下应当只有一个浮层节点，实际 ${layers.length} 个`);
		// 关键：旧节点被补上了内联定位 —— 不补的话它就一直贴在普通流里
		assert.equal(m.root.style.position, "fixed", "旧节点必须被补上定位");
		assert.equal(m.root.style.left, "50%");
		assert.equal(m.root.style.bottom, "18px");
		assert.equal(m.root.style.display, "block", "它还处在 active 状态，应保持显示");
		assert.equal(m.root.querySelector(".ce-row").style.display, "flex", "子元素也要补上");
	} finally {
		m.unmount();
	}
});

test("复用旧节点时**不会把无限动画叠起来**（`animate()` 每调一次都新建一条）", async () => {
	const m = await mount({
		progress: { active: true, phase: "download" },
		// 预置的旧节点上已经有一条"上一轮跑起来"的滑动动画
		setup: (dom) => seedStaleLayer(dom, true)
	});
	try {
		const fill = m.root.querySelector(".ce-bar").querySelector("i");
		assert.equal(
			fill.animations.length,
			2,
			"一共创建过两条动画（旧的那条 + 本轮新建的）"
		);
		assert.equal(
			fill.getAnimations().length,
			1,
			"但只应有一条在跑 —— 旧的那条必须先被 `cancel()`，否则同一个进度条上会叠多条无限动画"
		);
		assert.equal(fill.animations[0].cancelled, true, "被取消的是旧的那条");
		assert.equal(fill.animations[1].cancelled, false, "本轮新建的那条在跑");
	} finally {
		m.unmount();
	}
});

test("卸载：节点被摘掉，且文档里没有留下任何 `<style>`", async () => {
	const m = await mount({ progress: { active: true, phase: "download" } });
	assert.equal(m.dom.document.getElementById("dsh-ce-progress-layer"), m.root);

	m.unmount();

	assert.equal(m.dom.document.getElementById("dsh-ce-progress-layer"), null, "卸载后节点必须被摘掉");
	assert.equal(m.root.parentNode, null);
	assert.equal(m.dom.document.querySelectorAll("style").length, 0, "没有任何样式表需要清理（这正是修复点）");
});
