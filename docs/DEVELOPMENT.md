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
server.js             零依赖本地服务：静态托管 + /api/proxy + /api/window + /api/boards + /api/qoj/*
qoj-cdp.js            QOJ 浏览器驱动（临时 Edge + DevTools 协议，登录态存 qoj-session.json）
start.bat             隐藏启动本地服务 + Edge 应用窗口（不留 cmd 窗口）
stop.bat              关闭本地服务
launch.vbs            隐藏启动的桥（wscript 调 PowerShell，纯 ASCII）
VPBoardBetter.exe     图形启动器：asInvoker（不需管理员），检测 Low IL 后给提示；正常时转给 start.bat
tools/launcher/       exe 源码（Program.cs）、图标与清单，用 tools/build-exe.ps1 重新生成
tools/launch-hidden.ps1  真正干活的部分：等端口就绪 → 按 _window.json 开 Edge 窗口
tools/stop-server.ps1    结束占用端口的进程
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

- `scale = min(1, 3h ÷ 原时长)`，完整时长模式为 1；
- 提交的虚拟时刻 `t = realTs × scale`，封榜起点同样按 `scale` 压缩；
- 罚时按原始时间算；手动记录按录入的虚拟时间算。

## 缓存策略

- 静态资源：`gzip` + `ETag` + `304`（`app.js` 77 KB → 21 KB，二次打开 0 字节响应）。
- 在线榜单数据：前端直连 `xcpcio.github.io`，靠浏览器 HTTP 缓存，不重复下载 490 KB 的 `run.json`。
- 比赛列表：`/api/boards` 内存 + `_boards.cache.json` 缓存 6 小时（响应 `max-age=300`）；`/api/qoj/contests` 缓存 10 分钟。
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

## exe 与 Low 完整性

`VPBoardBetter.exe` 是 `asInvoker`（不请求管理员）。它会先读自身令牌的完整性级别：

- Medium 及以上：把 `start.bat` 交给 Shell 执行，正常开窗；
- Low（工作区目录被打了 `Mandatory Label\Low Mandatory Level` 并继承到文件时会出现）：Windows 会把从该 exe 启动的进程降为 Low IL，Chromium 沙箱在 Low IL 下渲染不出页面，表现为 `--app` 窗口白屏、标题停在 `127.0.0.1_/`。此时 exe 直接弹窗给出修复命令：
  `icacls "目录" /setintegritylevel (OI)(CI)Medium /T`（不需要管理员），或把程序移出该目录。

## 测试

```
node tools/test-core.js        # 核心算法（359 队/4075 提交，首次 AC 缩放、封榜不泄露、奖牌线）
node --check assets/app.js     # 语法
tools/shot.ps1                 # 无头 Edge 截图（需要本地服务在跑）
```
