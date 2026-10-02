import type { Listener } from '@aang/contract'

const wildcardHosts: Readonly<Record<string, string>> = { '0.0.0.0': '127.0.0.1', '::': '::1' }

export const daemonUrl = ({ host, port }: Listener): string => {
  const reachable = wildcardHosts[host] ?? host
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${String(port)}`
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}
