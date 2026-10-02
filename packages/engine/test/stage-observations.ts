import { Action, Agent, type ArtifactVersion, type Fact } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
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

export const recordObjectOwners = (home: Home, objects: readonly (Action | Agent | ArtifactVersion)[]): void => {
  const database = home.database()
  const insert = database.prepare(
    'INSERT INTO objects (id, kind, entity_key, run_id, data, change_seq) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const object of objects) {
    insert.run(object.id, object.key.kind, canonicalJson(object.key), object.run, '{}', object.change_seq)
  }
  database.close()
}
