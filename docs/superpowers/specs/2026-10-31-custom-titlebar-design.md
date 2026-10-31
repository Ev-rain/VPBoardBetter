# 自绘标题栏（方案 A：保留 Edge 渲染，由启动器接管窗口边框）

日期：2026-10-31
状态：待用户批准

## 背景与意图

现在应用窗口是 Edge 的 `--app` 模式，最小化/最大化/关闭三个按钮和上边框都由 Chromium 画，和界面里的深色顶栏不是一个风格。用户希望：

1. 边框由我们自己画，和顶栏视觉统一；
2. 点关闭时服务自动停掉，不再需要手动 `stop.bat`。

用户已确认要「真·原生手感」：贴边吸附、双击标题栏最大化、边缘拖拽改大小、圆角与阴影都希望保留，而不只是看起来像。用户已选择方案 A。

## 目标

- 页面顶部出现 32–34px 的自绘标题条：左侧图标 + 标题，右侧最小化 / 最大化（还原）/ 关闭。
- 拖动标题条可移动窗口；拖到屏幕边缘吸附；双击标题条最大化/还原；窗口四边可拖拽改大小；圆角与阴影由 DWM 保留。
- 关闭窗口（自绘按钮、Alt+F4、任务栏右键关闭）都走同一条清理路径：停本地服务、关掉 QOJ 用的后台浏览器、helper 退出。
- `VPBoardBetter.exe` 与 `start.bat` 两条启动路径行为一致。
- 在普通浏览器里直接打开 `http://127.0.0.1:8787/`（没有 helper）时，不显示自绘标题条，退回原生边框，功能不受影响。

## 非目标

- 不做系统托盘、不做窗口置顶、不做多主题。
- 不改 QOJ 自动化用的那个隐藏 Edge（它仍然无窗口、无任务栏项）。
- 不支持 Windows 以外的平台。

## 约束

- Edge `--app` 窗口的边框由 Chromium 绘制，HTML 无法覆盖，只能从 Win32 窗口样式层面拿走标题栏。
- 本机沙箱里起不了 Edge（`mojo platform_channel.cc:187 拒绝访问`），**视觉与拖拽手感必须由用户实机确认**；因此要提供日志与自检命令。
- 启动器用 .NET Framework 的 `csc.exe` 编译，不引入 NuGet 依赖，exe 体积保持在 100KB 以内。
- 必须保留现有「窗口尺寸在创建时由 `--window-size` 应用、事后不 SetWindowPos 纠正」的结论，不要退回到“先开后改”。
- 现有单文件结构（`index.html` + `assets/*` + `server.js` + `qoj-cdp.js` + 启动器）保持不变。

## 方案对比

**A. 保留 Edge 渲染，启动器接管边框（已选）**
Edge 继续负责渲染与 Cloudflare 环境，helper 去掉窗口标题栏，页面自绘标题条，拖拽/按钮通过 helper 调 Win32。原生吸附与双击由系统处理，手感最接近真窗口，零新依赖。代价：多一个常驻 helper 进程与本机回环端口。

**B. WebView2 自建宿主**
exe 自己建无边框窗口嵌入 WebView2，边框 100% 可控。WebView2 运行时（156.0.4314.50）与 SDK DLL 本机都有，但要把 DLL 一并分发（体积与许可），且 QOJ 仍要另开 Edge，两套引擎并存，风险高于 A。

**C. 只把系统标题栏染成深色**
`DWMWA_CAPTION_COLOR` + 沉浸式暗色，改动最小，但按钮仍是系统样式，满足不了「和现在不统一」的初衷。

选 A 的理由：在不引入新依赖的前提下拿到原生手感，且与现有启动链、窗口尺寸记忆逻辑兼容。

## 详细设计

### 1. 进程结构

```
页面 (http://127.0.0.1:8787)
   │  /api/frame/*             ← 同源，避免 CORS
   ▼
node server.js  ── 127.0.0.1:8790 ──►  VPBoardBetter.exe -frame（常驻 helper）
                                          │ Win32
                                          ▼
                                     Edge --app 窗口
```

- helper 监听 `127.0.0.1:8790`（`FRAME_PORT` 可覆盖），启动后写 `_frame.json`（`{port, pid}`）。
- node 启动时读 `_frame.json` 并探测 `/state`；helper 后到也没关系，页面每次打开标题栏前会重新探测。

### 2. helper 的窗口处理

- 找窗口：`EnumWindows` + `GetClassName` 以 `Chrome_WidgetWin` 开头 + `GetWindowThreadProcessId` 对应进程是 `msedge.exe` + `IsWindowVisible` + 标题含 `VP Board Better`（沿用现有 `FindAppWindow()`，避免误命中浏览器标签页）。
- 去边框：`style = GetWindowLongPtr(hwnd, GWL_STYLE)`，`style &= ~WS_CAPTION`，保留 `WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_SYSMENU`，`SetWindowLongPtr` 后 `SetWindowPos(hwnd, 0, 0,0,0,0, SWP_FRAMECHANGED|SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER)`。
- 去完边框再触发一次 NC 重算：把窗口高度 +1 再 -1（`SWP_NOMOVE`），让 Chromium 重新计算客户区，避免顶部留白。
- 保活：每 400ms 检查 `IsWindow(hwnd)` 与当前样式位；若 `WS_CAPTION` 被 Chromium 加回来（全屏切换、DPI 变化）就重新去掉。

### 3. helper 的命令接口

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/state` | `{ok, hwnd, maximized, visible, port}` |
| POST | `/drag` | 后台线程执行 `ReleaseCapture()` + `SendMessage(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)`，HTTP 立即返回 204 |
| POST | `/min` | `PostMessage(hwnd, WM_SYSCOMMAND, SC_MINIMIZE, 0)` |
| POST | `/max` | `IsZoomed` → `SC_RESTORE`，否则 `SC_MAXIMIZE` |
| POST | `/close` | `PostMessage(hwnd, WM_CLOSE, 0, 0)` |

`/drag` 必须立刻返回，不能等拖动结束（`WM_NCLBUTTONDOWN` 会进入系统的模态移动循环）。

### 4. 生命周期与关闭清理

- helper 每 400ms 轮询窗口是否还存在；窗口消失（自绘关闭、Alt+F4、任务栏关闭都会走到）→ 依次：
  1. 找 `8787`（`PORT` 可覆盖）上 LISTENING 的 PID 并 `Kill`；
  2. 关掉命令行含 `vpb-qoj-` 的 `msedge.exe`；
  3. 删除 `%TEMP%\vpb-qoj-*` 临时 profile（尽力）；
  4. 退出。
- helper 自己也响应 `-stop`：先 `WM_CLOSE` 关窗口，再走同一套清理。

### 5. 页面

- `index.html` 在 `.app` 内最顶部加：

```html
<div class="titlebar" id="titlebar" hidden>
  <div class="tb-title"><img src="assets/balloon.svg" alt=""><span>VP Board Better</span></div>
  <div class="tb-btns">
    <button class="tb-btn" id="tbMin" title="最小化">…</button>
    <button class="tb-btn" id="tbMax" title="最大化">…</button>
    <button class="tb-btn tb-close" id="tbClose" title="关闭">…</button>
  </div>
</div>
```

- `body.framed` 时才显示；`.app` 的 grid 从四行变五行，高度 `34px`。
- 事件：
  - 标题条 `mousedown`（按钮、链接、输入框除外）→ `fetch('/api/frame/drag', {method:'POST', keepalive:true})`，不 await；`mousedown` 只触发一次拖动，`mouseup` 不做事。
  - 双击由系统接管（`WM_NCLBUTTONDOWN` 序列会触发非客户区双击）。
  - 三个按钮分别 POST `/min`、`/max`、`/close`。
  - `window.resize` 与每 800ms 轮询 `/api/frame/state`，按 `maximized` 切换最大化图标（`□` / `❐`）。
- 无 helper（`/api/frame/state` 返回 `active:false`）：标题条保持 `hidden`，页面与今天完全一致。

### 6. 服务端

- `server.js`：
  - `frameBase()` 读 `_frame.json`，缺省 `http://127.0.0.1:8790`；
  - `GET /api/frame/state` 代理 helper 的 `/state`，失败返回 `{ok:true, active:false}`；
  - `POST /api/frame/{drag|min|max|close}` 转发，helper 不在时返回 `{ok:false, error:'没有自绘窗口'}`（页面提示“请用 VPBoardBetter.exe 打开”）。
- 启动链：
  - `tools/launch-hidden.ps1` 在打开 Edge 之后 `Start-Process VPBoardBetter.exe -ArgumentList '-frame'`（等窗口最多 20 秒，helper 自己重试）；
  - exe 双击路径保持现状（把 `start.bat` 交给 Shell），避免递归。

### 7. 视觉

- 高度 34px；背景与 `.topbar` 同色（`--panel` 上的深色渐变）；底部 1px `--border-soft`。
- 标题 12.5px、`--text-dim`；图标 18px。
- 按钮 46×34、无边框、`hover` 背景 `rgba(255,255,255,.06)`、`active` 更亮；关闭按钮 `hover` 用 `#e81123`、白字。
- 左侧拖拽区 `cursor: default`；按钮区 `cursor: default`，禁止选中文字。
- 圆角与阴影交给 DWM，不额外画伪圆角。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| Chromium 覆盖 `WM_NCHITTEST`，四边拖拽失效 | 保留 `WS_THICKFRAME`；实机确认，若失效改为页面四边 8px 热区 + helper 发 `WM_SYSCOMMAND SC_SIZE` |
| 全屏/DPI 变化后边框被加回 | helper 轮询样式位，发现 `WS_CAPTION` 回来就重新去掉 |
| 去掉标题栏后内容顶部留白 | `SWP_FRAMECHANGED` + 高度 +1/-1 触发 NC 重算；残留则页面加 `padding-top` 补偿（实测值） |
| 拖动延迟 | 本机 HTTP < 5ms；`/drag` 立即返回，不阻塞 |
| 沙箱内看不到画面 | `-frame -debug` 写 `_frame.log`（HWND、样式前后、client rect、每条命令耗时）；用户按验证清单实机确认 |
| helper 挂了但窗口还在 | 页面 `/api/frame/state` 失败 → 标题条自动隐藏，退回原生边框（窗口仍可用） |

## 交付物

- `tools/launcher/Program.cs`：新增 `-frame` 模式（约 200 行）。
- `tools/launch-hidden.ps1`：打开 Edge 后拉起 helper。
- `index.html` / `assets/style.css` / `assets/app.js`：标题条、按钮、拖动与状态轮询。
- `server.js`：`/api/frame/*` 代理。
- `docs/DEVELOPMENT.md`：补一节“自绘标题栏（helper + Win32）”。
- `README.md`：用户可见一句（窗口边框是我们画的，关闭会一起退服务）。
- 测试：`node tools/test-frame.js`（用假 helper 的 state 验证标题条显示/隐藏、按钮请求路径）；`node tools/test-core.js` 继续全绿。

## 留给实现者的决定

- helper 用 `HttpListener` 还是极简 `TcpListener`；
- 标题条高度 32 还是 34（按实测顶部留白微调）；
- 轮询间隔（400ms / 800ms）在实测 CPU 占用后定。

## 用户验证清单

1. 双击 exe：窗口没有系统标题栏，顶部是自绘条，颜色与顶栏一致。
2. 拖动标题条可移动窗口；拖到屏幕顶/左右边缘能吸附；双击标题条最大化/还原。
3. 四边可拖拽改大小；最大化后没有白边或黑边。
4. 三个按钮行为正确，最大化图标随之切换。
5. 点关闭：`netstat -ano | findstr :8787` 无监听，任务管理器里没有 `vpb-qoj-*` 的 `msedge.exe`。
6. Alt+F4、任务栏右键关闭结果相同。
7. 直接浏览器打开 `http://127.0.0.1:8787/`：没有自绘条，原生边框正常。
