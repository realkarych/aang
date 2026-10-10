import type {
  Action,
  ArtifactContent,
  ArtifactRef,
  ArtifactVersionId,
  AttentionItem,
  ChatCitation,
  ChatMessage,
  FactId,
  ObservationObjects,
  RunId,
  RunSnapshot,
  Stage,
} from '@aang/contract'
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  Suspense,
  use,
  useId,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { askChat, failureText, SignedOut } from './api.js'
import { attentionAnchor } from './attention-zone.js'
import { ActionBadge } from './badges.js'
import {
  citationKindLabel,
  contentMissingLabel,
  contentSourceLabel,
  factGist,
  factKindLabel,
  retentionLabel,
  speakerLabel,
} from './chat-labels.js'
import { factRead, versionRead } from './cached-read.js'
import { absoluteTime, bytes, clockTime } from './format.js'
import { LevelGlyph } from './glyphs.js'
import { attentionKindLabel, stageRevisionLabel } from './labels.js'
import { mapHeading, type StageChoice } from './map-section.js'
import { Moment } from './moment.js'
import { factPlace, placeOf } from './objects.js'
import { isPlainClick, runHref } from './route.js'
import type { ChatHistory } from './use-run-feed.js'
import { ruleText } from './view-labels.js'
import './chat.css'

interface ChatPanelProps {
  readonly snapshot: RunSnapshot
  readonly messages: readonly ChatMessage[]
  readonly history: ChatHistory
  readonly record: (message: ChatMessage) => void
  readonly choice: StageChoice
  readonly now: bigint
  readonly onSignedOut: () => void
}

interface CiteContext {
  readonly snapshot: RunSnapshot
  readonly choose: (stage: Stage['id']) => void
  readonly now: bigint
}

const stageTitle = (stages: readonly Stage[], id: Stage['id']): string =>
  `«${stages.find((stage) => stage.id === id)?.title ?? id}»`

const Disclosure = ({
  label,
  children,
}: {
  readonly label: ReactNode
  readonly children: ReactNode
}): ReactElement => {
  const [open, setOpen] = useState(false)
  const detail = useId()
  return (
    <>
      <button
        type="button"
        className="chat-cite"
        aria-expanded={open}
        aria-controls={detail}
        onClick={() => {
          setOpen(!open)
        }}
      >
        {label}
      </button>
      <div id={detail} className="cite-detail" hidden={!open}>
        {children}
      </div>
    </>
  )
}

const CiteKind = ({ label }: { readonly label: string }): ReactElement => (
  <>
    <span className="cite-kind">{label}</span>{' '}
  </>
)

const StageCite = ({ id, context }: { readonly id: Stage['id']; readonly context: CiteContext }): ReactElement => {
  const { snapshot, choose } = context
  const stage = snapshot.model.stages.find((candidate) => candidate.id === id)
  const revision = stage === undefined || stage.lifecycle.state === 'active' ? null : stage.lifecycle.state
  return (
    <a
      className="chat-cite"
      href={`${runHref(snapshot.summary.id)}&${new URLSearchParams({ stage: id }).toString()}`}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!isPlainClick(event)) {
          return
        }
        event.preventDefault()
        flushSync(() => {
          choose(id)
        })
        document.getElementById(mapHeading)?.scrollIntoView({ block: 'start' })
      }}
    >
      <CiteKind label={citationKindLabel.stage} />
      <span className="cite-text">{stageTitle(snapshot.model.stages, id)}</span>
      {revision === null ? null : <span className="cite-note">{` ${stageRevisionLabel[revision]}`}</span>}
    </a>
  )
}

const QuestionCite = ({ item }: { readonly item: AttentionItem }): ReactElement =>
  item.resolution === 'open' ? (
    <a className="chat-cite" href={`#${attentionAnchor(item.id)}`}>
      <CiteKind label={attentionKindLabel[item.kind]} />
      <span className="cite-text">{item.text}</span>
    </a>
  ) : (
    <span className="chat-cite" data-closed="true">
      <CiteKind label={attentionKindLabel[item.kind]} />
      <span className="cite-text">{item.text}</span>
      <span className="cite-note"> закрыт</span>
    </span>
  )

const ActionCite = ({
  action,
  objects,
  now,
}: {
  readonly action: Action
  readonly objects: ObservationObjects
  readonly now: bigint
}): ReactElement => (
  <Disclosure
    label={
      <>
        <CiteKind label={citationKindLabel.action} />
        <span className="cite-text">{action.tool}</span>
        {action.started_at === null ? null : <span className="cite-note">{` ${clockTime(action.started_at)}`}</span>}
      </>
    }
  >
    <ActionBadge action={action} />
    <span>{placeOf(objects, action.session, action.agent)}</span>
    {action.input_fact === null ? null : (
      <Suspense fallback={null}>
        <ActionGist fact={action.input_fact} now={now} />
      </Suspense>
    )}
  </Disclosure>
)

const ActionGist = ({ fact, now }: { readonly fact: FactId; readonly now: bigint }): ReactElement | null => {
  const read = use(factRead(fact, now))
  const gist = read === null ? null : factGist(read)
  return gist === null ? null : <code className="cite-gist">{gist}</code>
}

const FactCite = ({ id, context }: { readonly id: FactId; readonly context: CiteContext }): ReactElement => {
  const fact = use(factRead(id, context.now))
  if (fact === null) {
    return (
      <span className="chat-cite" data-closed="true">
        <CiteKind label={citationKindLabel.fact} />
        <span className="cite-note">не прочитан, повтор через несколько секунд</span>
      </span>
    )
  }
  const gist = factGist(fact)
  const place = factPlace(context.snapshot.objects, fact.entity_key)
  return (
    <Disclosure
      label={
        <>
          <CiteKind label={citationKindLabel.fact} />
          <span className="cite-text">{factKindLabel[fact.kind]}</span>
          <span className="cite-note">{` ${clockTime(fact.at)}`}</span>
        </>
      }
    >
      <span>{speakerLabel[fact.speaker]}</span>
      {place === null ? null : <span>{place}</span>}
      <span>сырая запись № {fact.seq}</span>
      {gist === null ? null : <span className="cite-gist">{gist}</span>}
    </Disclosure>
  )
}

const refName = (ref: ArtifactRef): string =>
  ref.kind === 'file' ? ref.path : ref.kind === 'commit' ? `${ref.repository}@${ref.sha}` : ref.url

const VersionContent = ({ content }: { readonly content: ArtifactContent }): ReactElement =>
  content.kind === 'unavailable' ? (
    <span>{`Содержимое недоступно: ${contentMissingLabel[content.reason]}`}</span>
  ) : (
    <>
      <span>{contentSourceLabel[content.source]}</span>
      {content.read_at === null ? null : <span>{absoluteTime(content.read_at)}</span>}
      <span>{bytes(content.size_bytes)}</span>
      {content.encoding === 'utf8' ? (
        <pre className="cite-content">{content.data}</pre>
      ) : (
        <span className="cite-gist">Содержимое двоичное, текстом его не показать.</span>
      )}
    </>
  )

const VersionCite = ({ id, now }: { readonly id: ArtifactVersionId; readonly now: bigint }): ReactElement => {
  const read = use(versionRead(id, now))
  return read === null ? (
    <span className="chat-cite" data-closed="true">
      <CiteKind label={citationKindLabel.artifact_version} />
      <span className="cite-note">не прочитана, повтор через несколько секунд</span>
    </span>
  ) : (
    <Disclosure
      label={
        <>
          <CiteKind label={citationKindLabel.artifact_version} />
          <code className="cite-text">{refName(read.version.ref)}</code>
          <span className="cite-note">{`, ${retentionLabel[read.version.retention.kind]}`}</span>
        </>
      }
    >
      <VersionContent content={read.content} />
    </Disclosure>
  )
}

const Reading = ({ kind }: { readonly kind: ChatCitation['kind'] }): ReactElement => (
  <span className="chat-cite" data-closed="true">
    <CiteKind label={citationKindLabel[kind]} />…
  </span>
)

const Missing = ({ citation }: { readonly citation: ChatCitation }): ReactElement => (
  <span className="chat-cite" data-closed="true">
    <CiteKind label={citationKindLabel[citation.kind]} />
    <span className="cite-note">нет в текущем снимке прогона</span>
  </span>
)

const Cite = ({
  citation,
  context,
}: {
  readonly citation: ChatCitation
  readonly context: CiteContext
}): ReactElement => {
  const { objects, attention } = context.snapshot
  switch (citation.kind) {
    case 'stage':
      return <StageCite id={citation.id} context={context} />
    case 'question': {
      const item = attention.items.find(({ id }) => id === citation.id)
      return item === undefined ? <Missing citation={citation} /> : <QuestionCite item={item} />
    }
    case 'action': {
      const action = objects.actions.find(({ id }) => id === citation.id)
      return action === undefined ? (
        <Missing citation={citation} />
      ) : (
        <ActionCite action={action} objects={objects} now={context.now} />
      )
    }
    case 'fact':
      return (
        <Suspense fallback={<Reading kind={citation.kind} />}>
          <FactCite id={citation.id} context={context} />
        </Suspense>
      )
    case 'artifact_version':
      return (
        <Suspense fallback={<Reading kind={citation.kind} />}>
          <VersionCite id={citation.id} now={context.now} />
        </Suspense>
      )
  }
}

const Citations = ({
  citations,
  context,
}: {
  readonly citations: readonly ChatCitation[]
  readonly context: CiteContext
}): ReactElement | null =>
  citations.length === 0 ? null : (
    <ul className="chat-citations" aria-label="Ссылки ответа">
      {citations.map((citation) => (
        <li key={`${citation.kind}:${citation.id}`}>
          <Cite citation={citation} context={context} />
        </li>
      ))}
    </ul>
  )

const Flag = ({ children }: { readonly children: string }): ReactElement => (
  <li>
    <LevelGlyph level="caution" />
    {children}
  </li>
)

const RuleNote = ({
  message,
  snapshot,
}: {
  readonly message: ChatMessage
  readonly snapshot: RunSnapshot
}): ReactElement | null => {
  if (message.view_rule_error !== null) {
    return <p className="chat-rule" data-applied="false">{`Правило вида не применено: ${message.view_rule_error}`}</p>
  }
  if (message.view_rule === null) {
    return null
  }
  const applied = snapshot.view.rules.find(({ rule }) => rule.id === message.view_rule)
  return applied === undefined ? (
    <p className="chat-rule" data-applied="false">
      Правило вида из этого ответа отменено.
    </p>
  ) : (
    <p className="chat-rule" data-applied="true">
      {`Правило вида применено: ${ruleText(applied.rule, snapshot.model.stages)}. Отменить его можно в списке правил.`}
    </p>
  )
}

const VersionNote = ({ version, current }: { readonly version: number; readonly current: number }): ReactElement => (
  <p className="chat-version">
    {`по версии карты ${String(version)}`}
    {current > version ? (
      <span className="chat-stale">{`, карта с тех пор обновилась до версии ${String(current)}`}</span>
    ) : null}
  </p>
)

const Reply = ({ message, context }: { readonly message: ChatMessage; readonly context: CiteContext }): ReactElement => {
  switch (message.status) {
    case 'pending':
      return (
        <p className="chat-pending" role="status">
          Наблюдатель готовит ответ…
        </p>
      )
    case 'failed':
      return <p className="chat-failed">{`Ответа нет: ${message.error ?? 'вызов наблюдателя не удался'}`}</p>
    case 'answered':
      return (
        <div className="chat-reply">
          <p className="chat-answer">{message.answer ?? 'Наблюдатель не нашёл ответа в данных прогона.'}</p>
          {message.insufficient_data || message.unconfirmed_citations ? (
            <ul className="chat-flags">
              {message.insufficient_data ? <Flag>недостаточно данных</Flag> : null}
              {message.unconfirmed_citations ? <Flag>часть ссылок не подтверждена и убрана</Flag> : null}
            </ul>
          ) : null}
          <Citations citations={message.citations} context={context} />
          <RuleNote message={message} snapshot={context.snapshot} />
          <VersionNote version={message.version} current={context.snapshot.run.version} />
        </div>
      )
  }
}

const Entry = ({ message, context }: { readonly message: ChatMessage; readonly context: CiteContext }): ReactElement => (
  <li className="chat-entry" data-status={message.status}>
    <div className="chat-asked">
      <p className="chat-question">{message.question}</p>
      <p className="chat-meta">
        <span>
          {message.stage === null
            ? 'по всему прогону'
            : `по этапу ${stageTitle(context.snapshot.model.stages, message.stage)}`}
        </span>
        <Moment at={message.asked_at} now={context.now} />
      </p>
    </div>
    <Reply message={message} context={context} />
  </li>
)

const AskForm = ({
  run,
  choice,
  record,
  onSignedOut,
}: {
  readonly run: RunId
  readonly choice: StageChoice
  readonly record: (message: ChatMessage) => void
  readonly onSignedOut: () => void
}): ReactElement => {
  const field = useId()
  const [question, setQuestion] = useState('')
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const stage = choice.selection?.stage ?? null
  const submit = async (): Promise<void> => {
    const text = question.trim()
    if (text === '' || sending) {
      return
    }
    setSending(true)
    setFailure(null)
    try {
      record(await askChat(run, { question: text, stage: stage?.id ?? null }))
      setQuestion('')
    } catch (error) {
      if (error instanceof SignedOut) {
        onSignedOut()
        return
      }
      setFailure(failureText(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <form
      className="chat-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={field} className="chat-label">
        Вопрос
      </label>
      <textarea
        id={field}
        className="chat-input"
        rows={3}
        value={question}
        placeholder="Например: почему этап ждёт решения? Или: сверни ревьюеров"
        onChange={(event) => {
          setQuestion(event.target.value)
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className="chat-actions">
        <p className="chat-scope">
          {stage === null ? (
            'Вопрос по всему прогону. Выберите этап на карте, чтобы сузить вопрос до него.'
          ) : (
            <>
              {`Вопрос по этапу «${stage.title}». `}
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  choice.choose(null)
                }}
              >
                Спросить по всему прогону
              </button>
            </>
          )}
        </p>
        <button type="submit" className="chat-send" disabled={sending || question.trim() === ''}>
          {sending ? 'Отправка…' : 'Спросить'}
        </button>
      </div>
      {failure === null ? null : (
        <p className="chat-error" role="alert">
          {`Вопрос не отправлен: ${failure}`}
        </p>
      )}
    </form>
  )
}

const HistoryNote = ({
  history,
  empty,
}: {
  readonly history: ChatHistory
  readonly empty: boolean
}): ReactElement | null => {
  switch (history.state) {
    case 'failed':
      return (
        <p className="chat-trouble" role="status">
          {`История чата не загружена: ${history.reason}. aang повторяет запрос.`}
        </p>
      )
    case 'loading':
      return empty ? <p className="chat-empty">История чата загружается…</p> : null
    case 'ready':
      return empty ? <p className="chat-empty">Вопросов по этому прогону ещё не было.</p> : null
  }
}

export const ChatPanel = ({
  snapshot,
  messages,
  history,
  record,
  choice,
  now,
  onSignedOut,
}: ChatPanelProps): ReactElement => {
  const heading = useId()
  const context: CiteContext = { snapshot, choose: choice.choose, now }
  return (
    <section className="chat" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">
        Чат
      </h2>
      <p className="chat-note">
        Отвечает наблюдатель по снимку карты и ссылается на этапы, факты и действия. Чат не меняет карту и ничего не
        отправляет решателю; правило вида из ответа применяется сразу, отменить его можно в списке правил.
      </p>
      <HistoryNote history={history} empty={messages.length === 0} />
      {messages.length === 0 ? null : (
        <ol className="chat-log" aria-label="Вопросы и ответы">
          {messages.map((message) => (
            <Entry key={message.id} message={message} context={context} />
          ))}
        </ol>
      )}
      <AskForm run={snapshot.summary.id} choice={choice} record={record} onSignedOut={onSignedOut} />
    </section>
  )
}
