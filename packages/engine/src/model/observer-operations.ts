import { randomUUID } from 'node:crypto'
import {
  AttentionItemId,
  type AttentionRef,
  CardId,
  CriterionId,
  type EpochNs,
  LinkId,
  type ObserverOp,
  StageId,
  type StageRef,
} from '@aang/contract'
import type { AttentionItemDraft, ModelEntityDraft, StageDraft } from './journal.js'
import { ObserverContext } from './observer-context.js'
import { stageLinkKey } from './stage-links.js'

const requiredText = (context: ObserverContext, text: string): void => {
  context.check(text.trim().length > 0, 'invariant', 'text must not be empty')
}

export const planOperation = (context: ObserverContext, op: ObserverOp, at: EpochNs): void => {
  const facts = context.facts(op)
  const basis = context.basis(op, facts)
  const { run } = context.call
  const put = (entity: ModelEntityDraft): void => {
    if (entity.kind === 'link' && 'stage' in entity.value) {
      const key = stageLinkKey(entity.value)
      for (const current of context.entities.values()) {
        if (current.kind === 'link' && 'stage' in current.value && stageLinkKey(current.value) === key) {
          entity = { kind: 'link', value: { ...entity.value, id: current.value.id } }
          break
        }
      }
    }
    context.put(op, entity, basis)
  }
  const stageId = (ref: StageRef, fields: readonly string[] = []) =>
    StageId.parse(context.id('stage', ref, fields))
  const stage = (ref: StageRef, fields: readonly string[] = []) => context.get('stage', stageId(ref, fields))
  const saveStage = (value: StageDraft): void => {
    put({ kind: 'stage', value })
    context.rememberSuccessors(value.id, value.lifecycle)
    context.checkGraphs()
  }
  const attention = (ref: AttentionRef, fields: readonly string[]): AttentionItemDraft =>
    context.get('attention_item', context.id('attention_item', ref, fields))
  const link = () => ({ id: LinkId.parse(randomUUID()), run, basis, evidence: op.evidence })
  const hasPlan = facts.some(({ kind }) => kind === 'plan_update')
  switch (op.op) {
    case 'stage.create': {
      requiredText(context, op.title)
      context.check(op.origin !== 'plan' || hasPlan, 'invariant', 'origin plan requires a plan fact')
      const id = stageId({ kind: 'new', temp_id: op.temp_id })
      saveStage({
        id,
        run,
        title: op.title,
        expected_result: op.expected_result,
        summary: op.summary,
        parent: op.parent === null ? null : stageId(op.parent),
        origin: op.origin,
        lifecycle: { state: 'active' },
        execution: { value: { state: 'planned' }, basis, evidence: op.evidence },
        execution_claim: null,
        decision: { value: 'none', basis, evidence: op.evidence },
        session_moved: false,
        basis,
        evidence: op.evidence,
      })
      return
    }
    case 'stage.update': {
      const fields = ['title', 'expected_result', 'summary'] as const
      const changed = fields.filter((field) => op[field] !== null)
      if (op.title !== null) {
        requiredText(context, op.title)
      }
      saveStage({
        ...stage(op.stage, changed),
        ...Object.fromEntries(changed.map((field) => [field, op[field]])),
        basis,
        evidence: op.evidence,
      })
      return
    }
    case 'stage.state': {
      const current = stage(op.stage, ['execution', 'execution_claim'])
      const claim = { value: op.execution, basis, evidence: op.evidence }
      const prior = current.execution.basis
      const ruled =
        prior.kind === 'observed' ||
        (prior.kind === 'interpreted' &&
          prior.interpreter.kind === 'rule' &&
          ['running', 'waiting'].includes(current.execution.value.state))
      saveStage({
        ...current,
        execution: ruled ? current.execution : claim,
        execution_claim: ruled ? claim : null,
      })
      return
    }
    case 'stage.nest':
      saveStage({ ...stage(op.stage, ['parent']), parent: op.parent === null ? null : stageId(op.parent) })
      return
    case 'stage.replace':
    case 'stage.split': {
      const current = stage(op.stage, ['lifecycle'])
      const into = (op.op === 'stage.replace' ? op.by : op.into).map((ref) => stageId(ref))
      context.check(
        new Set(into).size === into.length && into.length >= (op.op === 'stage.split' ? 2 : 1),
        'invariant',
        'successors must be distinct and nonempty; split requires two',
      )
      saveStage({
        ...current,
        lifecycle: op.op === 'stage.replace' ? { state: 'replaced', by: into } : { state: 'split', into },
      })
      return
    }
    case 'stage.merge': {
      const sources = op.stages.map((ref) => stage(ref, ['lifecycle']))
      const into = stageId(op.into)
      context.check(
        sources.length >= 2 && new Set(sources.map(({ id }) => id)).size === sources.length,
        'invariant',
        'merge requires two distinct stages',
      )
      for (const source of sources) {
        saveStage({ ...source, lifecycle: { state: 'merged', into } })
      }
      return
    }
    case 'stage.depends': {
      const id = stageId(op.stage)
      const depends_on = stageId(op.depends_on)
      context.check(id !== depends_on, 'invariant', 'a stage cannot depend on itself')
      if (op.via !== null) {
        context.object('artifact_version', op.via)
      }
      put({ kind: 'link', value: { ...link(), kind: 'dependency', stage: id, depends_on, via: op.via } })
      return
    }
    case 'actions.assign': {
      const id = stageId(op.stage)
      for (const action of op.actions) {
        context.object('action', action)
        put({ kind: 'link', value: { ...link(), kind: 'assignment', action, stage: id } })
      }
      return
    }
    case 'agents.participate': {
      const id = stageId(op.stage)
      for (const agent of op.agents) {
        context.object('agent', agent)
        put({ kind: 'link', value: { ...link(), kind: 'participation', agent, stage: id } })
      }
      return
    }
    case 'artifact.link':
      context.object('artifact_version', op.version)
      put({
        kind: 'link',
        value: {
          ...link(),
          kind: 'artifact',
          stage: stageId(op.stage),
          version: op.version,
          direction: op.direction,
        },
      })
      return
    case 'criterion.add':
      requiredText(context, op.text)
      context.check(op.source !== 'plan' || hasPlan, 'invariant', 'plan criterion requires a plan fact')
      put({
        kind: 'criterion',
        value: {
          id: CriterionId.parse(context.id('criterion', { kind: 'new', temp_id: op.temp_id })),
          run,
          stage: op.stage === null ? null : stageId(op.stage),
          text: op.text,
          source: op.source,
          contract: null,
          status: { value: 'not_checked', basis, evidence: op.evidence },
          checked_commit: null,
          clean_tree_commit: null,
        },
      })
      return
    case 'criterion.assess': {
      const current = context.get('criterion', context.id('criterion', op.criterion, ['status']))
      put({
        kind: 'criterion',
        value: { ...current, status: { value: op.status, basis, evidence: op.evidence } },
      })
      return
    }
    case 'card.add': {
      requiredText(context, op.text)
      const source = context.facts({ ...op, evidence: [op.source.fact] })[0]
      context.check(
        source?.kind === 'message' && source.speaker === 'solver' && source.payload.final,
        'invariant',
        'a card must cite a final solver message',
      )
      context.check(
        op.source.start < op.source.end && op.source.end <= source.payload.text.length,
        'invariant',
        'card coordinates are outside the original message',
      )
      context.check(
        op.text === source.payload.text.slice(op.source.start, op.source.end),
        'invariant',
        'card text does not match the original message fragment',
      )
      put({
        kind: 'card',
        value: {
          id: CardId.parse(randomUUID()),
          run,
          stages: op.stages.map((ref) => stageId(ref)),
          text: op.text,
          source: op.source,
          basis,
          evidence: op.evidence,
        },
      })
      return
    }
    case 'brief.update': {
      const current = context.get('run', run)
      const changes = context.transaction.model.entityChanges(
        run,
        { kind: 'run', id: run },
        context.call.base_version,
      )
      context.check(
        !changes.some(
          ({ author, before, after }) =>
            author === 'user' &&
            before?.kind === 'run' &&
            after?.kind === 'run' &&
            before.value.brief?.text !== after.value.brief?.text,
        ),
        'conflict',
        'user changed the run brief',
      )
      put({ kind: 'run', value: { ...current, brief: { text: op.text, basis, evidence: op.evidence } } })
      return
    }
    case 'question.add':
    case 'attention.add':
      requiredText(context, op.text)
      put({
        kind: 'attention_item',
        value: {
          id: AttentionItemId.parse(context.id('attention_item', { kind: 'new', temp_id: op.temp_id })),
          run,
          kind: op.op === 'question.add' ? 'question' : op.kind,
          author: 'observer',
          text: op.text,
          stage: op.stage === null ? null : stageId(op.stage),
          question: null,
          action: null,
          basis,
          evidence: op.evidence,
          runtime_wait: 'none',
          resolution: 'open',
          likely_resolved: null,
          priority: null,
          opened_at: at,
          closed_at: null,
        },
      })
      return
    case 'attention.resolve': {
      const current = attention(op.item, ['resolution', 'closed_at'])
      context.check(current.author === 'observer', 'invariant', 'observer cannot close rule attention')
      context.check(facts.length > 0, 'invariant', 'resolving attention requires evidence')
      put({ kind: 'attention_item', value: { ...current, resolution: op.resolution, closed_at: at } })
      return
    }
    case 'attention.likely_resolved': {
      const current = attention({ kind: 'existing', id: op.item }, ['likely_resolved'])
      context.check(
        current.author === 'rule' && facts.length > 0,
        'invariant',
        'likely resolved requires rule attention and evidence',
      )
      put({
        kind: 'attention_item',
        value: { ...current, likely_resolved: { basis, evidence: op.evidence } },
      })
      return
    }
    case 'attention.priority': {
      const current = attention(op.item, ['priority'])
      put({
        kind: 'attention_item',
        value: { ...current, priority: { value: op.priority, call: context.call.id } },
      })
    }
  }
}
