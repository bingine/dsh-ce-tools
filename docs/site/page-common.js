/* ==========================================================================
   三页共用：帧引擎背景 / 导航 / 主题 / 涟漪 / 复制 / 滚动揭示 / 手风琴
   —— 与 app.js 同源，抽出来是为了让 source.html、download.html 也有一致手感。
   ========================================================================== */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  window.$c = { $, $$, reduceMotion };
  // ⚠️ 同时导出**裸 `$` / `$$`**。
  // 页面专属脚本习惯写 `const { $, md } = window`，
  // 而 `$` 原本只挂在 `window.$c` 里 —— 解构出来是 undefined，
  // 于是子页第一行就 `TypeError: $ is not a function`，整页空白。
  window.$ = $;
  window.$$ = $$;

  window.escapeHtml = function (s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };
  /** 只放行 `code` 与 ** 强调，其余转义 */
  window.md = function (s) {
    return window.escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  };

  /* ---------------------------- 帧引擎背景 ---------------------------- */
  const FrameEngine = (function () {
    const canvas = $("#frame-engine");
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    let w = 0, h = 0, dpr = 1, raf = 0, running = false, cells = [], cols = 0;

    const SIZE = 30;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    }
    function build() {
      cols = Math.ceil(w / SIZE) + 1;
      const rows = Math.ceil(h / SIZE) + 1;
      cells = new Array(cols * rows);
      for (let i = 0; i < cells.length; i++) {
        cells[i] = { born: Math.random() * 2600, life: 2600 + Math.random() * 3600,
                     hit: Math.random() < 0.055, seed: Math.random() };
      }
    }
    function frame(t) {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const p = ((t + c.born) % c.life) / c.life;
        const env = Math.sin(p * Math.PI);
        if (env <= 0.01) continue;
        const a = env * (c.hit ? 0.30 : 0.055) * (0.6 + 0.4 * c.seed);
        ctx.fillStyle = c.hit ? `rgba(53,214,196,${a})` : `rgba(120,160,200,${a * 0.7})`;
        ctx.fillRect((i % cols) * SIZE + 0.5, Math.floor(i / cols) * SIZE + 0.5, SIZE - 1.5, SIZE - 1.5);
      }
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!running && !reduceMotion) { running = true; raf = requestAnimationFrame(frame); } }
    function stop() { running = false; cancelAnimationFrame(raf); }

    let rt = 0;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (running) resize(); }, 160);
    });
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));

    resize(); start();
  })();

  /* ---------------------------- 按钮涟漪 ---------------------------- */
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("[data-ripple]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement("span");
    s.className = "btn__ripple";
    s.style.width = s.style.height = size + "px";
    s.style.left = (e.clientX - r.left) + "px";
    s.style.top = (e.clientY - r.top) + "px";
    el.appendChild(s);
    setTimeout(() => s.remove(), 640);
  });

  /* ---------------------------- 复制 ---------------------------- */
  window.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch { return false; }
    }
  };

  document.addEventListener("click", async (e) => {
    const cp = e.target.closest(".code-block__copy");
    if (!cp) return;
    e.stopPropagation();
    const box = cp.closest("[data-copy]");
    const code = box && $("pre", box);
    if (!code) return;
    if (await window.copyText(code.innerText)) {
      cp.classList.add("is-done");
      cp.style.opacity = "1";
      setTimeout(() => { cp.classList.remove("is-done"); }, 1200);
    }
  });

  /* ---------------------------- 导航 ---------------------------- */
  const nav = $("#nav"), progress = $("#nav-progress");
  const links = $$(".nav__links a");
  // ⚠️ 只取**页内锚点**（`#xxx`）。
  //
  // 源码页/下载页的导航是跨页相对链接（`./index.html`、`./source.html`），
  // 早先无差别地 `$(a.getAttribute("href"))` 会拿 `./index.html` 去
  // `document.querySelector` —— 那不是合法选择器，**直接抛 DOMException**。
  // 异常发生在 IIFE 中段，于是后面的 `window.$c` 再也没能导出，
  // 页面专属脚本里的 `$` 全部 undefined → 两个子页**整页空白**。
  const sections = links
    .map((a) => a.getAttribute("href"))
    .filter((h) => h && h.startsWith("#"))
    .map((h) => document.getElementById(h.slice(1)))
    .filter(Boolean);

  function onScroll() {
    if (nav) nav.classList.toggle("is-stuck", window.scrollY > 8);
    if (progress) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? (window.scrollY / max) * 100 : 0) + "%";
    }
    // 子页没有页内锚点，sections 为空 → 不做任何高亮（跨页链接的高亮写在 HTML 里）
    if (sections.length === 0) return;
    let cur = null;
    for (const s of sections) if (s.getBoundingClientRect().top <= 140) cur = s.id;
    links.forEach((a) => {
      const h = a.getAttribute("href");
      a.classList.toggle("is-active", h === "#" + cur);
    });
  }
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { onScroll(); ticking = false; });
  }, { passive: true });
  onScroll();

  /* ---------------------------- 主题 ---------------------------- */
  const KEY = "dsh-ce-tools-theme";
  const root = document.documentElement;
  const saved = localStorage.getItem(KEY);
  if (saved) root.setAttribute("data-theme", saved);

  const toggle = $("#theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem(KEY, next);
      toggle.style.transform = "rotate(180deg)";
      setTimeout(() => { toggle.style.transform = ""; }, 420);
    });
  }

  /* ---------------------------- 滚动揭示 ---------------------------- */
  $$("[data-reveal-delay]").forEach((el) => el.style.setProperty("--reveal-delay", el.dataset.revealDelay));

  if ("IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add("is-in");
        // data-count 可能挂在子元素上，必须递归查（单层 $() 找不到）
        $$("[data-count]", en.target).forEach(countUp);
        io.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    const watch = () => $$("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
    watch();
    new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
  } else {
    $$("[data-reveal]").forEach((el) => el.classList.add("is-in"));
    $$("[data-count]").forEach((el) => {
      el.textContent = (Number(el.dataset.count) || 0) + (el.dataset.suffix || "");
    });
  }

  /** 数字滚动：最后一帧必须钉到终值，否则会永久停在中间值。 */
  function countUp(el) {
    if (!el) return;
    const target = Number(el.dataset.count) || 0;
    const suffix = el.dataset.suffix || "";
    if (reduceMotion || target === 0) { el.textContent = target + suffix; return; }
    const dur = 900, t0 = performance.now();
    const tick = (t) => {
      if (el.dataset.pinned === "1") return;   // 已被兜底钉死
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target + suffix;
    };
    requestAnimationFrame(tick);
  }

  // 兜底：把数字钉到终值。用 pinned 标志避免与仍在跑的 rAF 动画抢同一个 textContent
  // （早先写成"只在小于目标时才写"，实测被冻结后继续跑的 rAF 又写回中间值）。
  function pinCounts() {
    $$("[data-count]").forEach((el) => {
      if (el.dataset.pinned === "1") return;
      el.dataset.pinned = "1";
      el.textContent = (Number(el.dataset.count) || 0) + (el.dataset.suffix || "");
    });
  }
  setTimeout(pinCounts, 1400);
  setTimeout(pinCounts, 2600);

  /* ---------------------------- 手风琴（通用） ---------------------------- */
  const PLUS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  window.renderFaq = function (host, items) {
    if (!host || !items) return;
    host.innerHTML = items.map((f, i) => `
      <div class="faq__item" data-faq="${i}">
        <button class="faq__q" type="button" aria-expanded="false" aria-controls="cfp-${i}">
          ${window.md(f.q)}
          <span class="faq__sign">${PLUS}</span>
        </button>
        <div class="faq__panel" id="cfp-${i}">
          <div class="faq__panelInner"><div class="faq__a">${window.md(f.a)}</div></div>
        </div>
      </div>`).join("");
    host.addEventListener("click", (e) => {
      const q = e.target.closest(".faq__q");
      if (!q) return;
      const item = q.closest(".faq__item");
      const open = item.classList.toggle("is-open");
      q.setAttribute("aria-expanded", String(open));
    });
  };
})();
