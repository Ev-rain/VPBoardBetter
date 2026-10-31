using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// VP Board Better 的自绘窗口宿主：自己画标题栏，里面装一台 WebView2。
// 页面仍然由本地 server.js 提供，退出时顺手把服务和 QOJ 浏览器一起关掉。
static class Host
{
    const int PORT = 8787;
    const int WM_NCLBUTTONDOWN = 0x00A1;
    const int WM_NCHITTEST = 0x0084;
    const int HTCAPTION = 2;
    const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14,
              HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_MINIMIZEBOX = 0x00020000;
    const int WS_MAXIMIZEBOX = 0x00010000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_CAPTION = 0x00C00000;

    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string LogPath = Path.Combine(Root, "_host.log");
    static readonly string StatePath = Path.Combine(Root, "_window.json");

    static Process _server;
    public static bool Fallback;

    static readonly object LogLock = new object();
    public static void Log(string msg)
    {
        try
        {
            lock (LogLock)
                File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n");
        }
        catch { }
    }

    [STAThread]
    static void Main(string[] args)
    {
        bool stop = Has(args, "-stop");
        bool self = Has(args, "-selftest");
        try { File.Delete(LogPath); } catch { }
        Log("start pid=" + Process.GetCurrentProcess().Id + (self ? " selftest" : ""));

        if (stop) { StopEverything(); return; }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        bool started = false;
        if (!PortOpen()) { _server = StartServer(); started = _server != null; }
        if (!PortOpen())
        {
            Log("服务没有起来");
            if (!Has(args, "-selftest"))
                MessageBox.Show("本地服务没有启动成功（端口 " + PORT + "）。请确认 node 在 PATH 里，或查看 " + LogPath + "。",
                    "VP Board Better", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var f = new Frame();
        f.Load += delegate { f.StartBrowser(self); };
        Application.Run(f);

        Log("window closed");
        if (!Fallback) StopEverything();
    }

    static bool Has(string[] args, string flag)
    {
        foreach (string a in args) if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    // ---------- 服务 ----------

    public static bool PortOpen()
    {
        try
        {
            using (var c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", PORT, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(150)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            string p = Path.Combine(dir.Trim(), "node.exe");
            if (File.Exists(p)) return p;
        }
        foreach (string p in new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe") })
            if (File.Exists(p)) return p;
        return null;
    }

    static Process StartServer()
    {
        string node = FindNode();
        if (node == null) { Log("找不到 node.exe"); return null; }
        try
        {
            var psi = new ProcessStartInfo(node, "server.js");
            psi.WorkingDirectory = Root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process p = Process.Start(psi);
                        Log("已启动 node server.js pid=" + p.Id);
            for (int i = 0; i < 60 && !PortOpen(); i++)
            {
                Thread.Sleep(250);
                if (i % 8 == 7) Log("等待服务… " + ((i + 1) / 4) + "s exited=" + p.HasExited);
            }
            if (p.HasExited) Log("node 已退出 code=" + p.ExitCode);
            return p;
        }
        catch (Exception ex) { Log("启动 node 失败: " + ex.Message); return null; }
    }

    static void StopEverything()
    {
        try
        {
            foreach (int pid in ListenerPids())
            {
                try { Process.GetProcessById(pid).Kill(); Log("已结束服务进程 " + pid); }
                catch (Exception ex) { Log("结束 " + pid + " 失败: " + ex.Message); }
            }
            foreach (Process p in Process.GetProcessesByName("msedge"))
            {
                try
                {
                    string cmd = CmdLineOf(p.Id);
                    if (cmd != null && cmd.IndexOf("vpb-qoj-", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        p.Kill();
                        Log("已结束 QOJ 浏览器 " + p.Id);
                    }
                }
                catch { }
            }
            string temp = Path.GetTempPath();
            foreach (string dir in Directory.GetDirectories(temp, "vpb-qoj-*"))
            {
                try { Directory.Delete(dir, true); } catch { }
            }
        }
        catch (Exception ex) { Log("清理失败: " + ex.Message); }
    }

    public static void LaunchEdgeFallback()
    {
        try
        {
            string edge = null;
            foreach (string root in new string[] {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) })
            {
                string p = Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
                if (File.Exists(p)) { edge = p; break; }
            }
            if (edge == null) { MessageBox.Show("找不到 Edge，也没有可用的 WebView2 运行时。", "VP Board Better"); return; }
            var st = WinState.Load();
            string args = "--app=http://127.0.0.1:" + PORT + "/ --window-size=" + st.w + "," + st.h +
                " --window-position=" + st.x + "," + st.y +
                " --user-data-dir=" + Quote(Path.Combine(Root, ".app-profile")) +
                " --no-first-run --no-default-browser-check --disable-sync";
            var psi = new ProcessStartInfo(edge, args);
            psi.UseShellExecute = false;
            Process.Start(psi);
            Log("已用 Edge --app 打开");
        }
        catch (Exception ex) { Log("Edge fallback 失败: " + ex.Message); }
    }

    static string Quote(string path) { return ((char)34).ToString() + path + ((char)34).ToString(); }

    static List<int> ListenerPids()
    {
        var list = new List<int>();
        try
        {
            int size = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                if (GetExtendedTcpTable(buf, ref size, false, 2, 3, 0) == 0)
                {
                    int count = Marshal.ReadInt32(buf);
                    IntPtr row = (IntPtr)((long)buf + 4);
                    int rowSize = Marshal.SizeOf(typeof(MibTcpRow));
                    for (int i = 0; i < count; i++)
                    {
                        MibTcpRow r = (MibTcpRow)Marshal.PtrToStructure((IntPtr)((long)row + i * rowSize), typeof(MibTcpRow));
                        int port = ((r.localPort & 0xFF) << 8) | ((r.localPort >> 8) & 0xFF);
                        if (port == PORT && r.pid > 0 && !list.Contains(r.pid)) list.Add(r.pid);
                    }
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        catch (Exception ex) { Log("取监听进程失败: " + ex.Message); }
        return list;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MibTcpRow
    {
        public int state, localAddr, localPort, remoteAddr, remotePort, pid;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern int GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int tableClass, int reserved);

    static string CmdLineOf(int pid)
    {
        try
        {
            using (var mos = new System.Management.ManagementObjectSearcher(
                "SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
                foreach (System.Management.ManagementObject o in mos.Get())
                    return o["CommandLine"] as string;
        }
        catch { }
        return null;
    }

    // ---------- 窗口状态 ----------

    public class WinState
    {
        public int w = 1280, h = 820, x = 200, y = 120;
        public bool max;

        public static WinState Load()
        {
            var s = new WinState();
            try
            {
                if (!File.Exists(StatePath)) return s;
                string text = File.ReadAllText(StatePath);
                s.w = ReadInt(text, "\"w\"", s.w);
                s.h = ReadInt(text, "\"h\"", s.h);
                s.x = ReadInt(text, "\"x\"", s.x);
                s.y = ReadInt(text, "\"y\"", s.y);
                s.max = text.IndexOf("\"max\":true", StringComparison.Ordinal) >= 0;
            }
            catch { }
            if (s.w < 900) s.w = 1280;
            if (s.h < 600) s.h = 820;
            if (s.w > 8000) s.w = 8000;
            if (s.h > 5000) s.h = 5000;
            if (Math.Abs(s.x) > 20000) s.x = 200;
            if (Math.Abs(s.y) > 20000) s.y = 120;
            return s;
        }

        static int ReadInt(string text, string key, int fallback)
        {
            int i = text.IndexOf(key, StringComparison.Ordinal);
            if (i < 0) return fallback;
            i = text.IndexOf(':', i);
            if (i < 0) return fallback;
            int j = i + 1;
            while (j < text.Length && (text[j] == ' ' || text[j] == '\t')) j++;
            int start = j;
            if (j < text.Length && text[j] == '-') j++;
            while (j < text.Length && char.IsDigit(text[j])) j++;
            int v;
            if (j > start && int.TryParse(text.Substring(start, j - start), out v)) return v;
            return fallback;
        }

        public void Save()
        {
            try
            {
                string json = "{\"w\":" + w + ",\"h\":" + h + ",\"x\":" + x + ",\"y\":" + y +
                              ",\"max\":" + (max ? "true" : "false") + ",\"ts\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}";
                File.WriteAllText(StatePath, json);
            }
            catch { }
        }
    }

    // ---------- 窗口 ----------

    public class Frame : Form
    {
        Panel _bar, _body;
        Label _title;
        Button _min, _max, _close;
        WebView2 _view;
        System.Windows.Forms.Timer _saveTimer;
        WinState _state;
        bool _browserReady;
        bool _closing;
        bool _selfTest;
        bool _testFailed;
        int _resizeBorder = 6;

        public Frame()
        {
            _state = WinState.Load();

            Text = "VP Board Better";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(16, 18, 22);
            MinimumSize = new Size(900, 600);
            Size = new Size(_state.w, _state.h);
            Location = new Point(_state.x, _state.y);
            KeyPreview = false;

            _bar = new Panel();
            _bar.Dock = DockStyle.Top;
            _bar.Height = 36;
            _bar.BackColor = Color.FromArgb(22, 25, 30);
            _bar.Paint += PaintBar;
            _bar.MouseDown += delegate(object s, MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            };
            _bar.MouseDoubleClick += delegate(object s, MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) return;
                ToggleMax();
            };

            _title = new Label();
            _title.AutoSize = false;
            _title.Text = "VP Board Better";
            _title.ForeColor = Color.FromArgb(226, 232, 240);
            _title.BackColor = Color.Transparent;
            _title.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            _title.SetBounds(44, 0, 400, 36);
            _title.TextAlign = ContentAlignment.MiddleLeft;
            _title.MouseDown += delegate(object s, MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            };
            _title.MouseDoubleClick += delegate(object s, MouseEventArgs e) { ToggleMax(); };

            _min = MakeButton("\u2013", delegate { WindowState = FormWindowState.Minimized; });
            _max = MakeButton("\u25A1", delegate { ToggleMax(); });
            _close = MakeButton("\u2715", delegate { Close(); });
            _close.FlatAppearance.MouseOverBackColor = Color.FromArgb(232, 17, 35);
            _close.FlatAppearance.MouseDownBackColor = Color.FromArgb(200, 10, 25);

            _bar.Controls.Add(_title);
            _bar.Controls.Add(_min);
            _bar.Controls.Add(_max);
            _bar.Controls.Add(_close);
            _body = new Panel();
            _body.Dock = DockStyle.Fill;
            _body.BackColor = Color.FromArgb(16, 18, 22);
            Controls.Add(_body);
            Controls.Add(_bar);
            _bar.BringToFront();

            _saveTimer = new System.Windows.Forms.Timer();
            _saveTimer.Interval = 700;
            _saveTimer.Tick += delegate { _saveTimer.Stop(); SaveState(); };

            ResizeEnd += delegate { QueueSave(); };
            Move += delegate { QueueSave(); };
            Resize += delegate { LayoutButtons(); };
            FormClosing += OnClosing;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style |= WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
                cp.Style &= ~WS_CAPTION;
                return cp;
            }
        }

        Button MakeButton(string glyph, EventHandler onClick)
        {
            var b = new Button();
            b.Text = glyph;
            b.Width = 46;
            b.Height = 36;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = Color.Transparent;
            b.ForeColor = Color.FromArgb(200, 208, 220);
            b.TabStop = false;
            b.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            b.Click += onClick;
            return b;
        }

        void LayoutButtons()
        {
            if (_bar == null || _min == null) return;
            int y = Math.Max(0, (_bar.Height - 36) / 2);
            int right = _bar.ClientSize.Width;
            _close.SetBounds(right - 46, y, 46, 36);
            _max.SetBounds(right - 92, y, 46, 36);
            _min.SetBounds(right - 138, y, 46, 36);
        }

        void PaintBar(object s, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Rectangle r = _bar.ClientRectangle;
            using (var brush = new LinearGradientBrush(r, Color.FromArgb(26, 30, 37), Color.FromArgb(20, 23, 28), 0f))
                g.FillRectangle(brush, r);

            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var b = new SolidBrush(Color.FromArgb(255, 201, 60)))
                g.FillEllipse(b, 14, 9, 18, 18);
            using (var pen = new Pen(Color.FromArgb(120, 140, 160), 1f))
                g.DrawLine(pen, 23, 27, 23, 33);
        }

        void QueueSave()
        {
            if (_saveTimer != null) { _saveTimer.Stop(); _saveTimer.Start(); }
        }

        void SaveState()
        {
            if (_closing) return;
            Rectangle b = WindowState == FormWindowState.Maximized ? RestoreBounds : Bounds;
            _state.w = b.Width;
            _state.h = b.Height;
            _state.x = b.X;
            _state.y = b.Y;
            _state.max = WindowState == FormWindowState.Maximized;
            _state.Save();
        }

        void ToggleMax()
        {
            if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
            else
            {
                MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
                WindowState = FormWindowState.Maximized;
            }
        }

        public void StartBrowser(bool selfTest)
        {
            _selfTest = selfTest;
            LayoutButtons();
            _view = new WebView2();
            _view.Dock = DockStyle.Fill;
            _view.DefaultBackgroundColor = Color.FromArgb(16, 18, 22);
            string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VPBoardBetter", "wv2");
            try { Directory.CreateDirectory(data); } catch { }
            _view.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = data };
            _body.Controls.Add(_view);

            _view.CoreWebView2InitializationCompleted += OnBrowserInit;

            if (selfTest)
            {
                var t = new System.Windows.Forms.Timer();
                t.Interval = 15000;
                t.Tick += delegate
                {
                    t.Stop();
                    Host.Log("selftest timeout browserReady=" + _browserReady);
                    _testFailed = !_browserReady;
                    Close();
                };
                t.Start();
            }
        }

        void OnBrowserInit(object s, CoreWebView2InitializationCompletedEventArgs e)
        {
            Host.Log("browser init ok=" + e.IsSuccess + (e.InitializationException == null ? "" : " err=" + e.InitializationException.Message));
            if (!e.IsSuccess)
            {
                if (_selfTest) { _testFailed = true; Close(); return; }
                Host.Log("WebView2 不可用，改用 Edge 窗口打开");
                Host.Fallback = true;
                Host.LaunchEdgeFallback();
                Close();
                return;
            }
            _browserReady = true;
            try
            {
                _view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _view.CoreWebView2.NavigationCompleted += delegate(object s2, CoreWebView2NavigationCompletedEventArgs e2)
                {
                    Host.Log("nav ok=" + e2.IsSuccess + " url=" + _view.Source);
                    if (_selfTest) { _testFailed = false; var t = new System.Windows.Forms.Timer(); t.Interval = 1200; t.Tick += delegate { t.Stop(); Close(); }; t.Start(); }
                };
                _view.CoreWebView2.Navigate("http://127.0.0.1:" + PORT + "/");
            }
            catch (Exception ex) { Host.Log("navigate err " + ex.Message); }
        }

        void OnClosing(object s, FormClosingEventArgs e)
        {
            if (_closing) return;
            _closing = true;
            SaveState();
            Host.Log("closing, saving state");
            try { if (_view != null) { _body.Controls.Remove(_view); _view.Dispose(); } } catch { }
            if (_selfTest) Environment.ExitCode = _testFailed ? 1 : 0;
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
            {
                base.WndProc(ref m);
                if ((int)m.Result == 1)
                {
                    Point p = PointToClient(Cursor.Position);
                    int c = _resizeBorder;
                    bool left = p.X <= c, right = p.X >= ClientSize.Width - c;
                    bool top = p.Y <= c, bottom = p.Y >= ClientSize.Height - c;
                    if (left && top) { m.Result = (IntPtr)HTTOPLEFT; return; }
                    if (right && top) { m.Result = (IntPtr)HTTOPRIGHT; return; }
                    if (left && bottom) { m.Result = (IntPtr)HTBOTTOMLEFT; return; }
                    if (right && bottom) { m.Result = (IntPtr)HTBOTTOMRIGHT; return; }
                    if (left) { m.Result = (IntPtr)HTLEFT; return; }
                    if (right) { m.Result = (IntPtr)HTRIGHT; return; }
                    if (top) { m.Result = (IntPtr)HTTOP; return; }
                    if (bottom) { m.Result = (IntPtr)HTBOTTOM; return; }
                }
                return;
            }
            base.WndProc(ref m);
        }
    }

    [DllImport("user32.dll")]
    static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}
