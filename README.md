# VP Board Better · 虚拟榜单回放

把一场 XCPC / ICPC 比赛的真实榜单数据（XCPCIO board 格式）当成录像回放：
时间轴可以拖动、加速、暂停，榜单按时间点实时重算。

![完整时长回放](docs/preview.png)

<details>
<summary>3 小时模式（时间轴与封榜等比例压缩）</summary>

![3 小时模式](docs/preview-3h.png)

</details>

支持两种 VP 时长：

| 模式 | 时间轴 | 封榜 | 用途 |
| --- | --- | --- | --- |
| 完整时长 | 与比赛原始时长 1:1 | 与原始封榜时间一致 | 标准 5 小时 VP |
| 3 小时 | 按 `3h ÷ 原时长` 等比例压缩（5h 比赛 = ×0.6） | 同步压缩（原 60 分钟 → 36 分钟） | 个人 3 小时 VP |

> 3 小时模式下，原本第 5 小时才通过的题目会在第 3 小时出现在榜单上，
> 但格子里显示的**仍然是原始比赛时间与原始罚时**——鼠标悬停可以看缩放后的时刻。

## 快速开始

**方式一：直接打开（最简单）**

双击 `index.html`，点「加载榜单数据」，粘贴榜单链接或路径，例如：

```
https://board.xcpcio.com/icpc/50th/nanjing
icpc/50th/nanjing
```

也可以直接把 `config.json`、`team.json`、`run.json` 三个文件拖进窗口（或点「选择本地文件」）。

不知道路径？点边上的「选择榜单」，从 XCPCIO 里 466 场比赛（按日期倒序）里按名字 / 城市 / 路径搜，
点一行就自动填好路径。第一次点要等几秒抓一次列表，之后会缓存（`_boards.cache.json`）。

同一个弹窗里还有一行「这场比赛对应的 QOJ 比赛」：想让页面直接提交到 QOJ，就在这里填上**这一场**
的 QOJ 比赛链接（或只填 `4597`；不知道链接就点「选择比赛」，从 QOJ 的 3000+ 场比赛里按名字搜、
点一行自动填好；也可以点「识别窗口」读 QOJ 窗口当前的比赛页），题号会按 A/B/C 自动映射。
这段关联按「比赛名 · 开赛日期」分别记住：换一场比赛就换一条链接，各自记各自的；
从「选择榜单」挑一场之前关联过的比赛时，会把它原来那条 QOJ 链接一起带回来。

关联是**按比赛分开存**的：下一场换成另一条链接，各自记住各自的；换比赛时输入框里上一场的链接不会
被带到新比赛（填了没改也会自动忽略）。之后提交只需要选 A/B/C 题号 + 贴代码。

**方式二：本地启动器（推荐，能用 QOJ 提交）**

两种入口，行为完全一样：

- 双击 `VPBoardBetter.exe`（会弹一次 UAC：这个 app 必须在管理员权限下启动，否则 Windows 的
  工作区/沙箱限制会让页面渲染不出来，表现为白屏）；
- 或双击 `start.bat`。

展开讲 `start.bat`：**不会留下 cmd 黑窗口**（它转给 `launch.vbs` → `tools/launch-hidden.ps1`，
用隐藏窗口起一个零依赖 Node 服务，默认 `http://127.0.0.1:8787`），随后用 Edge 的 `--app` 模式
打开一个干净的应用窗口。这个模式下：

- 直连被浏览器跨域策略挡住时，自动走本地代理（`/api/proxy`，只放行 `board.xcpcio.com` 与 `xcpcio.github.io`）；
- 可以在页面里直接登录 QOJ、提交代码、轮询评测结果（`/api/qoj/*`）；
- **会记住窗口大小和位置**：拖动/缩放后，页面把外框尺寸和屏幕坐标报给 `/api/window`（存在 `_window.json`）；
  下次启动时启动器把 `_window.json` 里的值直接作为 `--window-size` / `--window-position` 传给 Edge，
  **窗口一创建就是目标尺寸**，不会再出现“先按旧尺寸显示、再被改一下”的跳动。
  最大化时不会覆盖保存值，避免下次开机变成一个满屏窗口。

  这里有个前提：应用窗口用**独立的浏览器配置目录** `.app-profile/`（首次启动自动创建）。
  原因是 Edge 在默认用户目录里会优先恢复它自己的 `--app` 窗口状态（实测无论传什么参数都开成上一次的
  1050×999），命令行参数被忽略；换成独立目录后 Chromium 会**在创建窗口时**应用 `--window-size`，
  不再需要任何“开窗后再纠正”的 Win32 操作。首次创建时会从默认配置里迁移
  `Default\Local Storage`（保留「我的队伍」「QOJ 关联」「上次比赛」等设置）；删掉 `.app-profile/`
  等于把本应用的设置恢复出厂，浏览器里的其他网站数据不受影响。

想关掉服务：双击 `stop.bat`（结束占用 8787 的进程）；下次再双击 `start.bat` 即可。

需要 Node 18+（本机 v24 已验证）。服务端日志在 `_server.log` / `_server.err`。
起不来时会弹一个提示框并附上日志尾部；端口 8787 被占用时可以先 `set PORT=8788` 再运行。

## 时间轴操作

| 操作 | 快捷键 |
| --- | --- |
| 播放 / 暂停 | `空格` |
| 后退 / 前进 1 分钟 | `←` / `→`（按住 `Shift` = 5 分钟） |
| 从头顶开始 | `R` |
| 聚焦搜索框 | `/` |
| 关闭弹窗 / 抽屉 | `Esc` |

- 拖动进度条任意跳转；右侧「完整时长 / 3 小时」随时切换（切换后按当前真实时间重新定位）。
- 倍速 0.5×–8×。
- 走到封榜时刻会出现「封榜中」徽标与倒计时；到终点自动揭榜（结束即完整榜单）。
- 时间轴末段斜纹区就是封榜区，长度随模式缩放。

## 榜单

- 排名规则：过题数降序 → 罚时升序 → 最后过题时间升序 → 队名。
- 罚时：每题首次通过的比赛时间 + 20 分钟 × 该题此前失败次数；格子内显示的分钟数就是计算用的原始时间。
- 编译错误（CE）不计罚时、也不占格子（和正式赛规则一致）：手动记录可以选「编译错误 CE」，QOJ 判 CE 时同样只记提交、不加罚时。
- 一血格有虚线内框；封榜期内未揭晓的格子显示 `?`（悬停可见已记录的失败数），pending 显示 `…`。
- 顶部可以搜索队伍 / 学校 / 队号，勾选「只看正式队伍」过滤打星队，勾选「奖牌线」显示金银铜分界与名次配色。
- 点击任意队伍打开详情抽屉：名次、过题、罚时、每题通过时刻与失败次数、队员与教练、提交记录。

## 我的队伍

点右上「我的队伍」：

1. **创建我的队伍**：不用填任何信息，直接以 `我 · 本机` 的身份（`__me__`）插入榜单，按你记录的提交实时计算；
2. **从已有队伍中选择**：直接在原榜单里高亮你参加的那支队，并给它补记你自己的提交。

之后点「记录提交」：选择题目、AC / 失败、提交时间（默认当前虚拟时刻，格式 `分:秒`，例如 `72:30`；
3 小时模式下这里填的就是 3 小时制的时间）。记录会立刻反映到排名与罚时，并保存在浏览器本地。

## QOJ 集成（可选，需用 `start.bat` 启动）

- 「我的队伍」→「提交到 QOJ」打开面板，三个标签页：
  - **提交代码**：**QOJ 比赛链接在导入榜单时填**（「数据源」弹窗里「QOJ 比赛」一行，粘一次即可，
    也可以只填 `1234`，或点「识别窗口」读取 QOJ 窗口当前的比赛页）。比赛题号会按 A/B/C… 自动映射到榜单题目，
    之后**只需要选题号 + 贴代码 + 提交**，页面会显示评测状态，评测结束后按**当前榜单时间**自动记成一次提交（榜单立刻更新）；
  - **账号与映射**：填 QOJ 用户名密码登录（密码只在本机 Node 进程内存里，不写入磁盘），
    点「登录」后会启动一个**在屏幕外运行的 Edge 实例**（不弹窗、不抢焦点），
    **自动填入账号密码并点登录按钮**；登录态导出成 `qoj-session.json`（只有 cookie），下次启动直接注入，不用再登录；
    下面还能看到每道题映射到的 QOJ 题号，也可以手动改；
  - **诊断日志**：每一步打开登录页 / 填表 / 识别比赛 / 提交 / 轮询的原始记录，出问题时看这里。
- 关联关系按比赛分别保存（浏览器 localStorage），下次打开同一场比赛不用再填。
- 提交前请先设置「我的队伍」，否则结果没有归属，不会记进榜单。
- QOJ 前面挂着 Cloudflare 人机验证，普通 HTTP 请求会被挡在 `Just a moment...` 页面；
  无头模式（headless）同样会被拦。所以登录和提交不是用 `http` 模块硬怼表单，而是：启动一个
  **独立的 Edge 实例**（带远程调试端口、`%TEMP%` 下的临时用户目录，用完即删），通过 DevTools 协议在
  真实浏览器里操作——Cloudflare 会自动放行，然后脚本把账号密码填进登录框、点「登录」。
  这个窗口默认被放到屏幕外（`--window-position=-32000,-32000`），再调用 Win32 `ShowWindow(SW_HIDE)`
  把它整个隐藏掉，所以看不到登录页、不会弹出、也不会在任务栏留按钮（页面仍在后台渲染，
  Cloudflare 才肯放行）。想看着它操作可以在启动服务前设 `QOJ_VISIBLE=1`；已经隐藏的窗口也可以手动
  `powershell -File tools\hide-edge-window.ps1 -Profile vpb-qoj -Action show` 叫出来（按临时目录名前缀匹配）。
  登录态用 `a[href*="/logout"]` 判断，页面右上角能看到用户名就说明成功。
- 输出型题目（例如 `#1 I/O Test` 那种交 `config.txt` 的题）不支持源码提交，会得到 Compile Error。
- QOJ 改版后可能失效，届时看诊断日志定位；即使不可用，手动「记录提交」仍然可用。

## 数据来源

优先顺序：`board.xcpcio.com/data/<path>/` → `xcpcio.github.io/board-data/data/<path>/` → 本地代理。

支持两种历史数据格式（自动识别）：

- 新格式：`config.problems[]`，`run.status` 为 `correct / incorrect / pending`；
- 旧格式：`config.problem_id` + `balloon_color` 数组，`run.status` 为 `ACCEPTED / WRONG_ANSWER / …`。

`timestamp` 支持相对开赛的毫秒 / 秒，也兼容绝对时间戳；缺失 `team.json` 时会用提交记录里的队号兜底。

## 文件结构

```
index.html            单页应用入口（零依赖，可直接双击）
VPBoardBetter.exe     图形启动器：UAC 提权后转给 start.bat（和双击 start.bat 同一条路径）
tools/launcher/       exe 的源码（Program.cs）、图标与清单，用 tools/build-exe.ps1 重新生成
start.bat             Windows 启动器：隐藏启动本地服务 + Edge 应用窗口（不留 cmd 窗口）
stop.bat              关闭本地服务
launch.vbs            隐藏启动的桥（wscript 调 PowerShell，纯 ASCII）
server.js             零依赖本地服务：静态托管 + /api/proxy + /api/qoj/*
assets/style.css      样式
assets/balloon.svg    应用图标：黄色气球（favicon / 任务栏 / 顶栏品牌位共用，无文字）
assets/core.js        数据归一化、时间轴缩放、排名计算（UMD，可单独测试）
assets/data.js        在线 / 本地 / 示例数据加载
assets/qoj.js         QOJ 客户端（走本地服务）
qoj-cdp.js            QOJ 浏览器驱动（临时 Edge + DevTools 协议，登录态单独存 qoj-session.json）
assets/app.js         界面、播放时钟、渲染、抽屉、弹窗
fixtures/             真实比赛数据样例（2025 ICPC 南京站，359 队 / 4075 提交）
tools/launch-hidden.ps1  隐藏启动的实现：等端口就绪再开 Edge 窗口
tools/stop-server.ps1    关服务：结束占用端口的进程
tools/test-core.js    核心算法自测（node tools/test-core.js）
tools/hide-edge-window.ps1 把 QOJ 用的 Edge 窗口 SW_HIDE（连任务栏按钮一起去掉）
tools/collect.js      抓取 xcpcio.github.io 数据的小工具（无头浏览器）
tools/uicheck.ps1     无头浏览器截图自检脚本
tools/shot.ps1        单张截图小工具
```

## 磁盘占用

源码 + 资源约 **0.3 MB**，示例数据 0.6 MB，其余文件都很小。QOJ 用的浏览器**不再保留配置目录**：

- 每次启动都在 `%TEMP%\vpb-qoj-<pid>` 建一个临时配置目录，退出（或关服务）时立即删除；
- 登录态只存成项目下的 `qoj-session.json`（3 个 cookie，约 1.5 KB，不含密码）；
- 旧版本留下的 `.qoj-profile/`（可能几百 MB）会在下次启动时自动删掉；
- 启动时还会顺手清理 24 小时前残留的 `%TEMP%\vpb-qoj-*`。

这样既不会长出 Chromium 的组件缓存，也不需要手动清理。想彻底退出 QOJ，点「退出登录」（会删 `qoj-session.json`）或直接删这个文件。

## 架构与缓存

三层结构，各管一段，互不耦合：

| 层 | 做什么 | 为什么这么放 |
| --- | --- | --- |
| `index.html` + `assets/*` | 全是静态文件，直接双击也能看榜单 | 零构建、零依赖，换机器拷走就能用 |
| `server.js` | 静态托管、同源代理、QOJ 自动化 | 这三件事浏览器自己做不了：压缩/缓存头、跨域代理、过 Cloudflare |
| `qoj-cdp.js` | 用 Edge + DevTools 协议登录/提交 | QOJ 有 Cloudflare，纯 HTTP 过不去 |

缓存策略（都按标准 HTTP 语义实现，不是自创）：

- **静态资源**：`gzip` + `ETag` + `304`。`app.js` 77 KB → 21 KB，二次打开只做条件请求（0 字节响应）。
- **在线榜单数据**：前端直连 `xcpcio.github.io`，由浏览器 HTTP 缓存自动 304，不重复下载 490 KB 的 `run.json`。
- **比赛列表**：`/api/boards` 服务端内存 + 磁盘缓存 6 小时（`_boards.cache.json`），响应带 `Cache-Control: public, max-age=300`；`/api/qoj/contests` 缓存 10 分钟。
- **渲染**：榜单只在「秒」变化时重算，播放时从每 90 ms 一次降到每秒 1 次。实测 359 队一次完整重算 0.7–0.9 ms，首屏 5.4 ms，`DOMContentLoaded` 31 ms。

QOJ 登录态用的是 Playwright 文档推荐的 **storageState** 思路（把 cookies 导出成 JSON 复用），而不是长期保留浏览器配置目录——这也是 Chromium 用户目录会被组件缓存撑大的根因。

参考：<https://playwright.dev/docs/auth>（storageState / `context.storageState({ path })`）、<https://developer.mozilla.org/docs/Web/HTTP/Caching>（ETag / 条件请求）。

## 已知限制

- 直接双击打开时，部分网络环境不允许浏览器跨域访问 `board.xcpcio.com`；此时用 `start.bat`（本地代理），或改用 `xcpcio.github.io` 数据源、本地文件。
- QOJ 集成依赖网页结构与 Edge/Chrome 的 DevTools 协议，官方改版后需要调整 `qoj-cdp.js` 里的选择器与流程；QOJ 用的那个 Edge 实例窗口被 `SW_HIDE` 隐藏（不在任务栏出现），但**别在任务管理器里关掉它**，否则登录态会断（重新点一次登录即可恢复）。
- QOJ 登录偶尔会卡在 Cloudflare 人机验证：先在启动服务前设 `set QOJ_VISIBLE=1`（窗口会正常显示），重新登录并在窗口里手动点一下验证，脚本会自动继续（最多等 90 秒）；平时不用设。
- QOJ 的登录状态保存在项目下的 `qoj-session.json`（浏览器会话 cookie，不含密码），浏览器本体跑在临时目录里、退出即删；想彻底退出就点「退出登录」或直接删这个文件。
- 手动记录的提交只存在当前浏览器（localStorage），换浏览器 / 清缓存就没了。
