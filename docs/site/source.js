/* 源码页内容 */
(function () {
  "use strict";
  const { $ } = window;
  const md = window.md;

  const layers = [
    { t: "入口层 · lib/index.js", d: "配置合并、16 个工具的注册、只读状态路由、以及插件卸载时的资源清理。配置不在这里声明 schemastery 的 Config，而是从加载行的 config 读取 —— 原因见首页「为什么这样设计」。" },
    { t: "契约层 · lib/toolkit.js", d: "零依赖的 defineTool：把作者侧的参数 DSL 编译成注册表要求的原始 JSON Schema。刻意不 import DSH 的注册表包，规避版本错配导致整插件激活失败。" },
    { t: "能力层 · lib/kernel.js", d: "内核的延迟加载、后端选择（self / native-ce）、以及汇编反汇编的 WASM 后端初始化。延迟加载是关键：内核在 require 那一刻就会 eager 绑定 kernel32。" },
    { t: "状态层 · lib/session.js", d: "每个会话一份 CE 状态：已附加进程、扫描会话、指针扫描器、AA 还原历史、Lua state、地址表。空闲回收从这里统一触发，避免残留管理员进程与句柄。" },
    { t: "值与地址 · lib/values.js", d: "值编解码、地址表达式解析、展示格式化。模块相对偏移的十六进制规范化在这里 —— 它曾经踩过一个静默读错地址的坑，注释里记着。其它所有工具都走它。" },
    { t: "出口信封 · lib/tools/shared.js", d: "全部工具经 makeEnvelopeTool 返回 { summary, lines, data }。注册表对返回值做 lossless-JSON 规范化（bigint 直接抛错），所以 bigint / Buffer / Map 必须在出口统一转成字符串。" }
  ];

  const conventions = [
    { t: "失败靠抛错，不用标志位", d: "未附加目标、地址解析不了、写不进去、用法错误……一律 throw。官方《工具编写参考》写明「抛出异常或返回无效值意味着 isError」，用返回值里的 ok:false 会让整次调用在 harness 眼里是**成功**的。" },
    { t: "每条错误都自带下一步", d: "错误消息里写清原因、候选列表与建议。模型看到的是可读的诊断，而不是一串栈信息。" },
    { t: "bigint 绝不出边界", d: "地址是 64 位，JS 的 number 扛不住。所有地址在内部用 bigint，出边界前转成字符串。" },
    { t: "遵守 exec.signal 的开工前检查", d: "调用方已取消就拒绝开工。但扫描/指针扫描内部是同步原生循环，中途无法抢占式中断 —— 这是如实告知的限制，不是「已支持取消」。" }
  ];

  const host = $("#layers");
  if (host) {
    host.innerHTML = layers.map((c) => `
      <article class="card" data-reveal>
        <h3>${md(c.t)}</h3>
        <p>${md(c.d)}</p>
      </article>`).join("");
  }

  const conv = $("#conventions");
  if (conv) {
    conv.innerHTML = conventions.map((c) => `
      <article class="limit limit--warn" data-reveal>
        <h3>${md(c.t)}</h3>
        <p style="font-size:14px;color:var(--text-dim)">${md(c.d)}</p>
      </article>`).join("");
  }
})();
