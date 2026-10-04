import { setTimeout as sleep } from 'node:timers/promises'
import { appendTo, archivedPath, move, type PlayerRoots, remove, resolveTarget, writeWhole } from './files.js'
import { type HookTarget, invokeHook } from './hook.js'
import type { AppendStep, LoadedManifest, PlayerStep } from './manifest.js'
import { sendOtlp } from './otlp.js'
import { playbackShift, type RecordTime, shifted } from './record-time.js'

export interface PlayerOptions {
  readonly roots: PlayerRoots
  readonly timeScale?: number
  readonly recordTime?: RecordTime
  readonly hook?: HookTarget
  readonly otlp?: string
}

export interface PlayOptions {
  readonly until?: string
  readonly signal?: AbortSignal
}

export interface PlayedStep {
  readonly index: number
  readonly label: string | null
  readonly at: number
  readonly playedAt: number
}

export interface Player {
  readonly position: () => number
  readonly finished: () => boolean
  readonly play: (options?: PlayOptions) => Promise<PlayedStep[]>
}

export class PlaybackError extends Error {
  override readonly name = 'PlaybackError'
}

const hookSpacingMs = 20

const newline = 0x0a

const waitUntil = async (deadline: number, signal: AbortSignal | undefined): Promise<void> => {
  signal?.throwIfAborted()
  for (let remaining = deadline - performance.now(); remaining > 0; remaining = deadline - performance.now()) {
    await sleep(remaining, undefined, signal === undefined ? {} : { signal })
  }
}

const stepName = (index: number, step: PlayerStep): string =>
  `step ${String(index)} (${step.kind}${step.label === undefined ? '' : ` "${step.label}"`})`

const required = <T>(value: T | undefined, missing: () => string): T => {
  if (value === undefined) {
    throw new PlaybackError(missing())
  }
  return value
}

export const createPlayer = (manifest: LoadedManifest, options: PlayerOptions): Player => {
  const { roots, timeScale = 1, recordTime = 'original' } = options
  if (!Number.isFinite(timeScale) || timeScale < 0) {
    throw new PlaybackError(`the time scale must be a finite number not below 0, got ${String(timeScale)}`)
  }
  const { steps, file } = manifest
  const has = (kind: PlayerStep['kind']): boolean => steps.some((step) => step.kind === kind)
  if (options.hook === undefined && has('hook')) {
    throw new PlaybackError(`${file} has hook steps, but the player has no hook target`)
  }
  if (options.otlp === undefined && has('otlp')) {
    throw new PlaybackError(`${file} has OTLP steps, but the player has no OTLP endpoint`)
  }

  const shift = recordTime === 'playback' ? playbackShift(manifest.sources.values(), Date.now()) : 0
  const offsets = new Map<string, number>()
  const state = { next: 0, playing: false, lastHookEnd: Number.NEGATIVE_INFINITY }

  const source = (name: string): Buffer =>
    required(manifest.sources.get(name), () => `${file}: source ${name} is not loaded`)

  const endOfLines = (name: string, content: Buffer, offset: number, lines: number): number => {
    let end = offset
    for (let taken = 0; taken < lines; taken += 1) {
      if (end >= content.length) {
        throw new PlaybackError(`source ${name} has ${String(taken)} of ${String(lines)} lines left`)
      }
      const lineEnd = content.indexOf(newline, end)
      end = lineEnd < 0 ? content.length : lineEnd + 1
    }
    return end
  }

  const nextChunk = (step: AppendStep): { chunk: Buffer; end: number } => {
    const content = source(step.source)
    const offset = offsets.get(step.source) ?? 0
    const end =
      step.lines !== undefined
        ? endOfLines(step.source, content, offset, step.lines)
        : step.bytes !== undefined
          ? offset + step.bytes
          : content.length
    if (end > content.length || end === offset) {
      throw new PlaybackError(`source ${step.source} has ${String(content.length - offset)} bytes left`)
    }
    return { chunk: content.subarray(offset, end), end }
  }

  const perform = async (step: PlayerStep, signal: AbortSignal | undefined): Promise<void> => {
    switch (step.kind) {
      case 'append': {
        const { chunk, end } = nextChunk(step)
        await appendTo(resolveTarget(roots, step.target), shifted(chunk, shift))
        offsets.set(step.source, end)
        return
      }
      case 'write':
        return writeWhole(resolveTarget(roots, step.target), shifted(source(step.source), shift))
      case 'remove':
        return remove(resolveTarget(roots, step.target))
      case 'move':
        return move(resolveTarget(roots, step.target), resolveTarget(roots, step.to))
      case 'archive':
        return move(resolveTarget(roots, step.target), archivedPath(roots, step.target.path))
      case 'hook': {
        const target = required(options.hook, () => 'no hook target')
        await waitUntil(state.lastHookEnd + hookSpacingMs, signal)
        try {
          await invokeHook(target, {
            runtime: step.runtime,
            registration: step.registration,
            env: step.env,
            payload: shifted(source(step.source), shift),
          })
        } finally {
          state.lastHookEnd = performance.now()
        }
        return
      }
      case 'otlp':
        return sendOtlp(
          required(options.otlp, () => 'no OTLP endpoint'),
          source(step.source),
        )
    }
  }

  const endIndex = (until: string | undefined): number => {
    if (until === undefined) {
      return steps.length
    }
    const index = steps.findIndex((step) => step.label === until)
    if (index < 0) {
      throw new PlaybackError(`${file} has no step labelled "${until}"`)
    }
    if (index < state.next) {
      throw new PlaybackError(`step "${until}" of ${file} has already been played`)
    }
    return index
  }

  const play = async ({ until, signal }: PlayOptions = {}): Promise<PlayedStep[]> => {
    if (state.playing) {
      throw new PlaybackError(`${file} is already playing`)
    }
    const end = endIndex(until)
    state.playing = true
    try {
      const startedAt = performance.now()
      const origin = steps[state.next]?.at ?? 0
      const played: PlayedStep[] = []
      for (; state.next < end; state.next += 1) {
        const index = state.next
        const step = required(steps[index], () => `${file} has no step ${String(index)}`)
        await waitUntil(startedAt + (step.at - origin) * timeScale, signal)
        try {
          await perform(step, signal)
        } catch (error) {
          throw new PlaybackError(
            `${file}: ${stepName(index, step)} failed: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error,
            },
          )
        }
        played.push({ index, label: step.label ?? null, at: step.at, playedAt: Date.now() })
      }
      return played
    } finally {
      state.playing = false
    }
  }

  return {
    position: () => state.next,
    finished: () => state.next === steps.length,
    play,
  }
}
