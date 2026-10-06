import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'
import { isJsonObject, parseJson } from './io.js'
import { allValues, lastValue, type ParsedOptions } from './options.js'

export const admissionHookPath = (runtime: 'claude' | 'codex'): string => runtime === 'claude'
  ? join(process.cwd(), '.claude', 'settings.json')
  : join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'hooks.json')

export const runAdmissionHook = async (runtime: 'claude' | 'codex', options: ParsedOptions, fault?: string): Promise<boolean> => {
  const file = admissionHookPath(runtime)
  if (!existsSync(file)) return false
  const enabled = runtime === 'claude' ? lastValue(options, 'setting-sources') !== '' : !allValues(options, 'disable').includes('hooks') && options.flags.has('dangerously-bypass-hook-trust')
  if (fault === 'hook_missing' || (!enabled && fault !== 'hook_leak')) return false
  const config = parseJson(readFileSync(file, 'utf8'))
  const hooks = isJsonObject(config) && isJsonObject(config.hooks) ? config.hooks.SessionStart : undefined
  if (!Array.isArray(hooks)) throw new Error('Invalid SessionStart hook')
  for (const group of hooks) {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) throw new Error('Invalid hook group')
    for (const hook of group.hooks) {
      if (!isJsonObject(hook) || typeof hook.command !== 'string') throw new Error('Invalid hook command')
      const args = Array.isArray(hook.args) ? hook.args.map(String) : []
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const launch = runtime === 'codex' && process.platform === 'win32'
        ? { command: powershell, args: ['-NoProfile', '-Command', hook.command], shell: false }
        : { command: hook.command, args, shell: !Array.isArray(hook.args) }
      const child = spawn(launch.command, launch.args, { shell: launch.shell, detached: runtime === 'codex' && process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.stdin.on('error', () => undefined).end('{}')
      const status = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      if (status !== 0) throw new Error(`Control hook failed: ${stderr}`)
    }
  }
  return true
}

export const claudeAdmissionArtifacts = async (sessionId: string, durationMs: number, fault?: string): Promise<() => void> => {
  const root = join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), '.claude')
  const registry = join(root, 'sessions', `${String(process.pid)}.json`)
  mkdirSync(dirname(registry), { recursive: true })
  if (fault !== 'registry_missing') writeFileSync(registry, JSON.stringify({ cwd: process.cwd(), entrypoint: fault === 'registry_marker' ? 'cli' : process.env.CLAUDE_CODE_ENTRYPOINT }))
  if (fault === 'transcript') {
    const project = join(root, 'projects', 'admission')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, `${sessionId}.jsonl`), '{}\n')
  }
  if (fault === 'tool_execution') writeFileSync(join(process.cwd(), 'tool-ran'), 'executed')
  await setTimeout(durationMs)
  return () => { rmSync(registry, { force: true }) }
}

export const codexAdmissionArtifacts = (fault?: string): void => {
  const root = process.env.CODEX_HOME
  if (root === undefined) return
  if (fault === 'rollout') writeFileSync(join(root, 'rollout-admission.jsonl'), '{}\n')
  if (fault === 'sqlite') {
    const db = new DatabaseSync(join(root, 'state_5.sqlite'))
    try { db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT); INSERT INTO threads VALUES ('admission')") }
    finally { db.close() }
  }
}
