import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Runtime } from '@aang/contract'
import { admitClaude, admitCodex, type ProbeContext } from './admission-probes.js'
import { authenticate, LaunchError, requireSuccess, stoppedAll, type AuthResult, type BackendOptions, type LaunchErrorClass, type LaunchFailure, type ObserverOutcome, type ObserverRequest, type ObserverResult } from './backend.js'
import { createClaudeLauncher, type ClaudeBackendOptions, type ClaudeBuiltins } from './claude.js'
import { createCodexLauncher } from './codex.js'
import { cleanEnvironment, prepareWorkspace, resolveCli } from './environment.js'
import { createProcessRunner, type LaunchStatus, type ProcessResult } from './process.js'
import { watchProcessGroup, type ProcessGroupWatch } from './process-group.js'

export interface AdmissionOptions {
  readonly admissionStatusPath?: string
  readonly verifiedClaudeVersions?: readonly string[]
}

export interface AdmissionStatus {
  readonly runtime: Runtime
  readonly version: string | null
  readonly profile: string
  readonly platform: NodeJS.Platform
  readonly admitted: boolean
  readonly checkedAt: string | null
  readonly reason: string | null
  readonly warning: string | null
  readonly isolationViolated: boolean
  readonly builtinPlugins: readonly string[]
}

export interface AdmissionRequest {
  readonly manual?: boolean
}

const violatedVersion = (path: string, profile: string): string | null => {
  try {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof stored !== 'object' || stored === null || !('isolationViolated' in stored) || stored.isolationViolated !== true) return null
    if (!('profile' in stored) || stored.profile !== profile || !('version' in stored) || typeof stored.version !== 'string') return null
    return stored.version
  } catch { return null }
}

const admittedBuiltins = (configured: ClaudeBuiltins | undefined, plugins: readonly string[]): ClaudeBuiltins => ({
  mcpServers: configured?.mcpServers ?? [],
  skills: configured?.skills ?? [],
  plugins: [...new Set([...(configured?.plugins ?? []), ...plugins])],
})

const violation = (version: string): string => `Isolation was violated on CLI ${version}; a new CLI version or a manual admission is required`

const createAdmittedBackend = (runtime: Runtime, source: ClaudeBackendOptions & AdmissionOptions) => {
  const options = {
    ...source,
    environment: { ...(source.environment ?? process.env) },
    cli: typeof source.cli === 'string' ? source.cli : { command: source.cli.command, args: [...(source.cli.args ?? [])] },
    ...(source.builtins === undefined ? {} : { builtins: structuredClone(source.builtins) }),
  }
  const profile = createHash('sha256').update(JSON.stringify({ revision: 2, runtime, cli: options.cli, model: options.model, effort: options.effort, builtins: options.builtins })).digest('hex')
  const verified = [...(source.verifiedClaudeVersions ?? [])]
  const statusPath = source.admissionStatusPath ?? join(options.environment.HOME ?? options.environment.USERPROFILE ?? homedir(), '.aang', 'support', `${runtime}-observer.json`)
  const runner = createProcessRunner(options)
  const makeLauncher = (version?: string, plugins: readonly string[] = []) => runtime === 'claude' ? createClaudeLauncher({ ...options, builtins: admittedBuiltins(options.builtins, plugins) }, version) : createCodexLauncher(options, version)
  let launcher = makeLauncher()
  const violated = violatedVersion(statusPath, profile)
  let record: AdmissionStatus = { runtime, version: violated, profile, platform: process.platform, admitted: false, checkedAt: null, reason: violated === null ? 'version_not_admitted' : violation(violated), warning: null, isolationViolated: violated !== null, builtinPlugins: [] }
  let errorClass: LaunchErrorClass = violated === null ? 'version_not_admitted' : 'isolation'
  let admitting = false
  let executing = 0
  const listeners = new Set<(snapshot: LaunchStatus) => void>()
  const status = (): LaunchStatus => {
    const launch = launcher.status()
    const probe = runner.status()
    const reason = errorClass === 'isolation' || errorClass === 'cli_missing' || errorClass === 'unsafe_workdir' || errorClass === 'launcher_unavailable' || errorClass === 'version_not_admitted' ? errorClass : 'admission_failed'
    const state: LaunchStatus['state'] = !record.admitted ? { state: 'disabled' as const, reason } : launch.state
    return {
      activeCalls: launch.activeCalls + probe.activeCalls,
      state: probe.state.state === 'unavailable' ? probe.state : launch.state.state === 'unavailable' ? launch.state : state,
    }
  }
  const notify = (): void => { for (const listener of listeners) listener(status()) }
  runner.subscribe(notify)
  let unsubscribe = launcher.subscribe(notify)
  const save = async (): Promise<void> => {
    await mkdir(dirname(statusPath), { recursive: true, mode: 0o700 })
    const staged = `${statusPath}.${randomUUID()}.tmp`
    try {
      await writeFile(staged, JSON.stringify(record), { mode: 0o600 })
      await rename(staged, statusPath)
    } finally { await rm(staged, { force: true }) }
  }
  const context = (signal?: AbortSignal, watchGroups = false) => {
    let cwd: string
    try { cwd = prepareWorkspace(options.temporaryDirectory) }
    catch (error) { throw new LaunchError('unsafe_workdir', String(error)) }
    let cli
    try { cli = resolveCli(runtime, options.cli, options.environment) }
    catch (error) { throw new LaunchError('cli_missing', String(error)) }
    const env = cleanEnvironment(runtime, options.environment)
    const stopped: Promise<void>[] = []
    const run: ProbeContext['run'] = async (args, input = '', directory = cwd, environment = env) => {
      const groups: ProcessGroupWatch[] = []
      const result = await runner.run({
        command: cli.command, args: [...(cli.args ?? []), ...args], input, cwd: directory, env: environment, timeoutMs: options.timeoutMs ?? (runtime === 'claude' ? 90_000 : 150_000),
        ...(signal === undefined ? {} : { signal }),
        ...(watchGroups ? { onProcessGroup: (pgid: number) => { groups.push(watchProcessGroup(pgid)) } } : {}),
      })
      stopped.push(result.stopped)
      let departed: string[]
      try { departed = (await Promise.all(groups.map((group) => group.finish()))).flat() }
      catch (error) { throw new LaunchError('isolation', `CLI process group could not be checked: ${String(error)}`) }
      if (departed.length > 0) throw new LaunchError('isolation', `CLI descendant left its process group: ${departed.join(', ')}`)
      return result
    }
    return { cwd, env, run, stopped }
  }
  const versionOf = (result: ProcessResult): string => {
    requireSuccess(result)
    const match = runtime === 'claude' ? /^(\S+) \(Claude Code\)$/.exec(result.stdout.trim()) : /^codex-cli (\S+)$/.exec(result.stdout.trim())
    if (match?.[1] === undefined) throw new LaunchError('version_not_admitted', 'CLI did not report a recognizable version')
    return match[1]
  }
  const fail = (error: unknown): ObserverOutcome => {
    const problem = error instanceof LaunchError ? error : new LaunchError('invalid_output', String(error))
    record = { ...record, admitted: false, reason: problem.message, warning: null, isolationViolated: record.isolationViolated || problem.kind === 'isolation' }
    errorClass = problem.kind
    notify()
    return { ok: false, error: { class: problem.kind, message: problem.message }, usage: problem.usage }
  }
  const admit = async (signal?: AbortSignal, { manual = false }: AdmissionRequest = {}): Promise<AdmissionStatus> => {
    const busy = admitting || executing > 0
    if (busy || status().state.state === 'unavailable') return { ...record, admitted: false, reason: busy ? 'admission_busy' : 'process_stuck' }
    admitting = true
    record = { ...record, admitted: false, reason: 'admission_pending', checkedAt: new Date().toISOString(), warning: null, builtinPlugins: [] }
    errorClass = 'version_not_admitted'
    notify()
    let probe: ReturnType<typeof context> | undefined
    let directory: string | undefined
    try {
      await save()
      probe = context(signal, true)
      const version = versionOf(await probe.run(['--version']))
      if (version !== record.version) record = { ...record, version, isolationViolated: false }
      else if (record.isolationViolated && !manual) throw new LaunchError('isolation', violation(version))
      directory = await realpath(await mkdtemp(join(dirname(probe.cwd), 'admission-')))
      const invocation = { directory, env: probe.env, run: probe.run }
      let plugins: readonly string[] = []
      if (runtime === 'claude') {
        await authenticate('claude', probe.run)
        plugins = await admitClaude(invocation, options)
      } else await admitCodex(invocation, options)
      if (versionOf(await probe.run(['--version'])) !== version) throw new LaunchError('version_not_admitted', 'CLI version changed during admission')
      record = { ...record, admitted: true, reason: null, warning: runtime === 'claude' && !verified.includes(version) ? 'изоляция от сообщений других сессий на этой версии не проверена' : null, isolationViolated: false, builtinPlugins: plugins }
      await save()
      unsubscribe()
      launcher = makeLauncher(version, plugins)
      unsubscribe = launcher.subscribe(notify)
    } catch (error) {
      fail(error)
      try { await save() } catch (failure) { fail(failure) }
    } finally {
      if (directory !== undefined) {
        const path = directory
        const cleanup = Promise.all(probe?.stopped ?? []).then(() => rm(path, { recursive: true, force: true, maxRetries: 5 }))
        if (status().state.state === 'unavailable') void cleanup.catch(() => undefined)
        else await cleanup
      }
      admitting = false
      notify()
    }
    return { ...record }
  }
  const refusal = (): LaunchFailure | null => {
    if (admitting) return { class: 'admission_busy', message: 'Backend is checking admission' }
    if (!record.admitted) return { class: errorClass, message: record.reason ?? 'version_not_admitted' }
    if (status().state.state === 'unavailable') return { class: 'process_stuck', message: 'Backend process tree has not stopped' }
    return null
  }
  const attempt = async (request: ObserverRequest, stopped: Promise<void>[]): Promise<ObserverOutcome> => {
    const refused = refusal()
    if (refused !== null) return { ok: false, error: refused, usage: null }
    executing += 1
    let probe: ReturnType<typeof context> | undefined
    try {
      probe = context(request.signal)
      const version = versionOf(await probe.run(['--version']))
      if (record.version !== version) {
        record = { ...record, version, isolationViolated: false }
        throw new LaunchError('version_not_admitted', 'CLI version changed; synthetic admission is required')
      }
      const result = await launcher.execute(request)
      stopped.push(result.stopped)
      if (!result.ok && record.version === version && (launcher.status().state.state === 'disabled' || result.error.class === 'version_not_admitted')) {
        fail(new LaunchError(result.error.class, result.error.message, result.usage))
        await save()
      }
      return result
    } catch (error) {
      const result = fail(error)
      try { await save() } catch (failure) { return fail(failure) }
      return result
    } finally {
      stopped.push(...(probe?.stopped ?? []))
      executing -= 1
    }
  }
  const execute = async (request: ObserverRequest): Promise<ObserverResult> => {
    const stopped: Promise<void>[] = []
    return { ...(await attempt(request, stopped)), stopped: stoppedAll(stopped) }
  }
  const cliVersion = async (signal?: AbortSignal): Promise<string | null> => {
    try { return versionOf(await context(signal).run(['--version'])) }
    catch { return null }
  }
  const authStatus = async (signal?: AbortSignal): Promise<AuthResult> => {
    const refused = refusal()
    if (refused !== null) return { ok: false, error: refused, stopped: Promise.resolve() }
    executing += 1
    try { return await launcher.authStatus(signal) }
    finally { executing -= 1 }
  }
  return {
    admit, execute, authStatus, status, cliVersion,
    admission: (): AdmissionStatus => ({ ...record }),
    subscribe: (listener: (snapshot: LaunchStatus) => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export const createClaudeBackend = (options: ClaudeBackendOptions & AdmissionOptions) => createAdmittedBackend('claude', options)
export const createCodexBackend = (options: BackendOptions & AdmissionOptions) => createAdmittedBackend('codex', options)
