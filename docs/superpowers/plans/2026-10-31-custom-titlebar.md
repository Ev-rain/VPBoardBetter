# 自绘标题栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让应用窗口拥有与界面同色系的自绘标题栏（最小化/最大化/关闭），同时保留 Windows 原生拖动、吸附、双击最大化与边缘缩放；关闭窗口时自动停掉本地服务。

**Architecture:** Edge `--app` 继续负责渲染；`VPBoardBetter.exe -frame` 作为常驻 helper 用 Win32 去掉窗口的 `WS_CAPTION`（保留 `WS_THICKFRAME/WS_MAXIMIZEBOX/WS_SYSMENU`），并在 `127.0.0.1:8790` 上接受 `/drag`、`/min`、`/max`、`/close` 命令；页面通过同源 `/api/frame/*` 调它，顶部画 34px 标题条。窗口销毁（按钮、Alt+F4、任务栏关闭）后 helper 负责停服务并退出。

**Tech Stack:** 零依赖 Node（`server.js`）、原生 HTML/CSS/JS（`index.html`、`assets/*`）、C# .NET Framework WinForms（`tools/launcher/Program.cs`，`csc.exe` 编译）、PowerShell 启动脚本（UTF-8 BOM）。

**Spec:** `docs/superpowers/specs/2026-10-31-custom-titlebar-design.md`

## Global Constraints

- 不引入任何 npm / NuGet 依赖；exe 仍由 `tools/build-exe.ps1` 用 `csc.exe` 编译。
- `.ps1` 必须保存为 UTF-8 **带 BOM**（PS 5.1 否则按 ANSI 解析报错）；`.bat`/`.vbs` 必须 CRLF。
- 禁止在窗口创建后用 `SetWindowPos` “纠正”尺寸/位置（窗口跳动回归）；尺寸只由 `--window-size/--window-position` 在创建时生效。
- helper 与页面都必须在没有对方时安全降级：无 helper → 不显示自绘条、原生边框照常可用。
- 关闭清理顺序固定：先 `WM_CLOSE`，窗口消失后再杀 8787 监听进程、再杀命令行含 `vpb-qoj-` 的 `msedge.exe`、最后退出 helper。
- 自绘条高度 34px；按钮尺寸 46×34；关闭按钮 hover `#e81123`。
- 所有新接口都要在 `docs/DEVELOPMENT.md` 留一行说明。

## Review Focus

- **helper 不存在或端口被占用**：页面打开时 `/api/frame/state` 连不上，必须静默隐藏标题条，不能卡住首屏；由 Task 1/3 的测试覆盖。
- **点按钮被当成拖窗口**：标题条按下即发 `/drag`，若按钮区域没排除，点关闭会先把窗口拖走；由 Task 3 的测试覆盖。
- **服务是提权进程时关不掉**：旧会话里管理员启动的 node 无法 `Kill`，helper 必须写日志并继续退出，而不是卡在清理里；由 Task 4 的自检覆盖。
- **最大化后顶部多出一条空白**：去 caption 后 Chromium 需要一次 NC 重算，否则客户区让出 30px；由 Task 4 的 `-selftest` 检查 client rect 与窗口 rect 是否一致。
- **全屏/DPI 变化把 caption 加回来**：helper 轮询样式位并重新去掉；由 Task 4 的 `-selftest` 覆盖“样式被改回后能再次清除”。

---

### Task 1: server.js 增加 `/api/frame/*` 代理

**Files:**
- Modify: `server.js`（路由表 `/api/frame` 一节，建议放在 `/api/open` 之后）
- Test: `tools/test-frame.js`（新建，零依赖 `node:test` 不用，直接用 `assert` + 手写 runner，与 `tools/test-core.js` 一致）

**Interfaces:**
- Consumes: `sendJson(res, code, obj)`（现有）；`_frame.json`（helper 写入的 `{port}`）
- Produces:
  - `frameBase()` → `string`，如 `http://127.0.0.1:8790`
  - `frameGet(path)` → `Promise<object|null>`（2 秒超时）
  - `GET /api/frame/state` → `{ok:true, active:boolean, maximized:boolean}`
  - `POST /api/frame/{drag|min|max|close}` → `{ok:true}` 或 `502 {ok:false,error}`

- [ ] **Step 1: 写失败测试**

`tools/test-frame.js` 里启动一个假 helper（`http.createServer` 监听 8790，`/state` 返回 `{ok:true,hwnd:"1",maximized:false}`，其余返回 204），再起 `server.js`（`PORT=8793`），断言：

```js
assert.deepStrictEqual(await get('/api/frame/state'), { ok: true, active: true, maximized: false });
assert.deepStrictEqual(await post('/api/frame/min'), { ok: true });
assert.deepStrictEqual(await post('/api/frame/bogus'), { ok: false, error: 'unknown frame command' });
```

再关掉假 helper，断言 `/api/frame/state` 返回 `{ok:true,active:false}` 且 `POST /api/frame/close` 返回 502 `{ok:false,error:'没有自绘窗口'}`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node tools/test-frame.js`
Expected: FAIL（404 或 `fetch failed`）

- [ ] **Step 3: 实现**

`server.js`：

```js
const FRAME_PORT = Number(process.env.FRAME_PORT || 8790);
function frameBase() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '_frame.json'), 'utf8'));
    if (j && j.port) return 'http://127.0.0.1:' + j.port;
  } catch (e) {}
  return 'http://127.0.0.1:' + FRAME_PORT;
}
async function frameCall(cmd) { /* fetch(frameBase() + '/state' | '/' + cmd, {signal: AbortSignal.timeout(2000)}) → json 或 null */ }
```

路由：`GET /api/frame/state` → `frameCall('state')` 成功则 `{ok:true,active:true,maximized:!!s.maximized}`，失败 `{ok:true,active:false}`；POST 三种命令成功 `{ok:true}`、`unknown frame command` 400、helper 不可达 502 `{ok:false,error:'没有自绘窗口'}`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node tools/test-frame.js`
Expected: `全部通过 ✓`

- [ ] **Step 5: 提交**

```bash
git add server.js tools/test-frame.js
git commit -m "feat(frame): server 增加 /api/frame 代理"
```

---

### Task 2: 标题条结构与样式

**Files:**
- Modify: `index.html:12-14`（`.app` 内最顶部插入 `.titlebar`）
- Modify: `assets/style.css`（`.titlebar` 一节，接在 `.topbar` 规则之后）
- Test: `tools/test-frame.js` 追加 DOM 断言（用 Task 3 的 DOM 桩）

**Interfaces:**
- Produces: `#titlebar`、`#tbTitle`、`#tbMin`、`#tbMax`、`#tbClose`；`body.framed` 时可见

- [ ] **Step 1: 写失败测试**

在 `tools/test-frame.js` 的 UI 段（Task 3 负责桩）先加：

```js
assert.ok(doc.getElementById('titlebar'), '有标题条');
assert.equal(doc.getElementById('titlebar').hidden, true, '默认隐藏');
```

- [ ] **Step 2: 运行确认失败**

Run: `node tools/test-frame.js`
Expected: FAIL `有标题条`

- [ ] **Step 3: 实现**

`index.html` 在 `<div class="app" id="app">` 后插入：

```html
<div class="titlebar" id="titlebar" hidden>
  <div class="tb-title" id="tbTitle"><img src="assets/balloon.svg" alt=""><span>VP Board Better</span></div>
  <div class="tb-btns">
    <button class="tb-btn" id="tbMin" title="最小化">–</button>
    <button class="tb-btn" id="tbMax" title="最大化">□</button>
    <button class="tb-btn tb-close" id="tbClose" title="关闭">✕</button>
  </div>
</div>
```

`assets/style.css`：`.titlebar{display:none;height:34px;align-items:center;justify-content:space-between;padding:0 0 0 12px;background:linear-gradient(180deg,var(--panel-2),var(--panel));border-bottom:1px solid var(--border-soft);user-select:none}`、`body.framed .titlebar{display:flex}`、`.tb-btn{width:46px;height:34px;border:0;background:transparent;color:var(--text-dim)}`、`.tb-btn:hover{background:rgba(255,255,255,.06);color:var(--text)}`、`.tb-close:hover{background:#e81123;color:#fff}`、`.app{grid-template-rows:auto auto auto 1fr auto}`（保持原行数，标题条是额外一行时用 `body.framed .app{grid-template-rows:34px auto auto auto 1fr auto}`）。

- [ ] **Step 4: 运行确认通过**

Run: `node tools/test-frame.js`
Expected: PASS（该项）

- [ ] **Step 5: 提交**

```bash
git add index.html assets/style.css tools/test-frame.js
git commit -m "feat(frame): 自绘标题条结构与样式"
```

---

### Task 3: 页面交互（拖动 / 三按钮 / 状态轮询）

**Files:**
- Modify: `assets/app.js`（新增 `initFrame()`，在 `bindEvents()` 之后、`init()` 开头调用）
- Test: `tools/test-frame.js`（DOM 桩按 `tools/test-curve.js` 的做法：`vm.runInContext` + 最小 `document`）

**Interfaces:**
- Produces:
  - `frameState()` → `Promise<{active:boolean,maximized:boolean}>`
  - `frameCmd(cmd)` → `Promise<boolean>`，内部 `fetch('/api/frame/' + cmd, {method:'POST'})`
  - `initFrame()` → `Promise<void>`；成功后 `document.body.classList.add('framed')` 并设置 `#tbMax` 文案
  - `#tbMax` 文案：最大化时 `❐`（还原），否则 `□`

- [ ] **Step 1: 写失败测试**

```js
// helper 在线
await vpApp.initFrame({ state: { active: true, maximized: false } });
assert.equal(doc.getElementById('titlebar').hidden, false);
assert.ok(doc.body.classList.contains('framed'));
assert.equal(doc.getElementById('tbMax').textContent, '□');
// 点按钮不触发拖动
doc.getElementById('tbMin').dispatchEvent(mousedown);
assert.deepEqual(calls, ['/api/frame/min']);
// 拖动区触发一次
doc.getElementById('tbTitle').dispatchEvent(mousedown);
assert.deepEqual(calls, ['/api/frame/min', '/api/frame/drag']);
// 没有 helper
await vpApp.initFrame({ state: { active: false } });
assert.equal(doc.getElementById('titlebar').hidden, true);
```

- [ ] **Step 2: 运行确认失败**

Run: `node tools/test-frame.js`
Expected: FAIL `initFrame is not a function`

- [ ] **Step 3: 实现**

`assets/app.js`：

```js
function frameState() { return fetch('/api/frame/state').then(r => r.json()).catch(() => ({ active: false })); }
function frameCmd(cmd) { return fetch('/api/frame/' + cmd, { method: 'POST' }).then(r => r.ok).catch(() => false); }
function initFrame() {
  return frameState().then(function (s) {
    if (!s || !s.active) { document.getElementById('titlebar').hidden = true; document.body.classList.remove('framed'); return; }
    document.body.classList.add('framed');
    document.getElementById('titlebar').hidden = false;
    document.getElementById('tbMax').textContent = s.maximized ? '❐' : '□';
    // 拖动：标题条 mousedown（closest('button') 除外）→ frameCmd('drag')
    // 三按钮 click/min/max/close；window resize + 800ms 轮询刷新最大化图标
  });
}
```

`init()` 开头 `initFrame();`；`window.VPApp` 暴露 `initFrame`、`frameCmd`。

- [ ] **Step 4: 运行确认通过**

Run: `node tools/test-frame.js && node tools/test-core.js`
Expected: 两个都通过

- [ ] **Step 5: 提交**

```bash
git add assets/app.js tools/test-frame.js
git commit -m "feat(frame): 标题条拖动与窗口按钮"
```

---

### Task 4: helper `-frame` 模式（Win32）

**Files:**
- Modify: `tools/launcher/Program.cs`（新增 `FrameMode()` 与 P/Invoke：`GetWindowLongPtr/SetWindowLongPtr/SetWindowPos/IsZoomed/ReleaseCapture/SendMessage/IsWindow`）
- Test: 手动自检 `VPBoardBetter.exe -frame -selftest`（无 Edge 时只校验降级路径，写 `_frame.log`）

**Interfaces:**
- Consumes: 现有 `FindAppWindow()`、`Log()`、`PortOpen()`
- Produces: `HttpListener` on `127.0.0.1:8790`，写 `_frame.json`
  - `GET /state` → `{"ok":true,"hwnd":"<hex>","maximized":false,"active":true}`
  - `POST /drag` → 后台线程 `ReleaseCapture(); SendMessage(hwnd, 0xA1 /*WM_NCLBUTTONDOWN*/, (IntPtr)2 /*HTCAPTION*/, IntPtr.Zero)`，立即 204
  - `POST /min` → `PostMessage(hwnd, 0x112 /*WM_SYSCOMMAND*/, (IntPtr)0xF020, 0)`
  - `POST /max` → `IsZoomed(hwnd) ? 0xF120 : 0xF030`
  - `POST /close` → `PostMessage(hwnd, 0x10 /*WM_CLOSE*/, 0, 0)`
- `StripCaption(hwnd)`：`style & ~WS_CAPTION`，`SetWindowPos(..., SWP_FRAMECHANGED|SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER)`，随后高度 +1/-1 触发 NC 重算；`WatchWindow()` 每 400ms 检查 `IsWindow` 与 `WS_CAPTION` 是否被加回。

- [ ] **Step 1: 写自检入口（先让它输出可断言的行）**

`-frame -selftest`：不找窗口，打印 `selftest: server=ok`、`selftest: style=0x…`（用一个临时 `CreateWindowEx` 或跳过）、`selftest: done` 到 `_frame.log` 后退出 0。

- [ ] **Step 2: 编译并运行，确认当前失败**

Run: `powershell -File tools/build-exe.ps1` then `.\VPBoardBetter.exe -frame -selftest`
Expected: 当前版本不认识 `-frame`，`_frame.log` 无 `selftest:` 行

- [ ] **Step 3: 实现 `-frame`**

- `args` 含 `-frame` 时进入 `FrameMode()`（不调用 `start.bat`）；
- 启动 `HttpListener`（`FRAME_PORT` 覆盖），写 `_frame.json`；
- 每 400ms 找窗口，找到即 `StripCaption`；`IsWindow` 变 false → `CleanupAndExit()`（杀 8787 监听 PID、杀 `vpb-qoj-` 的 msedge、删 `%TEMP%\vpb-qoj-*`、退出）；
- 所有命令与样式变化写 `_frame.log`。

- [ ] **Step 4: 编译 + 自检 + 降级验证**

Run: `powershell -File tools/build-exe.ps1 && .\VPBoardBetter.exe -frame -selftest && type _frame.log`
Expected: 含 `selftest: server=ok` 与 `selftest: done`；随后 `Start-Process .\VPBoardBetter.exe -ArgumentList '-frame'`，2 秒内 `_frame.log` 出现 `未找到窗口，重试`，`curl http://127.0.0.1:8790/state` 返回 `active:true`。

- [ ] **Step 5: 提交**

```bash
git add tools/launcher/Program.cs
git commit -m "feat(frame): 启动器 -frame 模式，接管窗口边框并提供窗口命令"
```

---

### Task 5: 启动链接线

**Files:**
- Modify: `tools/launch-hidden.ps1`（打开 Edge 后启动 helper）
- Modify: `docs/DEVELOPMENT.md`、`README.md`
- Test: `powershell -NoProfile -File tools/launch-hidden.ps1` 的解析检查（`PSParser::ParseFile`）+ 用户实机

**Interfaces:**
- Consumes: `VPBoardBetter.exe -frame`
- Produces: 启动后 `_frame.json` 存在，`http://127.0.0.1:8790/state` 可访问

- [ ] **Step 1: 改 ps1 并解析校验**

在启动 Edge 之后加：

```powershell
$exe = Join-Path $root 'VPBoardBetter.exe'
if (Test-Path $exe) { Start-Process -FilePath $exe -ArgumentList '-frame' -WorkingDirectory $root | Out-Null; Log '已启动边框 helper' }
```

Run: `powershell -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('tools/launch-hidden.ps1',[ref]$null,[ref]$e)"`
Expected: 无语法错误，且文件仍是 UTF-8 BOM（`Format-Hex` 前三字节 `EF BB BF`）

- [ ] **Step 2: 文档**

`docs/DEVELOPMENT.md` 增「自绘标题栏」一节（进程图、8790 命令表、清理顺序）；`README.md` 启动说明补一句「关掉窗口会一起退服务」。

- [ ] **Step 3: 提交**

```bash
git add tools/launch-hidden.ps1 docs/DEVELOPMENT.md README.md
git commit -m "feat(frame): 启动器接线与文档"
```

---

### Task 6（需用户确认后才做）：收敛启动链，去掉 .bat

**Files:**
- Create/Modify: `start.bat`、`stop.bat`、`launch.vbs`、`tools/launch-hidden.ps1`（视结论保留或删除）
- Modify: `tools/launcher/Program.cs`（若由 exe 自己起 node + Edge）

**前置条件：** 用户实机确认 `VPBoardBetter.exe -frame` 能独立起服务与窗口（Task 5 之后）。

- [ ] **Step 1: 让 exe 自给自足**：`-frame` 在找不到服务时 `StartServer()`（复用现有方法），找不到窗口时用 `--app=… --window-size=… --window-position=… --user-data-dir=.app-profile` 启动 Edge。
- [ ] **Step 2: 保留最小兜底**：`start.bat` 改为 `@echo off` + `start "" "%~dp0VPBoardBetter.exe"`；`stop.bat` 改为 `"%~dp0VPBoardBetter.exe" -stop`。
- [ ] **Step 3: 用户实机验证通过后**，删除 `start.bat`、`stop.bat`、`launch.vbs`、`tools/launch-hidden.ps1`，`README.md` 只留「双击 exe」。
- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "refactor(launcher): exe 独立起服务与窗口，去掉 bat 启动链"
```

---

## 验证（Task 5 之后）

- `node tools/test-frame.js`、`node tools/test-core.js`、`node tools/test-curve.js` 全绿。
- `node --check server.js assets/app.js` 通过；`powershell -File tools/build-exe.ps1` 成功。
- 用户按设计文档末尾的 7 条清单实机确认（沙箱里起不了 Edge，这一步只能由用户做）。

## Self-Review

- 覆盖：`/api/frame` 代理（Task 1）、标题条外观（Task 2）、拖动与按钮（Task 3）、Win32 去边框与清理（Task 4）、接线与文档（Task 5）、bat 收敛（Task 6，带前置条件）。
- 类型一致：`frameState()`/`frameCmd()`/`initFrame()` 在 Task 3 定义，Task 3 的测试直接引用；`/state` 返回字段 `active`/`maximized` 在 Task 1 与 Task 4 一致。
- 比例：计划约 260 行，正文以接口和断言为主，未展开实现体。
