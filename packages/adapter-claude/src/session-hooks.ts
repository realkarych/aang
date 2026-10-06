import type {
  AnswerOutcome,
  BackgroundTask,
  FactDraft,
  FactEntityKey,
  JsonValue,
  PlanItemStatus,
  SessionLaunch,
  SpoolEnv,
  Surface,
  SurfaceClaim,
} from '@aang/contract'
import { z } from 'zod'
import { startedAgent } from './agents.js'
import { compactionTrigger } from './compaction.js'
import { fact, invalid, unknown } from './facts.js'
import { name, optionalText } from './fields.js'
import { facts, HookCommon, type HookContext, type HookParser, hookParser } from './hook-parser.js'
import { isJsonObject } from './json.js'
import { agentKey, ownerKey, questionKey, sessionKey, teammateKey } from './keys.js'
import { answerText } from './questions.js'

const observerEntrypoint = 'aang-observer'
const desktopEntrypoint = 'claude-desktop'
const compactSource = 'compact'

const SessionStart = HookCommon.extend({ source: optionalText })

const SessionEnd = HookCommon.extend({ reason: optionalText })

const BackgroundTaskEntry = z.looseObject({
  id: name,
  type: name,
  status: name,
  description: optionalText,
  agent_type: optionalText,
})

const Stop = HookCommon.extend({
  last_assistant_message: optionalText,
  background_tasks: z.array(BackgroundTaskEntry).nullish(),
})

const StopFailure = HookCommon.extend({ error: name, last_assistant_message: optionalText })

const SubagentStart = HookCommon.extend({ agent_id: name, agent_type: optionalText })

const SubagentStop = SubagentStart.extend({ agent_transcript_path: optionalText, last_assistant_message: optionalText })

const PreCompact = HookCommon.extend({ trigger: optionalText })

const PostCompact = PreCompact.extend({ compact_summary: optionalText })

const InstructionsLoaded = HookCommon.extend({ file_path: name, memory_type: optionalText, load_reason: optionalText })

const Task = HookCommon.extend({
  task_id: name,
  task_subject: z.string(),
  task_description: optionalText,
  teammate_name: name.nullish(),
  team_name: name.nullish(),
})
type Task = z.infer<typeof Task>

const Elicitation = HookCommon.extend({ mcp_server_name: name, message: z.string(), elicitation_id: optionalText })
type Elicitation = z.infer<typeof Elicitation>

const ElicitationResult = HookCommon.extend({
  mcp_server_name: name,
  elicitation_id: optionalText,
  action: name,
  content: z.json().nullish(),
})

const TeammateIdle = HookCommon.extend({ teammate_name: name, team_name: name })

const launches: ReadonlyMap<string, SessionLaunch> = new Map([
  ['startup', 'startup'],
  ['resume', 'resume'],
  ['clear', 'clear'],
  ['fork', 'fork'],
])

const entrypointSurfaces: ReadonlyMap<string, Surface> = new Map([
  ['cli', 'claude_cli'],
  ['sdk-cli', 'claude_cli'],
  ['sdk-ts', 'claude_sdk'],
  ['sdk-py', 'claude_sdk'],
  [desktopEntrypoint, 'claude_desktop'],
])

const answerOutcomes: ReadonlyMap<string, AnswerOutcome> = new Map([
  ['accept', 'answered'],
  ['decline', 'declined'],
  ['cancel', 'cancelled'],
])

const genericEvents: ReadonlyMap<string, boolean> = new Map([
  ['MessageDisplay', true],
  ['Setup', false],
  ['UserPromptExpansion', false],
  ['ConfigChange', false],
  ['CwdChanged', false],
  ['DirectoryAdded', false],
  ['FileChanged', false],
  ['WorktreeCreate', false],
  ['WorktreeRemove', false],
  ['PreModelSwitch', false],
  ['PostModelSwitch', false],
])

const surfaceOf = (env: SpoolEnv): SurfaceClaim | null => {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? ''
  const sdk = (env.CLAUDE_AGENT_SDK_VERSION ?? '') !== '' && entrypoint !== desktopEntrypoint
  const surface = sdk ? 'claude_sdk' : entrypointSurfaces.get(entrypoint)
  return surface === undefined ? null : { surface, basis: 'observed' }
}

const ownerOf = (event: HookCommon) => ownerKey(event.session_id, event.agent_id ?? null)

const runtimeEvent = (entity: FactEntityKey, context: HookContext, verified: boolean): FactDraft =>
  fact(
    context.origin,
    {
      kind: 'runtime_event',
      entity_key: entity,
      speaker: 'runtime',
      urgent: false,
      payload: { event: context.event, data: context.payload },
    },
    { verified },
  )

const backgroundTask = (task: z.infer<typeof BackgroundTaskEntry>): BackgroundTask => ({
  id: task.id,
  task_type: task.type,
  status: task.status,
  description: task.description ?? null,
  agent_type: task.agent_type ?? null,
})

const teammateOf = ({ teammate_name: teammate, team_name: team }: Task) =>
  typeof teammate === 'string' && typeof team === 'string' ? { name: teammate, team } : null

const taskParser = (status: PlanItemStatus): HookParser =>
  hookParser(Task, (event, { origin }) => {
    const teammate = teammateOf(event)
    return facts(
      fact(origin, {
        kind: 'plan_update',
        entity_key: teammate === null ? ownerOf(event) : teammateKey(event.session_id, teammate.name, teammate.team),
        speaker: 'solver',
        urgent: true,
        payload: {
          source: 'task_hook',
          text: event.task_description ?? null,
          items: [{ id: event.task_id, text: event.task_subject, status }],
        },
      }),
    )
  })

const elicitationCall = (event: Pick<Elicitation, 'mcp_server_name' | 'elicitation_id'>): string =>
  event.elicitation_id ?? event.mcp_server_name

const elicitationAnswers = (content: JsonValue | null | undefined) => {
  if (content === null || content === undefined) {
    return []
  }
  return isJsonObject(content)
    ? Object.entries(content).map(([field, value]) => ({ question: field, answer: answerText(value) }))
    : [{ question: null, answer: answerText(content) }]
}

export const sessionHookParsers: ReadonlyMap<string, HookParser> = new Map([
  [
    'SessionStart',
    hookParser(SessionStart, (event, context) => {
      const source = event.source ?? null
      if (source === compactSource) {
        return facts(runtimeEvent(ownerOf(event), context, true))
      }
      return facts(
        fact(context.origin, {
          kind: 'session_start',
          entity_key: sessionKey(event.session_id),
          speaker: 'runtime',
          urgent: false,
          payload: {
            launch: (source === null ? undefined : launches.get(source)) ?? 'unknown',
            surface: surfaceOf(context.env),
            cwd: event.cwd ?? null,
            forked_from: null,
            observer_marker: context.env.CLAUDE_CODE_ENTRYPOINT === observerEntrypoint,
          },
        }),
      )
    }),
  ],
  [
    'SessionEnd',
    hookParser(SessionEnd, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'session_end',
          entity_key: sessionKey(event.session_id),
          speaker: 'runtime',
          urgent: false,
          payload: { reason: event.reason ?? null },
        }),
      ),
    ),
  ],
  [
    'UserPromptSubmit',
    hookParser(HookCommon, (event, { origin }) =>
      facts(
        fact(origin, { kind: 'turn_start', entity_key: ownerOf(event), speaker: 'runtime', urgent: false, payload: {} }),
      ),
    ),
  ],
  [
    'Stop',
    hookParser(Stop, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'turn_end',
          entity_key: ownerOf(event),
          speaker: 'runtime',
          urgent: true,
          payload: {
            outcome: 'completed',
            reason: null,
            final_message: event.last_assistant_message ?? null,
            background_tasks: (event.background_tasks ?? []).map(backgroundTask),
          },
        }),
      ),
    ),
  ],
  [
    'StopFailure',
    hookParser(StopFailure, (event, { origin }) =>
      facts(
        fact(
          origin,
          {
            kind: 'turn_end',
            entity_key: ownerOf(event),
            speaker: 'runtime',
            urgent: true,
            payload: {
              outcome: 'failed',
              reason: event.error,
              final_message: event.last_assistant_message ?? null,
              background_tasks: [],
            },
          },
          { verified: false },
        ),
      ),
    ),
  ],
  [
    'SubagentStart',
    hookParser(SubagentStart, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'agent_start',
          entity_key: agentKey(event.session_id, event.agent_id),
          speaker: 'runtime',
          urgent: false,
          payload: startedAgent({ role: 'subagent', agent_type: event.agent_type ?? null }),
        }),
      ),
    ),
  ],
  [
    'SubagentStop',
    hookParser(SubagentStop, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'agent_end',
          entity_key: agentKey(event.session_id, event.agent_id),
          speaker: 'runtime',
          urgent: true,
          payload: {
            outcome: 'completed',
            final_message: event.last_assistant_message ?? null,
            agent_type: event.agent_type ?? null,
            transcript_path: event.agent_transcript_path ?? null,
          },
        }),
      ),
    ),
  ],
  [
    'PreCompact',
    hookParser(PreCompact, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'compaction',
          entity_key: ownerOf(event),
          speaker: 'runtime',
          urgent: false,
          payload: { phase: 'started', trigger: compactionTrigger(event.trigger), summary: null, tokens_before: null },
        }),
      ),
    ),
  ],
  [
    'PostCompact',
    hookParser(PostCompact, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'compaction',
          entity_key: ownerOf(event),
          speaker: 'runtime',
          urgent: true,
          payload: {
            phase: 'completed',
            trigger: compactionTrigger(event.trigger),
            summary: event.compact_summary ?? null,
            tokens_before: null,
          },
        }),
      ),
    ),
  ],
  [
    'InstructionsLoaded',
    hookParser(InstructionsLoaded, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'instructions_loaded',
          entity_key: ownerOf(event),
          speaker: 'runtime',
          urgent: false,
          payload: {
            path: event.file_path,
            memory_type: event.memory_type ?? null,
            load_reason: event.load_reason ?? null,
          },
        }),
      ),
    ),
  ],
  ['TaskCreated', taskParser('pending')],
  ['TaskCompleted', taskParser('completed')],
  [
    'Elicitation',
    hookParser(Elicitation, (event, { origin, spoolFile }) =>
      spoolFile === null
        ? invalid('Elicitation is identified by its spool file, and the record has none')
        : facts(
            fact(
              origin,
              {
                kind: 'question_asked',
                entity_key: questionKey(event.session_id, spoolFile),
                speaker: 'tool',
                urgent: true,
                payload: {
                  source: 'elicitation',
                  blocking: true,
                  questions: [{ header: event.mcp_server_name, text: event.message, options: [] }],
                },
              },
              { ids: { call_id: elicitationCall(event) } },
            ),
          ),
    ),
  ],
  [
    'ElicitationResult',
    hookParser(ElicitationResult, (event, { origin }) => {
      const outcome = answerOutcomes.get(event.action)
      return outcome === undefined
        ? unknown(null)
        : facts(
            fact(
              origin,
              {
                kind: 'question_answered',
                entity_key: ownerOf(event),
                speaker: 'human',
                urgent: false,
                payload: { outcome, answers: outcome === 'answered' ? elicitationAnswers(event.content) : [] },
              },
              { ids: { call_id: elicitationCall(event) } },
            ),
          )
    }),
  ],
  [
    'TeammateIdle',
    hookParser(TeammateIdle, (event, context) =>
      facts(runtimeEvent(teammateKey(event.session_id, event.teammate_name, event.team_name), context, true)),
    ),
  ],
  ...[...genericEvents].map(([event, verified]): [string, HookParser] => [
    event,
    hookParser(HookCommon, (common, context) => facts(runtimeEvent(ownerOf(common), context, verified))),
  ]),
])
