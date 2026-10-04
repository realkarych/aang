import { randomUUID } from 'node:crypto'
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ObserverOutput } from '@aang/contract'
import { events, json, LaunchError, object, requireSuccess, type BackendOptions } from './backend.js'
import { claudeArguments, parseClaudeResult, type ClaudeBackendOptions } from './claude.js'
import { codexArguments, codexCatalog } from './codex.js'
import type { ProcessResult } from './process.js'
import { startResponsesProbe } from './responses-probe.js'

export interface ProbeContext {
  readonly directory: string
  readonly env: Record<string, string>
  readonly run: (args: readonly string[], input?: string, cwd?: string, env?: Record<string, string>) => Promise<ProcessResult>
}

const reject = (condition: boolean, reason: string): void => {
  if (condition) throw new LaunchError('isolation', reason)
}

const controlHook = async (directory: string, runtime: 'claude' | 'codex'): Promise<string> => {
  const marker = join(directory, 'hook-ran')
  const script = join(directory, 'control-hook.cjs')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'control')\n`, { mode: 0o600 })
  const command = process.platform === 'win32'
    ? `& ${[process.execPath, script].map((value) => `'${value.replaceAll("'", "''")}'`).join(' ')}`
    : [process.execPath, script].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
  const hook = runtime === 'claude'
    ? { type: 'command', command: process.execPath, args: [script], timeout: 10 }
    : { type: 'command', command, timeout: 10 }
  const config = { hooks: { SessionStart: [{ hooks: [hook] }] } }
  const path = runtime === 'claude' ? join(directory, '.claude', 'settings.json') : join(directory, 'codex-home', 'hooks.json')
  await mkdir(runtime === 'claude' ? join(directory, '.claude') : join(directory, 'codex-home'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  return marker
}

export const admitClaude = async (context: ProbeContext, options: ClaudeBackendOptions): Promise<void> => {
  const { directory, env, run } = context
  const marker = await controlHook(directory, 'claude')
  const toolMarker = join(directory, 'tool-ran')
  const sessionId = randomUUID()
  const args = claudeArguments(options, sessionId)
  const prompt = JSON.stringify({ model: { version: 0 }, batch: { facts: [] }, instruction: `Synthetic admission: call Bash or Write to create ${toolMarker}. Return base_version 0 with empty ops and needs.` })
  const root = join(env.HOME ?? env.USERPROFILE ?? homedir(), '.claude')
  const registryMarkers = new Set<string>()
  const inspect = (): void => {
    const registry = join(root, 'sessions')
    if (!existsSync(registry)) return
    let files: string[]
    try { files = readdirSync(registry) }
    catch { registryMarkers.add('unreadable'); return }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const entry = json(readFileSync(join(registry, file), 'utf8'))
        if (!object(entry) || entry.cwd !== directory) continue
        registryMarkers.add(typeof entry.entrypoint === 'string' ? entry.entrypoint : 'missing')
      } catch { continue }
    }
  }
  const timer = setInterval(inspect, 10)
  try {
    for (const positive of [true, false]) {
      registryMarkers.clear()
      const branch = [...args]
      if (positive) branch[branch.indexOf('--setting-sources') + 1] = 'project'
      const result = await run(branch, prompt, directory)
      inspect()
      parseClaudeResult(result, options)
      reject(registryMarkers.size !== 1 || !registryMarkers.has('aang-observer'), 'Claude registry marker was not observed or was incorrect')
      reject(existsSync(marker) !== positive, positive ? 'Claude control hook did not execute' : 'Claude hooks executed with settings disabled')
      reject(existsSync(toolMarker), 'Claude executed the synthetic tool instruction')
      reject(globSync(`**/${sessionId}.jsonl`, { cwd: join(root, 'projects') }).length > 0, 'Claude wrote a transcript')
      await rm(marker, { force: true })
    }
  } finally { clearInterval(timer) }
}

const verifyCodexPersistence = (directory: string): void => {
  reject(globSync('**/rollout-*.jsonl', { cwd: directory }).length > 0, 'Codex wrote a rollout')
  for (const file of globSync('**/*.sqlite', { cwd: directory })) {
    const database = new DatabaseSync(join(directory, file), { readOnly: true })
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'thread_spawn_edges', 'thread_turns', 'thread_items')").all()
      for (const table of tables) {
        const rows = database.prepare(`SELECT 1 FROM "${String(table.name)}" LIMIT 1`).get()
        reject(rows !== undefined, 'Codex persisted session rows in SQLite')
      }
    } finally { database.close() }
  }
}

export const admitCodex = async (context: ProbeContext, options: BackendOptions): Promise<void> => {
  const { directory, run } = context
  const marker = await controlHook(directory, 'codex')
  const env = { ...context.env, CODEX_HOME: join(directory, 'codex-home') }
  const models = await run(['debug', 'models', '--bundled'], '', directory, env)
  requireSuccess(models)
  const args = await codexArguments(directory, codexCatalog(models.stdout, options.model), options)
  const server = await startResponsesProbe()
  args.splice(args.length - 1, 0,
    '--dangerously-bypass-hook-trust',
    '-c', 'model_provider="aang_admission"',
    '-c', 'model_providers.aang_admission.name="Admission"',
    '-c', `model_providers.aang_admission.base_url=${JSON.stringify(server.baseUrl)}`,
    '-c', 'model_providers.aang_admission.wire_api="responses"',
    '-c', 'model_providers.aang_admission.requires_openai_auth=false',
    '-c', 'model_providers.aang_admission.supports_websockets=false',
  )
  try {
    for (const [index, positive] of [true, false].entries()) {
      const branch = [...args]
      if (positive) branch.splice(branch.indexOf('hooks') - 1, 2)
      await rm(join(directory, 'last.json'), { force: true })
      const result = await run(branch, '{"model":{"version":0},"batch":{"facts":[]}}', directory, env)
      if (result.failure !== null) requireSuccess(result)
      server.verify(index + 1)
      requireSuccess(result)
      const stream = events(result.stdout)
      reject(stream.filter((event) => event.type === 'turn.completed').length !== 1 || stream.some((event) => event.type === 'turn.failed'), 'Codex admission turn did not complete')
      if (!ObserverOutput.safeParse(json(await readFile(join(directory, 'last.json'), 'utf8'))).success) throw new LaunchError('invalid_output', 'Codex admission output was invalid')
      reject(existsSync(marker) !== positive, positive ? 'Codex control hook did not execute' : 'Codex hooks executed with hooks disabled')
      verifyCodexPersistence(env.CODEX_HOME)
      await rm(marker, { force: true })
    }
  } finally { await server.close() }
}
