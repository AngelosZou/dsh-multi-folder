#requires -Version 5.1
<#
  native-picker.ps1 -- a modern Windows folder chooser for non-GUI processes.

  Why this exists: `System.Windows.Forms.FolderBrowserDialog` is the LEGACY
  tree-view dialog (SHBrowseForFolder) and `System.Windows.Forms.OpenFolderDialog`
  (.NET 8+) is not present in every PowerShell build, so neither can be relied on
  when the goal is the SAME dialog Explorer and other apps show -- the Vista+
  common item dialog (`IFileOpenDialog` with `FOS_PICKFOLDERS`). Shell helpers
  such as Listary hook that dialog, not the legacy tree.

  The dialog runs on a dedicated STA thread (PowerShell 7 starts MTA, where the
  common dialog is not guaranteed to work), gets a bounded foreground assist
  (the caller is usually a background host process, so a fresh window would
  otherwise open behind the user's windows), and can auto-close after a timeout
  so a request can never be blocked forever by an unanswered dialog.

  Output: the selected absolute path on stdout, or NOTHING when the user
  cancelled or the timeout dismissed the dialog; both of those exit 0, so the
  caller can tell them from a helper that never ran. A non-zero exit therefore
  means the helper itself failed (an ExecutionPolicy block, a failed Add-Type)
  and must be reported instead of read as a cancellation.
#>
[CmdletBinding()]
param(
  [string]$InitialDirectory = '',
  [int]$TimeoutMs = 0,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW
    {
    }

    [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr hwndParent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close([MarshalAs(UnmanagedType.Error)] int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    private delegate bool EnumProc(IntPtr hWnd, IntPtr param);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr param);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const uint WM_CLOSE = 0x0010;
    /** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 / _PER_MONITOR_AWARE. */
    private static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    private static readonly IntPtr PER_MONITOR_AWARE = new IntPtr(-3);

    /// The folder dialog is a plain #32770 window created BY THIS PROCESS, so it
    /// is found by pid + class rather than by its title: a title is optional
    /// (Windows then supplies its own localized one), and matching on one could
    /// pick up a window that is not ours.
    private static IntPtr FindOwnDialog()
    {
        uint me = GetCurrentProcessId();
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr param)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != me) return true;
            StringBuilder cls = new StringBuilder(64);
            GetClassName(hWnd, cls, cls.Capacity);
            if (cls.ToString() != "#32770") return true;
            found = hWnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static string Pick(string initial, int timeoutMs)
    {
        string result = null;
        Exception failure = null;
        Thread thread = new Thread(delegate()
        {
            IntPtr previous = IntPtr.Zero;
            try
            {
                // Render at the monitor's REAL DPI. The PowerShell host is
                // DPI-UNAWARE, so an untouched dialog is drawn at 96 DPI and then
                // BITMAP-STRETCHED by Windows to the display scaling (150% on the
                // machine this was written on) — which is exactly the soft, fuzzy
                // text users notice. Thread-level awareness is the fix that always
                // applies: a process manifest may already have fixed the PROCESS
                // context (SetProcessDpiAwarenessContext would then be refused), but
                // a thread context may be set at any time, and the dialog is created
                // on this thread.
                previous = SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
                if (previous == IntPtr.Zero) previous = SetThreadDpiAwarenessContext(PER_MONITOR_AWARE);
            }
            catch
            {
                // A Windows build without the thread-scoped DPI API still shows the
                // dialog, only bitmap-stretched at the process DPI — not worth
                // failing the pick over, and an exception here would have escaped
                // this thread and killed the helper outright.
            }
            try { result = Show(initial, timeoutMs); }
            catch (Exception error) { failure = error; }
            finally
            {
                if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        bool finished = timeoutMs > 0
            ? thread.Join(timeoutMs + 5000)
            : thread.Join(Timeout.Infinite);
        if (failure != null) throw failure;
        return finished ? result : null;
    }

    private static string Show(string initial, int timeoutMs)
    {
        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        if (!String.IsNullOrEmpty(initial))
        {
            try
            {
                Guid iid = typeof(IShellItem).GUID;
                IShellItem folder;
                SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
                dialog.SetFolder(folder);
            }
            catch
            {
                // An unusable start directory is not worth failing the pick over.
            }
        }
        // One watchdog owns both jobs, because they need the same window handle
        // but NOT the same apartment: `IFileDialog::Close` cannot be called on
        // the dialog from another thread (COM refuses the cross-apartment call
        // and the dialog simply stayed on screen until the process died), while
        // the plain Win32 calls below work from any thread. WM_CLOSE is what the
        // dialog's own X button sends, so Show() returns the ordinary cancel
        // HRESULT afterwards.
        // `watchdog` is declared first and assigned second on purpose: a lambda
        // that captures a local must find it definitely assigned when the
        // delegate is created, so the single-statement form does not compile.
        Timer watchdog = null;
        DateTime deadline = timeoutMs > 0 ? DateTime.UtcNow.AddMilliseconds(timeoutMs) : DateTime.MinValue;
        // The foreground assist is BOUNDED: it exists to bring a fresh dialog in
        // front of a user whose host process is in the background, not to fight
        // that user for the foreground for the dialog's whole life. Roughly three
        // seconds of nudges, after which this timer only watches the deadline.
        int assistTicks = 12;
        int windowWaits = 240;
        watchdog = new Timer(delegate(object state)
        {
            IntPtr window = FindOwnDialog();
            if (window == IntPtr.Zero)
            {
                // A dialog that never appears leaves nothing to watch.
                if (--windowWaits <= 0 && watchdog != null) watchdog.Dispose();
                return;
            }
            if (deadline != DateTime.MinValue && DateTime.UtcNow >= deadline)
            {
                PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                if (watchdog != null) watchdog.Dispose();
                return;
            }
            if (assistTicks > 0)
            {
                SetForegroundWindow(window);
                BringWindowToTop(window);
                assistTicks--;
            }
        }, null, 250, 250);
        int hr;
        try { hr = dialog.Show(IntPtr.Zero); }
        finally
        {
            if (watchdog != null) watchdog.Dispose();
        }
        if (hr != 0)
        {
            // 0x800704C7 (HRESULT_FROM_WIN32(ERROR_CANCELLED)) is the ordinary
            // dismiss path; every other HRESULT means the dialog could not be
            // shown at all, which the caller needs to hear about.
            if (hr == unchecked((int)0x800704C7)) return null;
            throw new COMException("dsh-native-picker: dialog returned 0x" + hr.ToString("X8"), hr);
        }
        IShellItem item;
        dialog.GetResult(out item);
        string path;
        item.GetDisplayName(SIGDN_FILESYSPATH, out path);
        return path;
    }
}
'@

if ($DryRun) {
  # Compile only: proves the helper builds in this PowerShell without showing UI.
  if (-not ('DshFolderPicker' -as [type])) { Add-Type -TypeDefinition $source -Language CSharp }
  Write-Output 'compiled'
  exit 0
}

if (-not ('DshFolderPicker' -as [type])) { Add-Type -TypeDefinition $source -Language CSharp }
$selected = [DshFolderPicker]::Pick($InitialDirectory, $TimeoutMs)
if ($selected) { Write-Output $selected }
exit 0
