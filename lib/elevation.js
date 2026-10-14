/**
 * 提权相关的判定、建议与「同意闸门」——**对外统一入口**。
 *
 * ## 这个文件的定位
 *
 * 提权能力已经抽成独立插件 `dsh-get-admin`，所以这些与提权直接相关的通用能力
 * （是否已提权 / 识别权限错误 / 生成可执行建议 / 提权前征求同意）**以它为准**，
 * 本文件只做转发，不再各自维护一份实现。
 *
 * 早先的形态是：cheat-engine 与 get-admin 各有一份近乎相同的 `elevation.js`。
 * 代价很快就出现了 —— **两份的 `permissionDeniedAdvice` 文案开始漂移**，
 * 其中一份还把"用助手提权"写成了不可行（用户照做会白白重启会话）。
 * 于是改成：`elevation-impl.js` 保留为**回退实现**（解析不到 get-admin 时用），
 * 本文件统一从 `elevation-backend.js` 取，从而只有一个权威来源。
 *
 * ## 关于提权的实现约束（保留这段说明，避免后人重走弯路）
 *
 * Windows 的权限是**进程级**的：要读写以更高权限运行的目标进程，**发起调用的进程本身**
 * 必须有管理员权限，因此「按需提权」只有三条路：
 *
 *   1. 让宿主以管理员身份重启（会中断会话）；
 *   2. 起一个管理员权限的**助手进程**，把内存操作转发给它 ← get-admin 走这条；
 *   3. 连一个已提权的 `ceserver`，切到内核的 `native-ce` 后端。
 *
 * 第 2 条有个硬约束：内核的 `ScanSession` / `PointerScanner` / `AutoAssembler`
 * 内部调用的是 `Process` 的**同步**方法，而同步方法在**异步后端**上会直接抛错。
 * 所以助手若只做成普通异步 RPC，扫描/指针扫描/汇编**全部不可用**。
 * 要全功能，远程后端必须是**同步**的 —— 这也是 `RemoteMemoryBackend` 用
 * worker + `SharedArrayBuffer` + `Atomics.wait` 的原因。
 *
 * @module dsh-cheat-engine/elevation
 */

export {
	askToElevate,
	enrichPermissionError,
	isElevated,
	isPermissionDenied,
	permissionDeniedAdvice,
	resetElevationCache
} from "./elevation-backend.js";
