/**
 * 工具定义适配层：把作者侧 DSL 编译成注册表要求的原始 JSON Schema，并复刻
 * `defineTool` 的「执行前校验参数」语义。
 *
 * **为什么不 import `@deepseek-ai/dsh-tools` 的 `defineTool`**：
 * 桌面版（Electron）把 DSH 依赖打进 asar，而 profile 的 `node_modules/@deepseek-ai/*`
 * 联接指向 npm 全局那份，两者版本不同（实测 0.2.0-rc.2 vs 0.1.0-rc.8）。
 * 插件只要 `import` 任何 `@deepseek-ai/*`，就会把**另一个版本**的实现拉进来，
 * 注册表的校验规则对不上时 `tools.register()` 直接抛错、整个插件激活失败，
 * 而界面只显示 `failed`，极难定位。注册表真正要求的只有
 * `name` / `description` / `parameters`（原始 JSON Schema）/ `output.schema` /
 * `output.render`，自己产出这些即可，从而不引入任何模块解析风险。
 *
 * 本文件复刻自同机同版本上已验证过的 dsh-plugin-hyy-assistive-tool。
 *
 * ## `ENVELOPE_SCHEMA` / `toJsonSafe` 为什么在这里（而不是 tools/shared.js）
 *
 * 这两样是**工具信封的通用契约**，与具体是哪个工具无关。早先它们在
 * `tools/shared.js` 与 `lib/toolkit.js` 里**各写了一份**，而两份已经分叉
 * （shared 版会过滤数组里的 `undefined`、Map 键强制字符串、未知类型兜底；
 * toolkit 版没有）—— 同一件事两套语义，正是本项目反复受过的伤。
 *
 * 现在以 `shared.js` 那份**更完整的语义**为准，只保留在**本文件**这一处定义，
 * `tools/shared.js` 改为从本文件 re-export。这样：
 *   · 只有一个实现，"两份漂移"这一整类问题从根上消失；
 *   · 两个入口（`toolkit.js` 与 `tools/shared.js`）的语义**确定一致**。
 *
 * @module dsh-ce-tools/toolkit
 */

/**
 * 工具返回值的 schema（信封）。
 *
 * 刻意**没有** `ok` 字段：一次调用的成功与否由「是否抛错」表达
 * （见 tools/shared.js 顶部第 2 条），再在返回值里放一个永远为 true 的 `ok`
 * 只会是噪声。
 */
export const ENVELOPE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		summary: { type: "string", required: true },
		lines: { type: "array", items: { type: "string" } },
		// 结构化载荷：形状随工具而变，所以显式声明为「任意属性的对象」，
		// 而不是留一个空 schema（空 schema 是否被注册表接受取决于实现细节）
		data: { type: "object", additionalProperties: true }
	}
};

/**
 * 把任意值转成可安全 JSON 化的形式。
 *
 * `bigint` → 十进制字符串（地址另用 `formatAddress` 展示）；
 * `Buffer` → 十六进制串；`Map`/`Set` → 对象/数组；函数与 `undefined` 丢弃。
 *
 * 注意几个**刻意的取舍**（早期两份实现不一致的地方，这里定死为：
 * 数组里过滤 `undefined`、Map 键强制字符串、未知类型 `String()` 兜底）：
 *   - 数组元素若为 `undefined` 会被**过滤掉**，而不是变成 `null` ——
 *     保留 `null` 会让"字段缺失"和"字段是 null"变得不可分辨；
 *   - Map 的键一律转成字符串 —— JSON 对象的键只能是字符串；
 *   - 其它未知类型（symbol 等）用 `String()` 兜底，而不是静默丢字段 ——
 *     静默丢字段会让调用方以为"没这个信息"，而其实是我们丢了。
 *
 * @param {unknown} value 任意值
 * @param {number} [depth] 递归深度（防环）
 * @returns {unknown} 纯 JSON 值
 */
export function toJsonSafe(value, depth = 0) {
	if (value === null || value === undefined) return undefined;
	const t = typeof value;
	if (t === "bigint") return value.toString();
	if (t === "string" || t === "boolean") return value;
	if (t === "number") return Number.isFinite(value) ? value : String(value);
	if (t === "function") return undefined;
	if (Buffer.isBuffer(value)) return value.toString("hex");
	if (depth > 8) return "[…]";
	if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, depth + 1)).filter((item) => item !== undefined);
	if (value instanceof Map) {
		const out = {};
		for (const [k, v] of value) {
			const key = typeof k === "string" ? k : String(k);
			out[key] = toJsonSafe(v, depth + 1);
		}
		return out;
	}
	if (value instanceof Set) return [...value].map((item) => toJsonSafe(item, depth + 1));
	if (t === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			const converted = toJsonSafe(v, depth + 1);
			if (converted !== undefined) out[k] = converted;
		}
		return out;
	}
	return String(value);
}

/** `defineTool` 的作者侧 DSL 类型 → JSON Schema 类型。 */
const TYPE_MAP = new Map([
	["string", "string"],
	["number", "number"],
	["integer", "integer"],
	["boolean", "boolean"],
	["null", "null"],
	["array", "array"],
	["object", "object"],
	// 无约束 JSON：不产出 type，注册表按「任意值」处理
	["json", undefined]
]);

/**
 * 把一个 schema 定义编译成 JSON Schema 节点。
 *
 * 作者侧 DSL 的约定（与 `dsh-tools` 一致）：
 * - `required: true` 写属性上，编译时提到父级的 `required` 数组；
 * - `object` 应显式给出 `additionalProperties` 与 `properties`；
 * - `array` 用 `items`；
 * - `enum` / `const` 只能落在标量上。
 *
 * @param {string} name 用于报错定位的名字
 * @param {object} spec schema 定义
 * @returns {{ node: object, required: boolean }}
 */
function compileProperty(name, spec) {
	if (spec === null || typeof spec !== "object") {
		throw new Error(`defineTool 的 "${name}" 必须是对象形式的 schema 定义`);
	}
	const node = {};
	for (const [key, value] of Object.entries(spec)) {
		if (key === "required") continue; // 提到父级
		if (key === "type") {
			if (!TYPE_MAP.has(value)) throw new Error(`defineTool 的 "${name}" 含不支持的 type "${value}"`);
			const mapped = TYPE_MAP.get(value);
			if (mapped !== undefined) node.type = mapped;
			continue;
		}
		if (key === "properties") {
			const properties = {};
			const required = [];
			for (const [childName, childSpec] of Object.entries(value ?? {})) {
				const compiled = compileProperty(childName, childSpec);
				properties[childName] = compiled.node;
				if (compiled.required) required.push(childName);
			}
			node.properties = properties;
			if (required.length > 0) node.required = required;
			continue;
		}
		if (key === "items") {
			node.items = compileProperty(`${name}[]`, value).node;
			continue;
		}
		if (key === "additionalProperties") {
			node.additionalProperties = value;
			continue;
		}
		if (key === "enum") {
			node.enum = [...value];
			continue;
		}
		if (key === "const") {
			node.const = value;
			continue;
		}
		if (key === "description") {
			node.description = value;
			continue;
		}
		if (key === "oneOf") {
			node.oneOf = value.map((branch, index) => compileProperty(`${name}.oneOf[${index}]`, branch).node);
			continue;
		}
		throw new Error(`defineTool 的 "${name}" 含未知字段 "${key}"`);
	}
	return { node, required: spec.required === true };
}

/** 编译工具的参数表（隐式开放的对象根）。 */
function compileParameters(parameters) {
	if (parameters === undefined) return { type: "object", properties: {} };
	const properties = {};
	const required = [];
	for (const [name, spec] of Object.entries(parameters)) {
		const compiled = compileProperty(name, spec);
		properties[name] = compiled.node;
		if (compiled.required) required.push(name);
	}
	return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** 编译工具的 output.schema。 */
function compileOutputSchema(schema) {
	if (schema === null || typeof schema !== "object") {
		throw new Error("defineTool 的 output.schema 必须是对象");
	}
	return compileProperty("output", schema).node;
}

/**
 * 极简校验：只检查必填键、类型、enum 与 additionalProperties:false。
 * 够用来把模型的参数错误变成可读消息，而不是让它变成一次难懂的内部异常。
 *
 * 也导出给测试用：注册表对返回值同样严格（多键/缺必填/类型不符都会让整次调用失败），
 * 测试里用它复现那套规则，从而在没有 DSH 的环境下也能挡住这类错误。
 *
 * @param {object} schema 编译后的 JSON Schema
 * @param {unknown} value 待校验的值
 * @returns {string[]} 违规描述（空数组表示通过）
 */
export function validateSchemaValue(schema, value) {
	const violations = [];
	const check = (node, current, path) => {
		if (node === null || typeof node !== "object") return;
		if (node.type !== undefined) {
			const actual = current === null ? "null" : Array.isArray(current) ? "array" : typeof current;
			const ok =
				node.type === "array" ? Array.isArray(current)
					: node.type === "integer" ? typeof current === "number" && Number.isInteger(current)
						: node.type === "number" ? typeof current === "number"
							: node.type === "object" ? actual === "object" && !Array.isArray(current)
								: actual === node.type;
			if (!ok) {
				violations.push(`${path || "arguments"} 应为 ${node.type}，实际是 ${actual}`);
				return;
			}
		}
		if (node.enum !== undefined && !node.enum.includes(current)) {
			violations.push(`${path || "arguments"} 必须是 ${node.enum.map((v) => JSON.stringify(v)).join(" | ")} 之一`);
		}
		if (node.type === "object" && current !== null && typeof current === "object" && !Array.isArray(current)) {
			for (const key of node.required ?? []) {
				if (!Object.hasOwn(current, key)) violations.push(`${path ? path + "." : ""}${key} 是必填项`);
			}
			for (const [key, child] of Object.entries(node.properties ?? {})) {
				if (Object.hasOwn(current, key)) check(child, current[key], path ? `${path}.${key}` : key);
			}
			if (node.additionalProperties === false) {
				for (const key of Object.keys(current)) {
					if (!Object.hasOwn(node.properties ?? {}, key)) {
						violations.push(`${path ? path + "." : ""}${key} 不是可接受的参数`);
					}
				}
			}
		}
		if (node.type === "array" && Array.isArray(current) && node.items) {
			current.forEach((item, index) => check(node.items, item, `${path}[${index}]`));
		}
	};
	check(schema, value, "");
	return violations;
}

/**
 * 回退版 `defineTool`：语义与 `dsh-tools` 的一致，只是参数校验更宽松。
 * 注册表只要求 `output.schema` 是受支持的 JSON Schema、`output.render` 是函数，
 * 因此这个实现产出的是「注册表就绪」的定义。
 *
 * @param {object} options 见 dsh-tools 的 defineTool
 * @returns {object} 可直接交给 ctx.tools.register 的工具定义
 */
export function fallbackDefineTool(options) {
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new Error(`defineTool(${options.name}): timeoutMs 必须是正的有限数`);
	}
	const parameters = compileParameters(options.parameters);
	const outputSchema = compileOutputSchema(options.output.schema);
	const userExecute = options.execute;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;

	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render: (args, value) => userRender(args, value),
			...(userPresentationMeta !== undefined
				? { presentationMeta: (args, value) => userPresentationMeta(args, value) }
				: {})
		},
		...(options.deferLoading === true ? { deferLoading: true } : {}),
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		async execute(args, exec) {
			const violations = validateSchemaValue(parameters, args);
			if (violations.length > 0) throw new Error(`参数不合法: ${violations.join("; ")}`);
			return userExecute(args, exec);
		}
	};
	if (options.projectContent !== undefined) tool.projectContent = (exec, result) => options.projectContent(exec, result);
	if (options.finalizeContent !== undefined) tool.finalizeContent = (exec, result) => options.finalizeContent(exec, result);
	// 展示器必须纯粹且不能因旧日志而崩溃：参数不合法时退回通用卡片
	if (userPresentCall !== undefined) {
		tool.presentCall = (args) => (validateSchemaValue(parameters, args).length > 0 ? undefined : userPresentCall(args));
	}
	if (userPresentResult !== undefined) {
		tool.presentResult = (args, result) => (validateSchemaValue(parameters, args).length > 0 ? undefined : userPresentResult(args, result));
	}
	if (userIsConcurrencySafe !== undefined) {
		tool.isConcurrencySafe = (args) => (validateSchemaValue(parameters, args).length > 0 ? false : userIsConcurrencySafe(args));
	}
	return tool;
}

/** 配置默认值表；插件不声明 schemastery 的 `Config`，用它兜底合并。 */
export function withDefaults(config, defaults) {
	const merged = { ...defaults };
	if (config && typeof config === "object") {
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined && value !== null) merged[key] = value;
		}
	}
	return merged;
}

/**
 * 只保留 schema 声明过的键，并丢掉值为 `null` / `undefined` 的字段。
 *
 * 注册表会**严格校验** `execute` 的返回值：多一个未声明的键、或把可选字符串
 * 字段填成 `null`，都会让整次调用以
 * `returned invalid output: "xxx" is not a declared property` 失败。
 * 内部数据结构通常比对外 schema 更宽，所以出口处必须收敛一次。
 *
 * @param {object} value 待清洗的对象
 * @param {string[]} keys 允许保留的键；未列出的一律丢弃
 */
export function pickDeclared(value, keys) {
	const out = {};
	if (value === null || typeof value !== "object") return out;
	for (const key of keys) {
		const v = value[key];
		if (v === undefined || v === null) continue;
		out[key] = v;
	}
	return out;
}
