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
import { useGeneration } from './generation.js'
import { Clipped, Grounds, ReadNote } from './grounds.js'
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
          commit <code>{shortSha(artifact.sha)}</code> in <code>{artifact.repository}</code>
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
      return <span className="retention" data-stored="true">saved: content written by the action</span>
    case 'file_read':
      return (
        <span className="retention" data-stored="true">
          saved: file state as read at {absoluteTime(retention.read_at)}
        </span>
      )
    case 'commit':
      return (
        <span className="retention" data-stored="true">
          saved: commit <code>{shortSha(retention.sha)}</code>
        </span>
      )
    case 'hash_only':
      return (
        <span className="retention" data-stored="false">
          hash only: the {bytes(retention.size_bytes)} file exceeds the storage limit
        </span>
      )
    case 'reference':
      return (
        <span className="retention" data-stored="false">
          reference only: content not saved
        </span>
      )
  }
}

const ProducerNote = ({ version, producer }: { readonly version: ArtifactVersion; readonly producer: Action }): ReactElement => {
  const tool = <code>{producer.tool}</code>
  switch (version.retention.kind) {
    case 'action_payload':
      return <span>written by action {tool}</span>
    case 'file_read':
      return <span>action {tool} wrote to the file; it is not proven that this copy is what it wrote</span>
    case 'commit':
    case 'hash_only':
    case 'reference':
      return <span>action {tool} wrote to the file</span>
  }
}

const unavailableLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'unavailable' }>['reason'], string>> = {
  reference_only: 'Only the reference is known; aang did not save the content.',
  hash_only: 'Only the content hash is saved.',
  commit_missing: 'This version’s commit is no longer in the repository.',
  blob_missing: 'The content is missing from aang storage.',
}

const sourceLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'stored' }>['source'], string>> = {
  action_payload: 'content from the action',
  file_read: 'file state at the time of reading',
  commit: 'commit content',
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
        <p className="read-note">The content is binary and cannot be shown as text.</p>
      )}
    </>
  )
}

const SavedVersion = ({ version, label }: { readonly version: ArtifactVersion; readonly label: string }): ReactElement => {
  const { versions } = useGeneration()
  const read = useRead(versions, version.id)
  return (
    <div className="saved" role="region" aria-label={label}>
      {read.kind === 'ready' ? (
        <SavedBody response={read.value} />
      ) : (
        <ReadNote
          read={read}
          loading="Loading saved version…"
          missing="The version is no longer in aang storage."
          failed="Could not load the saved version."
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
        <span>seen {absoluteTime(version.observed_at)}</span>
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
            {open ? 'Hide saved version' : 'Open saved version'}
          </button>
          <div id={saved}>{open ? <SavedVersion version={version} label={`Saved version: ${name}`} /> : null}</div>
        </>
      ) : null}
      <Grounds basis={link.basis} evidence={link.evidence} label={`Link to ${name}`} />
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
    return <p className="section-empty">The observer has not linked artifact versions to the stage.</p>
  }
  return (
    <>
      <ArtifactGroup title="Outputs" artifacts={outputs} producers={producers} />
      <ArtifactGroup title="Inputs" artifacts={inputs} producers={producers} />
    </>
  )
}
