# dsh-ce-tools 站点

`dsh-ce-tools` 的说明文档与网页。纯静态，**零依赖、零构建**：
把 `docs/site/` 整个目录用任意静态服务器（或直接双击 `index.html`）打开即可。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 首页：能力总览、交互式扫描演示、上手、能力边界、配置、排查、设计取舍 |
| `source.html` | 源码页：目录结构、分层职责、硬约定、测试命令 |
| `download.html` | 下载页：安装命令、验证方式、三条获取路径、安装排查 |
| `styles.css` | 全部样式（设计令牌 + 深浅双主题 + 响应式） |
| `data.js` | **站点内容的单一事实来源** —— 工具清单、步骤、边界、FAQ、设计取舍都在这里 |
| `app.js` | 首页交互：帧引擎背景、按钮涟漪、手风琴、滚动揭示、数字滚动、扫描演示 |
| `page-common.js` | 三页共用：背景、导航、主题、复制、手风琴渲染 |
| `source.js` / `download.js` | 两个子页的内容渲染 |

> **改内容只改 `data.js`。** HTML 里不放正文，避免文档与 README 各写一份而漂移
> —— 这是本项目反复踩过的坑（`permissionDeniedAdvice` 的两份文案、`id` 语义的两套理解）。

## 本地预览

```bash
# 任选其一
python -m http.server 8000        # 然后打开 http://127.0.0.1:8000/docs/site/
npx serve docs/site
```

直接双击 `index.html` 也能用（`file://` 下 `navigator.clipboard` 不可用时，
复制会自动退回 `execCommand`，三页都能正常工作）。

## 动画

| 效果 | 实现 |
| --- | --- |
| 帧引擎背景 | `requestAnimationFrame` 驱动的 canvas 格子场，正弦包络做呼吸；意象取自内存扫描逐轮收窄。页面不可见时自动停机 |
| 按钮点击 | 指针位置生成 `.btn__ripple`，`scale(0)→scale(2.6)` 扩散淡出 |
| 展开 / 收起 | `grid-template-rows: 0fr → 1fr`，**无需 JS 测高**，任意内容高度都自然 |
| 滚动揭示 | `IntersectionObserver` 触发 `translateY(20px)→0` + 淡入，按 `data-reveal-delay` 错峰 |
| 数字滚动 | rAF 缓动计数；**带 pinned 兜底**，确保一定落到终值 |
| 卡片光晕 | 指针位置写进 `--mx/--my` CSS 变量，径向渐变跟随鼠标 |
| 导航进度 | 顶部 2px 进度条 + 当前区块高亮 |

### 两个必须保留的实现约定

1. **`html.js` 类**：`[data-reveal]` 的初始 `opacity: 0` 只在 `html.js` 下生效。
   否则脚本没跑（或首帧之前）就会整页空白 —— 这是真实的健壮性问题，不只是截图问题。
2. **数字必须钉到终值**：`countUp` 用 `el.dataset.pinned` 防止兜底与仍在跑的
   rAF 抢同一个 `textContent`。这些数字是**事实陈述**（16 个工具 / 0 依赖），
   停在动画中间值等于报错信息。

### 子页曾整页空白：两个叠加的错误（已修）

1. `page-common.js` 里 `$(a.getAttribute("href"))` 把**跨页相对链接**
   （`./index.html`）当选择器传给 `querySelector` → 抛 `DOMException`。
   异常发生在 IIFE 中段，`window.$c` 再也没导出 → 子页第一行就
   `TypeError: $ is not a function` → **整页空白**。
   现在只取 `#` 开头的页内锚点。
2. `source.js` / `download.js` 写的是 `const { $, md } = window`，
   而 `$` 只挂在 `window.$c` 上 —— 解构出来是 `undefined`。
   现在 `page-common.js` 同时导出裸 `$` / `$$` / `md` / `escapeHtml` / `copyText`，
   子页一律显式取用。

> **教训**：共享脚本里任何一处抛错都会让后续整段失效，而页面是 JS 渲染的
> —— 表现就是"空白"，没有任何提示。所以改完子页必须**抓控制台**验证，
> 不能只看截图（截图里空白和"内容还没渲染"长得一样）。

## 无障碍与降级

- 尊重 `prefers-reduced-motion`：关闭帧引擎与全部过渡
- 语义标签 + `aria-expanded` / `aria-controls` / `aria-pressed` 覆盖手风琴
- 手风琴按钮是真 `<button>`，可 Tab 聚焦、回车触发
- 焦点环用 `:focus-visible`，不干扰鼠标点击
- 深浅主题记忆在 `localStorage`，跟随首次访问时的系统表现

## 校验

```bash
for f in docs/site/*.js; do node --check "$f"; done   # 语法
```

**渲染校验必须抓控制台** —— 页面是 JS 渲染的，"脚本崩了"和"内容还没渲染"
在截图里长得一模一样：

```bash
chrome --headless --disable-gpu --no-sandbox \
  --enable-logging=stderr --v=0 --virtual-time-budget=6000 \
  --dump-dom "file:///<abs>/docs/site/source.html" 2>&1 >/dev/null | grep CONSOLE
```

无输出即无报错。再用 `--dump-dom` 数一下渲染出的节点（工具卡 16 / FAQ 11 等），
确认内容真的进去了。

截图看布局：

```bash
chrome --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=9000 --window-size=1440,900 \
  --screenshot=out.png "file:///<abs>/docs/site/index.html"
```

> 两个陷阱：
> 1. Chrome 的 `--virtual-time-budget` **不推进 CSS 过渡**，直接截图会拍到
>    `opacity: 0` 的中间态（曾据此误判"页面全白"）。校验布局请临时注入
>    `<style>html.js [data-reveal]{opacity:1!important;transform:none!important}</style>`，
>    动画本身则用真机浏览确认。
> 2. **别把页面复制到别处再测**。相对路径 `./data.js` 会失效，
>    `window.DOC` 直接是 `undefined` —— 会误判成"渲染逻辑有 bug"。
>    要测就改引用为绝对路径，或直接在原目录跑。
