import type { ActionStartPayload, Execution, Fact, SessionState } from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import { agentKey, byTime, type Evidence } from './evidence.js'

interface TurnState {
  readonly state: SessionState
  readonly execution: Execution
}

const statusTime = ({ fact }: Evidence): bigint =>
  fact.kind === 'json_snapshot' && fact.payload.file === 'registry'
    ? fact.payload.content?.status_updated_at ?? fact.at
    : fact.at

const priority = ({ fact }: Evidence): number => {
  switch (fact.kind) {
    case 'session_start': return 0
    case 'turn_start':
    case 'prompt': return 1
    case 'action_start': return 2
    case 'action_end': return 3
    case 'permission_request':
    case 'question_asked': return 4
    case 'question_answered': return 5
    case 'turn_end': return 7
    case 'session_end': return 8
    default: return 6
  }
}

const byStatusTime = (left: Evidence, right: Evidence): number => {
  const a = statusTime(left)
  const b = statusTime(right)
  return a < b ? -1 : a > b ? 1 : priority(left) - priority(right) || byTime(left, right)
}

const agentName = (fact: Fact): string | null => {
  const { agent } = agentKey(fact)
  switch (agent.kind) {
    case 'subagent': return agent.agent_id
    case 'thread': return agent.thread_id
    default: return null
  }
}

export const turnState = (items: readonly Evidence[], all: readonly Evidence[] = items): TurnState => {
  let status: TurnState = { state: 'unknown', execution: { state: 'unknown' } }
  const waits = new Map<string, Set<string> | null>()
  const calls = new Map<string, ActionStartPayload>()
  const answers = new Map<string, Set<string>>()
  const background = new Set<string>()
  const nonblocking = new Set(items.filter(({ fact }) => fact.kind === 'question_asked' && !fact.payload.blocking).map(({ fact }) => fact.seq))
  const running = (): TurnState => {
    waits.delete('registry')
    return { state: 'turn_running', execution: { state: 'running' } }
  }
  const idle = (): TurnState => {
    waits.clear()
    calls.clear()
    return { state: 'turn_done', execution: { state: 'waiting', reason: 'idle' } }
  }
  const finishCall = (call: string): void => {
    calls.delete(call)
    for (const [question, candidates] of waits) {
      if (candidates?.delete(call) === true && candidates.size === 0) { waits.delete(question) }
    }
  }
  for (const { fact } of items.toSorted(byStatusTime)) {
    switch (fact.kind) {
      case 'session_start':
        if (status.state === 'ended' && fact.payload.launch === 'resume') {
          status = { state: 'unknown', execution: { state: 'unknown' } }
        }
        break
      case 'turn_start':
        waits.clear()
        calls.clear()
        background.clear()
        status = running()
        break
      case 'prompt':
        if (fact.speaker === 'human') {
          waits.clear()
          status = running()
        }
        break
      case 'message':
        if (nonblocking.has(fact.seq) || status.state === 'ended') { break }
        if (fact.payload.final) { status = idle() }
        else { status = running() }
        break
      case 'action_start':
        if (status.state !== 'ended') { status = running() }
        if (fact.entity_key.kind === 'action') { calls.set(fact.entity_key.call, fact.payload) }
        break
      case 'action_end':
        if (status.state !== 'ended') { status = running() }
        if (fact.entity_key.kind === 'action') { finishCall(fact.entity_key.call) }
        break
      case 'permission_request': {
        if (status.state === 'ended') { break }
        status = running()
        const candidates = [...calls].filter(([, call]) =>
          call.tool === fact.payload.tool && canonicalJson(call.input) === canonicalJson(fact.payload.input),
        ).map(([call]) => call)
        waits.set(canonicalJson(fact.entity_key), candidates.length === 0 ? null : new Set(candidates))
        break
      }
      case 'question_asked':
        if (fact.payload.blocking && status.state !== 'ended') {
          status = running()
          const question = fact.entity_key.kind === 'question' ? fact.entity_key.question : canonicalJson(fact.entity_key)
          waits.set(question, new Set([question]))
          const call = fact.runtime_ids.call_id
          if (call !== null) { answers.set(call, (answers.get(call) ?? new Set<string>()).add(question)) }
        }
        break
      case 'permission_denied':
      case 'permission_decision':
        if (fact.entity_key.kind === 'action') { finishCall(fact.entity_key.call) }
        break
      case 'tool_batch_end':
        for (const { call_id: call } of fact.payload.calls) { finishCall(call) }
        break
      case 'question_answered': {
        const call = fact.runtime_ids.call_id
        const questions = fact.entity_key.kind === 'question' ? [fact.entity_key.question] : call === null ? [] : answers.get(call) ?? []
        for (const question of questions) { waits.delete(question) }
        break
      }
      case 'notification':
        if (fact.payload.notification_type === 'idle_prompt' && status.state !== 'ended') { status = idle() }
        break
      case 'json_snapshot': {
        if (fact.payload.file !== 'registry' || fact.payload.removed || status.state === 'ended') { break }
        const registryStatus = fact.payload.content?.status
        if (registryStatus === 'busy') {
          waits.clear()
          status = running()
        } else if (registryStatus === 'waiting') {
          status = running()
          waits.set('registry', null)
        } else if (registryStatus === 'idle') { status = idle() }
        break
      }
      case 'turn_end':
        if (status.state === 'ended') { break }
        status = idle()
        background.clear()
        for (const task of fact.payload.background_tasks) {
          if (task.status !== 'running' && task.status !== 'pending') { continue }
          const ended = all.some(({ fact: later }) =>
            later.kind === 'agent_end' && agentName(later) === task.id && later.at >= fact.at,
          )
          if (!ended) { background.add(task.id) }
        }
        if (fact.payload.outcome !== 'completed') {
          status = { ...status, execution: { state: fact.payload.outcome === 'failed' ? 'failed' : fact.payload.outcome === 'interrupted' ? 'cancelled' : 'unknown' } }
        }
        break
      case 'session_end':
        status = { state: 'ended', execution: { state: 'done' } }
        waits.clear()
        background.clear()
        break
    }
  }
  if (status.state === 'turn_running' && waits.size > 0) {
    status = { ...status, execution: { state: 'waiting', reason: 'human' } }
  } else if (status.state === 'turn_done' && status.execution.state === 'waiting' && background.size > 0) {
    status = { ...status, execution: { state: 'waiting', reason: 'background' } }
  }
  return status
}
