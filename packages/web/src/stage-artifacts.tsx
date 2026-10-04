import type {
  Action,
  ActionId,
  ArtifactContent,
  ArtifactRef,
  ArtifactVersion,
  ArtifactVersionResponse,
  StageArtifact,
} from '@aang/contract'
import { type ReactElement, useId, useState } from 'react'
import { absoluteTime, bytes } from './format.js'
import { Clipped, Grounds, ReadNote } from './grounds.js'
import { versionSource } from './sources.js'
import { useRead } from './use-read.js'

const shortSha = (sha: string): string => sha.slice(0, 12)

const RefName = ({ artifact }: { readonly artifact: ArtifactRef }): ReactElement => {
  switch (artifact.kind) {
    case 'file':
      return <code className="artifact-path">{artifact.path}</code>
    case 'url':
    case 'pull_request':
      return (
        <a className="artifact-path" href={artifact.url} target="_blank" rel="noreferrer">
          {artifact.url}
        </a>
      )
    case 'commit':
      return (
        <span className="artifact-path">
          коммит <code>{shortSha(artifact.sha)}</code> в <code>{artifact.repository}</code>
        </span>
      )
  }
}

const refText = (artifact: ArtifactRef): string => {
  switch (artifact.kind) {
    case 'file':
      return artifact.path
    case 'url':
    case 'pull_request':
      return artifact.url
    case 'commit':
      return `${artifact.repository}@${shortSha(artifact.sha)}`
  }
}

const isStored = ({ retention }: ArtifactVersion): boolean =>
  retention.kind === 'action_payload' || retention.kind === 'file_read' || retention.kind === 'commit'

const RetentionNote = ({ version }: { readonly version: ArtifactVersion }): ReactElement => {
  const { retention } = version
  switch (retention.kind) {
    case 'action_payload':
      return <span className="retention" data-stored="true">сохранена: содержимое, которое записало действие</span>
    case 'file_read':
      return (
        <span className="retention" data-stored="true">
          сохранена: состояние файла на момент чтения {absoluteTime(retention.read_at)}
        </span>
      )
    case 'commit':
      return (
        <span className="retention" data-stored="true">
          сохранена: коммит <code>{shortSha(retention.sha)}</code>
        </span>
      )
    case 'hash_only':
      return (
        <span className="retention" data-stored="false">
          только хеш: файл {bytes(retention.size_bytes)} больше предела хранения
        </span>
      )
    case 'reference':
      return (
        <span className="retention" data-stored="false">
          только ссылка: содержимое не сохранено
        </span>
      )
  }
}

const ProducerNote = ({ version, producer }: { readonly version: ArtifactVersion; readonly producer: Action }): ReactElement => {
  const tool = <code>{producer.tool}</code>
  switch (version.retention.kind) {
    case 'action_payload':
      return <span>записана действием {tool}</span>
    case 'file_read':
      return <span>в файл писало действие {tool}; что копия — записанное им содержимое, не доказано</span>
    case 'commit':
    case 'hash_only':
    case 'reference':
      return <span>в файл писало действие {tool}</span>
  }
}

const unavailableLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'unavailable' }>['reason'], string>> = {
  reference_only: 'Известна только ссылка, содержимое aang не сохранял.',
  hash_only: 'Сохранён только хеш содержимого.',
  commit_missing: 'Коммита этой версии больше нет в репозитории.',
  blob_missing: 'Содержимое пропало из хранилища aang.',
}

const sourceLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'stored' }>['source'], string>> = {
  action_payload: 'содержимое из действия',
  file_read: 'состояние файла на момент чтения',
  commit: 'содержимое коммита',
}

const SavedBody = ({ response }: { readonly response: ArtifactVersionResponse }): ReactElement => {
  const { content } = response
  if (content.kind === 'unavailable') {
    return (
      <p className="read-note" data-trouble="true">
        {unavailableLabel[content.reason]}
      </p>
    )
  }
  return (
    <>
      <p className="saved-meta">
        <span>{sourceLabel[content.source]}</span>
        {content.read_at === null ? null : <span>{absoluteTime(content.read_at)}</span>}
        <span>{bytes(content.size_bytes)}</span>
      </p>
      {content.encoding === 'utf8' ? (
        <Clipped text={content.data} className="saved-content" />
      ) : (
        <p className="read-note">Содержимое двоичное, текстом его не показать.</p>
      )}
    </>
  )
}

const SavedVersion = ({ version, label }: { readonly version: ArtifactVersion; readonly label: string }): ReactElement => {
  const read = useRead(versionSource, version.id)
  return (
    <div className="saved" role="region" aria-label={label}>
      {read.kind === 'ready' ? (
        <SavedBody response={read.value} />
      ) : (
        <ReadNote
          read={read}
          loading="Загрузка сохранённой версии…"
          missing="Версии больше нет в хранилище aang."
          failed="Не удалось загрузить сохранённую версию."
        />
      )}
    </div>
  )
}

const ArtifactItem = ({
  artifact,
  producers,
}: {
  readonly artifact: StageArtifact
  readonly producers: ReadonlyMap<ActionId, Action>
}): ReactElement => {
  const { link, version } = artifact
  const [open, setOpen] = useState(false)
  const saved = useId()
  const producer = version.produced_by === null ? undefined : producers.get(version.produced_by)
  const name = refText(version.ref)
  return (
    <li className="artifact">
      <p className="artifact-name">
        <RefName artifact={version.ref} />
      </p>
      <p className="artifact-meta">
        <RetentionNote version={version} />
        {producer === undefined ? null : <ProducerNote version={version} producer={producer} />}
        <span>замечена {absoluteTime(version.observed_at)}</span>
      </p>
      {isStored(version) ? (
        <>
          <button
            type="button"
            className="text-button"
            aria-expanded={open}
            aria-controls={saved}
            onClick={() => {
              setOpen(!open)
            }}
          >
            {open ? 'Скрыть сохранённую версию' : 'Открыть сохранённую версию'}
          </button>
          <div id={saved}>{open ? <SavedVersion version={version} label={`Сохранённая версия: ${name}`} /> : null}</div>
        </>
      ) : null}
      <Grounds basis={link.basis} evidence={link.evidence} label={`Связь с ${name}`} />
    </li>
  )
}

const ArtifactGroup = ({
  title,
  artifacts,
  producers,
}: {
  readonly title: string
  readonly artifacts: readonly StageArtifact[]
  readonly producers: ReadonlyMap<ActionId, Action>
}): ReactElement | null => {
  const heading = useId()
  if (artifacts.length === 0) {
    return null
  }
  return (
    <div className="artifact-group">
      <h4 id={heading} className="subsection-title">
        {title}
      </h4>
      <ul className="artifacts" aria-labelledby={heading}>
        {artifacts.map((artifact) => (
          <ArtifactItem key={artifact.link.id} artifact={artifact} producers={producers} />
        ))}
      </ul>
    </div>
  )
}

export const StageArtifacts = ({
  inputs,
  outputs,
  actions,
}: {
  readonly inputs: readonly StageArtifact[]
  readonly outputs: readonly StageArtifact[]
  readonly actions: readonly Action[]
}): ReactElement => {
  const producers = new Map(actions.map((action) => [action.id, action]))
  if (inputs.length === 0 && outputs.length === 0) {
    return <p className="section-empty">Наблюдатель не привязал к этапу версий артефактов.</p>
  }
  return (
    <>
      <ArtifactGroup title="Выходы" artifacts={outputs} producers={producers} />
      <ArtifactGroup title="Входы" artifacts={inputs} producers={producers} />
    </>
  )
}
