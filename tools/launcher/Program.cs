using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
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
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                var sb = new StringBuilder(512);
                GetWindowText(h, sb, 512);
                if (sb.ToString().IndexOf(TitlePart, StringComparison.OrdinalIgnoreCase) < 0) return true;
                var cls = new StringBuilder(64);
                GetClassName(h, cls, 64);
                if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid == 0) return true;
                try { if (Process.GetProcessById((int)pid).ProcessName != "msedge") return true; } catch { return true; }
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        private static void Focus(IntPtr h)
        {
            ShowWindow(h, SwRestore);
            SetForegroundWindow(h);
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
