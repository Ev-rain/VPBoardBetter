# 开发说明

面向“想改这个项目”的人。用户文档见 [README](../README.md)。

## 结构

```
index.html            单页应用入口（零依赖，可直接双击）
assets/style.css      样式
assets/balloon.svg    图标（favicon / 任务栏 / 顶栏共用）
assets/core.js        数据归一化、时间轴缩放、排名计算（UMD，可单独测试）
assets/data.js        在线 / 本地 / 示例数据加载
assets/qoj.js         QOJ 客户端（走本地服务）
assets/app.js         界面、播放时钟、渲染、抽屉、弹窗
server.js             零依赖本地服务：静态托管（gzip/ETag/304）+ /api/health + /api/proxy
                      + /api/boards + /api/window + /api/open + /api/qoj/*
qoj-cdp.js            QOJ 浏览器驱动（临时 Edge + DevTools 协议，登录态存 qoj-session.json）
start.bat             隐藏启动本地服务 + Edge 应用窗口（不留 cmd 窗口）
stop.bat              关闭本地服务
launch.vbs            隐藏启动的桥（wscript 调 PowerShell，纯 ASCII）
VPBoardBetter.exe     图形启动器：asInvoker（不需管理员），检测 Low IL 后给提示；正常时转给 start.bat
tools/launcher/       exe 源码（Program.cs）、图标与清单，用 tools/build-exe.ps1 重新生成
tools/launch-hidden.ps1  真正干活的部分：识别旧版本服务 → 等端口就绪 → 按 _window.json 开 Edge 窗口
tools/stop-server.ps1    结束占用端口的进程
tools/prune-profile.ps1  清理 `.app-profile` 里可再生的浏览器缓存（启动前调用）
tools/kill-qoj-browser.ps1 兜底：结束 QOJ 用的后台 Edge
tools/build-exe.ps1      渲染图标 → 生成 ico → csc 编译 exe（需要 .NET Framework 的 csc.exe）
tools/test-core.js       核心算法自测（node tools/test-core.js）
tools/hide-edge-window.ps1 把 QOJ 用的 Edge 窗口 SW_HIDE（连任务栏按钮一起去掉）
tools/collect.js         抓取 xcpcio.github.io 数据的小工具（无头浏览器）
tools/uicheck.ps1        无头浏览器截图自检
tools/shot.ps1           单张截图
fixtures/                真实比赛数据样例（2025 ICPC 南京站，359 队 / 4075 提交）
```

## 数据格式

支持两套历史格式，`assets/core.js` 里自动识别：

- 新格式：`config.problems[]`，`run.status` 为 `correct / incorrect / pending`；
- 旧格式：`config.problem_id` + `balloon_color` 数组，`run.status` 为 `ACCEPTED / WRONG_ANSWER / …`。

`timestamp` 支持相对开赛的毫秒 / 秒，也兼容绝对时间戳；缺失 `team.json` 时用提交记录里的队号兜底。

## 时间轴模型

`assets/core.js` 的 `buildTimeMap(contest, mode)` 返回 `toVirtual(r)` / `toReal(t)`，`buildView` 用它把提交的原始时刻换成虚拟时刻。

- 完整时长模式：恒等映射，`V = D`；
- 3 小时模式：`V = min(3h, D)`、`s = V / D`，`F` 为封榜时长、`A = D − F`、`Tf = V − F·s`（封榜点）；
  - 赛前段 `r ≤ A`：`f(r) = m·r − (m−α)·r²/A`，其中 `α = Tf/A`、`m = min(1, 2α)`；上凸抛物线，`f(0)=0`、`f(A)=Tf`、开场斜率 1、收尾斜率 `2α−1`；
  - 封榜段 `r > A`：`f(r) = Tf + s·(r−A)`，即封榜区仍按 `s` 比例线性压缩（5 小时比赛 36 分钟）；
  - `A = 0` 时退化为整体线性 `s`；`D ≤ 3h` 时 `s = 1`，恒等。
- 罚时按原始时间算；手动记录按录入的虚拟时间算。
- 帮助弹窗里的曲线图由 `assets/app.js` 的 `renderTimeCurve()` 用同一份 `toVirtual` 绘制，`toReal` 用于格子上「原始时刻」的悬停提示。

## 缓存策略

- 静态资源：`gzip` + `ETag` + `304`（`app.js` 84 KB → 23 KB，二次打开 0 字节响应）。
- 在线榜单数据：前端直连 `xcpcio.github.io`，靠浏览器 HTTP 缓存，不重复下载 490 KB 的 `run.json`。
- 比赛列表：`/api/boards` 内存 + `_boards.cache.json` 缓存 6 小时（响应 `max-age=300`）；`/api/qoj/contests` 缓存 10 分钟（`_qoj-contests.cache.json`）。
- 服务版本：`/api/health` 带 `build` 和 `features`，前端发现缺 `editorial` 就提示「本地服务是旧版本」，启动器也会结束/提示旧 node，避免新前端连旧接口。
- 渲染：榜单只在「秒」变化时重算；实测 359 队一次重算 0.7–0.9 ms。

## QOJ 集成

QOJ 前面挂着 Cloudflare 人机验证，纯 HTTP 与 headless 都会被挡在 `Just a moment...` 页面。做法是：

1. `qoj-cdp.js` 启动一个独立的 Edge 实例（临时用户目录、远程调试端口），通过 DevTools 协议操作；
2. Cloudflare 在真实浏览器里会自动放行，然后脚本把账号密码填进登录框、点「登录」；
3. 登录态按 Playwright 文档推荐的 storageState 思路导出成 `qoj-session.json`（只含 cookie），下次启动注入；
4. 提交就是导航到题目页、填代码、提交，再轮询提交页拿评测结果。

窗口默认被移到屏幕外并 `SW_HIDE`，所以不弹窗、不抢焦点、不在任务栏出现。要看着它操作：启动服务前设 `set QOJ_VISIBLE=1`；已经隐藏的窗口可以
`powershell -File tools\hide-edge-window.ps1 -Profile vpb-qoj -Action show` 叫出来（按临时目录名前缀匹配）。

登录态判断用 `a[href*="/logout"]`。输出型题目（例如 `#1 I/O Test`）不支持源码提交，会得到 Compile Error。

评测结果怎么看：`submission()` 优先读提交页的测试点卡片（`#details_details_accordion` 里每个 `.card` 的 `Test #N / score / 判定`），
只要有一个点不是 `Accepted` 就按那个点判整题失败——ICPC 规则下没有“部分分通过”。页面上不显示是第几个点错的，
与正式比赛一致；测试点信息只在本机日志里。

### 查看题解

比赛回放到终点后，`ensureEditorial()` 会请求 `/api/qoj/editorial?contest=<链接>`，在 QOJ 比赛页里找
`/tutorial|题解|editorial|solution/i` 的链接，按 `(zh-cn)` / `(en)` 后缀选中文优先、没有再用英文；结果按比赛
写进 localStorage，点按钮时由 `/api/open`（白名单只放 `qoj.ac`）用系统默认浏览器打开。热身赛通常没有题解附件，
接口会返回空列表，按钮提示「这场比赛在 QOJ 上没有题解附件」。

## 磁盘占用

- 源码 + 资源约 0.3 MB，示例数据 0.6 MB；
- QOJ 的浏览器每次启动都在 `%TEMP%\vpb-qoj-<pid>` 建临时配置目录，退出（或关服务）时删除；
- 登录态只有 `qoj-session.json`（3 个 cookie，约 1.5 KB，不含密码）；
- 旧版本留下的 `.qoj-profile/` 会在下次启动时自动删掉；启动时还会清理 24 小时前残留的 `%TEMP%\vpb-qoj-*`。

## 页面窗口记忆

应用窗口用独立的浏览器配置目录 `.app-profile/`。原因是 Edge 在默认用户目录里会优先恢复自己的
`--app` 窗口状态（实测无论传什么参数都开成上一次的 1050×999），命令行参数被忽略；换成独立目录后
Chromium 会在**创建窗口时**应用 `--window-size`，不需要任何“开窗后再纠正”的 Win32 操作。

- 页面把 `outerWidth/outerHeight` 与 `screenX/screenY` 报给 `/api/window`，写进 `_window.json`（最大化不覆盖）；
- 启动器读 `_window.json`，直接作为 `--window-size` / `--window-position` 传给 Edge，窗口一创建就是目标尺寸；
- 首次创建 `.app-profile/` 时会从默认 Edge 配置迁移 `Default\Local Storage\leveldb`，保留「我的队伍」「QOJ 关联」「上次比赛」；删掉这个目录等于恢复出厂。

## 自绘窗口（VPBoardBetter.exe）

系统标题栏和页面配色不统一，而且点右上角关闭只会关掉浏览器窗口、本地服务还留着。Chromium 的 `--app` 窗口在新版本里
没法从外面去掉系统标题栏（改 `WS_CAPTION` 会被它自己加回来，上游也删掉了相关 flag），所以改成自己开窗口装 WebView2：

- `tools/launcher/Host.cs` → `VPBoardBetter.exe`：无边框窗口，自己画 48px 标题条（气球图标、比赛名、最小化/最大化/关闭）；
- 系统标题栏留下的那圈非客户区也去掉了：`WndProc` 里 `WM_NCCALCSIZE`（wParam 非 0）直接回 0，客户区铺满整个窗口，否则顶上会多出一条 10px 的系统色带，看着像“多了一块”；
- 三个窗口按钮是自绘的 `TitleButton : Control`：平时透明、只画 `Segoe Fluent Icons` 字形（`\uE921` / `\uE922` / `\uE8BB`，最大化后换成还原 `\uE923`），鼠标移上去才填一层浅色底，关闭按钮 hover 是 `#e81123` 红底白字——这样不会出现系统按钮那种灰方块；按钮高度 46，底部正好切在 48px 标题条的第 46 行；
- 标题条底下占第 46–47 行，是一条 2px 品牌黄（`#ffc93c`）的高光：红色关闭按钮只在它上面，不会盖住这条线；它原来是 `Color.FromArgb(255,255,255,20)` 写错顺序（alpha=255、蓝=20）画出来的纯黄线，现在改成了有意的强调线；
- 标题条底色用和页面 `.topbar` 同色系的纵向渐变（`#131d28` → `#0b1016`），接缝不会突兀；
- 客户区四周留 5px 当缩放/吸附的抓取带（`GRIP`），窗口背景色取页面底色 `#0a0e13`，所以这 5px 在视觉上就是页面的一部分；
- 启动时若 8787 没有监听，就先隐藏启动 `node server.js` 并等它就绪；
- 页面仍由本地服务提供，WebView2 载入 `http://127.0.0.1:8787/`；
- 标题条拖动走 `WM_NCLBUTTONDOWN(HTCAPTION)`，边缘命中测试返回 `HTLEFT` 等，所以贴边吸附、双击最大化、边缘缩放仍然是系统的；
- 窗口保留系统的 `WS_THICKFRAME`（只去掉 `WS_CAPTION`）：边缘缩放/贴边吸附交给 Windows，客户区仍然铺满、没有内缩的“截图带”；
- 用 DWM 属性把系统那圈边框线去掉、并显式要求圆角：`DwmSetWindowAttribute(hwnd, 34 /*BORDER_COLOR*/, 0xFFFFFFFE /*NONE*/)`、`(33 /*CORNER_PREFERENCE*/, 2 /*ROUND*/)`、`(20 /*USE_IMMERSIVE_DARK_MODE*/, 1)`；
- 于是非最大化时是圆角窗口（Windows 11 的 DWM 圆角），最大化时自动变直角；
- 标题文字用 `Segoe UI Semibold` 11pt（46px 高、垂直居中于黄线之上），宽度随窗口伸缩：`LayoutParts()` 里右边界取 `客户区宽 - 138 - 16`，只有真的放不下才出省略号；
- 标题条左侧图标直接取 exe 内嵌图标（`Icon.ExtractAssociatedIcon`，来自 `tools/launcher/app.ico`，也就是黄色气球）；
- 标题条文字跟着页面 `document.title` 走：`CoreWebView2.DocumentTitleChanged` 里把 `" · VP Board Better"` 后缀去掉，只留比赛名；还没加载比赛时页面标题是 `VP Board Better · 虚拟榜单`，此时标题条留空；
- 宿主加载的是 `http://127.0.0.1:8787/?host=1`，页面看到 `host=1` 会给 `<body>` 加 `.hosted`，`.hosted .brand { display: none }` 把页面自己那套品牌栏藏掉——标题条上已经有一个气球，页面里就不该再有第二个；
- 窗口大小/位置/最大化状态写 `_window.json`，关闭时保存；
- 关掉窗口后：结束监听 8787 的进程 → 结束命令行里带 `vpb-qoj-` 的 `msedge.exe` → 删 `%TEMP%\vpb-qoj-*`；
- 运行期依赖 exe 旁边的 `Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll`（`tools/build-exe.ps1` 从本机 SDK 目录复制）；
- 降级：WebView2 起不来时自动退回 `msedge --app=…` 窗口（老路径），只是没有自绘标题条。

## 启动流程与耗时

- `Main` 里先探测 8787：已经在跑就直接用，否则 `StartServerInBackground()` 起一个后台线程拉 `node server.js`，**不阻塞**创建窗口；
- 窗口先出现并显示自绘的 `Splash`（气球图标 + VP BOARD BETTER + 不定进度条 + 「正在载入榜单…」），不是黑屏；
- `Shown` 里立刻 `EnsureCoreWebView2Async`（不再等 2.5s 的兜底定时器——那 2.5 秒是纯等待，初始化本身只要约 0.3s）；
- WebView2 就绪后再等 `PortReady`（后台线程每 100ms 探一次，最多 30s），就绪即 `Navigate`；超时则把 splash 文案换成红色「本地服务没有启动」；
- 实测（150% DPI，本机）：冷启动窗口约 0.29–0.32s、页面可见 0.71–0.84s；热启动窗口 0.13–0.18s、页面 0.56–0.67s。改动前分别是 0.86s / 3.65s。

## exe 的完整性级别检查

`VPBoardBetter.exe` 用 `asInvoker` 清单，不请求提升。启动时读自身令牌的完整性级别（`GetTokenInformation(TokenIntegrityLevel)`）：

- Medium 及以上：把 `start.bat` 交给 Shell 执行；
- Low：从带 Low 标签的目录启动会出现这种情况，Chromium 在该级别下渲染不出页面，会表现为 `--app` 窗口空白。此时 exe 直接弹窗提示处理办法，而不是留一个白窗口。

## 测试

```
node tools/test-core.js        # 核心算法（359 队/4075 提交，时间映射、封榜不泄露、奖牌线）
node tools/test-curve.js       # 帮助里的时间曲线（Node + 最小 DOM 桩，检查生成的 SVG）
node --check assets/app.js     # 语法
tools/shot.ps1                 # 无头 Edge 截图（需要本地服务在跑）
```
