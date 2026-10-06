import {
  type ActionId,
  type AgentId,
  type CriterionRef,
  type FactId,
  type InputFact,
  type JsonValue,
  ObserverInput,
  type ObserverOp,
  type ObserverOpOf,
  type ObserverOutput,
  type RunAgentBrief,
  type SnapshotStage,
  type StageRef,
  TempId,
} from '@aang/contract'
import { z } from 'zod'
import { ScenarioError } from '../fake-cli/scenario-error.js'

export const mainStageTitle = 'Main work'
export const continuedStageTitle = 'Main work, continued'
export const goalCriterionText = 'The goal of the run is reached'
export const continuationQuestionText = 'Is the result of the continued run accepted?'
export const preparationStageTitle = 'Preparation'
export const reportStageTitle = 'Report'
export const reportQuestionText = 'Is the report accepted?'
export const splitStageTitles = ['Changes', 'Checks'] as const
export const mergedStageTitle = 'Changes and checks'
export const branchStageTitles = { build: 'Build', compile: 'Compile', verify: 'Verify', test: 'Test' } as const
export const nestedStageTitles = { release: 'Release', bundle: 'Bundle', sign: 'Sign' } as const

const nonblank = z.string().refine((text) => text.trim() !== '')

const FinalSolverText = z.object({ text: nonblank, final: z.literal(true), audience: z.literal('user') })

const PromptText = z.object({ text: nonblank })

const AgentCall = z.object({ action_kind: z.literal('agent') })

const briefLength = 200

interface FinalText {
  readonly fact: FactId
  readonly text: string
}

interface MapPlan {
  readonly ops: ObserverOp[]
  readonly root: StageRef
  readonly criterion: CriterionRef | null
  readonly agentStages: ReadonlyMap<AgentId, StageRef>
}

interface Layout {
  readonly ops: ObserverOp[]
  readonly place: (fact: InputFact) => StageRef | undefined
}

const byAgent = (): Layout => ({ ops: [], place: () => undefined })

export const readObserverInput = (input: JsonValue | undefined): ObserverInput => {
  const parsed = ObserverInput.safeParse(input)
  if (!parsed.success) {
    throw new ScenarioError(`the prompt carries no observer input: ${parsed.error.message}`)
  }
  return parsed.data
}

const temp = (id: string): TempId => TempId.parse(id)

export const sentFacts = (input: ObserverInput): FactId[] => [
  ...new Set([...input.batch.facts.map(({ id }) => id), ...input.batch.collapsed.flatMap(({ facts }) => facts)]),
]

const stageTitled = (input: ObserverInput, title: string): SnapshotStage | undefined =>
  input.model.stages.find((stage) => stage.title === title)

const delegated = (agent: RunAgentBrief): boolean =>
  (agent.role === 'subagent' || agent.role === 'teammate') && agent.service === null

export const agentStageTitle = (agent: RunAgentBrief): string =>
  `${agent.agent_type ?? agent.name ?? agent.role} (${agent.id})`

const stageOfAgent = (input: ObserverInput, agent: RunAgentBrief): SnapshotStage | undefined =>
  input.model.stages.find((stage) => stage.title.endsWith(` (${agent.id})`))

const agentStageUpdate = (
  known: SnapshotStage,
  agent: RunAgentBrief,
  evidence: FactId[],
): ObserverOpOf<'stage.update'>[] => {
  const title = agentStageTitle(agent)
  const retitled = known.title === title ? null : title
  const expected = known.expected_result === agent.description ? null : agent.description
  return retitled === null && expected === null
    ? []
    : [
        {
          op: 'stage.update',
          stage: { kind: 'existing', id: known.id },
          title: retitled,
          expected_result: expected,
          summary: null,
          evidence,
          rationale: 'The metadata of the delegated agent became known',
        },
      ]
}

const factsOfAgent = (input: ObserverInput, agent: AgentId): FactId[] =>
  input.batch.facts.filter((fact) => fact.agent === agent).map(({ id }) => id)

export const finalSolverTexts = (input: ObserverInput): FinalText[] =>
  input.batch.facts.flatMap((fact) => {
    const payload = FinalSolverText.safeParse(fact.payload)
    return fact.kind === 'message' && fact.speaker === 'solver' && fact.truncated.length === 0 && payload.success
      ? [{ fact: fact.id, text: payload.data.text }]
      : []
  })

const briefUpdate = (input: ObserverInput): ObserverOpOf<'brief.update'>[] => {
  if (input.run.brief !== null) {
    return []
  }
  for (const fact of input.batch.facts) {
    const prompt = PromptText.safeParse(fact.payload)
    if (fact.kind === 'prompt' && fact.speaker === 'human' && prompt.success) {
      const goal = input.run.goal ?? prompt.data.text
      return [
        {
          op: 'brief.update',
          text: `Working towards: ${goal.slice(0, briefLength)}`,
          evidence: [fact.id],
          rationale: 'Retelling of the task the human gave',
        },
      ]
    }
  }
  return []
}

const batchSummary = (input: ObserverInput): string => {
  const actions = new Set(input.batch.facts.flatMap(({ action }) => (action === null ? [] : [action])))
  const backlog = input.batch.backlog
  const restored = backlog === null ? '' : `; restored from a summary of ${String(backlog.facts)} earlier facts`
  return `Latest batch: ${String(sentFacts(input).length)} facts, ${String(actions.size)} actions${restored}`
}

export const createStage = (
  id: string,
  title: string,
  expected: string | null,
  parent: StageRef | null,
  evidence: FactId[],
  summary: string | null = null,
): ObserverOpOf<'stage.create'> => ({
  op: 'stage.create',
  temp_id: temp(id),
  title,
  expected_result: expected,
  summary,
  parent,
  origin: 'inferred',
  evidence,
  rationale: 'Work observed in the run',
})

const stageOfFact = (fact: InputFact, root: StageRef, agentStages: ReadonlyMap<AgentId, StageRef>): StageRef =>
  (fact.agent === null ? undefined : agentStages.get(fact.agent)) ?? root

const assignments = (input: ObserverInput, place: (fact: InputFact) => StageRef): ObserverOpOf<'actions.assign'>[] => {
  const groups = new Map<StageRef, { actions: Set<ActionId>; facts: FactId[] }>()
  for (const fact of input.batch.facts) {
    if (fact.action === null) {
      continue
    }
    const stage = place(fact)
    const group = groups.get(stage) ?? { actions: new Set(), facts: [] }
    group.actions.add(fact.action)
    group.facts.push(fact.id)
    groups.set(stage, group)
  }
  return [...groups].map(([stage, { actions, facts }]) => ({
    op: 'actions.assign',
    actions: [...actions],
    stage,
    evidence: facts,
    rationale: 'The actions belong to the work of this stage',
  }))
}

export const planMap = (
  input: ObserverInput,
  rootTitle: string,
  arrange: (root: StageRef) => Layout = byAgent,
): MapPlan => {
  const evidence = sentFacts(input)
  const ops: ObserverOp[] = []
  const existingRoot = stageTitled(input, rootTitle)
  const root: StageRef =
    existingRoot === undefined ? { kind: 'new', temp_id: temp('root') } : { kind: 'existing', id: existingRoot.id }
  const summary = batchSummary(input)
  ops.push(
    existingRoot === undefined
      ? createStage('root', rootTitle, input.run.goal, null, evidence, summary)
      : {
          op: 'stage.update',
          stage: root,
          title: null,
          expected_result: null,
          summary,
          evidence,
          rationale: 'Progress of the work in the latest batch',
        },
  )
  const agentStages = new Map<AgentId, StageRef>()
  input.run.agents.filter(delegated).forEach((agent, index) => {
    const grounds = factsOfAgent(input, agent.id)
    const agentEvidence = grounds.length === 0 ? evidence : grounds
    const known = stageOfAgent(input, agent)
    if (known !== undefined) {
      ops.push(...agentStageUpdate(known, agent, agentEvidence))
      agentStages.set(agent.id, { kind: 'existing', id: known.id })
      return
    }
    const id = `agent-${String(index)}`
    const stage: StageRef = { kind: 'new', temp_id: temp(id) }
    ops.push(createStage(id, agentStageTitle(agent), agent.description, root, evidence), {
      op: 'agents.participate',
      agents: [agent.id],
      stage,
      evidence: agentEvidence,
      rationale: 'The delegated agent does the work of this stage',
    })
    agentStages.set(agent.id, stage)
  })
  const layout = arrange(root)
  const stageOf = (fact: InputFact): StageRef => layout.place(fact) ?? stageOfFact(fact, root, agentStages)
  ops.push(...layout.ops, ...assignments(input, stageOf), ...briefUpdate(input))
  const knownCriterion = input.model.criteria.find(({ text }) => text === goalCriterionText)
  if (knownCriterion !== undefined) {
    return { ops, root, criterion: { kind: 'existing', id: knownCriterion.id }, agentStages }
  }
  if (rootTitle !== mainStageTitle || existingRoot !== undefined) {
    return { ops, root, criterion: null, agentStages }
  }
  ops.push({
    op: 'criterion.add',
    temp_id: temp('goal'),
    stage: root,
    text: goalCriterionText,
    source: 'task',
    evidence,
    rationale: 'The run is done when its goal is reached',
  })
  return { ops, root, criterion: { kind: 'new', temp_id: temp('goal') }, agentStages }
}

const output = (input: ObserverInput, ops: ObserverOp[]): ObserverOutput => ({
  base_version: input.model.version,
  ops,
  needs: [],
})

export const mapScript = (input: ObserverInput): ObserverOutput => output(input, planMap(input, mainStageTitle).ops)

export const claimedDoneScript = (input: ObserverInput): ObserverOutput => {
  const { ops, root, criterion } = planMap(input, mainStageTitle)
  const claim = finalSolverTexts(input).at(-1)
  if (claim === undefined) {
    return output(input, ops)
  }
  const claims = [claim.fact]
  const done: ObserverOp[] = [
    { op: 'stage.state', stage: root, execution: { state: 'done' }, evidence: claims, rationale: 'The solver reports the work done' },
  ]
  if (criterion !== null) {
    done.push({
      op: 'criterion.assess',
      criterion,
      status: 'reported_done',
      evidence: claims,
      rationale: 'The solver reports the goal reached',
    })
  }
  return output(input, [...ops, ...done])
}

export const reportScript = (input: ObserverInput): ObserverOutput => {
  const { ops, root, agentStages } = planMap(input, mainStageTitle)
  const links = input.batch.artifact_versions.flatMap((version): ObserverOpOf<'artifact.link'>[] => {
    const facts = input.batch.facts.filter(({ action }) => action !== null && action === version.produced_by)
    const [producer] = facts
    return version.ref.kind !== 'file' || producer === undefined
      ? []
      : [
          {
            op: 'artifact.link',
            stage: stageOfFact(producer, root, agentStages),
            version: version.id,
            direction: 'output',
            evidence: facts.map(({ id }) => id),
            rationale: 'The action produced this file',
          },
        ]
  })
  return output(input, [...ops, ...links])
}

export const rejectedScript = (input: ObserverInput): ObserverOutput => {
  const main = stageTitled(input, mainStageTitle)
  if (main === undefined) {
    return mapScript(input)
  }
  const stage: StageRef = { kind: 'existing', id: main.id }
  return output(input, [
    { op: 'stage.nest', stage, parent: stage, evidence: sentFacts(input), rationale: 'The main work is nested under itself' },
  ])
}

export const revisionScript = (input: ObserverInput): ObserverOutput => {
  const replaced = stageTitled(input, mainStageTitle)
  const continued = stageTitled(input, continuedStageTitle)
  const { ops, root } = planMap(input, continuedStageTitle)
  if (continued === undefined && replaced !== undefined) {
    ops.push({
      op: 'stage.replace',
      stage: { kind: 'existing', id: replaced.id },
      by: [root],
      evidence: sentFacts(input),
      rationale: 'The continued run revises the earlier work',
    })
  }
  const finals = finalSolverTexts(input)
  const asked = input.model.attention.some(
    ({ kind, author, text }) => kind === 'question' && author === 'observer' && text === continuationQuestionText,
  )
  if (finals.length > 0 && !asked) {
    ops.push({
      op: 'question.add',
      temp_id: temp('question'),
      text: continuationQuestionText,
      stage: root,
      evidence: finals.map(({ fact }) => fact),
      rationale: 'The solver awaits acceptance of the continued result',
    })
  }
  for (const { fact, text } of finals) {
    ops.push({
      op: 'card.add',
      stages: [root],
      text,
      source: { fact, start: 0, end: text.length },
      evidence: [fact],
      rationale: 'Final text of the solver',
    })
  }
  return output(input, ops)
}

export const splitScript = (input: ObserverInput): ObserverOutput => {
  const continued = stageTitled(input, continuedStageTitle)
  if (continued === undefined) {
    return output(input, [])
  }
  const evidence = sentFacts(input)
  const parent: StageRef | null = continued.parent === null ? null : { kind: 'existing', id: continued.parent }
  const parts = splitStageTitles.map((title, index) => createStage(`part-${String(index)}`, title, null, parent, evidence))
  return output(input, [
    ...parts,
    {
      op: 'stage.split',
      stage: { kind: 'existing', id: continued.id },
      into: parts.map(({ temp_id }): StageRef => ({ kind: 'new', temp_id })),
      evidence,
      rationale: 'The continued work divides into the changes and their checks',
    },
  ])
}

export const mergeScript = (input: ObserverInput): ObserverOutput => {
  const parts = splitStageTitles.flatMap((title) => stageTitled(input, title) ?? [])
  const [first] = parts
  if (first === undefined || parts.length < splitStageTitles.length) {
    return output(input, [])
  }
  const evidence = sentFacts(input)
  const parent: StageRef | null = first.parent === null ? null : { kind: 'existing', id: first.parent }
  const merged = createStage('merged', mergedStageTitle, null, parent, evidence)
  return output(input, [
    merged,
    {
      op: 'stage.merge',
      stages: parts.map(({ id }): StageRef => ({ kind: 'existing', id })),
      into: { kind: 'new', temp_id: merged.temp_id },
      evidence,
      rationale: 'The changes and their checks turn out to be one piece of work',
    },
  ])
}

const ownedByMain = (input: ObserverInput, agent: AgentId | null): boolean =>
  agent === null || input.run.agents.some(({ id, role }) => id === agent && role === 'main')

const preparationFacts = (input: ObserverInput): InputFact[] => {
  if (input.run.agents.some(delegated)) {
    return []
  }
  const spawns = new Set(
    input.batch.facts.flatMap(({ kind, action, payload }) =>
      kind === 'action_start' && action !== null && AgentCall.safeParse(payload).success ? [action] : [],
    ),
  )
  return input.batch.facts.filter(
    ({ action, agent }) => action !== null && !spawns.has(action) && ownedByMain(input, agent),
  )
}

const preparationDone = (
  input: ObserverInput,
  stage: StageRef,
  preparing: readonly InputFact[],
): ObserverOpOf<'stage.state'>[] => {
  const actions = new Set(preparing.map(({ action }) => action))
  const ends = input.batch.facts.filter(({ kind, action }) => kind === 'action_end' && actions.has(action))
  return actions.size === 0 || new Set(ends.map(({ action }) => action)).size < actions.size
    ? []
    : [
        {
          op: 'stage.state',
          stage,
          execution: { state: 'done' },
          evidence: ends.map(({ id }) => id),
          rationale: 'Every preparation action has ended',
        },
      ]
}

const reportOps = (input: ObserverInput, root: StageRef, delegatedStages: readonly StageRef[]): ObserverOp[] => {
  const claims = finalSolverTexts(input).map(({ fact }) => fact)
  if (claims.length === 0 || stageTitled(input, reportStageTitle) !== undefined) {
    return []
  }
  const evidence = sentFacts(input)
  const report: StageRef = { kind: 'new', temp_id: temp('report') }
  return [
    createStage('report', reportStageTitle, null, root, evidence),
    {
      op: 'stage.state',
      stage: report,
      execution: { state: 'done' },
      evidence: claims,
      rationale: 'The solver reports the result',
    },
    ...delegatedStages.map(
      (stage): ObserverOp => ({
        op: 'stage.depends',
        stage: report,
        depends_on: stage,
        via: null,
        evidence,
        rationale: 'The report builds on the delegated work',
      }),
    ),
    {
      op: 'question.add',
      temp_id: temp('question'),
      text: reportQuestionText,
      stage: report,
      evidence: claims,
      rationale: 'The solver awaits acceptance of the report',
    },
  ]
}

export const mapLayoutScript = (input: ObserverInput): ObserverOutput => {
  const preparing = preparationFacts(input)
  const placed = new Set(preparing)
  const known = stageTitled(input, preparationStageTitle)
  const preparation: StageRef =
    known === undefined ? { kind: 'new', temp_id: temp('preparation') } : { kind: 'existing', id: known.id }
  const { ops, root, agentStages } = planMap(input, mainStageTitle, (parent) => ({
    ops:
      known === undefined && preparing.length > 0
        ? [createStage('preparation', preparationStageTitle, null, parent, preparing.map(({ id }) => id))]
        : [],
    place: (fact) => (placed.has(fact) ? preparation : undefined),
  }))
  return output(input, [
    ...ops,
    ...preparationDone(input, preparation, preparing),
    ...reportOps(input, root, [...agentStages.values()]),
  ])
}

export const mapBranchesScript = (input: ObserverInput): ObserverOutput => {
  if (stageTitled(input, branchStageTitles.build) !== undefined) {
    return output(input, [])
  }
  const evidence = sentFacts(input)
  const stage = (id: keyof typeof branchStageTitles): StageRef => ({ kind: 'new', temp_id: temp(id) })
  const depends = (
    dependent: keyof typeof branchStageTitles,
    on: keyof typeof branchStageTitles,
  ): ObserverOpOf<'stage.depends'> => ({
    op: 'stage.depends',
    stage: stage(dependent),
    depends_on: stage(on),
    via: null,
    evidence,
    rationale: 'The stage builds on the result of the other',
  })
  return output(input, [
    createStage('build', branchStageTitles.build, null, null, evidence),
    createStage('compile', branchStageTitles.compile, null, stage('build'), evidence),
    createStage('verify', branchStageTitles.verify, null, null, evidence),
    createStage('test', branchStageTitles.test, null, stage('verify'), evidence),
    depends('test', 'compile'),
    depends('verify', 'test'),
  ])
}

export const mapNestedScript = (input: ObserverInput): ObserverOutput => {
  if (stageTitled(input, nestedStageTitles.release) !== undefined) {
    return output(input, [])
  }
  const evidence = sentFacts(input)
  const stage = (id: keyof typeof nestedStageTitles): StageRef => ({ kind: 'new', temp_id: temp(id) })
  const onRelease = (dependent: keyof typeof nestedStageTitles): ObserverOpOf<'stage.depends'> => ({
    op: 'stage.depends',
    stage: stage(dependent),
    depends_on: stage('release'),
    via: null,
    evidence,
    rationale: 'The stage builds on the result of the release',
  })
  return output(input, [
    createStage('release', nestedStageTitles.release, null, null, evidence),
    createStage('bundle', nestedStageTitles.bundle, null, stage('release'), evidence),
    createStage('sign', nestedStageTitles.sign, null, stage('bundle'), evidence),
    onRelease('bundle'),
    onRelease('sign'),
  ])
}
