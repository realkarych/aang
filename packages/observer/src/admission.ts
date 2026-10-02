import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Runtime } from '@aang/contract'
import { admitClaude, admitCodex, type ProbeContext } from './admission-probes.js'
import { LaunchError, requireSuccess, type BackendOptions, type LaunchErrorClass, type ObserverRequest, type ObserverResult } from './backend.js'
import { createClaudeLauncher, type ClaudeBackendOptions } from './claude.js'
import { createCodexLauncher } from './codex.js'
import { cleanEnvironment, prepareWorkspace, resolveCli } from './environment.js'
import { createProcessRunner, type LaunchStatus, type ProcessResult } from './process.js'

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
}

const createAdmittedBackend = (runtime: Runtime, source: ClaudeBackendOptions & AdmissionOptions) => {
  const options = {
    ...source,
    environment: { ...(source.environment ?? process.env) },
    cli: typeof source.cli === 'string' ? source.cli : { command: source.cli.command, args: [...(source.cli.args ?? [])] },
    ...(source.builtins === undefined ? {} : { builtins: structuredClone(source.builtins) }),
  }
  const profile = createHash('sha256').update(JSON.stringify({ revision: 1, runtime, cli: options.cli, model: options.model, effort: options.effort, builtins: options.builtins })).digest('hex')
  const verified = [...(source.verifiedClaudeVersions ?? [])]
  const statusPath = source.admissionStatusPath ?? join(options.environment.HOME ?? options.environment.USERPROFILE ?? homedir(), '.aang', 'support', `${runtime}-observer.json`)
  const runner = createProcessRunner(options)
  const makeLauncher = (version?: string) => runtime === 'claude' ? createClaudeLauncher(options, version) : createCodexLauncher(options, version)
  let launcher = makeLauncher()
  let record: AdmissionStatus = { runtime, version: null, profile, platform: process.platform, admitted: false, checkedAt: null, reason: 'version_not_admitted', warning: null }
  let errorClass: LaunchErrorClass = 'version_not_admitted'
  let busy = false
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
  const context = (signal?: AbortSignal) => {
    let cwd: string
    try { cwd = prepareWorkspace(options.temporaryDirectory) }
    catch (error) { throw new LaunchError('unsafe_workdir', String(error)) }
    let cli
    try { cli = resolveCli(runtime, options.cli, options.environment) }
    catch (error) { throw new LaunchError('cli_missing', String(error)) }
    const env = cleanEnvironment(runtime, options.environment)
    const stopped: Promise<void>[] = []
    const run: ProbeContext['run'] = async (args, input = '', directory = cwd, environment = env) => {
      const result = await runner.run({ command: cli.command, args: [...(cli.args ?? []), ...args], input, cwd: directory, env: environment, timeoutMs: options.timeoutMs ?? (runtime === 'claude' ? 90_000 : 150_000), ...(signal === undefined ? {} : { signal }) })
      stopped.push(result.stopped)
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
  const fail = (error: unknown): ObserverResult => {
    const problem = error instanceof LaunchError ? error : new LaunchError('invalid_output', String(error))
    record = { ...record, admitted: false, reason: problem.message, warning: null }
    errorClass = problem.kind
    notify()
    return { ok: false, error: { class: problem.kind, message: problem.message }, usage: problem.usage }
  }
  const admit = async (signal?: AbortSignal): Promise<AdmissionStatus> => {
    if (busy || status().state.state === 'unavailable') return { ...record, admitted: false, reason: busy ? 'admission_busy' : 'process_stuck' }
    busy = true
    record = { ...record, admitted: false, reason: 'admission_pending', checkedAt: new Date().toISOString(), warning: null }
    errorClass = 'version_not_admitted'
    notify()
    let probe: ReturnType<typeof context> | undefined
    let directory: string | undefined
    try {
      await save()
      probe = context(signal)
      const version = versionOf(await probe.run(['--version']))
      record = { ...record, version }
      directory = await realpath(await mkdtemp(join(dirname(probe.cwd), 'admission-')))
      const invocation = { directory, env: probe.env, run: probe.run }
      if (runtime === 'claude') {
        const auth = await probe.run(['auth', 'status'])
        if (auth.failure !== null) requireSuccess(auth)
        if (auth.exitCode !== 0) throw new LaunchError('auth', 'Claude is not logged in')
        const authStatus: unknown = JSON.parse(auth.stdout)
        if (typeof authStatus !== 'object' || authStatus === null || !('loggedIn' in authStatus) || authStatus.loggedIn !== true) throw new LaunchError('auth', 'Claude is not logged in')
        await admitClaude(invocation, options)
      } else await admitCodex(invocation, options)
      if (versionOf(await probe.run(['--version'])) !== version) throw new LaunchError('version_not_admitted', 'CLI version changed during admission')
      record = { ...record, admitted: true, reason: null, warning: runtime === 'claude' && !verified.includes(version) ? 'изоляция от сообщений других сессий на этой версии не проверена' : null }
      await save()
      unsubscribe()
      launcher = makeLauncher(version)
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
      busy = false
      notify()
    }
    return { ...record }
  }
  const execute = async (request: ObserverRequest): Promise<ObserverResult> => {
    if (busy) return { ok: false, error: { class: 'admission_busy', message: 'Backend is checking admission or executing a call' }, usage: null }
    if (!record.admitted) return { ok: false, error: { class: errorClass, message: record.reason ?? 'version_not_admitted' }, usage: null }
    if (status().state.state === 'unavailable') return { ok: false, error: { class: 'process_stuck', message: 'Backend process tree has not stopped' }, usage: null }
    busy = true
    try {
      const probe = context(request.signal)
      const version = versionOf(await probe.run(['--version']))
      if (record.version !== version) {
        record = { ...record, version }
        throw new LaunchError('version_not_admitted', 'CLI version changed; synthetic admission is required')
      }
      const result = await launcher.execute(request)
      if (!result.ok && (launcher.status().state.state === 'disabled' || result.error.class === 'version_not_admitted')) {
        fail(new LaunchError(result.error.class, result.error.message, result.usage))
        await save()
      }
      return result
    } catch (error) {
      const result = fail(error)
      try { await save() } catch (failure) { return fail(failure) }
      return result
    } finally { busy = false }
  }
  return {
    admit, execute, status,
    admission: (): AdmissionStatus => ({ ...record }),
    subscribe: (listener: (snapshot: LaunchStatus) => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export const createClaudeBackend = (options: ClaudeBackendOptions & AdmissionOptions) => createAdmittedBackend('claude', options)
export const createCodexBackend = (options: BackendOptions & AdmissionOptions) => createAdmittedBackend('codex', options)
