import { spawnSync } from 'node:child_process'
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

export const runAdmissionHook = (runtime: 'claude' | 'codex', options: ParsedOptions, fault?: string): void => {
  const file = admissionHookPath(runtime)
  if (!existsSync(file)) return
  const enabled = runtime === 'claude' ? lastValue(options, 'setting-sources') !== '' : !allValues(options, 'disable').includes('hooks') && options.flags.has('dangerously-bypass-hook-trust')
  if (fault === 'hook_missing' || (!enabled && fault !== 'hook_leak')) return
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
      const result = spawnSync(launch.command, launch.args, { shell: launch.shell, windowsHide: true, input: '{}', encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`Control hook failed: ${result.stderr}`)
    }
  }
}

export const claudeAdmissionArtifacts = async (sessionId: string, fault?: string): Promise<() => void> => {
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
  await setTimeout(100)
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
