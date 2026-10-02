param(
    [Parameter(Mandatory = $true)][string]$SpecPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public class AangJobProcess
{
    public int Pid { get; set; }
    public string Name { get; set; }
}

public class AangJobResult
{
    public AangJobResult()
    {
        RootExitCode = -1;
        ActiveAfterTerminate = -1;
        StopConfirmedMs = -1;
        TotalProcesses = -1;
        Seen = new List<AangJobProcess>();
        RemainingAfterRootExit = new List<AangJobProcess>();
    }

    public string Error { get; set; }
    public int RootPid { get; set; }
    public long RootExitCode { get; set; }
    public bool RootTimedOut { get; set; }
    public int TotalProcesses { get; set; }
    public List<AangJobProcess> Seen { get; set; }
    public List<AangJobProcess> RemainingAfterRootExit { get; set; }
    public int ActiveAfterTerminate { get; set; }
    public long StopConfirmedMs { get; set; }
    public long DurationMs { get; set; }
}

public static class AangJob
{
    const uint CreateSuspended = 0x00000004;
    const uint CreateUnicodeEnvironment = 0x00000400;
    const int StartfUseStdHandles = 0x00000100;
    const uint HandleFlagInherit = 0x00000001;
    const int BasicAccountingInformation = 1;
    const int BasicAccountingSize = 48;
    const int BasicProcessIdList = 3;
    const int ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x00002000;
    const uint WaitTimeout = 0x00000102;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    static int AccountingField(IntPtr job, int offset)
    {
        IntPtr buffer = Marshal.AllocHGlobal(BasicAccountingSize);
        try
        {
            return QueryInformationJobObject(job, BasicAccountingInformation, buffer, BasicAccountingSize, IntPtr.Zero) ? Marshal.ReadInt32(buffer, offset) : -1;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    static List<int> ProcessIds(IntPtr job)
    {
        int size = 8 + 4096 * IntPtr.Size;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        List<int> ids = new List<int>();
        try
        {
            if (QueryInformationJobObject(job, BasicProcessIdList, buffer, size, IntPtr.Zero))
            {
                int count = Marshal.ReadInt32(buffer, 4);
                for (int index = 0; index < count; index++)
                {
                    ids.Add((int)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64());
                }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return ids;
    }

    static string NameOf(int pid)
    {
        try
        {
            using (Process process = Process.GetProcessById(pid))
            {
                return process.ProcessName;
            }
        }
        catch (Exception)
        {
            return null;
        }
    }

    static void Record(IntPtr job, Dictionary<int, string> seen)
    {
        foreach (int pid in ProcessIds(job))
        {
            if (!seen.ContainsKey(pid) || seen[pid] == null)
            {
                seen[pid] = NameOf(pid);
            }
        }
    }

    static List<AangJobProcess> Describe(IEnumerable<int> pids, Dictionary<int, string> names)
    {
        List<AangJobProcess> described = new List<AangJobProcess>();
        foreach (int pid in pids)
        {
            described.Add(new AangJobProcess { Pid = pid, Name = names.ContainsKey(pid) ? names[pid] : NameOf(pid) });
        }
        return described;
    }

    static IntPtr Inheritable(SafeFileHandle handle)
    {
        IntPtr raw = handle.DangerousGetHandle();
        SetHandleInformation(raw, HandleFlagInherit, HandleFlagInherit);
        return raw;
    }

    static string Failure(string call)
    {
        return call + " failed with " + Marshal.GetLastWin32Error();
    }

    static IntPtr EnvironmentBlock(string[] environment)
    {
        return Marshal.StringToHGlobalUni(string.Join("\0", environment) + "\0\0");
    }

    public static AangJobResult Run(string commandLine, string[] environment, string directory, string stdinPath, string stdoutPath, string stderrPath, int timeoutMs)
    {
        AangJobResult result = new AangJobResult();
        Stopwatch clock = Stopwatch.StartNew();
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            result.Error = Failure("CreateJobObject");
            return result;
        }
        ExtendedLimit limits = new ExtendedLimit();
        limits.Basic.LimitFlags = KillOnJobClose;
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimit))))
        {
            result.Error = Failure("SetInformationJobObject");
            CloseHandle(job);
            return result;
        }
        using (FileStream stdin = File.Open(stdinPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (FileStream stdout = File.Open(stdoutPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
        using (FileStream stderr = File.Open(stderrPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
        {
            StartupInfo startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            startup.dwFlags = StartfUseStdHandles;
            startup.hStdInput = Inheritable(stdin.SafeFileHandle);
            startup.hStdOutput = Inheritable(stdout.SafeFileHandle);
            startup.hStdError = Inheritable(stderr.SafeFileHandle);
            ProcessInformation information;
            IntPtr block = EnvironmentBlock(environment);
            bool created = CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | CreateUnicodeEnvironment, block, directory, ref startup, out information);
            string creationError = created ? null : Failure("CreateProcess");
            Marshal.FreeHGlobal(block);
            if (!created)
            {
                result.Error = creationError;
                CloseHandle(job);
                return result;
            }
            result.RootPid = information.dwProcessId;
            if (!AssignProcessToJobObject(job, information.hProcess))
            {
                result.Error = Failure("AssignProcessToJobObject");
                TerminateProcess(information.hProcess, 1);
                CloseHandle(information.hThread);
                CloseHandle(information.hProcess);
                CloseHandle(job);
                return result;
            }
            ResumeThread(information.hThread);
            CloseHandle(information.hThread);
            Dictionary<int, string> seen = new Dictionary<int, string>();
            long deadline = clock.ElapsedMilliseconds + timeoutMs;
            while (WaitForSingleObject(information.hProcess, 20) == WaitTimeout)
            {
                Record(job, seen);
                if (clock.ElapsedMilliseconds > deadline)
                {
                    result.RootTimedOut = true;
                    break;
                }
            }
            uint code;
            if (!result.RootTimedOut && GetExitCodeProcess(information.hProcess, out code))
            {
                result.RootExitCode = code;
            }
            CloseHandle(information.hProcess);
            List<int> remaining = ProcessIds(job);
            Record(job, seen);
            result.RemainingAfterRootExit = Describe(remaining, seen);
            result.Seen = Describe(seen.Keys, seen);
            Stopwatch stopping = Stopwatch.StartNew();
            TerminateJobObject(job, 1);
            while (AccountingField(job, 40) > 0 && stopping.ElapsedMilliseconds < 10000)
            {
                Thread.Sleep(10);
            }
            result.ActiveAfterTerminate = AccountingField(job, 40);
            if (result.ActiveAfterTerminate == 0)
            {
                result.StopConfirmedMs = stopping.ElapsedMilliseconds;
            }
            result.TotalProcesses = AccountingField(job, 36);
        }
        CloseHandle(job);
        result.DurationMs = clock.ElapsedMilliseconds;
        return result;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$traceName = 'aangProcessTrace'
$traceError = $null
try {
    Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $traceName -ErrorAction Stop
} catch {
    $traceError = $_.Exception.Message
}

$job = [AangJob]::Run($spec.commandLine, [string[]]$spec.environment, $spec.cwd, $spec.stdin, $spec.stdout, $spec.stderr, [int]$spec.timeoutMs)

function Describe-TraceEvents($events, $alive) {
    @($events | ForEach-Object {
        $start = $_.SourceEventArgs.NewEvent
        $ppid = [int]$start.ParentProcessID
        [pscustomobject]@{ pid = [int]$start.ProcessID; ppid = $ppid; name = [string]$start.ProcessName; parentName = $alive[$ppid]; createdAt = [string]$start.TIME_CREATED; receivedAt = [string]$_.TimeGenerated.ToFileTimeUtc() }
    })
}

$started = @()
$traceSnapshots = @()
if ($null -eq $traceError) {
    $traceClock = [System.Diagnostics.Stopwatch]::StartNew()
    $earlyEvents = @(Get-Event -SourceIdentifier $traceName -ErrorAction SilentlyContinue)
    $earlyAfterRunMs = $traceClock.ElapsedMilliseconds
    Start-Sleep -Milliseconds 1500
    $alive = @{}
    Get-CimInstance Win32_Process | ForEach-Object { $alive[[int]$_.ProcessId] = [string]$_.Name }
    $standardEvents = @(Get-Event -SourceIdentifier $traceName -ErrorAction SilentlyContinue)
    $standardAfterRunMs = $traceClock.ElapsedMilliseconds
    $started = @(Describe-TraceEvents $standardEvents $alive)
    $remainingDelay = [Math]::Max(0, 10000 - $traceClock.ElapsedMilliseconds)
    if ($remainingDelay -gt 0) { Start-Sleep -Milliseconds $remainingDelay }
    $lateEvents = @(Get-Event -SourceIdentifier $traceName -ErrorAction SilentlyContinue)
    $lateAfterRunMs = $traceClock.ElapsedMilliseconds
    $traceSnapshots = @(
        [pscustomobject]@{ afterRunMs = $earlyAfterRunMs; started = @(Describe-TraceEvents $earlyEvents $alive) }
        [pscustomobject]@{ afterRunMs = $standardAfterRunMs; started = $started }
        [pscustomobject]@{ afterRunMs = $lateAfterRunMs; started = @(Describe-TraceEvents $lateEvents $alive) }
    )
    Unregister-Event -SourceIdentifier $traceName -ErrorAction SilentlyContinue
}

$result = [pscustomobject]@{ harnessPid = $PID; job = $job; started = $started; traceError = $traceError; traceSnapshots = $traceSnapshots }
$json = ConvertTo-Json -InputObject $result -Depth 6
[System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding $false))
