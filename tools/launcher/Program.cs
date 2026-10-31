using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace VPBoardBetter
{
    /// <summary>
    /// 启动器（WinExe，无控制台）：
    ///   双击   -> 起隐藏 node（如未运行）+ 用独立配置目录打开 Edge 应用窗口，尺寸/位置作为“创建参数”传进去
    ///   -stop  -> 关闭应用窗口并停掉本地服务
    ///
    /// 关键点（与 launch-hidden.ps1 一致，见 README）：Edge 在默认用户目录里会恢复它自己的
    /// --app 窗口状态并忽略 --window-size；独立 --user-data-dir 才会在创建窗口时应用参数。
    /// 不要再在窗口出现后用 SetWindowPos 去“纠正”，那正是之前窗口跳动的原因。
    /// </summary>
    internal static class Program
    {
        private const string TitlePart = "VP Board Better";
        private const int DefaultPort = 8787;
        private const int SwRestore = 9;

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
        private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        // 完整性级别检测：工作区目录若带 Low 标签，从里面启动的 exe 会跑在 Low IL，
        // Chromium 的沙箱在 Low IL 下起不来（表现为 --app 窗口白屏）。
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength, out int returnLength);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthorityIndex);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private const int TokenIntegrityLevel = 25;
        private const int MediumRid = 0x2000;

        /// <summary>返回当前进程的完整性级别 RID；取不到时按 Medium 处理。</summary>
        private static int IntegrityRid()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /* TOKEN_QUERY */, out token)) return MediumRid;
            try
            {
                int len;
                GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out len);
                if (len <= 0) return MediumRid;
                IntPtr buf = Marshal.AllocHGlobal(len);
                try
                {
                    if (!GetTokenInformation(token, TokenIntegrityLevel, buf, len, out len)) return MediumRid;
                    IntPtr sid = Marshal.ReadIntPtr(buf); // TOKEN_MANDATORY_LABEL.Label（SID_AND_ATTRIBUTES）在偏移 0
                    int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                    if (count <= 0) return MediumRid;
                    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            finally { CloseHandle(token); }
        }

        private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        private static readonly string LogFile = Path.Combine(Root, "_launch.log");
        private static int Port = DefaultPort;

        private static void Log(string msg)
        {
            try { File.AppendAllText(LogFile, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                var portEnv = Environment.GetEnvironmentVariable("PORT");
                int parsed;
                if (!string.IsNullOrEmpty(portEnv) && int.TryParse(portEnv, out parsed)) Port = parsed;

                if (args.Any(a => string.Equals(a, "-frame", StringComparison.OrdinalIgnoreCase)))
                {
                    FrameMode(args.Any(a => string.Equals(a, "-selftest", StringComparison.OrdinalIgnoreCase)));
                    return;
                }

                if (args.Any(a => string.Equals(a, "-dump", StringComparison.OrdinalIgnoreCase)))
                {
                    DumpWindows();
                    return;
                }

                if (args.Any(a => string.Equals(a, "-shot", StringComparison.OrdinalIgnoreCase)))
                {
                    string outFile = args.Length > 1 && !args[0].StartsWith("-") ? args[0] : args[args.Length - 1];
                    ShotWindow(outFile);
                    return;
                }

                if (args.Any(a => string.Equals(a, "-stop", StringComparison.OrdinalIgnoreCase)))
                {
                    Stop();
                    return;
                }

                Log("启动器开始（端口 " + Port + "）");

                if (FindAppWindow() != IntPtr.Zero)
                {
                    Log("应用窗口已在运行，切到前台");
                    Focus(FindAppWindow());
                    return;
                }

                // 工作区里带的 Low 完整性标签会把本进程降到 Low IL，Chromium 在 Low IL 下
                // 渲染不出页面（白屏、标题停在 127.0.0.1）。交给 explorer.exe 重新拉起，
                // 由它（Medium IL）启动 start.bat，这样无需管理员也无需改动目录 ACL。
                int rid = IntegrityRid();
                Log("当前完整性级别 RID=0x" + rid.ToString("X"));
                if (rid > 0 && rid < MediumRid)
                {
                    Log("Low IL：Chromium 无法渲染，给出修复提示并退出");
                    MessageBox.Show(
                        "本程序现在运行在「低完整性级别」(Low IL)。\r\n\r\n" +
                        "原因：程序所在目录（通常是 DSH/Agent 的工作区）被系统打了 Low 完整性标签，\r\n" +
                        "该标签会被目录里的所有文件继承；Windows 从这类 exe 启动进程时会把进程降为 Low，\r\n" +
                        "而 Edge/Chromium 的沙箱在 Low 下无法渲染页面，于是窗口全白。\r\n\r\n" +
                        "修复（任选其一，都不需要管理员）：\r\n" +
                        "1) 把整个文件夹移到工作区之外，例如 C:\\Users\\你的用户名\\VPBoardBetter；\r\n" +
                        "2) 或在命令行执行一次：\r\n" +
                        "   icacls \"" + Root + "\" /setintegritylevel (OI)(CI)Medium /T\r\n\r\n" +
                        "做完后重新双击本程序即可。",
                        TitlePart, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                // 不自己启动浏览器：只把已经验证过的 start.bat 交给 Shell 拉起。
                // 走 ShellExecute 与“双击 start.bat”是同一路径，且脱离本进程的作业对象/环境继承。
                string bat = Path.Combine(Root, "start.bat");
                if (!File.Exists(bat))
                {
                    MessageBox.Show("找不到 start.bat：" + bat, TitlePart, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                Log("调用 start.bat");
                var psi = new ProcessStartInfo(bat)
                {
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = Root
                };
                Process.Start(psi);
                Log("已交给 start.bat，本进程退出");
                return;
            }
            catch (Exception ex)
            {
                Log("失败: " + ex.Message);
                MessageBox.Show("启动失败：" + ex.Message + "\r\n\r\n日志：" + LogFile, TitlePart, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        // 仅用于排障：设置 VPB_CDP_PORT 后，Edge 会带 --remote-debugging-port，可用 CDP 查看页面状态
        private static string DebugPortArg()
        {
            string p = Environment.GetEnvironmentVariable("VPB_CDP_PORT");
            return string.IsNullOrEmpty(p) ? "" : "--remote-debugging-port=" + p;
        }

        private static void StartServer()
        {
            if (PortOpen()) { Log("服务已在运行"); return; }
            string node = FindNode();
            if (node == null)
            {
                MessageBox.Show("没有找到 Node.js。请先安装 https://nodejs.org/ 再运行。", TitlePart, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                throw new InvalidOperationException("node not found");
            }
            Log("启动 node: " + node);
            var psi = new ProcessStartInfo(node)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Root,
                Arguments = "server.js",
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var p = Process.Start(psi);
            try { p.StandardOutput.ReadLineAsync(); } catch { }
            for (int i = 0; i < 60 && !PortOpen(); i++) Thread.Sleep(250);
            if (!PortOpen()) throw new InvalidOperationException("本地服务没有起来（端口 " + Port + "），详见 _server.log");
        }

        private static bool PortOpen()
        {
            try
            {
                using (var c = new TcpClient())
                {
                    var t = c.ConnectAsync("127.0.0.1", Port);
                    if (!t.Wait(400)) return false;
                    return c.Connected;
                }
            }
            catch { return false; }
        }

        private static string FindNode()
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in path.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    var exe = Path.Combine(dir.Trim('"'), "node.exe");
                    if (File.Exists(exe)) return exe;
                }
                catch { }
            }
            var candidates = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
            };
            return candidates.FirstOrDefault(File.Exists);
        }

        private static string FindEdge()
        {
            var candidates = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe")
            };
            return candidates.FirstOrDefault(File.Exists);
        }

        private static void EnsureProfile()
        {
            string profile = Path.Combine(Root, ".app-profile");
            if (Directory.Exists(profile)) return;
            Log("首次创建应用配置目录");
            Directory.CreateDirectory(Path.Combine(profile, "Default"));
            string src = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "Edge", "User Data", "Default", "Local Storage", "leveldb");
            string dst = Path.Combine(profile, "Default", "Local Storage", "leveldb");
            if (!Directory.Exists(src)) return;
            try
            {
                CopyDir(src, dst);
                var lockFile = Path.Combine(dst, "LOCK");
                if (File.Exists(lockFile)) File.Delete(lockFile);
                Log("已迁移旧配置里的 localStorage");
            }
            catch (Exception ex) { Log("迁移 localStorage 失败: " + ex.Message); }
        }

        private static void CopyDir(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src))
            {
                try { File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true); } catch { }
            }
            foreach (var d in Directory.GetDirectories(src))
            {
                try { CopyDir(d, Path.Combine(dst, Path.GetFileName(d))); } catch { }
            }
        }

        private static void KillStaleBrowsers()
        {
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
                {
                    foreach (var obj in searcher.Get())
                    {
                        var cmd = obj["CommandLine"] as string;
                        if (cmd == null || cmd.IndexOf(".app-profile", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        try { Process.GetProcessById(Convert.ToInt32(obj["ProcessId"])).Kill(); } catch { }
                    }
                }
            }
            catch { }
        }

        private static void ReadWindowState(out int w, out int h, out int x, out int y)
        {
            w = 1400; h = 860; x = 150; y = 90;
            var file = Path.Combine(Root, "_window.json");
            if (!File.Exists(file)) return;
            try
            {
                var text = File.ReadAllText(file, Encoding.UTF8);
                int v;
                var m = Regex.Match(text, "\"w\"\\s*:\\s*(\\d+)");
                if (m.Success && int.TryParse(m.Groups[1].Value, out v) && v >= 640 && v <= 8000) w = v;
                m = Regex.Match(text, "\"h\"\\s*:\\s*(\\d+)");
                if (m.Success && int.TryParse(m.Groups[1].Value, out v) && v >= 480 && v <= 5000) h = v;
                m = Regex.Match(text, "\"x\"\\s*:\\s*(-?\\d+)");
                if (m.Success && int.TryParse(m.Groups[1].Value, out v) && Math.Abs(v) < 20000) x = v;
                m = Regex.Match(text, "\"y\"\\s*:\\s*(-?\\d+)");
                if (m.Success && int.TryParse(m.Groups[1].Value, out v) && Math.Abs(v) < 20000) y = v;
            }
            catch { }
        }

        private static IntPtr FindAppWindow()
        {
            var list = FindAppWindows();
            return list.Count > 0 ? list[0] : IntPtr.Zero;
        }

        /// <summary>所有可见的、属于 msedge 的 Chromium 顶层窗口，按面积从大到小排列。</summary>
        private static System.Collections.Generic.List<IntPtr> FindAppWindows()
        {
            var list = new System.Collections.Generic.List<IntPtr>();
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                var cls = new StringBuilder(64);
                GetClassName(h, cls, 64);
                if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return true;
                if (!IsWindowVisible(h)) return true;

                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid == 0) return true;

                var sb = new StringBuilder(512);
                GetWindowText(h, sb, 512);
                string title = sb.ToString();
                bool byTitle = title.IndexOf(TitlePart, StringComparison.OrdinalIgnoreCase) >= 0;
                // 正式标题出来之前窗口标题是 URL（127.0.0.1/…），这时要靠进程命令行里的 .app-profile 认人，
                // 免得把用户自己浏览器里打开的同一个地址也当成应用窗口
                bool byUrl = !byTitle && title.IndexOf("127.0.0.1", StringComparison.Ordinal) >= 0
                    && CmdLineOf(pid).IndexOf(".app-profile", StringComparison.OrdinalIgnoreCase) >= 0;
                if (!byTitle && !byUrl) return true;

                try { if (Process.GetProcessById((int)pid).ProcessName != "msedge") return true; } catch { return true; }

                NativeRect r;
                if (!GetWindowRect(h, out r)) return true;
                int w = r.Right - r.Left, ht = r.Bottom - r.Top;
                if (w < 300 || ht < 200) return true;

                list.Add(h);
                return true;
            }, IntPtr.Zero);
            list.Sort(delegate(IntPtr a, IntPtr b) { return AreaOf(b).CompareTo(AreaOf(a)); });
            return list;
        }

        private static long AreaOf(IntPtr h)
        {
            NativeRect r;
            if (!GetWindowRect(h, out r)) return 0;
            return (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        }

        private static readonly System.Collections.Generic.Dictionary<uint, string> CmdLineCache =
            new System.Collections.Generic.Dictionary<uint, string>();

        private static string CmdLineOf(uint pid)
        {
            lock (CmdLineCache)
            {
                string cached;
                if (CmdLineCache.TryGetValue(pid, out cached)) return cached;
            }
            string cmd = "";
            try
            {
                using (var q = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
                {
                    foreach (ManagementObject mo in q.Get())
                    {
                        cmd = Convert.ToString(mo["CommandLine"]);
                        break;
                    }
                }
            }
            catch { }
            lock (CmdLineCache) { CmdLineCache[pid] = cmd; }
            return cmd;
        }

        private static void Focus(IntPtr h)
        {
            ShowWindow(h, SwRestore);
            SetForegroundWindow(h);
        }

        private static readonly string FrameLogFile = Path.Combine(Root, "_frame.log");

        private static void FrameLog(string msg)
        {
            try { File.AppendAllText(FrameLogFile, "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + msg + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }

        private const int GwlStyle = -16;
        private const uint VpbWsCaption = 0x00C00000;
        private const uint SwpNoSize = 0x0001, SwpNoMove = 0x0002, SwpNoZOrder = 0x0004, SwpFrameChanged = 0x0020;
        private static volatile IntPtr FrameHwnd = IntPtr.Zero;

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
        private static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        private static extern IntPtr GetWindowLongW(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
        private static extern IntPtr SetWindowLongPtrW(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern IntPtr SetWindowLongW(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }

        /// <summary>调试用：列出所有 Chromium 顶层窗口（句柄/进程/可见/样式/矩形/标题）到 _dump.txt。</summary>
        private static void DumpWindows()
        {
            var sb = new StringBuilder();
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                var cls = new StringBuilder(256);
                GetClassName(h, cls, 256);
                string clsName = cls.ToString();
                if (!clsName.StartsWith("Chrome_WidgetWin")) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                string proc = "";
                try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
                var title = new StringBuilder(512);
                GetWindowText(h, title, 512);
                NativeRect r;
                GetWindowRect(h, out r);
                sb.AppendLine(string.Format(
                    "hwnd=0x{0:X} pid={1} proc={2} visible={3} style=0x{4:X8} rect={5},{6},{7},{8} class={9} title={10}",
                    h.ToInt64(), pid, proc, IsWindowVisible(h), GetStyleBits(h).ToInt64(),
                    r.Left, r.Top, r.Right, r.Bottom, clsName, title));
                return true;
            }, IntPtr.Zero);
            File.WriteAllText(Path.Combine(Root, "_dump.txt"), sb.ToString(), Encoding.UTF8);
            FrameLog("dump: " + sb.Length + " chars");
        }

        /// <summary>调试用：截应用窗口到 PNG（PrintWindow，含系统标题栏）。</summary>
        private static void ShotWindow(string outFile)
        {
            IntPtr h = FindAppWindow();
            FrameLog("shot: hwnd=0x" + h.ToInt64().ToString("X"));
            if (h == IntPtr.Zero) return;
            NativeRect r;
            if (!GetWindowRect(h, out r)) { FrameLog("shot: GetWindowRect 失败"); return; }
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            if (w <= 0 || ht <= 0) { FrameLog("shot: 窗口尺寸异常"); return; }
            using (var bmp = new Bitmap(w, ht))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    bool ok = PrintWindow(h, hdc, 2);
                    g.ReleaseHdc(hdc);
                    FrameLog("shot: printwindow=" + ok + " " + w + "x" + ht);
                }
                string p = Path.IsPathRooted(outFile) ? outFile : Path.Combine(Root, outFile);
                bmp.Save(p, System.Drawing.Imaging.ImageFormat.Png);
                FrameLog("shot: saved " + p);
            }
        }

        private static IntPtr GetStyleBits(IntPtr h)
        {
            return IntPtr.Size == 8 ? GetWindowLongPtrW(h, GwlStyle) : GetWindowLongW(h, GwlStyle);
        }

        private static void SetStyleBits(IntPtr h, IntPtr value)
        {
            if (IntPtr.Size == 8) SetWindowLongPtrW(h, GwlStyle, value);
            else SetWindowLongW(h, GwlStyle, value);
        }

        /// <summary>去掉标题栏样式位（保留 THICKFRAME/MAXIMIZEBOX/SYSMENU），再强制一次 NC 重算。</summary>
        private static void StripCaption(IntPtr h)
        {
            try
            {
                long style = GetStyleBits(h).ToInt64();
                if ((style & VpbWsCaption) != 0)
                {
                    long next = style & ~(long)VpbWsCaption;
                    SetStyleBits(h, (IntPtr)next);
                    FrameLog("去掉 WS_CAPTION（style 0x" + style.ToString("X") + " → 0x" + next.ToString("X") + "）");
                }
                bool ok = SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SwpFrameChanged | SwpNoMove | SwpNoSize | SwpNoZOrder);
                FrameLog("strip: FrameChanged=" + ok + " now=0x" + GetStyleBits(h).ToInt64().ToString("X"));
            }
            catch (Exception ex) { FrameLog("去 caption 失败: " + ex.Message); }
        }

        private static void FrameReply(TcpClient client, int code, string body)
        {
            try
            {
                using (var s = client.GetStream())
                {
                    string reason = code == 200 ? "OK" : code == 204 ? "No Content" : code == 404 ? "Not Found" : "Service Unavailable";
                    string head = "HTTP/1.1 " + code + " " + reason + "\r\n" +
                        "Content-Type: application/json; charset=utf-8\r\n" +
                        "Content-Length: " + (body == null ? 0 : Encoding.UTF8.GetByteCount(body)) + "\r\n" +
                        "Connection: close\r\n\r\n";
                    var hb = Encoding.UTF8.GetBytes(head);
                    s.Write(hb, 0, hb.Length);
                    if (body != null)
                    {
                        var bb = Encoding.UTF8.GetBytes(body);
                        s.Write(bb, 0, bb.Length);
                    }
                    s.Flush();
                }
            }
            catch { }
            finally { try { client.Close(); } catch { } }
        }

        private static string FrameStateJson()
        {
            IntPtr h = FrameHwnd;
            bool max = h != IntPtr.Zero && IsZoomed(h);
            return "{\"ok\":true,\"hwnd\":\"0x" + h.ToInt64().ToString("X") + "\",\"maximized\":" + (max ? "true" : "false") + ",\"active\":true}";
        }

        private static void ServeClient(TcpClient client)
        {
            try
            {
                client.ReceiveTimeout = 3000;
                string path = "/";
                // 不能在这里释放 NetworkStream：释放会关闭连接，响应就发不出去
                var stream = client.GetStream();
                var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                string first = reader.ReadLine();
                if (string.IsNullOrEmpty(first)) { FrameReply(client, 400, "{\"ok\":false}"); return; }
                var parts = first.Split(' ');
                if (parts.Length >= 2) path = parts[1];
                string line;
                while (!string.IsNullOrEmpty(line = reader.ReadLine())) { }
                FrameLog("命令 " + path);
                if (path == "/state") { FrameReply(client, 200, FrameStateJson()); return; }
                IntPtr h = FrameHwnd;
                if (h == IntPtr.Zero) { FrameReply(client, 503, "{\"ok\":false,\"error\":\"没有窗口\"}"); return; }
                switch (path)
                {
                    case "/drag":
                        ReleaseCapture();
                        SendMessage(h, 0x00A1 /* WM_NCLBUTTONDOWN */, (IntPtr)2 /* HTCAPTION */, IntPtr.Zero);
                        FrameReply(client, 204, null);
                        return;
                    case "/min":
                        PostMessage(h, 0x0112 /* WM_SYSCOMMAND */, (IntPtr)0xF020, IntPtr.Zero);
                        FrameReply(client, 204, null);
                        return;
                    case "/max":
                        PostMessage(h, 0x0112, (IntPtr)(IsZoomed(h) ? 0xF120 : 0xF030), IntPtr.Zero);
                        FrameReply(client, 204, null);
                        return;
                    case "/close":
                        PostMessage(h, 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero);
                        FrameReply(client, 204, null);
                        return;
                    default:
                        FrameReply(client, 404, "{\"ok\":false,\"error\":\"unknown\"}");
                        return;
                }
            }
            catch (Exception ex)
            {
                FrameLog("处理请求失败: " + ex.Message);
                try { client.Close(); } catch { }
            }
        }

        private static void KillQojBrowsers()
        {
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
                {
                    foreach (var obj in searcher.Get())
                    {
                        var cmd = obj["CommandLine"] as string;
                        if (cmd == null || cmd.IndexOf("vpb-qoj-", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        try { Process.GetProcessById(Convert.ToInt32(obj["ProcessId"])).Kill(); } catch { }
                    }
                }
            }
            catch { }
        }

        private static void KillServerPort()
        {
            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c netstat -ano -p tcp | findstr LISTENING | findstr :" + Port)
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
                using (var p = Process.Start(psi))
                {
                    var output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    foreach (var line in output.Split('\n'))
                    {
                        var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length == 0) continue;
                        int pid;
                        if (!int.TryParse(parts[parts.Length - 1], out pid)) continue;
                        try { Process.GetProcessById(pid).Kill(); FrameLog("已结束服务进程 " + pid); }
                        catch (Exception ex) { FrameLog("结束服务进程 " + pid + " 失败: " + ex.Message); }
                    }
                }
            }
            catch { }
        }

        private static void CleanupAndExit()
        {
            FrameLog("窗口已关闭：清理服务与后台浏览器");
            try { File.Delete(Path.Combine(Root, "_frame.json")); } catch { }
            KillServerPort();
            KillQojBrowsers();
            try
            {
                foreach (var dir in Directory.GetDirectories(Path.GetTempPath(), "vpb-qoj-*"))
                {
                    try { Directory.Delete(dir, true); } catch { }
                }
            }
            catch { }
            FrameLog("清理完成，退出");
            Environment.Exit(0);
        }

        /// <summary>
        /// -frame：去掉窗口的系统标题栏，并在 127.0.0.1 上提供 /state、/drag、/min、/max、/close。
        /// 窗口被关掉（按钮、Alt+F4、任务栏）后清理服务进程与后台浏览器再退出。
        /// </summary>
        private static void FrameMode(bool selftest)
        {
            FrameLog("selftest: start");
            int fport = 8790;
            int parsed;
            var env = Environment.GetEnvironmentVariable("FRAME_PORT");
            if (!string.IsNullOrEmpty(env) && int.TryParse(env, out parsed)) fport = parsed;

            TcpListener tcp;
            try
            {
                tcp = new TcpListener(IPAddress.Loopback, fport);
                tcp.Start();
            }
            catch (Exception ex)
            {
                FrameLog("监听 127.0.0.1:" + fport + " 失败: " + ex.Message);
                return;
            }
            FrameLog("selftest: server=ok");
            FrameLog("helper 已监听 127.0.0.1:" + fport);
            try { File.WriteAllText(Path.Combine(Root, "_frame.json"), "{\"port\":" + fport + "}", Encoding.UTF8); }
            catch (Exception ex) { FrameLog("写 _frame.json 失败: " + ex.Message); }

            var accept = new Thread(delegate()
            {
                while (true)
                {
                    TcpClient client;
                    try { client = tcp.AcceptTcpClient(); } catch { break; }
                    var t = new Thread(delegate() { ServeClient(client); });
                    t.IsBackground = true;
                    t.Start();
                }
            });
            accept.IsBackground = true;
            accept.Start();

            if (selftest)
            {
                FrameLog("selftest: style=skip（没有窗口）");
                FrameLog("selftest: done");
                try { tcp.Stop(); } catch { }
                try { File.Delete(Path.Combine(Root, "_frame.json")); } catch { }
                return;
            }

            bool saidNoWindow = false;
            int goneTicks = 0;
            while (true)
            {
                var wins = FindAppWindows();
                if (wins.Count == 0)
                {
                    if (FrameHwnd != IntPtr.Zero && !IsWindow(FrameHwnd))
                    {
                        goneTicks++;
                        if (goneTicks >= 3)
                        {
                            FrameHwnd = IntPtr.Zero;
                            CleanupAndExit();
                            return;
                        }
                    }
                    if (FrameHwnd == IntPtr.Zero && !saidNoWindow)
                    {
                        FrameLog("未找到窗口，重试");
                        saidNoWindow = true;
                    }
                    Thread.Sleep(400);
                    continue;
                }
                goneTicks = 0;

                if (saidNoWindow || FrameHwnd == IntPtr.Zero)
                {
                    var names = new StringBuilder();
                    foreach (var w in wins) names.Append(" 0x" + w.ToInt64().ToString("X"));
                    FrameLog("找到 " + wins.Count + " 个候选窗口:" + names);
                    saidNoWindow = false;
                }
                FrameHwnd = wins[0];

                // 每一个可见的应用窗口都要处理：启动过程中可能同时存在加载中的旧窗口
                foreach (var h in wins)
                {
                    long style = GetStyleBits(h).ToInt64();
                    if ((style & VpbWsCaption) != 0)
                    {
                        FrameLog("接管窗口 0x" + h.ToInt64().ToString("X"));
                        StripCaption(h);
                    }
                }
                Thread.Sleep(400);
            }
        }

        private static void Stop()
        {
            Log("停止：关闭窗口并结束服务");
            IntPtr h;
            while ((h = FindAppWindow()) != IntPtr.Zero)
            {
                PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
                Thread.Sleep(600);
            }
            KillStaleBrowsers();
            Thread.Sleep(600);
            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c netstat -ano -p tcp | findstr LISTENING | findstr :" + Port)
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
                using (var p = Process.Start(psi))
                {
                    var output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    foreach (var line in output.Split('\n'))
                    {
                        var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length == 0) continue;
                        int pid;
                        if (!int.TryParse(parts[parts.Length - 1], out pid)) continue;
                        try { Process.GetProcessById(pid).Kill(); } catch { }
                    }
                }
            }
            catch { }
        }
    }
}
