import { ArtifactVersion, ObserverCallId, type ObserverOp } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { applyObserverResponse } from '@aang/engine'
import { expect, test } from 'vitest'
import { at, runA, stages } from './model.js'
import { callId, existing, response, setupObserver, version } from './observer-fixtures.js'
import { observationsFor, recordObjectOwners } from './stage-observations.js'

test('preserves distinct artifact inputs, outputs and dependencies across repeated responses and replay', async ({ onTestFinished }) => {
  const { store, home, facts, solver, human, begin } = await setupObserver(onTestFinished)
  const { action } = observationsFor(facts)
  const artifact = { kind: 'file', path: '/workspace/report.txt' } as const
  const key = { kind: 'artifact_version', run: runA, artifact, identity: { kind: 'reference', fact: solver.id } } as const
  const artifactVersion = ArtifactVersion.parse({
    id: objectId(key), key, run: runA, artifact: objectId({ kind: 'artifact', run: runA, artifact }),
    ref: artifact, retention: { kind: 'reference' }, produced_by: action.id, observed_at: at(10), change_seq: 1,
  })
  recordObjectOwners(home, [artifactVersion])
  const operations = (evidence: typeof solver.id[]): ObserverOp[] => [
    { op: 'artifact.link', stage: existing(stages.build), version: artifactVersion.id, direction: 'input', evidence, rationale: 'Input' },
    { op: 'artifact.link', stage: existing(stages.build), version: artifactVersion.id, direction: 'output', evidence, rationale: 'Output' },
    { op: 'artifact.link', stage: existing(stages.test), version: artifactVersion.id, direction: 'input', evidence, rationale: 'Shared version' },
    { op: 'stage.depends', stage: existing(stages.test), depends_on: existing(stages.build), via: artifactVersion.id, evidence, rationale: 'Uses the result' },
  ]
  begin([solver])
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), output: response(operations([solver.id]), 2),
  })).status).toBe('accepted')
  const before = store.model.entities(runA).filter((entity) => entity.kind === 'link')
  expect(before).toHaveLength(4)
  const call = ObserverCallId.parse('repeat-artifacts')
  const input = begin([human], call)
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call, at: at(30), output: response(operations([human.id]), input.model.version),
  })).status).toBe('accepted')
  const links = store.model.entities(runA).filter((entity) => entity.kind === 'link')
  expect(links.map(({ value }) => value.id)).toEqual(before.map(({ value }) => value.id))
  expect(links.map(({ value }) => value)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'artifact', stage: stages.build, direction: 'input', version: artifactVersion.id }),
    expect.objectContaining({ kind: 'artifact', stage: stages.build, direction: 'output', version: artifactVersion.id }),
    expect.objectContaining({ kind: 'artifact', stage: stages.test, direction: 'input', version: artifactVersion.id }),
    expect.objectContaining({ kind: 'dependency', stage: stages.test, depends_on: stages.build, via: artifactVersion.id }),
  ]))
  expect(links.every(({ value }) => value.basis.kind === 'interpreted' && value.evidence[0] === human.id)).toBe(true)
  expect(store.model.changes(runA, version(3))).toHaveLength(4)
  store.transaction((transaction) => { transaction.model.replay() })
  expect(store.model.entities(runA).filter((entity) => entity.kind === 'link')).toEqual(links)
})
