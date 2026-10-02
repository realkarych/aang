import { codexAdapter } from '@aang/adapter-codex'
import type { StreamKey } from '@aang/contract'
import { expect, test } from 'vitest'
import { z } from 'zod'
import {
  factsOf,
  iso,
  millis,
  realThread,
  record,
  sampleFiles,
  sampleLine,
  sampleObject,
  streamFrom,
  threadStream,
} from './rollout-records.js'

const real = threadStream(realThread)
const failedRun = threadStream('01a0f75b-024a-7630-ab74-a88bf43d5f32')
const patchRun = threadStream('01a0f75b-f1ae-7202-88d4-4759d4563cf9')
const questionRun = threadStream('01a0f75b-f4bd-76c2-a690-3a3d92a00517')
const spawnRoot = '01a0f75c-465e-7a01-876f-c7df6fc989a0'
const spawnChild = '01a0f75c-46d2-7430-92a2-c3b0cd5d85b6'
const spawnRun = threadStream(spawnRoot)
const childRun = threadStream(spawnRoot, spawnChild)
const interruptRun = threadStream('01a0f765-4429-7c23-8d10-aea36a8d601b')
const escalationRun = threadStream('rejected-escalation-thread')
const compactRun = threadStream('01a0f75c-caa3-7032-aff1-44dbbf58a79b')
const spawnTurn = '01a0f75c-467d-70d2-acd5-a508348639bb'
const childTurn = '01a0f75c-46f1-7091-8408-199407132c7c'
const childAgent = { kind: 'agent', session: spawnRoot, agent: { kind: 'thread', thread_id: spawnChild } }
const inlineSummary = z
  .object({ payload: z.object({ message: z.string().startsWith('Another language model started') }) })
  .parse(sampleObject('compacted.inline-local.mock.json')).payload.message
const firstResponse = {
  uncached_input_tokens: 1990,
  cache_read_input_tokens: 12288,
  cache_write_input_tokens: 0,
  output_tokens: 27,
  reasoning_output_tokens: 0,
}

const session = (stream: StreamKey) => ({ kind: 'session', runtime: 'codex', session: stream.split(':')[1] })
const action = (stream: StreamKey, call: string) => ({
  kind: 'action',
  runtime: 'codex',
  session: stream.split(':')[1],
  call,
})

interface Expectation {
  readonly stream: StreamKey | 'own'
  readonly facts?: readonly Record<string, unknown>[]
}

const unrecognized = (stream: StreamKey): Expectation => ({ stream })

const noFacts = (stream: StreamKey): Expectation => ({ stream, facts: [] })

const expectations: Readonly<Record<string, Expectation>> = {
  'session_meta.exec.real.json': {
    stream: 'own',
    facts: [
      {
        kind: 'session_start',
        entity_key: session(real),
        speaker: 'runtime',
        urgent: false,
        at: iso('2026-10-01T11:55:58.003Z'),
        runtime_ids: { session_id: realThread, thread_id: realThread, ordinal: 0 },
        runtime_env: {
          cwd: '/tmp/aang-spike/codex-cli/run1',
          version: '0.159.2',
          originator: 'codex_exec',
          git_branch: null,
        },
        payload: {
          launch: 'startup',
          surface: { surface: 'codex_exec', basis: 'observed' },
          cwd: '/tmp/aang-spike/codex-cli/run1',
          forked_from: null,
          observer_marker: false,
        },
      },
    ],
  },
  'session_meta.tui.mock.json': {
    stream: 'own',
    facts: [
      {
        kind: 'session_start',
        entity_key: { kind: 'session', session: '01a0f763-d046-7011-91c1-e1031d75b971' },
        runtime_env: { originator: 'codex-tui', version: '0.159.2' },
        payload: {
          launch: 'startup',
          surface: { surface: 'codex_tui', basis: 'assumed' },
          observer_marker: false,
        },
      },
    ],
  },
  'session_meta.exec.thread_source-aang-observer.mock.json': {
    stream: 'own',
    facts: [
      {
        kind: 'session_start',
        entity_key: { kind: 'session', session: '01a0f75a-a4b7-7361-aa8c-65ee90d82f99' },
        payload: {
          launch: 'startup',
          surface: { surface: 'codex_exec', basis: 'observed' },
          observer_marker: true,
        },
      },
    ],
  },
  'session_meta.fork.mock.json': {
    stream: 'own',
    facts: [
      {
        kind: 'session_start',
        entity_key: { kind: 'session', session: '01a0f75f-4fc5-7bf0-9860-9766a76bffd7' },
        runtime_ids: { ordinal: 38 },
        payload: {
          launch: 'fork',
          surface: { surface: 'codex_exec', basis: 'observed' },
          forked_from: { session: '01a0f75a-a4b7-7361-aa8c-65ee90d82f99', ordinal: 38 },
          observer_marker: false,
        },
      },
    ],
  },
  'session_meta.guardian.mock.json': {
    stream: 'own',
    facts: [
      {
        kind: 'agent_start',
        entity_key: {
          kind: 'agent',
          session: '01a0f75b-8043-70d2-95ed-39bd0831b81a',
          agent: { kind: 'thread', thread_id: '01a0f75b-8064-73c2-8b8a-ba66c5467425' },
        },
        payload: {
          role: 'service',
          service: 'guardian',
          agent_type: 'guardian',
          parent: { kind: 'main' },
          depth: null,
        },
      },
    ],
  },
  'session_meta.subagent.thread_spawn.mock.json': {
    stream: 'own',
    facts: [
      {
        kind: 'agent_start',
        entity_key: { kind: 'agent', session: spawnRoot, agent: { kind: 'thread', thread_id: spawnChild } },
        runtime_ids: { session_id: spawnRoot, thread_id: spawnChild },
        payload: {
          role: 'subagent',
          service: null,
          agent_role: null,
          description: '/root/probe_child',
          nickname: 'Confucius',
          parent: { kind: 'main' },
          spawned_by_call: null,
          depth: 1,
        },
      },
    ],
  },
  'turn_context.real.json': {
    stream: real,
    facts: [
      {
        kind: 'turn_settings',
        entity_key: session(real),
        runtime_ids: { turn_id: '01a0f752-4102-7740-9432-0533263c2dc1', ordinal: 7 },
        runtime_env: { cwd: '/tmp/aang-spike/codex-cli/run1' },
        payload: { model: 'gpt-6.1-sol', effort: null, approval_policy: 'never', sandbox: 'read-only' },
      },
    ],
  },
  'event_msg.task_started.real.json': {
    stream: real,
    facts: [
      {
        kind: 'turn_start',
        entity_key: session(real),
        urgent: false,
        at: iso('2026-10-01T11:55:58.088Z'),
        runtime_ids: { turn_id: '01a0f752-4102-7740-9432-0533263c2dc1' },
        payload: {},
      },
    ],
  },
  'event_msg.task_started.subagent.mock.json': {
    stream: childRun,
    facts: [
      {
        kind: 'turn_start',
        entity_key: { kind: 'agent', session: spawnRoot, agent: { kind: 'thread', thread_id: spawnChild } },
        runtime_ids: { session_id: spawnRoot, thread_id: spawnChild, turn_id: '01a0f75c-46f1-7091-8408-199407132c7c' },
      },
    ],
  },
  'event_msg.task_complete.real.json': {
    stream: real,
    facts: [
      {
        kind: 'turn_end',
        entity_key: session(real),
        urgent: true,
        payload: { outcome: 'completed', reason: null, final_message: 'OK', background_tasks: [] },
      },
    ],
  },
  'event_msg.turn_aborted.mock-tui.json': {
    stream: interruptRun,
    facts: [
      {
        kind: 'turn_end',
        urgent: true,
        runtime_ids: { turn_id: '01a0f765-4454-74d1-8523-2749f1374bef' },
        payload: { outcome: 'interrupted', reason: 'interrupted', final_message: null },
      },
    ],
  },
  'event_msg.item_completed.UserMessage.real.json': {
    stream: real,
    facts: [
      {
        kind: 'prompt',
        entity_key: { kind: 'message', session: realThread, message: `${realThread}:9` },
        speaker: 'human',
        urgent: false,
        at: millis(1790855777769),
        payload: {
          text: 'Run the shell command `echo hi` exactly once, then reply with just: OK',
          origin: 'human',
          origin_raw: null,
        },
      },
    ],
  },
  'event_msg.item_completed.AgentMessage.final.real.json': {
    stream: real,
    facts: [
      {
        kind: 'message',
        entity_key: { kind: 'message', session: realThread, message: `${realThread}:15` },
        speaker: 'solver',
        urgent: true,
        at: millis(1790855787504),
        runtime_ids: { message_id: 'msg_00a7ba1502c50863016abe4a6b53bc87d29075b5116fc1dd4c' },
        payload: { text: 'OK', final: true, audience: 'user', model: null },
      },
    ],
  },
  'event_msg.item_completed.AgentMessage.question-async.mock.json': {
    stream: questionRun,
    facts: [
      {
        kind: 'message',
        payload: { text: 'Proceed with probe?\n- yes\n- no', final: true, audience: 'user' },
      },
      {
        kind: 'question_asked',
        entity_key: { kind: 'question', session: '01a0f75b-f4bd-76c2-a690-3a3d92a00517', question: 'call_mock_25' },
        speaker: 'solver',
        urgent: true,
        payload: {
          source: 'agent_message',
          blocking: false,
          questions: [{ header: null, text: 'Proceed with probe?', options: ['yes', 'no'] }],
        },
      },
    ],
  },
  'event_msg.item_completed.CommandExecution.real.json': {
    stream: real,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(real, 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb'),
        speaker: 'solver',
        at: millis(1790855785136),
        runtime_ids: {
          call_id: 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb',
          turn_id: '01a0f752-4102-7740-9432-0533263c2dc1',
        },
        payload: {
          tool: 'CommandExecution',
          action_kind: 'command',
          input: { command: ['/bin/zsh', '-lc', 'echo hi'], cwd: 'file:///tmp/aang-spike/codex-cli/run1' },
          container_call: null,
        },
      },
      {
        kind: 'action_end',
        entity_key: action(real, 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb'),
        speaker: 'tool',
        urgent: false,
        at: millis(1790855785136),
        payload: { outcome: 'ok', output: 'hi\n', exit_code: 0, duration_ms: 0 },
      },
    ],
  },
  'event_msg.item_completed.CommandExecution.failed.mock.json': {
    stream: failedRun,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(failedRun, 'call_mock_13'),
        urgent: false,
        payload: { action_kind: 'command' },
      },
      {
        kind: 'action_end',
        entity_key: action(failedRun, 'call_mock_13'),
        urgent: true,
        payload: { outcome: 'error', exit_code: 1, output: 'ls: /definitely/not/here: No such file or directory\n' },
      },
    ],
  },
  'event_msg.item_completed.CommandExecution.after-abort.mock-tui.json': {
    stream: interruptRun,
    facts: [
      { kind: 'action_start', entity_key: action(interruptRun, 'call_mock_5'), at: millis(1790857004358) },
      {
        kind: 'action_end',
        entity_key: action(interruptRun, 'call_mock_5'),
        urgent: true,
        at: millis(1790857024080),
        payload: { outcome: 'error', exit_code: -1, output: '', duration_ms: 19722 },
      },
    ],
  },
  'event_msg.item_completed.FileChange.mock.json': {
    stream: patchRun,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(patchRun, 'call_mock_21'),
        at: millis(1790856393259),
        payload: {
          tool: 'FileChange',
          action_kind: 'file_write',
          input: { changes: { '/tmp/aang-spike/codex-cli/m_patch3/patched.txt': { type: 'add', content: 'hello\n' } } },
        },
      },
      {
        kind: 'action_end',
        entity_key: action(patchRun, 'call_mock_21'),
        urgent: false,
        at: millis(1790856393277),
        payload: {
          outcome: 'ok',
          output: 'Success. Updated the following files:\nA patched.txt\n',
          exit_code: null,
          duration_ms: 18,
        },
      },
    ],
  },
  'event_msg.item_completed.ContextCompaction.real.json': {
    stream: real,
    facts: [
      {
        kind: 'compaction',
        entity_key: session(real),
        urgent: true,
        at: millis(1790856003175),
        payload: { phase: 'started', trigger: 'unknown', summary: null },
      },
      {
        kind: 'compaction',
        entity_key: session(real),
        urgent: true,
        at: millis(1790856018085),
        payload: { phase: 'completed', trigger: 'unknown', summary: null },
      },
    ],
  },
  'response_item.function_call.exec_command.mock.json': {
    stream: failedRun,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(failedRun, 'call_mock_13'),
        speaker: 'solver',
        at: iso('2026-10-01T12:05:31.937Z'),
        runtime_ids: { call_id: 'call_mock_13', turn_id: '01a0f75b-0269-77c1-9982-57eddbe3e369' },
        payload: { tool: 'exec_command', action_kind: 'command', input: { cmd: 'ls /definitely/not/here' } },
      },
    ],
  },
  'response_item.function_call.request_user_input_async.mock.json': {
    stream: questionRun,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(questionRun, 'call_mock_25'),
        payload: {
          tool: 'request_user_input_async',
          action_kind: 'question',
          input: { questions: [{ title: 'Proceed with probe?', options: ['yes', 'no'] }] },
        },
      },
    ],
  },
  'response_item.function_call.spawn_agent.mock.json': {
    stream: spawnRun,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(spawnRun, 'call_mock_33'),
        payload: {
          tool: 'collaboration/spawn_agent',
          action_kind: 'agent',
          input: { task_name: 'probe_child', message: 'SCN_CHILD run echo from-child then finish', fork_turns: 'none' },
        },
      },
    ],
  },
  'response_item.custom_tool_call.exec-codemode.real.json': {
    stream: real,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(real, 'call_MxHF39QIUjLqImvlqfhdfE2y'),
        payload: {
          tool: 'exec',
          action_kind: 'code_cell',
          input: 'text(await tools.exec_command({cmd:"echo hi",max_output_tokens:100}));\n',
          container_call: null,
        },
      },
    ],
  },
  'response_item.custom_tool_call.apply_patch.mock.json': {
    stream: patchRun,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(patchRun, 'call_mock_21'),
        payload: {
          tool: 'apply_patch',
          action_kind: 'file_write',
          input: '*** Begin Patch\n*** Add File: patched.txt\n+hello\n*** End Patch\n',
        },
      },
    ],
  },
  'response_item.custom_tool_call_output.real.json': {
    stream: real,
    facts: [
      {
        kind: 'action_end',
        entity_key: action(real, 'call_MxHF39QIUjLqImvlqfhdfE2y'),
        speaker: 'tool',
        payload: {
          outcome: 'unknown',
          output:
            'Script completed\nWall time 0.1 seconds\nOutput:\n' +
            '{"chunk_id":"a84880","wall_time_seconds":0.000002625,' +
            '"exit_code":0,"original_token_count":1,"output":"hi\\n"}',
        },
      },
    ],
  },
  'response_item.function_call_output.mock.json': {
    stream: failedRun,
    facts: [
      {
        kind: 'action_end',
        entity_key: action(failedRun, 'call_mock_13'),
        payload: {
          outcome: 'unknown',
          output:
            'Chunk ID: 1adc9a\nWall time: 0.0000 seconds\nProcess exited with code 1\nOriginal token count: 13\n' +
            'Output:\nls: /definitely/not/here: No such file or directory\n',
        },
      },
    ],
  },
  'response_item.function_call_output.aborted-by-user.mock-tui.json': {
    stream: interruptRun,
    facts: [
      {
        kind: 'action_end',
        entity_key: action(interruptRun, 'call_mock_5'),
        payload: { outcome: 'unknown', output: 'Wall time: 4.9 seconds\naborted by user' },
      },
    ],
  },
  'response_item.function_call_output.rejected-escalation.mock.json': {
    stream: escalationRun,
    facts: [
      {
        kind: 'action_end',
        entity_key: action(escalationRun, 'call_mock_5'),
        payload: {
          outcome: 'unknown',
          output:
            'approval policy is Never; reject command — ' +
            'you cannot ask for escalated permissions if the approval policy is Never',
        },
      },
    ],
  },
  'response_item.message.assistant.real.json': noFacts(real),
  'response_item.message.developer.real.json': noFacts(real),
  'response_item.message.developer.turn_aborted.mock-tui.json': noFacts(interruptRun),
  'response_item.message.user.environment_context.real.json': noFacts(real),
  'response_item.message.user.prompt.real.json': noFacts(real),
  'event_msg.item_completed.SubAgentActivity.started.mock.json': {
    stream: spawnRun,
    facts: [
      {
        kind: 'agent_start',
        entity_key: childAgent,
        speaker: 'runtime',
        urgent: false,
        at: millis(1790856414961),
        runtime_ids: { session_id: spawnRoot, thread_id: spawnRoot, agent_id: spawnChild, turn_id: spawnTurn },
        payload: {
          role: 'subagent',
          description: '/root/probe_child',
          parent: { kind: 'main' },
          spawned_by_call: 'call_mock_33',
          depth: null,
        },
      },
    ],
  },
  'event_msg.item_completed.SubAgentActivity.completed.mock.json': {
    stream: spawnRun,
    facts: [
      {
        kind: 'agent_end',
        entity_key: childAgent,
        speaker: 'runtime',
        urgent: true,
        at: millis(1790856415120),
        runtime_ids: { agent_id: spawnChild, turn_id: spawnTurn },
        payload: { outcome: 'completed', final_message: null },
      },
    ],
  },
  'event_msg.item_completed.CollabAgentToolCall.wait.mock.json': {
    stream: spawnRun,
    facts: [
      {
        kind: 'action_start',
        entity_key: action(spawnRun, 'call_mock_35'),
        speaker: 'solver',
        at: millis(1790856415014),
        runtime_ids: { call_id: 'call_mock_35', turn_id: spawnTurn },
        payload: {
          tool: 'CollabAgentToolCall',
          action_kind: 'agent',
          input: { tool: 'wait', sender_thread_id: spawnRoot, receiver_thread_ids: [], prompt: null },
        },
      },
      {
        kind: 'action_end',
        entity_key: action(spawnRun, 'call_mock_35'),
        urgent: false,
        at: millis(1790856415120),
        payload: { outcome: 'ok', output: null, duration_ms: 106, result: {} },
      },
    ],
  },
  'response_item.agent_message.child-final-to-parent.mock.json': {
    stream: spawnRun,
    facts: [
      {
        kind: 'message',
        entity_key: { kind: 'message', session: spawnRoot, message: `${spawnRoot}:23` },
        speaker: 'solver',
        urgent: false,
        at: iso('2026-10-01T12:06:55.144Z'),
        runtime_ids: { turn_id: spawnTurn, message_id: 'amsg_01a0f75c-47a8-7e40-82f8-06a4718829a3' },
        payload: {
          text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/probe_child\nPayload:\nCHILD DONE',
          final: false,
          audience: 'agent',
          model: null,
        },
      },
    ],
  },
  'response_item.agent_message.new-task-in-child.mock.json': {
    stream: childRun,
    facts: [
      {
        kind: 'message',
        entity_key: { kind: 'message', session: spawnRoot, message: `${spawnChild}:9` },
        speaker: 'solver',
        runtime_ids: { session_id: spawnRoot, thread_id: spawnChild, turn_id: childTurn },
        payload: {
          text: 'Message Type: NEW_TASK\nTask name: /root/probe_child\nSender: /root\nPayload:\n',
          final: false,
          audience: 'agent',
        },
      },
    ],
  },
  'inter_agent_communication_metadata.mock.json': noFacts(spawnRun),
  'token_usage_record.real.json': {
    stream: real,
    facts: [
      {
        kind: 'usage',
        entity_key: {
          kind: 'usage',
          runtime: 'codex',
          session: realThread,
          usage: `${realThread}:resp_00a7ba1502c50863016abe4a6679b887d29972f57cdb348c7b`,
        },
        speaker: 'runtime',
        urgent: false,
        at: iso('2026-10-01T11:56:25.076Z'),
        runtime_ids: {
          turn_id: '01a0f752-4102-7740-9432-0533263c2dc1',
          message_id: 'resp_00a7ba1502c50863016abe4a6679b887d29972f57cdb348c7b',
          ordinal: 11,
        },
        payload: { model: null, tokens: firstResponse, stop_reason: null, synthetic: false },
      },
      {
        kind: 'usage_total',
        entity_key: session(real),
        speaker: 'runtime',
        urgent: false,
        payload: { source: 'thread_token_usage', tokens: firstResponse },
      },
    ],
  },
  'token_usage_record.subagent.mock.json': {
    stream: childRun,
    facts: [
      {
        kind: 'usage',
        entity_key: { kind: 'usage', session: spawnRoot, usage: `${spawnChild}:resp_mock_38` },
        runtime_ids: { session_id: spawnRoot, thread_id: spawnChild, turn_id: childTurn },
        payload: {
          tokens: {
            uncached_input_tokens: 1000,
            cache_read_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
          },
        },
      },
      { kind: 'usage_total', entity_key: childAgent, payload: { source: 'thread_token_usage' } },
    ],
  },
  'event_msg.token_count.real.json': {
    stream: real,
    facts: [
      {
        kind: 'usage_total',
        entity_key: session(real),
        at: iso('2026-10-01T11:56:25.140Z'),
        runtime_ids: { turn_id: null, ordinal: 14 },
        payload: { source: 'token_count', tokens: firstResponse },
      },
    ],
  },
  'event_msg.token_count.after-compaction.real.json': {
    stream: real,
    facts: [
      {
        kind: 'usage_total',
        payload: {
          source: 'token_count',
          tokens: {
            uncached_input_tokens: 2272,
            cache_read_input_tokens: 26368,
            cache_write_input_tokens: 0,
            output_tokens: 32,
            reasoning_output_tokens: 0,
          },
        },
      },
    ],
  },
  'compacted.remote.real.json': {
    stream: real,
    facts: [
      {
        kind: 'compaction',
        entity_key: session(real),
        speaker: 'runtime',
        urgent: true,
        at: iso('2026-10-01T12:00:18.080Z'),
        payload: { phase: 'boundary', trigger: 'unknown', summary: null, tokens_before: null },
      },
    ],
  },
  'compacted.inline-local.mock.json': {
    stream: compactRun,
    facts: [
      {
        kind: 'compaction',
        entity_key: session(compactRun),
        payload: {
          phase: 'boundary',
          summary: inlineSummary,
        },
      },
    ],
  },
  'event_msg.thread_settings_applied.real-resume.json': unrecognized(real),
  'world_state.real.json': unrecognized(real),
}

test('every rollout sample has an expectation', () => {
  expect(Object.keys(expectations).sort()).toEqual(sampleFiles())
})

test.each(Object.entries(expectations))('%s', (name, expectation) => {
  const line = sampleLine(name)
  const stream = expectation.stream === 'own' ? streamFrom(line) : expectation.stream
  const result = codexAdapter.parse(record(line, stream))

  if (expectation.facts === undefined) {
    expect(result.parse_state).toBe('unknown')
    return
  }
  const facts = factsOf(result)
  expect(facts).toMatchObject(expectation.facts)
  expect(facts.every((fact) => fact.format_verified && fact.redelivery_key === null)).toBe(true)
})
