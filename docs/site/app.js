/* ==========================================================================
   dsh-ce-tools 站点交互
   —— 帧引擎背景、按钮涟漪、展开/收起、滚动揭示、数字滚动、扫描演示
   ========================================================================== */
(function () {
  "use strict";

  const D = window.DOC;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ======================================================================
     1. 帧引擎背景
     意象取自内存扫描：一格格地址被点亮、被筛掉、最后收敛到少数命中。
     用 requestAnimationFrame 驱动；页面不可见时自动停机，不白烧 CPU。
     ====================================================================== */
  const FrameEngine = (function () {
    const canvas = $("#frame-engine");
    if (!canvas) return { start() {}, stop() {} };
    const ctx = canvas.getContext("2d", { alpha: true });
    let w = 0, h = 0, dpr = 1, raf = 0, running = false;
    let cells = [];

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    }

    function build() {
      const size = 30;
      const cols = Math.ceil(w / size) + 1;
      const rows = Math.ceil(h / size) + 1;
      cells = new Array(cols * rows);
      for (let i = 0; i < cells.length; i++) {
        cells[i] = {
          born: Math.random() * 2600,
          life: 2600 + Math.random() * 3600,
          hit: Math.random() < 0.055,
          seed: Math.random()
        };
      }
    }

    function frame(t) {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      const size = 30;

      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const age = (t + c.born) % c.life;
        const p = age / c.life;
        const x = (i % Math.ceil(w / size)) * size;
        const y = Math.floor(i / Math.ceil(w / size)) * size;

        // 进出场用正弦包络做出"呼吸"，避免整片同时亮灭
        const env = Math.sin(p * Math.PI);
        if (env <= 0.01) continue;
        const alpha = env * (c.hit ? 0.30 : 0.055) * (0.6 + 0.4 * c.seed);

        ctx.fillStyle = c.hit
          ? `rgba(53, 214, 196, ${alpha})`
          : `rgba(120, 160, 200, ${alpha * 0.7})`;
        ctx.fillRect(x + 0.5, y + 0.5, size - 1.5, size - 1.5);
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (running || reduceMotion) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    let rt = 0;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (running) resize(); }, 160);
    });
    document.addEventListener("visibilitychange", () => {
      document.hidden ? stop() : start();
    });

    resize();
    return { start, stop };
  })();
  FrameEngine.start();

  /* ======================================================================
     2. 按钮涟漪 + 复制反馈
     ====================================================================== */
  function ripple(e, el) {
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement("span");
    s.className = "btn__ripple";
    s.style.width = s.style.height = size + "px";
    s.style.left = (e.clientX - r.left) + "px";
    s.style.top = (e.clientY - r.top) + "px";
    el.appendChild(s);
    setTimeout(() => s.remove(), 640);
  }
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("[data-ripple]");
    if (el) ripple(e, el);
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 非安全上下文（file://）下 clipboard 不可用，退回 execCommand
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
  }

  // Hero 的「node wire.mjs」按钮
  const installBtn = $("#copy-install");
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      const ok = await copyText("node wire.mjs");
      if (!ok) return;
      installBtn.classList.add("is-done");
      setTimeout(() => installBtn.classList.remove("is-done"), 1500);
    });
  }

  // 代码块复制
  $$("[data-copy]").forEach((box) => {
    const btn = $(".code-block__copy", box);
    if (!btn) return;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = $("pre", box);
      if (!code) return;
      if (await copyText(code.innerText)) {
        btn.classList.add("is-done");
        btn.style.opacity = "1";
        setTimeout(() => btn.classList.remove("is-done"), 1200);
      }
    });
  });

  /* ======================================================================
     3. 手风琴（工具卡 / FAQ）
     用 grid-template-rows 0fr→1fr，天然适配任意内容高度，无需测高。
     ====================================================================== */
  const ICONS = {
    chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };

  const TOOL_ICON = {
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8ZM12 17v5"/>',
    cube: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>',
    read: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="2.6"/>',
    write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
    radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 20 6"/>',
    route: '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.5 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h6.5"/>',
    dis: '<path d="M4 4h16v16H4z"/><path d="M8 9h3M8 13h8M8 17h5"/>',
    asm: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
    auto: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    code: '<path d="m9 8-5 4 5 4M15 8l5 4-5 4"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
    shield: '<path d="M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-4Z"/><path d="m9 12 2 2 4-4"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'
  };

  function svg(inner) {
    return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>";
  }

  // 工具卡
  const grid = $("#tool-grid");
  if (grid && D.tools) {
    grid.innerHTML = D.tools.map((t, i) => `
      <article class="tool" data-tool="${i}">
        <button class="tool__head" type="button" aria-expanded="false" aria-controls="tp-${i}">
          <span class="tool__icon">${svg(TOOL_ICON[t.icon] || TOOL_ICON.cube)}</span>
          <span>
            <span class="tool__name">${t.name}</span>
            <span class="tool__desc">${t.desc}</span>
          </span>
          <span class="tool__chev">${ICONS.chevron}</span>
        </button>
        <div class="tool__panel" id="tp-${i}">
          <div class="tool__panelInner"><div class="tool__body">
            <p>${t.detail}</p>
            <span class="tool__tag">#${t.group}</span>
            <div class="code-block" style="margin-top:12px" data-copy>
              <button class="code-block__copy" type="button" aria-label="复制">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
              </button>
              <pre><code>${escapeHtml(t.code)}</code></pre>
            </div>
          </div></div>
        </div>
      </article>
    `).join("");

    // 事件委托：展开时把指针位置写进 CSS 变量，做出"跟随鼠标的光晕"
    grid.addEventListener("click", (e) => {
      const head = e.target.closest(".tool__head");
      if (head) {
        const card = head.closest(".tool");
        const open = card.classList.toggle("is-open");
        head.setAttribute("aria-expanded", String(open));
        return;
      }
      const cp = e.target.closest(".code-block__copy");
      if (cp) {
        e.stopPropagation();
        const box = cp.closest("[data-copy]");
        const code = box && $("pre", box);
        if (code && copyText(code.innerText)) {
          cp.classList.add("is-done");
          cp.style.opacity = "1";
          setTimeout(() => { cp.classList.remove("is-done"); }, 1200);
        }
      }
    });
    grid.addEventListener("pointermove", (e) => {
      const card = e.target.closest(".tool");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
      card.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
    });
  }

  // FAQ
  const faq = $("#faq");
  if (faq && D.faq) {
    faq.innerHTML = D.faq.map((f, i) => `
      <div class="faq__item" data-faq="${i}">
        <button class="faq__q" type="button" aria-expanded="false" aria-controls="fp-${i}">
          ${f.q}
          <span class="faq__sign">${ICONS.plus}</span>
        </button>
        <div class="faq__panel" id="fp-${i}">
          <div class="faq__panelInner"><div class="faq__a">${f.a}</div></div>
        </div>
      </div>
    `).join("");
    faq.addEventListener("click", (e) => {
      const q = e.target.closest(".faq__q");
      if (!q) return;
      const item = q.closest(".faq__item");
      const open = item.classList.toggle("is-open");
      q.setAttribute("aria-expanded", String(open));
    });
  }

  // 步骤
  const steps = $("#steps");
  if (steps && D.steps) {
    steps.innerHTML = D.steps.map((s) => `
      <article class="step" data-reveal>
        <p class="step__n">${s.n}</p>
        <p class="step__t">${s.title}</p>
        <p class="step__d">${s.d}</p>
      </article>
    `).join("");
  }

  // 边界清单
  const lno = $("#limit-no"), lwarn = $("#limit-warn");
  if (lno && D.limitNo) lno.innerHTML = D.limitNo.map((t) => `<li>${md(t)}</li>`).join("");
  if (lwarn && D.limitWarn) lwarn.innerHTML = D.limitWarn.map((t) => `<li>${md(t)}</li>`).join("");

  // 设计卡
  const cards = $("#design-cards");
  if (cards && D.design) {
    cards.innerHTML = D.design.map((c) => `
      <article class="card" data-reveal>
        <h3>${c.t}</h3>
        <p>${c.d}</p>
      </article>
    `).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // 只把 `code` 与 <b> 放行，其余转义
  function md(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  }

  /* ======================================================================
     4. 导航：滚动态 + 阅读进度 + 高亮当前节
     ====================================================================== */
  const nav = $("#nav"), progress = $("#nav-progress"), toTop = $("#to-top");
  const links = $$(".nav__links a");
  // ⚠️ 只取页内锚点。跨页相对链接（./source.html）不是合法选择器，
  // 拿去做 querySelector 会抛 DOMException，把整个脚本打断（见 page-common.js 同处注释）。
  const sections = links
    .map((a) => a.getAttribute("href"))
    .filter((h) => h && h.startsWith("#"))
    .map((h) => document.getElementById(h.slice(1)))
    .filter(Boolean);

  function onScroll() {
    const y = window.scrollY;
    nav.classList.toggle("is-stuck", y > 8);

    if (progress) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
    }
    if (toTop) toTop.classList.toggle("is-shown", y > 620);

    let cur = null;
    for (const s of sections) {
      if (s.getBoundingClientRect().top <= 140) cur = s.id;
    }
    links.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === "#" + cur));
  }
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { onScroll(); ticking = false; });
  }, { passive: true });
  onScroll();

  if (toTop) {
    toTop.addEventListener("click", () => {
      toTop.classList.remove("is-shown");
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
  }

  /* ======================================================================
     5. 滚动揭示 + 数字滚动
     ====================================================================== */
  // 先给 data-reveal-delay 定序
  $$("[data-reveal-delay]").forEach((el) => {
    el.style.setProperty("--reveal-delay", el.dataset.revealDelay);
  });

  if ("IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add("is-in");
        // ⚠️ 用 querySelectorAll 而不是 $()：`data-count` 挂在**子元素**上
        // （外层 dl/div 才是 data-reveal），单层查询会找不到，数字就一直停在 0。
        $$("[data-count]", en.target).forEach(countUp);
        io.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

    const watch = () => $$("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
    watch();
    // 动态插入的卡片也要纳入观察
    new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
  } else {
    $$("[data-reveal]").forEach((el) => el.classList.add("is-in"));
    $$("[data-count]").forEach((el) => { el.textContent = (Number(el.dataset.count) || 0) + (el.dataset.suffix || ""); });
  }

  // 兜底：把统计数字钉到终值。
  //
  // ⚠️ 必须**停掉动画**再写终值，而不是"只在小于目标时才写" ——
  // 早先写成 `if (cur < target) el.textContent = target`，但虚拟时间/后台标签页里
  // rAF 会被冻结在任意一帧，随后又继续跑并把数字改回中间值
  // （实测首屏 16 长期显示成 5）。
  // 这些数字是**事实陈述**（16 个工具 / 0 依赖 / 1 条命令），停在中间值等于报错。
  function pinCounts() {
    $$("[data-count]").forEach((el) => {
      if (el.dataset.pinned === "1") return;
      el.dataset.pinned = "1";
      el.textContent = (Number(el.dataset.count) || 0) + (el.dataset.suffix || "");
    });
  }
  // 先在动画结束后立刻钉一次，再加一个更长的兜底
  setTimeout(pinCounts, 1400);
  setTimeout(pinCounts, 2600);

  function countUp(el) {
    if (!el) return;
    const target = Number(el.dataset.count) || 0;
    const suffix = el.dataset.suffix || "";

    // ⚠️ 不管走哪条分支，**最后一定要落在目标值上**。
    // 早先的写法在 rAF 被节流/打断时会把数字永久停在中间值
    // （实测首屏出现 5 / 0 / 0，16 永远长不到），所以这里:
    //   - reduceMotion 直接写终值；
    //   - 动画路径在最后一帧显式赋值，而不是依赖最后一 tick 恰好跑到 1。
    if (reduceMotion || target === 0) {
      el.textContent = target + suffix;
      return;
    }
    const dur = 900, t0 = performance.now();
    const tick = (t) => {
      // 已被兜底钉死就别再动画了，否则会跟兜底抢同一个 textContent
      if (el.dataset.pinned === "1") return;
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target + suffix;   // 收尾钉死
    };
    requestAnimationFrame(tick);
  }

  /* ======================================================================
     6. 主题切换（记忆到 localStorage）
     ====================================================================== */
  const THEME_KEY = "dsh-ce-tools-theme";
  const root = document.documentElement;
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) root.setAttribute("data-theme", saved);

  const toggle = $("#theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
      toggle.style.transform = "rotate(180deg)";
      setTimeout(() => { toggle.style.transform = ""; }, 420);
    });
  }

  /* ======================================================================
     7. 扫描演示（把"首扫 → 收窄 → 命中"演出来）
     ====================================================================== */
  const scan = (function () {
    const host = $("#scan-rows");
    const step = $("#scan-step"), count = $("#scan-count");
    const runBtn = $("#demo-run"), resetBtn = $("#demo-reset");
    if (!host) return { play() {} };

    // ⚠️ 行数刻意压在 18 行以内：演示区是 CSS 限高的（超出部分淡出），
// 行数太多只会让动画跑很久却看不全，反而像"没展示完"。
const POOL = [];
    for (let i = 0; i < 18; i++) {
      POOL.push({ addr: "0x7FF6" + (0x0A0000 + i * 0x1B4).toString(16).toUpperCase(), val: (i % 5 === 0) ? "100" : String(50 + ((i * 37) % 900)) });
    }

    let timers = [];
    function clear() { timers.forEach(clearTimeout); timers = []; host.innerHTML = ""; }

    function row(p, cls, i) {
      const d = document.createElement("div");
      d.className = "scan__row " + cls;
      d.style.animationDelay = (i * 28) + "ms";
      d.innerHTML = '<span class="scan__tag"></span><span>' + p.addr + '</span><span class="scan__val">' + p.val + "</span>";
      host.appendChild(d);
      return d;
    }
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));

    function play() {
      clear();
      const L = reduceMotion ? 0 : 1;
      if (step) step.textContent = "action: first · type=dword · mode=exact · value=100";
      POOL.forEach((p, i) => later(120 + i * 34 * L, () => row(p, p.val === "100" ? "is-hit" : "", host.children.length)));
      later(120 + POOL.length * 34 * L + 160, () => {
        const n = POOL.filter((p) => p.val === "100").length;
        if (count) count.textContent = n + " 个候选";
        if (step) step.textContent = "首扫完成 · " + n + " 个候选";
      });
      later(120 + POOL.length * 34 * L + 620, () => {
        if (step) step.textContent = "action: next · mode=exact · value=85";
        Array.from(host.children).forEach((el, i) => {
          const p = POOL[i];
          if (p && p.val !== "100") later(i * 30 * L, () => el.classList.add("is-out"));
        });
      });
      later(1500 + POOL.length * 34 * L + 420, () => {
        const kept = Array.from(host.children).filter((el) => !el.classList.contains("is-out"));
        if (step) step.textContent = "再次扫描后 · " + kept.length + " 个仍在候选";
        if (count) count.textContent = kept.length + " / " + POOL.length;
      });
    }

    if (runBtn) runBtn.addEventListener("click", play);
    if (resetBtn) resetBtn.addEventListener("click", () => {
      clear();
      if (step) step.textContent = "待开始";
      if (count) count.textContent = "";
    });
    return { play };
  })();

  // 进入视口时自动跑一次演示
  const demo = $("#scan-demo");
  if (demo && "IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { scan.play(); io.disconnect(); } });
    }, { threshold: 0.35 });
    io.observe(demo);
  }

  /* ======================================================================
     8. 汇编数字语义：点一下切换十进制 / 十六进制写法
     ====================================================================== */
  (function () {
    const wrap = $("#demo-asm");
    if (!wrap) return;
    const src = $("#asm-src"), bytes = $("#asm-bytes"), back = $("#asm-back");
    const CASES = [
      { src: "mov eax, 11223344", bytes: "B8 30 41 AB 00", back: "mov eax, 0xab4130" },
      { src: "mov eax, 0x11223344", bytes: "B8 44 33 22 11", back: "mov eax, 0x11223344" }
    ];
    let i = 0;
    wrap.addEventListener("click", () => {
      i = (i + 1) % CASES.length;
      const c = CASES[i];
      src.textContent = c.src; bytes.textContent = c.bytes; back.textContent = c.back;
      wrap.classList.remove("is-flip");
      void wrap.offsetWidth;
      wrap.classList.add("is-flip");
    });
  })();

  /* ======================================================================
     9. 跨页动画延续：让多页之间的跳转也有"展开"感
     ====================================================================== */
  // 进入新页面时，卡片按顺序浮现（配合 CSS 的 data-reveal）
  window.addEventListener("pageshow", () => {
    if (reduceMotion) return;
    $$("[data-reveal]").forEach((el, i) => {
      el.style.setProperty("--reveal-delay", Math.min(8, Math.floor(i / 3)));
      requestAnimationFrame(() => el.classList.add("is-in"));
    });
  });

  console.info("%c dsh-ce-tools ", "background:#35d6c4;color:#06121a;font-weight:700;border-radius:3px",
    "让 AI 拥有 Cheat Engine 的能力 · 纯用户态 · 零外部依赖");
})();
