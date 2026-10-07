import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ChatOutput, chatOutputJsonSchema, ObserverOutput, observerOutputJsonSchema, type CallUsage, type JsonValue, type LlmJsonSchema, type ObserverDisabledReason, type ObserverErrorClass, type ObserverState, type Runtime } from '@aang/contract'
import type { z } from 'zod'
import { cleanEnvironment, prepareWorkspace, resolveCli, type InheritedEnvironment } from './environment.js'
import { createProcessRunner, type CliCommand, type LaunchStatus, type ProcessRequest, type ProcessResult, type ProcessRunnerOptions } from './process.js'
import { chatSystemPrompt, observerSystemPrompt } from './prompt.js'

export interface BackendOptions extends ProcessRunnerOptions {
  readonly cli: string | CliCommand
  readonly model: string
  readonly effort?: string
  readonly environment?: InheritedEnvironment
  readonly timeoutMs?: number
}

export interface ObserverRequest {
  readonly input: JsonValue
  readonly signal?: AbortSignal
}

export type LaunchErrorClass = ObserverErrorClass | 'cancelled' | 'unsafe_workdir' | 'launcher_unavailable' | 'version_not_admitted' | 'admission_busy'

export interface LaunchFailure {
  readonly class: LaunchErrorClass
  readonly message: string
  readonly resetsAt?: number
}

export interface CallProtocol<T> {
  readonly name: string
  readonly systemPrompt: string
  readonly schema: LlmJsonSchema
  readonly output: z.ZodType<T>
}

export const observerProtocol: CallProtocol<ObserverOutput> = {
  name: 'Observer',
  systemPrompt: observerSystemPrompt,
  schema: observerOutputJsonSchema(),
  output: ObserverOutput,
}

export const chatProtocol: CallProtocol<ChatOutput> = {
  name: 'Chat',
  systemPrompt: chatSystemPrompt,
  schema: chatOutputJsonSchema(),
  output: ChatOutput,
}

export type CallOutcome<T> =
  | { readonly ok: true; readonly output: T; readonly usage: CallUsage }
  | { readonly ok: false; readonly error: LaunchFailure; readonly usage: CallUsage | null }

export type CallResult<T> = CallOutcome<T> & { readonly stopped: Promise<void> }

export type ObserverOutcome = CallOutcome<ObserverOutput>

export type ObserverResult = CallResult<ObserverOutput>

export type ChatResult = CallResult<ChatOutput>

export type AuthOutcome = { readonly ok: true } | { readonly ok: false; readonly error: LaunchFailure }

export type AuthResult = AuthOutcome & { readonly stopped: Promise<void> }

export const stoppedAll = (stopped: readonly Promise<void>[]): Promise<void> => Promise.all(stopped).then(() => undefined)

export class LaunchError extends Error {
  constructor(readonly kind: LaunchErrorClass, message: string, readonly usage: CallUsage | null = null, readonly resetsAt: number | null = null) {
    super(message)
    this.name = 'LaunchError'
  }

  get failure(): LaunchFailure {
    return { class: this.kind, message: this.message, ...(this.resetsAt === null ? {} : { resetsAt: this.resetsAt }) }
  }
}

export type JsonObject = { readonly [key: string]: JsonValue }
export const object = (value: JsonValue | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
export const json = (text: string): JsonValue => JSON.parse(text) as JsonValue
export const events = (text: string): JsonObject[] => text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
  const value = json(line)
  if (!object(value)) throw new LaunchError('invalid_output', 'CLI emitted a non-object event')
  return value
})

export const number = (value: JsonValue | undefined): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export const validateOutput = <T>(protocol: CallProtocol<T>, value: JsonValue | undefined, usage: CallUsage): CallOutcome<T> => {
  const parsed = protocol.output.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map(({ path, message }) => `${path.length === 0 ? 'output' : path.map(String).join('.')}: ${message}`)
    throw new LaunchError('invalid_output', `${protocol.name} output does not match its schema: ${issues.join('; ')}`, usage)
  }
  return { ok: true, output: parsed.data, usage }
}

export const failureClass = (text: string): LaunchErrorClass => {
  if (/not logged in|unauthorized|please (?:run |log ?in)|authentication/i.test(text)) return 'auth'
  if (/usage limit|hit your limit|rate.?limit|\b429\b/i.test(text)) return 'limit'
  if (/API Error: (?:5\d\d|connection|request timed out)|unexpected status 5\d\d|stream disconnected|error sending request|connection (?:error|refused|reset|closed)|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|overloaded|service unavailable|bad gateway|gateway timeout/i.test(text)) return 'network'
  return 'invalid_output'
}

export const resetTime = (text: string): number | null => {
  const match = /(?:resets|try again at)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i.exec(text)
  return match?.[1] === undefined ? null : Date.parse(match[1])
}

export const requireSuccess = (result: ProcessResult): void => {
  if (result.failure !== null) throw new LaunchError(result.failure, `CLI launch failed: ${result.failure}`)
  if (result.exitCode !== 0) throw new LaunchError(failureClass(result.stdout + result.stderr), result.stderr || result.stdout || `CLI exited ${String(result.exitCode)}`)
}

export const authenticate = async (runtime: Runtime, run: (args: readonly string[]) => Promise<ProcessResult>): Promise<void> => {
  const name = runtime === 'claude' ? 'Claude' : 'Codex'
  const result = await run(runtime === 'claude' ? ['auth', 'status'] : ['login', 'status'])
  if (result.failure !== null) requireSuccess(result)
  if (result.exitCode !== 0) throw new LaunchError('auth', `${name} is not logged in`)
  if (runtime === 'codex') return
  const status: unknown = JSON.parse(result.stdout)
  if (typeof status !== 'object' || status === null || !('loggedIn' in status) || status.loggedIn !== true) throw new LaunchError('auth', `${name} is not logged in`)
}

export interface Invocation<T> {
  readonly directory: string
  readonly input: string
  readonly protocol: CallProtocol<T>
  readonly run: (args: readonly string[], input?: string) => Promise<ProcessResult>
}

export type Perform = <T>(invocation: Invocation<T>) => Promise<CallOutcome<T>>

const disabling = (kind: LaunchErrorClass): kind is LaunchErrorClass & ObserverDisabledReason =>
  kind === 'isolation' || kind === 'unsafe_workdir' || kind === 'cli_missing' || kind === 'launcher_unavailable'

export const createBackend = (
  runtime: Runtime,
  options: BackendOptions,
  perform: Perform,
) => {
  const runner = createProcessRunner(options)
  let disabled: Extract<ObserverState, { state: 'disabled' }> | undefined
  let disabledError: LaunchErrorClass = 'isolation'
  const listeners = new Set<(snapshot: LaunchStatus) => void>()
  const status = (): LaunchStatus => {
    const snapshot = runner.status()
    return { ...snapshot, state: snapshot.state.state === 'unavailable' ? snapshot.state : disabled ?? snapshot.state }
  }
  const notify = (): void => { for (const listener of listeners) listener(status()) }
  runner.subscribe(notify)
  const refusal = (): LaunchError | null => {
    const current = status().state
    if (current.state !== 'disabled' && current.state !== 'unavailable') return null
    return new LaunchError(current.reason === 'process_stuck' ? 'process_stuck' : disabledError, `Backend unavailable: ${current.reason}`)
  }
  const fail = (error: unknown): LaunchError => {
    const problem = error instanceof LaunchError ? error : new LaunchError('invalid_output', String(error))
    if (disabling(problem.kind)) {
      disabled = { state: 'disabled', reason: problem.kind }
      disabledError = problem.kind
      notify()
    }
    return problem
  }
  const prepare = (signal: AbortSignal | undefined, pending: Promise<void>[]) => {
    let cwd: string
    try { cwd = prepareWorkspace(options.temporaryDirectory) }
    catch (error) { throw new LaunchError('unsafe_workdir', String(error)) }
    let cli: CliCommand
    try { cli = resolveCli(runtime, options.cli, options.environment ?? process.env) }
    catch (error) { throw new LaunchError('cli_missing', String(error)) }
    const run = async (args: readonly string[], input = ''): Promise<ProcessResult> => {
      const launch: ProcessRequest = {
        command: cli.command,
        args: [...(cli.args ?? []), ...args],
        cwd,
        env: cleanEnvironment(runtime, options.environment ?? process.env),
        input,
        timeoutMs: options.timeoutMs ?? (runtime === 'claude' ? 90_000 : 150_000),
        ...(signal === undefined ? {} : { signal }),
      }
      const result = await runner.run(launch)
      pending.push(result.stopped)
      return result
    }
    return { cwd, run }
  }
  const attempt = async <T>(protocol: CallProtocol<T>, request: ObserverRequest, pending: Promise<void>[]): Promise<CallOutcome<T>> => {
    const refused = refusal()
    if (refused !== null) return { ok: false, error: refused.failure, usage: null }
    let directory: string | undefined
    try {
      const { cwd, run } = prepare(request.signal, pending)
      directory = await mkdtemp(join(dirname(cwd), 'call-'))
      return await perform({ directory, run, protocol, input: JSON.stringify(request.input) })
    } catch (error) {
      const problem = fail(error)
      return { ok: false, error: problem.failure, usage: problem.usage }
    } finally {
      if (directory !== undefined) {
        const path = directory
        const cleanup = Promise.all(pending).then(() => rm(path, { recursive: true, force: true, maxRetries: 5 }))
        if (runner.status().state.state === 'unavailable') void cleanup.catch(() => undefined)
        else await cleanup
      }
    }
  }
  const check = async (signal: AbortSignal | undefined, pending: Promise<void>[]): Promise<AuthOutcome> => {
    const refused = refusal()
    if (refused !== null) return { ok: false, error: refused.failure }
    try {
      await authenticate(runtime, prepare(signal, pending).run)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: fail(error).failure }
    }
  }
  const call = async <T>(protocol: CallProtocol<T>, request: ObserverRequest): Promise<CallResult<T>> => {
    const pending: Promise<void>[] = []
    return { ...(await attempt(protocol, request, pending)), stopped: stoppedAll(pending) }
  }
  const authStatus = async (signal?: AbortSignal): Promise<AuthResult> => {
    const pending: Promise<void>[] = []
    return { ...(await check(signal, pending)), stopped: stoppedAll(pending) }
  }
  return {
    call,
    execute: (request: ObserverRequest): Promise<ObserverResult> => call(observerProtocol, request),
    chat: (request: ObserverRequest): Promise<ChatResult> => call(chatProtocol, request),
    authStatus,
    status,
    subscribe: (listener: (snapshot: LaunchStatus) => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
