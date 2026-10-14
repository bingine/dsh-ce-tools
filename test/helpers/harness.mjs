/**
 * 测试夹具：一个最小的假 cordis 上下文。
 *
 * 目的：在**不需要启动 DSH** 的前提下，完整走一遍插件真实会经历的路径 ——
 * `apply(ctx, config)` 注册 14 个工具 → 工具 `execute` → `output.render`，
 * 并且用注册表那套严格规则校验返回值（多键 / 缺必填 / 类型不符 / null 都算违规）。
 * 这样测试能挡住「在真环境里会让整次调用失败」的那类错误。
 *
 * @module dsh-ce-tools/test/helpers/harness
 */
import { apply, CONFIG_DEFAULTS } from "../../lib/index.js";
import { validateSchemaValue } from "../../lib/toolkit.js";

/**
 * 建一个装好插件的假上下文。
 *
 * @param {object} [config] 插件行配置（覆盖默认值）
 * @param {object} [services] 额外提供的假服务（例如 `{ webServer: {...} }`）。
 *        未提供的服务不会被 `ctx.inject` 激活 —— 与 cordis「服务缺失则不激活子 fiber」一致。
 * @returns {{ tools: Map<string, object>, logs: string[], config: object, dispose: () => Promise<void> }}
 */
export function createHarness(config = {}, services = {}) {
	/** @type {Map<string, object>} */
	const tools = new Map();
	const disposers = [];
	const logs = [];

	const record = (level) => (...args) => {
		const [format, ...rest] = args;
		let text = String(format);
		for (const value of rest) text = text.replace(/%[sdofjO]/, String(value));
		logs.push(`${level}: ${text}`);
	};

	const registerEffect = (execute, label) => {
		const disposer = execute();
		disposers.push({ disposer, label });
		return disposer;
	};

	const ctx = {
		logger: { info: record("info"), warn: record("warn"), error: record("error"), debug: record("debug") },
		tools: {
			register(definition) {
				if (tools.has(definition.name)) throw new Error(`工具名重复注册：${definition.name}`);
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			}
		},
		effect: registerEffect,
		// 软依赖：只有所需服务都存在时才激活（复刻 cordis 的 fiber 语义）
		inject(dependencies, callback) {
			const missing = dependencies.filter((dependency) => ctx[dependency] === undefined);
			if (missing.length > 0) return { dispose() {} };
			return callback(ctx);
		},
		/**
		 * 复刻 cordis 的 `ctx.get(name, strict = true)`。
		 *
		 * 插件用 `ctx.get("getAdmin", false)` **探测**服务是否存在
		 * （`strict=false` 时不抛错、返回 `undefined`）—— 例如 cheat-engine 据此
		 * 决定要不要接管 get-admin 未启用时的提权界面。
		 * harness 早先没有这个方法，于是那些探测恒为 `undefined`，
		 * 让"服务已启用"的用例被误判成"未启用"。
		 *
		 * @param {string} name 服务名
		 * @param {boolean} [strict] true（默认）= 缺失时抛错；false = 返回 undefined
		 */
		get(name, strict = true) {
			const value = ctx[name];
			if (value === undefined && strict !== false) {
				throw new Error(`服务 ${name} 不存在`);
			}
			return value;
		},
		...services
	};

	apply(ctx, config);

	return {
		tools,
		logs,
		config: { ...CONFIG_DEFAULTS, ...config },
		async dispose() {
			for (const { disposer } of disposers) {
				if (typeof disposer === "function") await disposer();
			}
		}
	};
}

/**
 * 调用一个已注册的工具，并按注册表的规则校验返回值与参数。
 *
 * **失败会 reject**：官方约定「抛出异常意味着 `isError`」，因此领域失败（写不进去、
 * 未附加目标、用法错误……）都由工具抛错，测试里用 `assert.rejects` 断言；
 * 一个「只是返回了写着失败的值」的实现会在这里被当成成功，从而被测试暴露出来。
 *
 * @param {object} harness createHarness 的结果
 * @param {string} name 工具名
 * @param {object} [args] 参数
 * @param {object} [exec] 执行上下文（默认无 agent，会回落到 "default" 会话）
 * @returns {Promise<{ value: object, text: string, data: object }>}
 */
export async function callTool(harness, name, args = {}, exec = {}) {
	const definition = harness.tools.get(name);
	if (definition === undefined) {
		throw new Error(`插件没有注册工具 "${name}"。已注册：${[...harness.tools.keys()].join(", ")}`);
	}

	// 参数必须满足工具自己的 parameters schema（复现注册表在 execute 前的校验）
	const argViolations = validateSchemaValue(definition.parameters, args);
	if (argViolations.length > 0) {
		throw new Error(`工具 ${name} 的参数不合法：${argViolations.join("; ")}`);
	}

	const value = await definition.execute(args, exec);

	// 返回值必须严格满足 output.schema —— 这是注册表在真环境里做的事
	const valueViolations = validateSchemaValue(definition.output.schema, value);
	if (valueViolations.length > 0) {
		throw new Error(`工具 ${name} 的返回值不合法：${valueViolations.join("; ")}\n实际：${JSON.stringify(value).slice(0, 400)}`);
	}

	const blocks = definition.output.render(args, value);
	if (!Array.isArray(blocks) || blocks.length === 0) {
		throw new Error(`工具 ${name} 的 render 没有返回内容块`);
	}
	const text = blocks.map((block) => block.text ?? "").join("\n");
	return { value, text, data: value.data ?? {} };
}
