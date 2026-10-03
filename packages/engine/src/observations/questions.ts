import type {
  ActionId,
  AnswerOutcome,
  Assessed,
  AttentionResolution,
  Basis,
  EpochNs,
  Fact,
  FactId,
  FactKind,
  FactOf,
  HumanDecision,
  JsonValue,
  PermissionDecision,
  QuestionActionLink,
  QuestionKey,
  RuntimeWait,
} from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import { agentKey, byContent, byTime, type Evidence, grouped, type KindEvidence, ofKind } from './evidence.js'

export interface Grounds {
  readonly at: EpochNs
  readonly basis: Basis
  readonly evidence: readonly FactId[]
}

export interface QuestionOutcome {
  readonly opening: Fact
  readonly text: string
  readonly link: QuestionActionLink | null
  readonly decision: Assessed<HumanDecision>
  readonly answered_at: EpochNs | null
  readonly blocking: boolean
  readonly wait: RuntimeWait
  readonly wait_end: Grounds | null
  readonly resolution: AttentionResolution
  readonly closure: Grounds | null
}

export interface SessionFacts {
  readonly of: <K extends FactKind>(kind: K) => KindEvidence<K>[]
}

export const sessionFacts = (items: readonly Evidence[]): SessionFacts => {
  const kinds = grouped(items, ({ fact }) => fact.kind)
  return { of: (kind) => ofKind(kinds.get(kind) ?? [], kind) }
}

type Request = FactOf<'permission_request'>
type Asked = FactOf<'question_asked'>

const observed: Basis = { kind: 'observed' }

const byRule = (rule: string): Basis => ({ kind: 'interpreted', interpreter: { kind: 'rule', rule } })

const linkRule = byRule('permission-link')
const decisionRule = byRule('permission-decision')
const planRule = byRule('plan-approval')

const summaryLength = 200

const approvals: ReadonlySet<PermissionDecision> = new Set([
  'approved',
  'approved_for_session',
  'approved_with_amendment',
])

const rejections: ReadonlySet<PermissionDecision> = new Set(['denied', 'aborted'])

const answerDecisions: Readonly<Record<AnswerOutcome, HumanDecision>> = {
  answered: 'answered',
  declined: 'rejected',
  cancelled: 'rejected',
}

const agentName = (fact: Fact): string => canonicalJson(agentKey(fact))

const callOf = (fact: Fact): string | null => (fact.entity_key.kind === 'action' ? fact.entity_key.call : null)

const endedCalls = (session: SessionFacts, before: EpochNs): Set<string> =>
  new Set(
    [
      ...[...session.of('action_end'), ...session.of('permission_denied')].flatMap(({ fact }) =>
        fact.at < before && fact.entity_key.kind === 'action' ? [fact.entity_key.call] : [],
      ),
      ...session.of('tool_batch_end').flatMap(({ fact }) =>
        fact.at < before ? fact.payload.calls.map(({ call_id: call }) => call) : [],
      ),
    ],
  )

const earliest = <T extends Evidence>(items: readonly T[]): T | undefined => items.toSorted(byTime)[0]

const since = <T extends Evidence>(items: readonly T[], at: EpochNs): T[] => items.filter(({ fact }) => fact.at >= at)

const groundsAt = (at: EpochNs, basis: Basis, evidence: readonly FactId[]): Grounds => ({
  at,
  basis,
  evidence: [...new Set(evidence)].sort(),
})

const grounds = (fact: Fact, basis: Basis, evidence: readonly FactId[] = [fact.id]): Grounds =>
  groundsAt(fact.at, basis, evidence)

const assessed = (value: HumanDecision, { basis, evidence }: Grounds): Assessed<HumanDecision> => ({
  value,
  basis,
  evidence: [...evidence],
})

const clipped = (text: string): string => {
  const line = text.split('\n', 1)[0]?.trim() ?? ''
  return line.length > summaryLength ? `${line.slice(0, summaryLength)}…` : line
}

const inputSummary = (input: JsonValue): string | null => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  const value = input['command'] ?? input['file_path'] ?? input['path']
  return typeof value === 'string' && value.trim() !== '' ? clipped(value) : null
}

const permissionText = ({ payload }: Request): string => {
  const summary = inputSummary(payload.input)
  return summary === null ? payload.tool : `${payload.tool}: ${summary}`
}

const questionText = ({ payload }: Asked): string => {
  const texts = payload.questions.map(({ text }) => text.trim()).filter((text) => text !== '')
  const headers = payload.questions.flatMap(({ header }) => (header === null || header.trim() === '' ? [] : [header]))
  return texts.join('\n') || headers.join('\n') || payload.source
}

const turnBoundaries = (session: SessionFacts, agent: string): Evidence[] => [
  ...session.of('session_end'),
  ...[...session.of('turn_start'), ...session.of('turn_end'), ...session.of('agent_end')].filter(
    ({ fact }) => agentName(fact) === agent,
  ),
  ...session.of('prompt').filter(({ fact }) => fact.speaker === 'human' && agentName(fact) === agent),
]

const waitEnders = (session: SessionFacts, opening: Fact): Evidence[] =>
  since(turnBoundaries(session, agentName(opening)), opening.at)

const turnOpening = (session: SessionFacts, request: Request): EpochNs | null =>
  turnBoundaries(session, agentName(request)).reduce<EpochNs | null>(
    (last, { fact }) => (fact.at < request.at && (last === null || fact.at > last) ? fact.at : last),
    null,
  )

interface PermissionLink {
  readonly link: QuestionActionLink
  readonly calls: readonly string[]
}

const permissionLink = (session: SessionFacts, request: Request): PermissionLink | null => {
  const input = canonicalJson(request.payload.input)
  const agent = agentName(request)
  const ended = endedCalls(session, request.at)
  const opening = turnOpening(session, request)
  const starts = new Map<string, EpochNs>()
  for (const { fact } of session.of('action_start')) {
    const call = callOf(fact)
    if (
      call === null ||
      ended.has(call) ||
      fact.at > request.at ||
      agentName(fact) !== agent ||
      fact.payload.tool !== request.payload.tool ||
      canonicalJson(fact.payload.input) !== input
    ) {
      continue
    }
    const known = starts.get(call)
    starts.set(call, known === undefined || fact.at < known ? fact.at : known)
  }
  const candidates = [...starts]
    .filter(([, start]) => opening === null || start > opening)
    .sort(([leftCall, left], [rightCall, right]) =>
      left > right ? -1 : left < right ? 1 : leftCall < rightCall ? -1 : leftCall > rightCall ? 1 : 0,
    )
  const chosen = candidates[0]
  if (chosen === undefined) {
    return null
  }
  const [call] = chosen
  const { runtime, session: sessionName } = request.entity_key
  return {
    calls: candidates.map(([candidate]) => candidate),
    link: {
      action: objectId({ kind: 'action', runtime, session: sessionName, call }),
      ambiguous: candidates.length > 1,
      basis: linkRule,
    },
  }
}

interface Settled {
  readonly decision: Assessed<HumanDecision>
  readonly closure: Grounds
}

const settledBy = (value: HumanDecision, closure: Grounds): Settled => ({ decision: assessed(value, closure), closure })

const observedDecision = (session: SessionFacts, call: string): Settled | null => {
  const decisions = session
    .of('permission_decision')
    .filter(({ fact }) => callOf(fact) === call)
    .toSorted(byTime)
  const human = decisions.find(
    ({ fact }) =>
      fact.payload.source === 'user' &&
      (approvals.has(fact.payload.decision) || rejections.has(fact.payload.decision)),
  )?.fact
  if (human !== undefined) {
    return settledBy(approvals.has(human.payload.decision) ? 'approved' : 'rejected', grounds(human, observed))
  }
  const policy = decisions.find(
    ({ fact }) => fact.payload.source === 'config' || fact.payload.source === 'automated_reviewer',
  )?.fact
  if (policy === undefined) {
    return null
  }
  return settledBy('none', grounds(policy, observed))
}

const executed = ({ fact, raw }: KindEvidence<'action_end'>): boolean =>
  fact.payload.outcome === 'unknown' ? raw.channel === 'hook' : fact.payload.outcome !== 'denied'

const inferredDecision = (session: SessionFacts, request: Request, call: string): Settled | null => {
  const ends = since(session.of('action_end'), request.at).filter(({ fact }) => callOf(fact) === call)
  const ran = earliest(ends.filter(executed))?.fact
  const denied = earliest(ends.filter(({ fact }) => fact.payload.outcome === 'denied'))?.fact
  const batch = earliest(
    since(session.of('tool_batch_end'), request.at).filter(({ fact }) =>
      fact.payload.calls.some(({ call_id: id }) => id === call),
    ),
  )?.fact
  const settled = ran ?? denied ?? batch
  if (settled === undefined) {
    return null
  }
  return settledBy(settled === ran ? 'approved' : 'rejected', grounds(settled, decisionRule, [request.id, settled.id]))
}

const commonDecision = ([first, ...rest]: readonly HumanDecision[]): HumanDecision =>
  first !== undefined && rest.every((value) => value === first) ? first : 'unknown'

const decisionsOf = (settlements: readonly Settled[]): HumanDecision[] =>
  settlements.map(({ decision }) => decision.value)

const settlementEvidence = (settlements: readonly Settled[]): FactId[] =>
  settlements.flatMap(({ closure }) => closure.evidence)

const jointSettlement = (request: Request, settlements: readonly Settled[]): Settled | null => {
  const [first, ...rest] = settlements
  if (first === undefined || rest.length === 0) {
    return first ?? null
  }
  const at = rest.reduce((last, { closure }) => (closure.at > last ? closure.at : last), first.closure.at)
  return settledBy(
    commonDecision(decisionsOf(settlements)),
    groundsAt(at, decisionRule, [request.id, ...settlementEvidence(settlements)]),
  )
}

const permissionOutcome = (session: SessionFacts, request: Request): QuestionOutcome => {
  const linked = permissionLink(session, request)
  const calls = linked?.calls ?? []
  const settlements = calls.flatMap(
    (call) => observedDecision(session, call) ?? inferredDecision(session, request, call) ?? [],
  )
  const settled = settlements.length === calls.length ? jointSettlement(request, settlements) : null
  const base = { opening: request, text: permissionText(request), link: linked?.link ?? null, blocking: true }
  if (settled !== null) {
    return {
      ...base,
      decision: settled.decision,
      answered_at: settled.closure.at,
      wait: 'ended',
      wait_end: settled.closure,
      resolution: 'answered',
      closure: settled.closure,
    }
  }
  const ender = earliest(waitEnders(session, request))?.fact
  if (ender === undefined) {
    return {
      ...base,
      decision: assessed('requested', grounds(request, observed)),
      answered_at: null,
      wait: 'active',
      wait_end: null,
      resolution: 'open',
      closure: null,
    }
  }
  const aborted =
    request.entity_key.runtime === 'codex' && ender.kind === 'turn_end' && ender.payload.outcome !== 'completed'
  const end = grounds(ender, observed)
  const decision = commonDecision([aborted ? 'rejected' : 'unknown', ...decisionsOf(settlements)])
  return {
    ...base,
    decision: assessed(
      decision,
      grounds(ender, decisionRule, [request.id, ender.id, ...settlementEvidence(settlements)]),
    ),
    answered_at: null,
    wait: 'ended',
    wait_end: end,
    resolution: 'ended_without_answer',
    closure: end,
  }
}

const correlatedAnswer = (
  session: SessionFacts,
  key: QuestionKey,
  asked: Asked,
): FactOf<'question_answered'> | undefined => {
  const name = canonicalJson(key)
  const call = asked.runtime_ids.call_id
  return earliest(
    session.of('question_answered').filter(({ fact }) =>
      fact.entity_key.kind === 'question'
        ? canonicalJson(fact.entity_key) === name
        : call !== null && fact.runtime_ids.call_id === call && fact.at >= asked.at,
    ),
  )?.fact
}

const planDecision = (session: SessionFacts, key: QuestionKey, asked: Asked): Settled | null => {
  if (asked.payload.source !== 'exit_plan_mode') {
    return null
  }
  const end = earliest(
    session.of('action_end').filter(
      ({ fact }) => callOf(fact) === key.question && ['ok', 'denied'].includes(fact.payload.outcome),
    ),
  )?.fact
  if (end === undefined) {
    return null
  }
  return settledBy(end.payload.outcome === 'ok' ? 'approved' : 'rejected', grounds(end, planRule, [asked.id, end.id]))
}

const askedOutcome = (
  session: SessionFacts,
  key: QuestionKey,
  asked: Asked,
  opening: Asked,
  link: QuestionActionLink | null,
): QuestionOutcome => {
  const answer = correlatedAnswer(session, key, asked)
  const settled =
    answer === undefined
      ? planDecision(session, key, asked)
      : settledBy(answerDecisions[answer.payload.outcome], grounds(answer, observed))
  const blocking = asked.payload.blocking
  const base = { opening, text: questionText(asked), link, blocking }
  if (settled !== null) {
    return {
      ...base,
      decision: settled.decision,
      answered_at: settled.closure.at,
      wait: blocking ? 'ended' : 'none',
      wait_end: blocking ? settled.closure : null,
      resolution: 'answered',
      closure: settled.closure,
    }
  }
  const ownEnd =
    link === null ? [] : since(session.of('action_end'), opening.at).filter(({ fact }) => callOf(fact) === key.question)
  const ender = blocking ? earliest([...ownEnd, ...waitEnders(session, opening)])?.fact : undefined
  return {
    ...base,
    decision: assessed('requested', grounds(opening, observed)),
    answered_at: null,
    wait: blocking ? (ender === undefined ? 'active' : 'ended') : 'none',
    wait_end: ender === undefined ? null : grounds(ender, observed),
    resolution: 'open',
    closure: null,
  }
}

export const questionOutcome = (
  key: QuestionKey,
  own: readonly Evidence[],
  session: SessionFacts,
  hasAction: (action: ActionId) => boolean,
): QuestionOutcome | null => {
  const request = earliest(ofKind(own, 'permission_request'))?.fact
  if (request !== undefined) {
    return permissionOutcome(session, request)
  }
  const askedFacts = ofKind(own, 'question_asked')
  const asked = askedFacts.toSorted(byContent)[0]?.fact
  const opening = earliest(askedFacts)?.fact
  if (asked === undefined || opening === undefined) {
    return null
  }
  const action = objectId({ kind: 'action', runtime: key.runtime, session: key.session, call: key.question })
  const link: QuestionActionLink | null =
    (asked.payload.source === 'ask_user_question' || asked.payload.source === 'exit_plan_mode') && hasAction(action)
      ? { action, ambiguous: false, basis: observed }
      : null
  return askedOutcome(session, key, asked, opening, link)
}
