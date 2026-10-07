import {
  type FactId,
  type ObserverAttentionKind,
  type ObserverInput,
  type ObserverOp,
  type ObserverOutput,
  type SnapshotAttentionItem,
  type StageRef,
  TempId,
} from '@aang/contract'
import { z } from 'zod'
import { createStage, finalSolverTexts, mainStageTitle, planMap, sentFacts } from './observer.js'

export const checksStageTitle = 'Checks'
export const releaseStageTitle = 'Release'
export const checksBlockerText = 'The checks wait for a missing secret'
export const reviewRequestText = 'Review the final result'

const PromptText = z.object({ text: z.string() })

interface PlannedStage {
  readonly ref: StageRef
  readonly ops: ObserverOp[]
}

interface HumanPrompt {
  readonly fact: FactId
  readonly text: string
}

const plannedStage = (input: ObserverInput, title: string, id: string, evidence: FactId[]): PlannedStage => {
  const known = input.model.stages.find((stage) => stage.title === title)
  return known === undefined
    ? { ref: { kind: 'new', temp_id: TempId.parse(id) }, ops: [createStage(id, title, null, null, evidence)] }
    : { ref: { kind: 'existing', id: known.id }, ops: [] }
}

const observerItemExists = (input: ObserverInput, kind: ObserverAttentionKind, text: string): boolean =>
  input.model.attention.some((item) => item.author === 'observer' && item.kind === kind && item.text === text)

const openRuleItems = (input: ObserverInput): SnapshotAttentionItem[] =>
  input.model.attention.filter(({ author, resolution }) => author === 'rule' && resolution === 'open')

const humanPrompts = (input: ObserverInput): HumanPrompt[] =>
  input.batch.facts.flatMap((fact) => {
    const prompt = PromptText.safeParse(fact.payload)
    return fact.kind === 'prompt' && fact.speaker === 'human' && prompt.success
      ? [{ fact: fact.id, text: prompt.data.text }]
      : []
  })

const answersTo = (item: SnapshotAttentionItem, prompts: readonly HumanPrompt[]): FactId[] =>
  item.kind === 'question' && !item.likely_resolved && item.text.trim() !== ''
    ? prompts.filter(({ text }) => text.includes(item.text)).map(({ fact }) => fact)
    : []

const ruleItemOps = (input: ObserverInput, evidence: FactId[]): ObserverOp[] => {
  const prompts = humanPrompts(input)
  return openRuleItems(input).flatMap((item) => {
    const priority: ObserverOp = {
      op: 'attention.priority',
      item: { kind: 'existing', id: item.id },
      priority: 'high',
      evidence,
      rationale: 'The run waits for the human on this request',
    }
    const answers = answersTo(item, prompts)
    if (answers.length === 0) {
      return [priority]
    }
    const likely: ObserverOp = {
      op: 'attention.likely_resolved',
      item: item.id,
      evidence: answers,
      rationale: 'The human prompt repeats the question and answers it',
    }
    return [priority, likely]
  })
}

export const attentionScript = (input: ObserverInput): ObserverOutput => {
  const { ops, root } = planMap(input, mainStageTitle)
  const evidence = sentFacts(input)
  const checks = plannedStage(input, checksStageTitle, 'checks', evidence)
  const release = plannedStage(input, releaseStageTitle, 'release', evidence)
  ops.push(...checks.ops, ...release.ops)
  if (checks.ops.length > 0 || release.ops.length > 0) {
    ops.push({
      op: 'stage.depends',
      stage: release.ref,
      depends_on: checks.ref,
      via: null,
      evidence,
      rationale: 'The release waits for the checks',
    })
  }
  if (!observerItemExists(input, 'blocker', checksBlockerText)) {
    ops.push({
      op: 'attention.add',
      temp_id: TempId.parse('blocker'),
      kind: 'blocker',
      text: checksBlockerText,
      stage: checks.ref,
      evidence,
      rationale: 'The checks cannot run without the secret',
    })
  }
  const finals = finalSolverTexts(input)
  if (finals.length > 0 && !observerItemExists(input, 'review_request', reviewRequestText)) {
    ops.push({
      op: 'attention.add',
      temp_id: TempId.parse('review'),
      kind: 'review_request',
      text: reviewRequestText,
      stage: root,
      evidence: finals.map(({ fact }) => fact),
      rationale: 'The solver hands over its final result',
    })
  }
  ops.push(...ruleItemOps(input, evidence))
  return { base_version: input.model.version, ops, needs: [] }
}
