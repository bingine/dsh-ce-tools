/**
 * dsh-ce-tools 站点内容数据。
 *
 * 单一事实来源：站点正文一律从这里渲染，改文档时只改这一处，
 * 避免 HTML 与 README 各写一份而再次漂移（这是本项目的既有教训）。
 */
window.DOC = {
  tools: [
    {
      name: "ce_processes",
      icon: "list",
      group: "进程",
      desc: "列出或搜索进程，找到目标 pid。",
      detail: "起手式工具。先用它确认进程名与 pid，再交给 ce_attach。",
      code: `ce_processes { filter: "game" }`
    },
    {
      name: "ce_attach",
      icon: "target",
      group: "进程",
      desc: "附加目标（按 pid 或名字），返回主模块基址。",
      detail: "附加前会关闭上一个目标句柄。换目标等于换会话状态（扫描结果、Lua state、地址表都会失效）。",
      code: `ce_attach { pid: 1234 }`
    },
    {
      name: "ce_session",
      icon: "plug",
      group: "进程",
      desc: "会话状态 / 摘下目标并释放句柄。",
      detail: "不用了记得摘 —— 空闲 30 分钟也会自动回收，但显式释放更干净。",
      code: `ce_session { action: "status" }`
    },
    {
      name: "ce_modules",
      icon: "cube",
      group: "进程",
      desc: "模块基址与大小 —— 做「模块名+偏移」静态地址的参照。",
      detail: "静态地址（模块名+偏移）比扫描出来的临时地址稳定得多，值得优先找。",
      code: `ce_modules { filter: "game" }`
    },
    {
      name: "ce_regions",
      icon: "map",
      group: "内存",
      desc: "内存区域（可读/可写/可执行、类型、保护属性）。",
      detail: "排查「为什么扫不到」的第一站：确认目标地址所在区域是否可扫描。",
      code: `ce_regions { filter: "writable" }`
    },
    {
      name: "ce_read",
      icon: "read",
      group: "内存",
      desc: "读内存，支持 count/stride 批量、addresses 离散地址、地址表达式。",
      detail: "地址表达式与 CE 一致：`game.exe+1000`、`00401000`、`[[base]+4]`。",
      code: `ce_read { address: "game.exe+1000", type: "dword" }`
    },
    {
      name: "ce_write",
      icon: "write",
      group: "内存",
      desc: "写内存，写完立刻回读校验并报告原值/现值；可配 retry 重试。",
      detail: "回读不一致时结果里 verified 会明确标成 false —— 通常是目标进程自己把值改回去了，或页不可写。",
      code: `ce_write { address: "0x...", type: "dword", value: "9999" }`
    },
    {
      name: "ce_scan",
      icon: "radar",
      group: "扫描",
      desc: "完整扫描流程：首次 → 再次 → 结果 → 重置（含 AOB 与通配符）。",
      detail: "找不到初值就用「未知初值」流程：first 用 mode: unknown，之后反复 next 配 increased / decreased / unchanged / changed。",
      code: `ce_scan { action: "first", type: "dword", mode: "exact", value: "100" }`
    },
    {
      name: "ce_pointer_scan",
      icon: "route",
      group: "扫描",
      desc: "找「基址+多级偏移」的稳定路径，附带可直接复用的表达式。",
      detail: "返回的每条路径都带 expression，可直接喂给 ce_read / ce_write。指针映射按选项签名缓存复用，同进程里再次扫描会明显更快。",
      code: `ce_pointer_scan { address: "0x...", staticOnly: true, maxLevel: 5 }`
    },
    {
      name: "ce_disassemble",
      icon: "dis",
      group: "汇编",
      desc: "反汇编，标出跳转/调用目标。",
      detail: "看汇编结果对不对时，先用这个核对一遍。",
      code: `ce_disassemble { address: "0x...", count: 12 }`
    },
    {
      name: "ce_assemble",
      icon: "asm",
      group: "汇编",
      desc: "汇编成机器码，可选手写入（带回读校验与可还原的原字节）。",
      detail: "输出里的反汇编核对段会告诉你立即数被解成了什么值 —— 这是本插件防十进制/十六进制坑的主要手段。",
      code: `ce_assemble { code: "mov eax, 0x11223344" }`
    },
    {
      name: "ce_auto_assemble",
      icon: "auto",
      group: "汇编",
      desc: "AutoAssembler 脚本：AOBSCAN / ALLOC / 代码注入 / ENABLE·DISABLE。",
      detail: "改脚本时先用 action: check 预演（不碰内存），确认通过再 enable；调试完用 disable 依记录的原字节精确还原。",
      code: `ce_auto_assemble { action: "check", script: "..." }`
    },
    {
      name: "ce_lua",
      icon: "code",
      group: "扩展",
      desc: "直接跑 CE Lua 脚本（逃生通道），可列出可用 API。",
      detail: "内置工具覆盖不到时用它。action: api 会列出当前可用的全部 API 名字。脚本里的 print 输出会被收集并一并返回。",
      code: `ce_lua { code: "return readInteger(getAddress('game.exe+1000'))" }`
    },
    {
      name: "ce_cheat_table",
      icon: "table",
      group: "扩展",
      desc: ".CT 地址表读写，与 Cheat Engine 本体互通。",
      detail: "生成的 .CT 可直接用 CE 打开继续手动调试。注意 .CT 里每个裸数字都是十六进制，与工具参数的十进制手输语义刻意不同。",
      code: `ce_cheat_table { action: "save", path: "D:/my-table.ct" }`
    },
    {
      name: "ce_kernel",
      icon: "shield",
      group: "扩展",
      desc: "内核驱动 DBK64 的自动获取/安装/加载。",
      detail: "需要管理员权限。用于突破 PPL / 反作弊这类用户态读不到的进程 —— 但这是安全边界扩张，请自行评估。",
      code: `ce_kernel { action: "status" }`
    },
    {
      name: "ce_elevation",
      icon: "lock",
      group: "扩展",
      desc: "提权入口的兜底（dsh-get-admin 未启用时模型侧仍可调用）。",
      detail: "action=status 只读，能一次看清有没有助手、UAC 是否被禁用。设 GET_ADMIN_NO_ELEVATE=1 后 request 会直接拒绝且一个窗都不弹。",
      code: `ce_elevation { action: "status" }`
    }
  ],

  steps: [
    {
      n: "01",
      title: "校验内核能加载",
      text: "先确认内核真的能 require 起来。加载不了就宁可不接 —— 接出一行 failed 比不接更难查。"
    },
    {
      n: "02",
      title: "建内核目录联接",
      text: "在插件自己的 node_modules 里为内核建目录联接，让 require('@bingine/cemem') 可解析。"
    },
    {
      n: "03",
      title: "登记 profile 依赖",
      text: "在 profile 的 package.json 里登记 link: 依赖。"
    },
    {
      n: "04",
      title: "接入加载行",
      text: "建 profile 侧目录联接（名字就是包名 dsh-ce-tools），并向 cordis.patch.yml 插入加载行。桌面版通常靠 HMR 直接热加载。"
    }
  ],

  limitNo: [
    "读写被保护进程（反作弊、PPL）—— 没有内核驱动。可配 backend: native-ce 连官方 ceserver（需自行准备并启动）",
    "硬件断点、DBVM 超管隐身 —— 内核驱动 / hypervisor 能力，Node 无实现路径",
    "createthread 真正执行 —— Node 没有 CreateRemoteThread；内核只做校验并在结果里报告",
    "调试器（单步、寄存器上下文）—— 本移植不含调试器",
    "后台持续「冻结」数值 —— ce_cheat_table 的 frozen 只是标记，不会常驻写回"
  ],

  limitWarn: [
    "指令里的裸数字按十进制解析（mov eax, 1337 是十进制 1337），十六进制必须写 0x 前缀或 h 后缀。写错不报错，只静默产生错误字节",
    "db/dw/dd/dq 数据指令里的裸数字按 CE 习惯是十六进制（db 89 01 = 两个字节 89 01）。两套规则并存",
    ".CT 里的每一个裸数字都是十六进制，而工具参数里的裸数字按十进制 —— 两条路刻意不同，各有测试钉住"
  ],

  faq: [
    { q: "状态路由 404", a: "加载行没生效。确认 cordis.patch.yml 里有 id: cheat-engine，然后重启 dsh。" },
    { q: "工具返回「未能加载 cemem 内核」", a: "内核不在默认位置。用 wire.mjs --kernel <目录> 重接，或在配置里设 kernelPath。" },
    { q: "「还没有附加到任何进程」", a: "先 ce_attach（ce_processes 拿 pid）。" },
    { q: "扫描命中 0 个", a: "换类型（dword/float/double 都可能是候选）、用 mode: between 放宽、放开区域过滤；确认目标进程里确实是这个数。" },
    { q: "再次扫描报「没有结果」", a: "上一步筛光了。action: reset 后重来。" },
    { q: "指针扫描找不到", a: "先看输出里的「第一级候选」是否为 0：为 0 说明没有指针指向它（可能是栈上临时值）；否则调大 maxOffset、去掉 staticOnly。" },
    { q: "汇编写出的字节不对", a: "看 ce_assemble / ce_auto_assemble 输出里的反汇编核对段，或直接用 ce_disassemble。" },
    { q: "写入后回读不一致", a: "目标进程自己把值改回去了（常见于游戏）或页不可写。结果里 verified: false 会明确标出。" },
    { q: "读/写/附加报「权限不足」", a: "目标以更高权限运行。看错误里的两条主路径：以管理员重启 DSH，或用管理员权限的 ceserver 配 backend: native-ce。" },
    { q: "已提权却仍被拒", a: "目标多半受 PPL / 反作弊保护，普通用户态无解，需要内核驱动。" },
    { q: "原生 CE 后端下扫描报错", a: "扫描/指针/汇编内部是同步路径，需要 backend: self。" }
  ],

  design: [
    {
      t: "不 import 任何 @deepseek-ai/* 包",
      d: "桌面版把 DSH 依赖打进 asar，而 profile 里的联接指向 npm 全局那份，两者版本不同。插件只要 import 就会把另一个版本的实现拉进来，注册表校验对不上时直接抛错、整个插件激活失败，而界面只显示 failed，极难定位。于是自己实现 defineTool，把模块解析风险降到零。"
    },
    {
      t: "内核延迟加载",
      d: "内核在 require 那一刻就会 eager 加载 koffi 原生扩展并绑定 kernel32。若在插件激活时加载，任何环境问题都会变成「插件激活失败」；放到第一次真正调用工具时，它就只是一条可读的工具错误。"
    },
    {
      t: "出口统一收敛成一个规范 JSON 值",
      d: "注册表对返回值做 lossless-JSON 规范化：bigint 会直接抛错。所以全部工具都经统一信封返回 { summary, lines, data }，bigint / Buffer / Map 在出口处统一转成字符串。"
    },
    {
      t: "失败靠抛错表达（isError）",
      d: "官方《工具编写参考》写明「抛出异常或返回无效值意味着 isError」。未附加目标、地址解析不了、写不进去、用法错误……一律 throw，模型看到的仍是完整可读的诊断。"
    }
  ]
};
