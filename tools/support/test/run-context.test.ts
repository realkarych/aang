import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  EpochNs,
  type Fact,
  type FactOf,
  type RunContext,
  type RunContextEntry,
  type RunId,
  type SessionId,
} from '@aang/contract'
import { recordRunContext } from '@aang/engine'
import type { Store } from '@aang/store'
import { type LoadedManifest, loadManifest } from '@aang/testkit'
import { describe, type OnTestFinishedHandler, test } from 'vitest'
import {
  findRecordings,
  invariantViolations,
  playRecording,
  type PlaybackRoots,
  type Recording,
  recordedTimes,
  removeRoots,
} from '../dist/index.js'
import { hookBinary } from './fixtures.js'

interface PlayedContext {
  readonly store: Store
  readonly roots: PlaybackRoots
  readonly run: RunId
  readonly session: SessionId
  readonly context: RunContext
}

const recordings = await findRecordings(resolve('fixtures/sessions'))

const ofScenario = (scenario: string): (readonly [string, Recording])[] =>
  recordings
    .filter(({ manifest }) => manifest.scenario === scenario)
    .map((recording) => [recording.name, recording] as const)

const recordedAt = EpochNs.parse(1_900_000_000_000_000_000n)

const asRecorded = (manifest: LoadedManifest): LoadedManifest => manifest

type Finished = (handler: OnTestFinishedHandler) => void

const contextOf = async (recording: Recording, store: Store, roots: PlaybackRoots, run: RunId): Promise<RunContext> => {
  const context = await recordRunContext(store, {
    run,
    backend: recording.manifest.runtime,
    crossVendor: false,
    at: recordedAt,
    claudeConfigDir: roots.claude,
    codexHome: roots.codex,
  })
  if (context === null) {
    throw new Error(`${recording.name} has no run context`)
  }
  return context
}

const play = async (recording: Recording, onTestFinished: Finished, edit = asRecorded): Promise<PlayedContext> => {
  const manifest = edit(await loadManifest(join(recording.directory, 'playback.json')))
  const { store, roots } = await playRecording(manifest, { hookBinary, recorded: recordedTimes(recording.manifest) })
  onTestFinished(async () => {
    store.close()
    await removeRoots(roots)
  })
  const runs = store.model.runs()
  const [run] = runs
  if (run === undefined || runs.length > 1) {
    throw new Error(`${recording.name} plays into ${String(runs.length)} runs instead of one`)
  }
  return {
    store,
    roots,
    run: run.id,
    session: run.root_session,
    context: await contextOf(recording, store, roots, run.id),
  }
}

const entriesOf = (context: RunContext, kind: RunContextEntry['kind']): RunContextEntry[] =>
  context.entries.filter((entry) => entry.kind === kind)

const entry = (kind: RunContextEntry['kind'], ref: string, text: string): RunContextEntry => ({
  kind,
  ref,
  text,
  truncated: null,
})

const listedRef = (name: string, session: SessionId): string => `${name} (sessions: ${session})`

const factsOf = (store: Store): Fact[] => store.facts.sessions().flatMap((key) => store.facts.ofSession(key))

const hookRuns = (store: Store): FactOf<'hook_run'>[] =>
  factsOf(store).filter((fact): fact is FactOf<'hook_run'> => fact.kind === 'hook_run')

const lastWord = (command: string): string => command.slice(command.lastIndexOf(' ') + 1)

const hookRunView = ({ payload }: FactOf<'hook_run'>): string =>
  [
    payload.name === null ? '-' : lastWord(payload.name),
    payload.trigger ?? payload.event,
    payload.outcome,
    payload.output === null ? '-' : `${payload.output.kind}: ${payload.output.text}`,
  ].join(' | ')

const notesGuard = 'notes-guard.mjs'

const userHookRuns = [
  'SessionStart | SessionStart:startup | success | stdout: notes-guard: the project notes greet the reader with Hello.',
  '- | UserPromptSubmit | success | additional_context: notes-guard: the notes reviewer is on duty.',
  'PostToolUse | PostToolUse:Bash | success | -',
  '- | PostToolUse:Bash | success | system_message: notes-guard checked the command',
  '- | PostToolUse:Bash | success | additional_context: notes-guard: the command output was checked.',
  'Stop | Stop | error | stderr: Failed with non-blocking status code: notes-guard could not archive the turn',
  'Stop | Stop | unknown | -',
]

const unconfirmedHookType = (manifest: LoadedManifest): LoadedManifest => ({
  ...manifest,
  sources: new Map(
    [...manifest.sources].map(([source, bytes]) => [
      source,
      source.endsWith('.jsonl')
        ? Buffer.from(bytes.toString('utf8').replaceAll('"type":"hook_success"', '"type":"hook_blocking_error"'))
        : bytes,
    ]),
  ),
})

describe.concurrent('the run context of the R.4b reference sessions (F.7d)', () => {
  test.for(ofScenario('user-hooks'))(
    '%s: the user hook enters the context by its command, its runs reach the observer, the aang hook is no hook of the solver',
    async ([, recording], { expect, onTestFinished }) => {
      const { store, run, context } = await play(recording, onTestFinished)

      const hooks = entriesOf(context, 'hook')
      expect(hooks.map(({ ref, text }) => [lastWord(ref), text])).toEqual([
        ['PostToolUse', 'PostToolUse:Bash'],
        ['SessionStart', 'SessionStart:startup'],
        ['Stop', 'Stop'],
      ])
      expect(hooks.every(({ ref }) => ref.includes(notesGuard))).toBe(true)
      expect(hookRuns(store).map(hookRunView).toSorted()).toEqual(userHookRuns.toSorted())
      expect(hookRuns(store).every(({ payload }) => payload.name === null || payload.name.includes(notesGuard))).toBe(true)

      const queued = new Set(store.interpretations.ofRun(run).map(({ fact }) => fact))
      const listings = factsOf(store).filter(({ kind }) => kind === 'definition_listing')
      expect(hookRuns(store).every(({ id }) => queued.has(id))).toBe(true)
      expect(listings.length).toBeGreaterThan(0)
      expect(listings.filter(({ id }) => queued.has(id))).toEqual([])
    },
  )

  test.for(ofScenario('plugin'))(
    '%s: the plugin subagent gets its listed definition with the prompt it ran with, and the invoked plugin skill its description',
    async ([, recording], { expect, onTestFinished }) => {
      const { session, context } = await play(recording, onTestFinished)

      expect(entriesOf(context, 'agent_definition')).toEqual([
        entry(
          'agent_definition',
          listedRef('aang-kit:reviewer', session),
          [
            'Reviews the project notes and reports what it checked. Use it to review the notes. (Tools: Bash)',
            'You review the project notes. Run the command from the task with the Bash tool and report its output.',
          ].join('\n\n'),
        ),
      ])
      expect(entriesOf(context, 'skill')).toEqual([
        entry(
          'skill',
          listedRef('aang-kit:greeting', session),
          'Chooses the greeting of the project notes. Use it when asked which greeting the notes use.',
        ),
      ])
      expect(entriesOf(context, 'hook')).toEqual([])
    },
  )

  test.for(ofScenario('agents-flag'))(
    '%s: the subagent defined for one run gets its listed definition with the prompt it ran with, and a file of its name stands in for it only when it gives that whole definition',
    async ([, recording], { expect, onTestFinished }) => {
      const { store, roots, run, session, context } = await play(recording, onTestFinished)
      const listedLine = 'Checks the project notes and reports the result. Use it to check the notes. (Tools: Bash)'
      const prompt = 'You check the project notes. Run the command from the task with the Bash tool and report its output.'
      const flagDefinition = entry('agent_definition', listedRef('notes-checker', session), `${listedLine}\n\n${prompt}`)
      const file = join(roots.claude, 'agents', 'notes-checker.md')
      const definitionFile = (tools: string, body: string): string =>
        `---\nname: notes-checker\ndescription: Checks the project notes and reports the result. Use it to check the notes.\n${tools}---\n\n${body}\n`
      const contextWith = async (text: string): Promise<RunContextEntry[]> => {
        await writeFile(file, text)
        return entriesOf(await contextOf(recording, store, roots, run), 'agent_definition')
      }

      const queued = new Set(store.interpretations.ofRun(run).map(({ fact }) => fact))
      const prompts = factsOf(store).filter(({ kind }) => kind === 'agent_prompt')

      expect(entriesOf(context, 'agent_definition')).toEqual([flagDefinition])
      expect(entriesOf(context, 'skill')).toEqual([])
      expect(prompts.length).toBeGreaterThan(0)
      expect(prompts.filter(({ id }) => queued.has(id))).toEqual([])

      await mkdir(join(roots.claude, 'agents'), { recursive: true })
      expect(await contextWith(definitionFile('tools: Read\n', 'Read the user notes.'))).toEqual([flagDefinition])
      expect(await contextWith(definitionFile('tools: Bash\n', 'Read the user notes.'))).toEqual([flagDefinition])
      expect(await contextWith(definitionFile('tools:\n  - Bash\n\n  - Read\n', prompt))).toEqual([flagDefinition])
      expect(await contextWith(definitionFile('tools: Bash\n', prompt))).toEqual([
        entry('agent_definition', file, definitionFile('tools: Bash\n', prompt)),
      ])
    },
  )

  test.for(ofScenario('agent-role'))(
    '%s: the subagent of the role gets the role definition from config.toml, the subagent without a role none',
    async ([, recording], { expect, onTestFinished }) => {
      const { roots, context } = await play(recording, onTestFinished)

      expect(entriesOf(context, 'agent_definition')).toEqual([
        entry(
          'agent_definition',
          `${join(roots.codex, 'config.toml')} [agents.reviewer]`,
          [
            'description: Reviews the project notes and reports what it checked.',
            'developer_instructions: You are the notes reviewer of the aang recording. Run the command from your task and report its output.',
          ].join('\n'),
        ),
      ])
      expect(entriesOf(context, 'hook')).toEqual([])
    },
  )

  test('a hook attachment of a type that no reference session confirms stays unknown and names no hook', async ({
    expect,
    onTestFinished,
  }) => {
    const recording = recordings.find(({ name }) => name === 'claude/2.1.289/claude_cli/macos/user-hooks')
    if (recording === undefined) {
      throw new Error('the macOS CLI user-hooks recording is not found')
    }

    const { store, context } = await play(recording, onTestFinished, unconfirmedHookType)

    expect(invariantViolations(store)).toEqual(['claude transcript records of type attachment are unknown: 2'])
    expect(entriesOf(context, 'hook').map(({ ref }) => lastWord(ref))).toEqual(['Stop'])
    expect(hookRuns(store).map(hookRunView).toSorted()).toEqual(
      userHookRuns.filter((run) => !run.includes('| success | stdout') && !run.startsWith('PostToolUse')).toSorted(),
    )
  })
})
