import { Action, Agent, type ArtifactVersion, type Fact } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import type { Home } from './home.js'
import { runA, sessionA } from './model.js'

export const observationsFor = (facts: readonly Fact[]) => {
  const start = facts.find((fact) => fact.kind === 'action_start' && fact.entity_key.kind === 'action')
  if (start?.kind !== 'action_start' || start.entity_key.kind !== 'action') {
    throw new Error('the transcript must contain an action start')
  }
  const agentKey = {
    kind: 'agent',
    runtime: start.entity_key.runtime,
    session: start.entity_key.session,
    agent: { kind: 'main' },
  } as const
  const agent = Agent.parse({
    id: objectId(agentKey), key: agentKey, session: sessionA, run: runA,
    role: 'main', service: null, agent_type: null, agent_role: null, name: null, description: null,
    parent: null, spawned_by: null, execution: { state: 'done' }, thread_total: null,
    started_at: start.at, ended_at: start.at, change_seq: 1,
  })
  const action = Action.parse({
    id: objectId(start.entity_key), key: start.entity_key, session: sessionA, agent: agent.id, run: runA,
    tool: start.payload.tool, action_kind: start.payload.action_kind, container: null, is_container: false,
    started_at: start.at, ended_at: null, outcome: null, execution: { state: 'running' },
    input_fact: start.id, output_fact: null, inherited: false, change_seq: 1,
  })
  return { action, agent: { ...agent, execution_evidence: [start.id] }, start }
}

export const recordObjectOwners = (store: Store, owned: readonly (Action | Agent)[]): void => {
  store.transaction((transaction) => {
    for (const { key, run } of owned) {
      const observation = key.kind === 'action'
        ? transaction.observations.getAction(objectId(key))
        : transaction.observations.getAgent(objectId(key))
      if (observation === null) {
        throw new Error(`the ingested facts must project ${canonicalJson(key)}`)
      }
      transaction.observations.save({ ...observation, run })
    }
  })
}

export const recordArtifactVersion = (home: Home, version: ArtifactVersion): void => {
  const database = home.database()
  database.prepare(
    'INSERT INTO objects (id, kind, entity_key, run_id, data, change_seq, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(version.id, version.key.kind, canonicalJson(version.key), version.run, '{}', version.change_seq, version.change_seq)
  database.close()
}
