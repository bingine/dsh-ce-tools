/* 下载页内容 */
(function () {
  "use strict";
  const { $ } = window;
  const md = window.md;
  const copyText = window.copyText;

  const ways = [
    { t: "① 仓库子目录（默认）", d: "clone 仓库后内核就在 node-cheat-engine/ 下，wire.mjs 会自动找到它。最省事的一条路，也是本地开发默认走的。" },
    { t: "② 从 npm 装内核", d: "npm i @bingine/cemem 装到全局或本仓库，再让 wire.mjs 解析到它。适合不想保留整个内核仓库的情况。" },
    { t: "③ 显式指定路径", d: "node wire.mjs --kernel D:/path/to/node-cheat-engine，或在加载行配置里设 kernelPath。两者都会覆盖自动探测。" }
  ];

  const faq = [
    { q: "状态路由返回 404", a: "加载行没生效。确认 cordis.patch.yml 里有 id: cheat-engine，然后重启 dsh。桌面版通常靠 HMR 热加载，改插件的 **JS 文件** 默认不会热重载 —— 需要热重载就在 profile 的 cordis.patch.yml 里把 hmr 的 root 指向本仓库（会整体替换 config，root 必须完整重述）。" },
    { q: "提示「未能加载 cemem 内核」", a: "内核不在默认位置。用 wire.mjs --kernel <目录> 重接，或在配置里设 kernelPath。" },
    { q: "加载行的 name 该写什么", a: "必须是**包名** dsh-ce-tools，不是仓库目录名。写错会让客户端模块重复注册、整个应用起不来 —— 这是真实踩过的，test/startup.test.mjs 会拦住这类错误。" },
    { q: "改代码没生效", a: "HMR 默认只覆盖配置。改 lib/*.js 需要重启 DSH，或配 hmr 的 root 让它盯住本仓库。" },
    { q: "工具没出现怎么办", a: "先 curl 状态路由看 toolCount 是不是 16。桌面版热加载偶尔有延迟，重启一次通常就好。" }
  ];

  const host = $("#ways");
  if (host) {
    host.innerHTML = ways.map((c) => `
      <article class="card" data-reveal>
        <h3>${md(c.t)}</h3>
        <p>${md(c.d)}</p>
      </article>`).join("");
  }

  window.renderFaq($("#install-faq"), faq);

  // 主 CTA 的复制
  const btn = $("#copy-wire");
  if (btn) {
    btn.addEventListener("click", async () => {
      if (!(await copyText("node wire.mjs"))) return;
      btn.classList.add("is-done");
      setTimeout(() => btn.classList.remove("is-done"), 1500);
    });
  }
})();
