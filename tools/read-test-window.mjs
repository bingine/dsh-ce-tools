/**
 * 读 `CheatTestWindow.exe` 窗口里显示的文字（**只读，不点击任何控件**）。
 *
 * ## 为什么需要
 *
 * 那个测试程序把每个变量的**真实地址**打印在自己的窗口里
 * （`g_hp = 100 @ 0x00007FF6...`）。拿到这些地址就能做**确定性的**验证：
 * 直接读已知地址、写、回读、还原 —— 而不必在几千个扫描命中里猜哪个是真的。
 *
 * 实现：`koffi` 调 user32 的 `FindWindowW`（按类名 `CheatTestWndClass`）
 * 找到主窗口，再 `EnumChildWindows` 找到那个 STATIC 控件、读出它的文本。
 *
 * ⚠️ koffi 的 `func()` **第二参数不要传 `koffi.pointer(proto)`** ——
 * 实测会抛 `Unexpected character '(' in type specifier`。
 * 回调的写法是：`koffi.proto(sig)` 一次，然后
 * `func(sig, koffi.pointer(proto))` 里的 proto 复用同一个对象。
 *
 * 用法：node tools/read-test-window.mjs
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = path.join(path.dirname(HERE), "node-cheat-engine");
const require = createRequire(path.join(KERNEL, "package.json"));

let koffi;
try {
	koffi = require("koffi");
} catch (error) {
	console.error("解析不到 koffi：", error.message);
	process.exit(1);
}

const user32 = koffi.load("user32.dll");
const FindWindowW = user32.func("void *FindWindowW(char16_t *cls, char16_t *title)");
const GetWindowTextW = user32.func("int GetWindowTextW(void *hwnd, char16_t *buf, int max)");
const EnumChildWindows = user32.func("bool EnumChildWindows(void *parent, void *cb, int64 param)");

/** 回调原型：只声明一次，注册与函数签名共用。 */
const CHILD_PROC = koffi.proto("bool EnumChildProc(void *hwnd, int64 param)");

/** 读窗口标题（静态控件的内容也在其"标题"里）。 */
function windowText(hwnd) {
	const buf = koffi.alloc("char16_t", 8192);
	const n = GetWindowTextW(hwnd, buf, 8192);
	if (n <= 0) return "";
	// decode 到 NUL 为止
	return koffi.decode(buf, "char16_t", n).toString();
}

const hwnd = FindWindowW("CheatTestWndClass", null);
if (hwnd === null || hwnd === undefined) {
	console.log("❌ 没找到 CheatTestWndClass 窗口 —— 程序没在运行？");
	process.exit(1);
}
console.log("=== 找到主窗口 ===");
console.log("  标题:", windowText(hwnd));
console.log("");

let printed = false;
const collected = [];
const cb = koffi.register((child) => {
	const text = windowText(child);
	if (text.trim() !== "" && (text.includes("@ 0x") || text.includes("PID"))) {
		collected.push(text);
	}
	return true;
}, koffi.pointer(CHILD_PROC));

EnumChildWindows(hwnd, cb, 0);
koffi.unregister(cb);

if (collected.length === 0) {
	console.log("❌ 没读到含地址的控件文本");
	process.exit(1);
}
console.log("=== 控件文本（含变量真实地址）===");
for (const text of collected) {
	console.log(text);
	printed = true;
}
process.exit(printed ? 0 : 1);
