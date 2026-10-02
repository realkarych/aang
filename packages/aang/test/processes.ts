import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const windowsProcessControl = (pid: number, operation: 'NtSuspendProcess' | 'NtResumeProcess'): string =>
  [
    "$signature = '[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr handle); [DllImport(\"ntdll.dll\")] public static extern int NtResumeProcess(IntPtr handle);'",
    '$ntdll = Add-Type -MemberDefinition $signature -Name Ntdll -Namespace AangTest -PassThru',
    `$process = [System.Diagnostics.Process]::GetProcessById(${String(pid)})`,
    `$status = $ntdll::${operation}($process.Handle)`,
    'if ($status -ne 0) { exit 1 }',
  ].join('; ')

const powershell = async (script: string): Promise<void> => {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export const suspend = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    await powershell(windowsProcessControl(pid, 'NtSuspendProcess'))
  } else {
    process.kill(pid, 'SIGSTOP')
  }
}

export const resume = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    await powershell(windowsProcessControl(pid, 'NtResumeProcess'))
  } else {
    process.kill(pid, 'SIGCONT')
  }
}

export const kill = (pid: number): void => {
  if (isAlive(pid)) {
    process.kill(pid, 'SIGKILL')
  }
}

export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export const waitUntil = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`)
    }
    await sleep(25)
  }
}
