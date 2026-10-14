# dsh-ce-tools

> **包名是 `dsh-ce-tools`**（npm 封禁了 "cheat-engine" 一词，所以早期叫 `dsh-cheat-engine`）。
> 如果你的本地 checkout 目录还叫 `dsh-cheat-engine`，那只是历史遗留的**目录名**，不影响任何功能。
> 凡是"必须等于包名"的地方（客户端 `id`、服务端 `PACKAGE_NAME`、`cordis.patch.yml` 的
> `name:`、profile 联接名）**只能写包名** —— 写错会让客户端模块重复注册、整个应用起不来
> （真实踩过）。`test/startup.test.mjs` 会拦住这类错误。

让 AI 拥有 Cheat Engine 的能力。由 **[@bingine/cemem](https://github.com/bingine/cemem)**
（Cheat Engine 核心引擎的 Node.js 移植，**另一个独立仓库**）驱动，
纯用户态、**不需要安装 Cheat Engine 本体**。

注册 16 个模型可直接调用的工具，覆盖 CE 在用户态能做的核心工作：

| 工具 | 作用 |
| --- | --- |
| `ce_processes` | 列出/搜索进程，找到目标 pid |
| `ce_attach` | 附加目标（按 pid 或名字），返回主模块基址 |
| `ce_session` | 会话状态 / 摘下目标并释放句柄 |
| `ce_modules` | 模块基址与大小 —— 做「模块名+偏移」静态地址的参照 |
| `ce_regions` | 内存区域（可读/可写/可执行、类型、保护属性） |
| `ce_read` | 读内存（支持 `count`/`stride` 批量、`addresses` 离散地址、地址表达式） |
| `ce_write` | 写内存，**写完立刻回读校验**并报告原值/现值；可配 `retry` 重试 |
| `ce_scan` | 完整扫描流程：首次 → 再次 → 结果 → 重置（含 AOB 与通配符） |
| `ce_pointer_scan` | 找「基址+多级偏移」的稳定路径，附带可直接复用的表达式 |
| `ce_disassemble` | 反汇编，标出跳转/调用目标 |
| `ce_assemble` | 汇编成机器码，可选手写入（带回读校验与可还原的原字节） |
| `ce_auto_assemble` | AutoAssembler 脚本：AOBSCAN / ALLOC / 代码注入 / `[ENABLE]`·`[DISABLE]` |
| `ce_lua` | 直接跑 CE Lua 脚本（逃生通道），可列出可用 API |
| `ce_cheat_table` | `.CT` 地址表读写，与 Cheat Engine 本体互通 |
| `ce_kernel` | 内核驱动 DBK64 的自动获取/安装/加载（见 [§七](#七内核驱动ce_kernel)） |
| `ce_elevation` | 提权入口的兜底（`dsh-get-admin` 未启用时模型侧仍可调用） |

---

## 一、安装

### 前置条件

- Windows x64
- 内核存在且可 `require`：仓库里内核是子目录 `node-cheat-engine/`（发布名 `@bingine/cemem`），
  也可以从 npm 装 `@bingine/cemem`，或用 `--kernel` / `CE_KERNEL_PATH` 指定别处
- DSH 桌面版（或 `dsh web`）

### 接入（一条命令，幂等）

```powershell
cd <本仓库根目录>              # 目录名随意；判断依据是 package.json 里的包名 dsh-ce-tools
node wire.mjs                 # 默认接入 desktop profile
node wire.mjs --profile web   # 换 profile
node wire.mjs --kernel <目录>  # 显式指定内核目录
node wire.mjs --unwire        # 卸载
```

`wire.mjs` 做四件事，每步都先留时间戳备份、可重复执行：

1. 校验内核真能 `require` 起来（否则宁可不接，也不要接出一行 `failed`）；
2. 在插件自己的 `node_modules` 里为内核建目录联接，让 `require('@bingine/cemem')` 可解析；
3. 在 profile 的 `package.json` 登记 `link:` 依赖；
4. 建 profile 侧目录联接（名字就是**包名**），并向 `cordis.patch.yml` 插入加载行。

桌面版通常靠 HMR 直接热加载这一行；若工具没出现，重启一次即可。

> 注意：HMR 只覆盖**配置**（加载行、config）。改动插件的 **JS 文件**（`lib/*.js`）默认
> **不会**热重载 —— `dsh-base` 的 `hmr` 行默认是 `root: []`。要让改代码也即时生效，把下面这段
> 加进 profile 的 `cordis.patch.yml`（会整体替换 `hmr` 的 config，所以 `root` 必须完整重述）：
>
> ```yaml
> - id: hmr
>   config:
>     root: ["D:/Project/dsh-ce-tools"]   # ← 换成你本仓库的真实绝对路径
> ```

### 验证是否激活

```powershell
curl http://127.0.0.1:19387/cheat-engine/status
```

返回 JSON 里 `toolCount: 16` 且 `tools` 列出全部 `ce_*` 就说明注册成功。这个路由是**只读**的：
它不会加载内核、不读任何进程内存、不写任何东西（`kernel.loaded: false` 正是它轻量的证明）。

---

## 二、典型用法

### 1. 找一个数值的地址

```
ce_processes  { filter: "game" }              → 拿到 pid
ce_attach     { pid: 1234 }                   → 主模块基址
ce_scan       { action: "first", type: "dword", mode: "exact", value: "100" }
   （在游戏里让数值变化）
ce_scan       { action: "next", type: "dword", mode: "exact", value: "85" }
ce_scan       { action: "results", limit: 20 } → 地址列表 + 每个地址的当前值
ce_write      { address: "0x...", type: "dword", value: "9999" }
```

找不到初值时用「未知初值」流程：`first` 用 `mode: "unknown"`，之后反复
`next` + `mode: increased / decreased / unchanged / changed`。

### 2. AOB 扫描定位代码，然后注入

```
ce_scan         { action: "first", type: "aob", value: "48 8B 05 ?? ?? ?? ?? 89 41 08" }
ce_disassemble  { address: "0x...", count: 12 }
ce_auto_assemble { action: "check", script: "..." }     ← 先预演，不碰内存
ce_auto_assemble { action: "enable", script: "..." }
   （调试完）
ce_auto_assemble { action: "disable", script: "..." }   ← 用记录的原字节精确还原
```

### 3. 把临时地址变成稳定地址

```
ce_pointer_scan { address: "0x...", staticOnly: true, maxLevel: 5 }
```

返回的每条路径都带 `expression`，可直接喂给 `ce_read` / `ce_write`，也可写进 `.CT` 表。

### 4. 与 Cheat Engine 本体互通

```
ce_cheat_table { action: "add_scan", count: 20, descriptionPrefix: "health" }
ce_cheat_table { action: "save", path: "D:/my-table.ct" }
```
生成的 `.CT` 可直接用 Cheat Engine 打开继续手动调试。

**`.CT` 的地址语义与手输不同（重要）**：`.CT` 是 CE 自己的文件格式，里面的
**每一个裸数字都是十六进制** —— `00401000` 是 `0x401000`、`"mod.exe"+1000` 是
"基址 + 0x1000"、子条目的 `+18` 是"父条目 + 0x18"、`1000+1000` 是 `0x2000`。
而工具参数里的 `address` 面对的是**手输**，裸数字按**十进制**（与 CE 的扫描数值框一致）。
两条路刻意不同，各自有测试钉住（内核 `cheatTable` 那组 + 本仓库的
`test/ct-address-semantics.test.mjs`）。

写出时用的是 CE 的原生形态：地址**不带外层引号**、裸十六进制（`"mod.exe"+12ab34`）、
用户自定义符号写进 `<UserdefinedSymbols>` 且**保留原文**（`myStat+10` 不会被换算成绝对地址）。
载入时这些符号会真的注册，条目里可以直接引用（`myStat+8`）。

**`load` 不需要已附加进程**（它是纯文件操作）：未附加时只列出地址表达式，不解析、不读值。
**表级元数据会原样往返**：`save` 写回**载入的表版本**（不写死 46 —— CE 的
`_CurrentTableVersion` 是 45，写高了 CE 打开时会弹「有更新版本」）、
保留原表注释（原本没有注释时才用插件自己那句）、并原样保留根级其它属性与
`<Structures>` / `<LuaScript>` / `<Forms>` / `<Files>` / `<CheatCodes>` / `<Comments>`。
**空表与坏文件分开报错**：`<CheatTable><CheatEntries/></CheatTable>` 这类**合法空表**
要显式 `force: true` 才载入（默认拒绝，避免静默清空当前表），而空文件 / 非 XML 会被
明确说成"不像是一个 .CT"。

**同一条地址文本，`add` 与 `load` 给出同一个地址**（含 `ff+20` 这种裸十六进制字面量开头、
以及 `"mod.exe" + 9018` 这种数字前带空白的写法 —— CE 的 `tokenize` 对每个 token 都 trim）。
内部的裸十进制在**写出时**会换算成十六进制，所以 `add 1000` → 文件里的 `<Address>3e8</Address>`
→ 读回来仍是同一个地址（`add → save → load` 不会静默改地址）。

---

## 三、配置

插件不声明 schemastery 的 `Config`（原因见第五节），配置从加载行的 `config` 读取，
未给的一律用出厂默认：

```yaml
- insert:
    - id: cheat-engine
      name: 'dsh-ce-tools'          # ⚠️ 必须是**包名**，不是仓库目录名
      config:
        allowWrite: false          # 只读模式：禁掉 ce_write 与 AutoAssembler 的写入段
        backend: self              # self（默认，零依赖）| native-ce（连 ceserver）
        kernelPath: 'D:/.../node-cheat-engine'
        pointerScanMaxLevel: 5
        pointerScanMaxOffset: 2048
        arch: ''                   # 空 = 按目标位数推断
        scanParallel: true
        maxReadBytes: 4096
        idleTimeoutMs: 1800000     # 空闲 30 分钟回收会话（释放句柄/worker/Lua state）
```

完整列表见 `lib/index.js` 的 `CONFIG_DEFAULTS`。

---

## 四、能力边界（重要，请读完再用）

本插件复刻的是 **Cheat Engine 未加载内核驱动时**的用户态能力。诚实的边界：

| 做不到 | 原因 |
| --- | --- |
| 读写被保护进程（反作弊、PPL） | 没有内核驱动。可配 `backend: native-ce` 连官方 `ceserver`（需自行准备并启动） |
| 硬件断点、DBVM 超管隐身 | 内核驱动 / hypervisor 能力，Node 无实现路径 |
| `createthread` 真正执行 | Node 没有 `CreateRemoteThread`；内核只做校验并在结果里报告 |
| 调试器（单步、寄存器上下文） | 本移植不含调试器 |
| 后台持续「冻结」数值 | `ce_cheat_table` 的 `frozen` 只是**标记**，不会常驻写回 |

### 与 Cheat Engine 的差异（会静默坑人的那条）

**指令里的裸数字按十进制解析**（`mov eax, 1337` 是十进制 1337），十六进制必须写 `0x` 前缀或
`h` 后缀（`mov eax, 0x11223344`）。这与 CE 帮助文档一致，但和「AutoAssembler 里什么都当十六进制看」
的直觉相反 —— 写错不会报错，只会**静默产生错误的字节**。

**所以本插件不靠"记文档"来防这个坑：`ce_assemble` 与 `ce_auto_assemble` 会把汇编结果
反汇编回来一并展示**，立即数被解成什么值一眼可见。例如 `mov eax, 11223344` 会显示：

```
结果：B8 30 41 AB 00  （5 字节）
反汇编（核对立即数：裸数字=十进制，0x…/…h=十六进制）：
  0x…  mov eax, 0xab4130      ← 想写十六进制就得写 0x11223344
```

反过来，`db/dw/dd/dq` 数据指令里的裸数字按 CE 习惯是**十六进制**（`db 89 01` = 两个字节 `89 01`）。
两套规则并存，反汇编核对段能同时覆盖这两种情况；测试里也钉住了这两个方向。

> 本插件默认对内存**有写权限**（`allowWrite: true`）——这是 Cheat Engine 能力的核心，
> 但也意味着模型可以修改任意已打开进程的内存。只做分析时建议设 `allowWrite: false`。

---

## 五、为什么这样设计

三条贯穿全插件的决定，都来自实际踩过的坑：

**1. 不 import 任何 `@deepseek-ai/*` 包。**
桌面版把 DSH 依赖打进 asar，而 profile 里的 `@deepseek-ai/*` 联接指向 npm 全局那份，两者版本不同
（实测 `0.2.0-rc.2` vs `0.1.0-rc.8`）。插件只要 import 就会把**另一个版本**的实现拉进来，
注册表校验对不上时 `tools.register()` 直接抛错、整个插件激活失败，而界面只显示 `failed`，极难定位。
注册表真正要求的只有 `name` / `description` / `parameters`（原始 JSON Schema）/ `output.schema` /
`output.render`，于是自己实现 `defineTool`（`lib/toolkit.js`），把模块解析风险降到零。

**2. 内核延迟加载。**
内核在 `require` 那一刻就会 eager 加载 koffi 原生扩展并绑定 `kernel32`。若在插件激活时加载，
任何环境问题都会变成「插件激活失败」；放到第一次真正调用工具时，它就只是一条可读的工具错误。

**3. 出口统一收敛成一个规范 JSON 值。**
注册表对返回值做 lossless-JSON 规范化：**`bigint` 会直接抛错**，多一个未声明的键或把可选字段填成
`null` 也会让整次调用失败。而内存工具天然到处是 bigint。所以全部工具都经 `makeEnvelopeTool` 返回
`{ summary, lines, data }`，bigint / Buffer / Map 在出口处统一转成字符串。

**4. 失败靠抛错表达（`isError`），不在返回值里放标志位。**
官方《工具编写参考》写明「抛出异常或返回无效值意味着 `isError`」，且「基础设施故障请抛异常」。
所以未附加目标、地址解析不了、写不进去、用法错误……一律 `throw`；模型看到的仍是完整可读的诊断
（我把原因、候选列表、下一步建议都写进错误消息里）。
> 第一版这里做反了：用 `{ ok: false, ... }` 表示失败。那样这次调用在 harness 眼里是**成功**的 ——
> UI 卡片显示成功、`tools/result` 观测到成功、PTC 里 `await tools.ce_write(...)` 正常 resolve
> 而不是 reject。这是读了官方文档后纠正的，现在有测试专门盯着「失败必须 reject」。

另外两条体验上的选择：

- **不声明 UI 卡片投影**。内置 Web Client 不消费 `presentCall` / `presentResult`，而官方要求这些
  投影必须是 `args`（+result）的纯函数并服务于既有卡片类型（`card` 标签的联合）。本插件没有这类
  需求，于是交给默认的通用卡片 —— 第一版自造了 14 处 `presentationMeta` 形状（看着像卡片、其实
  没人消费），已全部移除。
- **`ce_pointer_scan` 不会因为 `maxLevel` 给太深而「找不到」**。内核只在**恰好达到 `maxLevel`
  深度**时返回路径，所以按 CE 默认给 `maxLevel: 5` 常常得到「找不到」——即使存在合法的 2 级路径。
  工具因此打开内核的 `preferShallow`：**一次扫描**汇总第 1..maxLevel 级的全部路径，
  由内核按「层数浅优先、同层静态基址优先」排序后再按 `maxResults` 截断，
  并把汇总行为（各级候选数、结果里最深几级）**明确写在输出里**（不静默）。
  只有在汇总模式**一条都没通过可用性验证**时，才退回「只取恰好 `maxLevel` 级」的模式再试一次。
  另外，指针映射（整片内存的索引，秒级~数十秒级）按**选项签名**缓存复用，所以同一进程里
  再次扫描会明显更快，且一次调用不会重建两遍（见 `lib/session.js` 的 `pointerScannerFor`）。
- **遵守 `exec.signal` 的开工前检查**。调用方已取消时直接拒绝开工。但扫描/指针扫描内部是**同步的
  原生循环**（对齐 CE 的 memscan），中途无法抢占式中断 —— 这是如实告知的限制，不是「已支持取消」。

---

## 六、测试

```powershell
npm run check         # 语法检查全部模块 + 客户端 id 守卫
npm run test:unit     # 单元测试（纯函数 / 工具定义 / 注册形状 / 状态路由 / 写校验规则 / signal / 提权判定）
npm run test:e2e      # 真实跨进程端到端测试
npm run test:retry    # 写入重试逻辑（参数收敛、错误分类、重试语义）
npm run test:remote   # 提权助手远程后端
npm run test:kernel   # 内核驱动（PE 解析、cepack 解包、安全闸门、只读状态）
npm run test:startup  # **启动层面**验证（真实客户端模块系统 + 干净目录安装产物）
npm run verify:guards # 反向验证全部守卫：把 bug 改回去，确认测试真的会红
npm test              # 全部
npm run verify:kernel # 真实获取 DBK64（从本机 CE 解 cepack，需本机装了 CE）
npm run soak          # 浸泡测试：反复跑 e2e 并按退出码归类原生崩溃（见「已知问题」）
```

`npm test` 里的 `test/startup.test.mjs` 是**启动层面**的验证，值得单独说：它把
`lib/client.js` 交给**真实的** DSH 客户端模块系统（从 DSH 安装目录的 `app.asar` 里
取出 `@deepseek-ai/dsh-client-modules/lib/client.js`，在 `vm` 里执行），按 boot manifest
的粒度注册并 `import()`；再在**干净临时目录**里 `npm install` 打包产物，从安装后的布局
跑一遍服务端 `apply`。这条链路是唯一能抓住「客户端 id 与包名不一致 → 整个应用起不来」
那类 bug 的手段 —— 语法检查、`import()`、单元测试**都抓不到**（真实踩过）。

`test/acquire-local-cepack.test.mjs` 管 `ce_kernel acquire` 的两条路（本机已装 CE 直接解
`dbk64.cepack` / 下载安装包再解），重点是**前者那四个 `installer*` 字段是 `null`**
—— 早先在输出层裸取属性，于是最省事的场景一调用就抛 `TypeError`。

`npm run verify:guards` 会**临时修改**被测文件、跑测试、断言它失败、然后**立刻还原**
（`finally` 保证），最后再确认基线仍然全绿。它存在的理由很直接：
**一条永远不会失败的守卫只是装饰品**。

### 验证"已发布的产物"（发布后跑一次）

`test/startup.test.mjs` 的 B 组默认用**本地目录**当依赖（离线、快）。要验证
**registry 上真正发布的那一份**，加一个环境变量：

```powershell
$env:CE_STARTUP_SOURCE = "registry"
node --test test/startup.test.mjs    # 会从 registry 装 dsh-ce-tools@<工作区版本>
```

它会确认 ① 依赖解析出 `@bingine/cemem` + `dsh-get-admin`；② 服务端 `apply` 注册 16 个工具；
③ 客户端 `client.js` 的 `id` 与包名一致；④ `resolveKernelDir()` 在安装布局下能定位内核；
⑤ `PLUGIN_VERSION` 与出站 user-agent 的版本都等于 `package.json` 的版本。

端到端测试用内核自带的 `test/fixture-target.js` 作为目标进程 —— 它 `VirtualAlloc` 出一段可预测内存
（已知基址、已知值、已知指针链、已知 AOB），思路与 CE 自带的 Tutorial 一致。测试覆盖：

- 进程枚举、按 pid/名字附加、模块与区域枚举
- 全类型读取（含 64 位整数不丢精度）、批量读取、模块相对与解引用表达式
- 写入后回读校验、原始字节写入、**重试参数**（一次成功不误报重试、越界值安全收敛）
- 数值扫描（首次/再次/结果）、AOB 扫描（含通配符）
- 指针扫描，并**沿返回的表达式重新读回原值**验证路径正确
- 反汇编、汇编后写入、AutoAssembler 的 `check`/`enable`/`disable` 与**精确还原**
- 立即数进制规则（裸数字十进制 vs `db` 十六进制）
- CE Lua（列出 API、读取目标进程内存、错误报告）
- `.CT` 表的增删、写出与读回
- `ce_kernel` 的只读状态、**`confirm` 安全闸门**、未知 action 与未提权路径
- 配置开关（`allowWrite` / `allowLua`）与各种失败路径的可读性
- **失败必须 reject**：所有负向用例都用 `assert.rejects` 断言，防止实现退化成
  「返回一个写着失败的成功值」（那样 UI 与 PTC 都会把它当成成功）

单元测试注入最小的内核枚举假体，因此**不依赖内核**也能跑；真实联通性由端到端测试覆盖。
内核驱动的获取链路用**本机真实文件**验证（PE 解析器拿 `ntfs.sys` 等 4 个真驱动 + `notepad.exe` 反例回归），
安装/加载路径因为需要管理员权限，只验证到「未提权给出可执行错误」，不假装已跑通。

### 已知问题：内核原生层偶发访问冲突（**未修复**）

端到端套件在反复快速运行时，约 **2.5%**（45 次里 1–2 次）会整文件失败。**这不是测试写法问题，
是内核原生层的崩溃**，证据如下：

| 观察 | 结论 |
| --- | --- |
| 直接执行时的退出码是 **`-1073741819` = `0xC0000005` STATUS_ACCESS_VIOLATION** | 原生访问冲突，不是 JS 异常 |
| 进程的 `exit` 钩子**从未执行**（轨迹里没有 `exit code=` 行） | 进程被原生层直接终止，来不及跑任何清理 |
| `uncaughtException` / `unhandledRejection` 上报钩子**均未触发** | 排除 JS 层错误 |
| 内核 `require` 在 15/15 次里没往 stdout 写东西 | 排除「污染 `node --test` 的序列化通道」这一常见成因 |
| 一个**独立脚本**把同一批原生调用（枚举/打开/模块/区域/读写/扫描/指针扫描/汇编/AA/Lua/地址表）跑一遍，**60/60 干净** | 不是某一次具体调用必崩 |
| 一个**最小 `node:test` 文件**（只做加载内核→起夹具→打开进程→枚举模块→读值）**0/50** | 也不是 `node:test` 本身的问题 |
| 纯函数单元测试 20 次、最小复现 50 次均 0 失败 | 需要「完整套件的操作量/分配量」才触发 |

综合看：这是 **koffi（原生扩展）在高分配压力下的偶发访问冲突**，最可能是 koffi 对象的
GC finalizer 与原生状态竞争 —— 触发条件是"够多的原生操作 + 够多的 JS 分配"，所以量小了就复现不出来。
它落在 `node-cheat-engine` 的原生绑定层，**不在本插件的 JS 逻辑里**，我改不动它。

**这件事在生产环境里的含义（请务必知道）**：插件跑在 DSH 宿主**主进程**内，所以一旦真的撞上，
**整个 DSH 会话会被一起打掉**，而不是只失败一次工具调用。因此：

- 高频、长时间、自动化的内存操作场景要有心理预期；
- `allowWrite`/`target` 这类风险请按第四节自行收紧；
- 出现后请把 `npm run soak` 的退出码与归类信息一并反馈给内核作者（`node-cheat-engine`）。

**定位工具**：`npm run soak`（默认 40 次，开启测试内轨迹）会把每次失败按退出码归类，
并打印崩溃前最后到达的测试步骤：

```
运行 40 次：通过 39，失败 1

失败分布：
  ×1  -1073741819 (0xC0000005) 0xC0000005 STATUS_ACCESS_VIOLATION（原生访问冲突）  ← 最后到达：[e2e] test1: 过滤完成
```

`CE_E2E_TRACE=1`（或 `npm run soak` 自带）会输出分步轨迹，用来确认崩在哪个阶段。

### 官方约定

本插件的工具契约以官方文档为准：

- [工具编写参考](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool)
  （`defineTool` 形态、`execute` 约定、失败 = `isError`、PTC、卡片渲染意图）
- [Tool 执行流水线](https://deepseek-harness.github.io/deepseek-harness/reference/tool-execution-pipeline)
- [扩展模式](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook)

---

## 七、权限不足与提权

Windows 的权限是**进程级**的：要读写以更高权限运行的目标，**发起调用的进程本身**必须有管理员权限，
无法只对单次操作提权。因此只有三条路：① 以管理员身份重启 DSH；② 起一个管理员权限的**助手进程**
并把内存操作转发给它；③ 连一个以管理员身份运行的 `ceserver`，切到 `native-ce` 后端。

### 已经做到（第一层）：识别权限不足 + 提权前征求同意（`lib/elevation.js`）

- **精确识别权限不足**：`ce_attach` / `ce_read` / `ce_write` 上把 Win32 `ERROR_ACCESS_DENIED(5)`、
  `0x80070005`、`EPERM/EACCES` 认出来，并且**不把无关失败误判成权限问题**
  （单测里有 `Win32 错误 998`、`错误 50`、地址解析失败等反例）。
- **给出可执行的下一步**，且区分两种截然不同的处境：未提权 → 告诉你怎么提权；**已提权却仍被拒** →
  说明目标多半受 PPL/反作弊保护，普通用户态无解（不会再让你"去提权"）。
- **提权前必须征求用户同意**：`askToElevate()` 走 `ctx.userQuestions`，确认框里写清"这会扩大插件权限边界"。
  并且在两种情况下会**主动拒绝去问、也绝不提权**：没有 agent 会话（子代理 / PTC 调用拿不到人机交互）、
  或 profile 没装 `user-questions` 服务。这两条都有测试；其中一条用**真实的受保护进程（pid 4 System）**
  跑通完整链路。
- **绝不自动提权**：本插件不弹 UAC、不改 DSH 的启动方式，只在你确认后给出做法。
- **「你不点 UAC」是被完整支持的用法**，不是异常路径。三道保障：
  1. **同意闸门 fail-closed**：`ask()` 的任何异常（取消 / 超时 / 无可交互前端 / `signal` 中断 /
     抛非 Error 值）一律视为「未获同意」并说明原因，**不会**让异常穿透到工具层。
     早先这里是裸 `await`，用户一不回应就会抛到上层，真正的失败原因被吞掉。
  2. **无人值守硬闸门**：设 `GET_ADMIN_NO_ELEVATE=1` 后，`ce_elevation action=request`
     **在弹窗之前**就被拒绝 —— 不问你、不弹 UAC、耗时 0ms。`status` 会显示当前 UAC 策略。
  3. **建议不再推荐走不通的路**：UAC 被禁用时，权限建议会换成"这条路走不通 + 哪些替代方案
     不需要 UAC"，不再推荐一个必然被拒的 `action=request`。
- **不想被弹窗打扰**：启动 DSH 前设 `GET_ADMIN_NO_ELEVATE=1` 即可。
  这时可用 `ce_elevation action=status` 查看现状（只读），它会直接告诉你 UAC 已被禁用。

### 已经做到（第二层）：管理员助手进程 + 同步远程后端

**按需启动提权助手，并把内存操作转发给它。** 关键设计：远程后端在 **JS 侧是同步的**
（worker 线程持 socket 做异步 I/O，主线程用 `SharedArrayBuffer` + `Atomics.wait` 阻塞等结果），
所以内核把它当成和 `SelfBackend` 同类的同步后端 ——
**`ScanSession` / `PointerScanner` / `AutoAssembler` / `.CT` 全部无需改动即可用**。
这正是为什么选择「实现 `MemoryBackend`」而不是「转发高层工具调用」。

为什么不能用普通的异步 RPC：内核的扫描/指针扫描/汇编内部调用 `Process` 的**同步**方法
（`src/scanner/scanner.ts` 的 `this.proc.readMemory(...)`），而同步方法在异步后端上会直接抛错
（`win/process.ts` 的 `syncResult`）。所以异步 RPC 只能拿到读写与枚举，扫描/汇编全部失效。

文件：`lib/remote/{protocol,helper,worker,backend,launch}.js`

**用法**

```yaml
config:
  backend: 'remote'        # 显式走助手
  remoteElevate: false     # 助手是否带 UAC 提权启动（默认 false）
```

- 也可以不提权就用：`backend: 'remote'` + `remoteElevate: false`，链路与提权时完全一样，
  只是助手拿的是普通令牌（自测就是这么跑的）。
- 权限不足时另有自动路径：识别 `Win32 5` → **先问用户** → 同意后 `autoElevate` 才允许通过 UAC
  启动助手并用它重新附加。

**安全约束**（都写进了代码注释与测试）

- token 与内核路径走**临时配置文件**、不走命令行（Windows 下别的进程能通过 WMI 读命令行）；
- 助手只监听 `127.0.0.1`，首条消息必须带正确 token，否则立即断开；
- 助手**客户端断开 8 秒后自退** —— 提权进程父进程无权终止它，所以只能由它自己收尾，
  以免在你机器上留下常驻的管理员进程；
- 插件卸载时同时 `disposeHelper()` 并释放会话资源。

**已验证 / 未验证（如实区分）**

- ✅ `test/remote.test.mjs` 9/9：真实夹具经助手跑通 枚举 / 模块 / 区域(bigint 保真) /
  跨进程读写(2KB payload 往返) / **首次+再次扫描** / AOB / 指针扫描 / AutoAssembler 注入与精确还原。
- ✅ e2e 里 `backend: 'remote'` 的插件层集成：`ce_attach` 报告 `remote-elevated`，
  `ce_read` 与直连结果一致，`ce_scan` 命中，`ce_write` 回读校验通过。
- ❌ **真正的 UAC 提权路径没有实测**（需要你点一次 UAC 并有一个以管理员运行的目标进程）。
  这条路径的代码与未提权路径只差"启动方式"，但**没跑过就是没跑过**。

**已知限制**

- 远程后端下**扫描退化为单线程**：内核的并行扫描 worker 自己 `import { Process }`，
  用它自己那份 koffi 读内存，走不到这条通道（`session.js` 会自动关掉并行）。
- 每次内存操作都会**阻塞 DSH 宿主主线程**（与 `SelfBackend` 一致；扫描本来就会阻塞）。

### 其他替代做法

1. 以管理员身份重启 DSH（右键 → 以管理员身份运行）。
2. 以管理员权限运行官方 `ceserver`，然后配置：

   ```yaml
   config: { backend: 'native-ce', ceserverHost: '127.0.0.1', ceserverPort: 52736 }
   ```

   （注意：`native-ce` 后端下，扫描/汇编仍受上面那条同步约束影响。）
3. 用 `ce_kernel` 装并加载内核驱动 —— 见下一节（可读写受保护进程，且不需要 UAC）。

---

## 七·补、内核驱动（`ce_kernel`）

`ce_kernel` 负责把 Cheat Engine 的内核驱动 **DBK64** 取到本机、校验、安装成内核服务并加载。

### 获取：两条路，优先本机

| 路径 | 前提 | 做了什么 |
| --- | --- | --- |
| **本机已装 Cheat Engine**（首选） | 无 | 直接解安装目录里的 `dbk64.cepack` |
| 官方安装包 | 需要联网 | 抓 `cheatengine.org/downloads.php` 取当前版本安装包 → 解包提取 |

首选路径值得展开说，因为它比预想的干净得多：

1. CE 7.5+ **不再直接放 `DBK64.sys`**，而是打包成 `dbk64.cepack`（实测 55KB，
   比裸驱动小 —— 这是 CE 为降低杀软误报做的处理）。
2. 这个格式的全文只有 116 行（`Cheat Engine/libcepack.pas`）：`"CEPACK"`(6 字节) +
   原始大小(4 字节 LE) + **裸 deflate** 压缩数据。
3. 于是**用 Node 内置的 `zlib` 就能解**，实测解出 **118,016 字节**的 `DBK64.sys`。

结论：本机装了 CE 时，**不需要下载安装包、不需要 innoextract/7-Zip、不需要管理员**
（见 `npm run verify:kernel` 的真实输出）。

> 踩过的坑：FPC 的 `Tcompressionstream.create(clmax, o, true)` 在**提供了输出流**时
> 写的是**裸 deflate（无 zlib 头）**，所以必须用 `inflateRawSync`；
> 用 `inflateSync` 会报 `unknown compression method`。

### 校验（两条路走完全一致的收尾）

- **PE 头判定**：`PE32+` + `IMAGE_SUBSYSTEM_NATIVE(1)` → 确认是 64 位**内核驱动**，
  不是普通 exe/dll。本机用 `ntfs.sys`/`tcpip.sys`/`ndis.sys`/`http.sys` 四个真实驱动
  加 `notepad.exe` 反例做了回归（这条曾经的 bug 是把 `DllCharacteristics` 的偏移
  当成了 `Subsystem`，导致真驱动被判成"不是内核驱动"）。
- **签名**：纯 Node 读 PE 的证书表判断"有没有内嵌签名"，再用 PowerShell 取
  Authenticode 有效性。实测本机驱动 `status=Valid`。
- 记录驱动与安装包的 **SHA256**，供留档比对。

### 安装与加载（**需要管理员**）

```
ce_kernel { action: "install", confirm: true }   # 复制到 System32\drivers + sc create
ce_kernel { action: "load",    confirm: true }   # sc start
ce_kernel { action: "probe_driver" }             # 只读：设备能否打开、GETVERSION 是否响应
ce_kernel { action: "unload",  confirm: true }   # sc stop + sc delete + 删驱动文件
ce_kernel { action: "cleanup" }                  # 只读地清缓存（不需要管理员）
```

**卸载**（`unload`）会做三件事，并如实报告每步结果：停服务、删服务注册、
删 `System32\drivers\DBK64.sys`。若驱动没进入 `STOPPED`（还有程序占着设备句柄），
它会明确提示而不是假装成功。

**清理缓存**（`cleanup`）与卸载**刻意分开**：它只删本插件缓存里的东西
（下载的安装包、解出的驱动、innoextract、静默解包的临时 CE 目录，实测可释放约 20MB），
**不动内核服务、不动注册表、不动 System32**。理由是那些缓存可以随时用
`acquire` 重新获取，删掉是安全的；而系统里的驱动必须由 `unload` 显式卸载。

**分配内存**走驱动（`allocate` → `IOCTL_CE_ALLOCATEMEM`），**受保护进程也能分配**。
**改内存保护**走用户态 —— 因为 CE 驱动的 `IOCTL_CE_MAKEWRITABLE` 在 **x64 上根本没实现**
（`IOPLDispatcher.c` 里 `#ifdef AMD64` 分支是空的）。好消息是**写内存不需要先改保护**：
驱动的写路径在内核态执行，只读页照样能写。

- 服务参数与 `DBK64.inf` 一致：`ServiceType=1`（内核驱动）、`StartType=3`（按需启动）。
- **必须显式传 `confirm: true`**，否则拒绝执行（测试覆盖了这条闸门）。

### 自动提权（UAC）

`install` / `load` / `unload` 在**未提权**时不是直接失败，而是**自动弹一次 UAC 完成它**：

```
ce_kernel { action: "load", confirm: true }
  → 未提权 → 拉起 UAC → 你在弹窗点「是」→ 以管理员权限执行 load → 回传结果
```

实现：`lib/remote/kernel-elevate.js`（父进程侧）+ `kernel-elevate-runner.js`（被提权的一次性执行器）。
因为 `Start-Process -Verb RunAs` 拉起的进程与父进程**没有继承关系**（拿不到 pid、拿不到 stdout），
所以参数走临时配置文件、结果走临时结果文件（带 nonce 校验，避免读到残留）。

**安全约束**（都有测试）：

- 执行器**只认白名单动作**（`install`/`load`/`unload`）—— 它以管理员权限运行，
  绝不能变成"任意函数调用"通道；
- 输入**只走配置文件、不走命令行**（Windows 下其他进程能用 WMI 读命令行）；
- 结果文件用随机名 + `nonce` 校验；
- 不杀提权进程（父进程无权终止它），所以动作必须短命 —— `sc.exe` 调用天然如此。

**配置**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `kernelElevate` | `true` | 未提权时是否允许通过 UAC 执行内核动作。设 `false` = 只报错给手工命令 |
| `kernelElevateTimeoutMs` | `120000` | 等待上限；要留足你点 UAC 的时间 |

> 与 `autoElevate`（管内存操作，走常驻助手进程）**刻意分开**：两者触发的机制不同
> （一个转发热内存 RPC，一个是执行一次性系统命令）。
> 这里默认 `true` 的理由：这几个动作**本来就强制要求 `confirm: true`**，
> 那已是明确的用户同意，再让你去手工敲 `sc.exe` 没有意义。
>
> ⚠️ 实测说明：**UAC 链路已验证可用** —— 在未提权环境调 `load` 会真的拉起 UAC，
> 确认后 `sc start` 以管理员权限执行并返回 1060（服务未安装，因为还没 install）。
> 这证明提权通路是通的。`test/kernel-elevate.test.mjs` 13 项覆盖决策与数据通路，
> 但**不覆盖"有人在安全桌面上点 UAC"这一步**（自动化做不到）。

#### 关于"不要一直弹"（三条约束，都有测试）

早期实现有三个让使用者很难受的问题，都已修掉：

| 问题 | 原因 | 现在的行为 |
| --- | --- | --- |
| **同一个动作弹两次** | 启动常驻助手失败后会"兜底"去跑一次性执行器，等于再弹一次 | 失败就报错，**不再兜底弹第二次** |
| **一拒绝就卡很久** | 用户点「否」后 powershell 立刻退出，但代码还在干等 90 秒超时 | **盯着启动器进程**，它一退出就立刻给出"提权被取消"的结论 |
| **下次动作又弹** | 拒绝没有留痕 | 拒绝后进入 **120 秒冷却期**，期间不再自动弹窗，改为告知手工做法（`force: true` 可立即重试） |

另外，**成功提权一次后不会重复弹**：助手是常驻的（空闲 30 分钟自退），
内核动作与内存操作都复用它。跨进程也做了复用 —— 提权助手的信息会写到
发现记录（仅在当前用户 profile 目录，权限 0600），所以 **DSH 重启后也能直接连上
那个还在跑的提权助手**，不必重新弹 UAC。

> 为什么不是"保存管理员密码"：Windows 不允许这样做，存密码既不安全也不可靠。
> 能"保存"的只有**一个还在运行的管理员进程** —— 这也正是助手的形态。

### 两条必须知道的边界

1. **加载内核驱动必须管理员权限**，这是 Windows 的硬边界，没有绕过的办法。
   这个"必须管理员"由上面的**自动提权**来满足：你确认过的动作会弹一次 UAC 完成它，
   而**不是**丢给你一条手工命令。（若 `kernelElevate: false`，则确实只给手工命令。）
2. **驱动加载成功 ≠ 受保护进程立刻可读。** 还差一步：把插件配置的 `backend`
   从 `self` 改成 `dbk` —— 只有 `DbkBackend` 走内核 ioctl，默认后端仍是用户态
   `OpenProcess`/`ReadProcessMemory`。
   另外两处已知短板一并在输出里说明：`changeProtection`/`free` 仍是用户态实现
   （CE 驱动的 `MAKEWRITABLE` 在 x64 上是空的），对受保护进程会失败；
   且 `DbkBackend` 的驱动侧结构布局尚未在真机验证，先用 `probe_driver` 确认连通性。

> 另需留意：Secure Boot + HVCI 环境下，系统可能拒绝加载 DBK64（即使它是 CE 的正式签名驱动）。
> 还有，DBK64 是**内核级**驱动 —— 加载它会削弱系统防护，反作弊/EDR 会拦截。请自行判断是否使用。

---

## 八、排查

| 现象 | 处理 |
| --- | --- |
| 状态路由 404 | 加载行没生效。确认 `cordis.patch.yml` 里有 `id: cheat-engine`，然后重启 dsh |
| 工具返回「未能加载 node-cheat-engine 内核」 | 内核不在默认位置。用 `wire.mjs --kernel <目录>` 重接，或在配置里设 `kernelPath` |
| 「还没有附加到任何进程」 | 先 `ce_attach`（`ce_processes` 拿 pid） |
| 扫描命中 0 个 | 换类型（dword/float/double 都可能是候选）、用 `mode: between` 放宽、放开区域过滤；确认目标进程里确实是这个数 |
| 再次扫描报「没有结果」 | 上一步筛光了。`action: reset` 后重来 |
| 指针扫描找不到 | 先看输出里的「第一级候选」是否为 0：为 0 说明没有指针指向它（可能是栈上临时值）；否则调大 `maxOffset`、去掉 `staticOnly` |
| 汇编写出的字节不对 | 看 `ce_assemble`/`ce_auto_assemble` 输出里的**反汇编核对段**（见第四节），或直接 `ce_disassemble` |
| 写入后回读不一致 | 目标进程自己把值改回去了（常见于游戏）或页不可写。结果里 `verified: false` 会明确标出 |
| 读/写/附加报「权限不足」 | 目标以更高权限运行。看错误里的两条主路径：以管理员重启 DSH，或用管理员权限的 ceserver 配 `backend: native-ce`（见第七节） |
| 已提权却仍被拒 | 目标多半受 PPL/反作弊保护，普通用户态无解，需要内核驱动 |
| 原生 CE 后端下扫描报错 | 扫描/指针/汇编内部是同步路径，需要 `backend: self` |

---

## 九、目录结构

```
lib/
  index.js              插件入口：配置、工具注册、状态路由、资源清理
  toolkit.js            零依赖的 defineTool（作者侧 DSL → 原始 JSON Schema）
  kernel.js             内核加载、后端选择、汇编后端(WASM)初始化
  kernel-driver.js      内核驱动 DBK64：cepack 解包、PE/签名校验、安装与加载
  retry.js              写入重试：错误分类、次数/间隔收敛、重试语义
  session.js            每会话 CE 状态（进程/扫描/指针/AA/Lua/地址表 + 回收）
  values.js             值编解码、地址解析、展示格式化
  elevation.js          权限不足的判定、提权前征求用户同意的闸门
  tools/
    shared.js           统一输出信封、错误收敛、参数解析
    process.js          ce_processes / ce_attach / ce_session / ce_modules / ce_regions
    memory.js           ce_read / ce_write（含重试）
    scan.js             ce_scan / ce_pointer_scan
    asm.js              ce_disassemble / ce_assemble / ce_auto_assemble
    lua.js              ce_lua
    table.js            ce_cheat_table
    kernel.js           ce_kernel（内核驱动的获取/安装/加载）
test/
  helpers/harness.mjs   最小假 cordis 上下文（含返回值严格校验）
  unit.test.mjs         单元测试：纯函数 / 工具定义 / 注册形状 / 状态路由
  e2e.test.mjs          真实跨进程端到端测试
  retry.test.mjs        写入重试逻辑（36 项）
  kernel-driver.test.mjs 内核驱动：PE 解析 / cepack 解包 / 只读探测
  kernel-tool.test.mjs  ce_kernel 的只读路径与安全闸门
  soak.mjs              浸泡测试：反复运行并归类原生崩溃（npm run soak）
tools/
  verify-kernel-local.mjs  真实获取 DBK64（本机 CE → cepack → 解包 → 校验）
.cache/ce-kernel/       驱动缓存（下载的安装包、解出的 DBK64.sys；已 gitignore）
wire.mjs                profile 接入 / 卸载脚本
```

MIT.
