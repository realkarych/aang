import type { RunSnapshot } from '@aang/contract'
import type { ReactElement, Ref } from 'react'
import { AttentionZone } from './attention-zone.js'
import { ChatDock } from './chat-dock.js'
import { ChatPanel } from './chat-panel.js'
import { MapSection, useStageChoice } from './map-section.js'
import { listHref, useNavigate } from './route.js'
import type { RunFeed } from './use-run-feed.js'

export const Missing = (): ReactElement => {
  const navigate = useNavigate()
  return (
    <div className="empty">
      <h2>Run not found</h2>
      <p>
        The daemon does not know this run: it was deleted or has not been re-admitted after a restart. The page will update
        itself when the run appears.
      </p>
      <p>
        <a href={listHref} onClick={navigate}>
          Back to runs
        </a>
      </p>
    </div>
  )
}

interface RunContentProps {
  readonly snapshot: RunSnapshot
  readonly feed: RunFeed
  readonly pane: Ref<HTMLElement>
  readonly now: bigint
  readonly onSignedOut: () => void
}

const RunContent = ({ snapshot, feed, pane, now, onSignedOut }: RunContentProps): ReactElement => {
  const choice = useStageChoice(snapshot)
  return (
    <div className="run-screen-body">
      <main ref={pane} className="run-main">
        <AttentionZone snapshot={snapshot} now={now} handlers={{ onView: feed.noteView, onSignedOut }} />
        <MapSection snapshot={snapshot} choice={choice} />
      </main>
      <ChatDock>
        <ChatPanel
          snapshot={snapshot}
          messages={feed.chat}
          history={feed.history}
          record={feed.record}
          choice={choice}
          now={now}
          onSignedOut={onSignedOut}
        />
      </ChatDock>
    </div>
  )
}

export interface RunPageProps {
  readonly feed: RunFeed
  readonly pane: Ref<HTMLElement>
  readonly now: bigint
  readonly onSignedOut: () => void
}

export const RunPage = ({ feed, pane, now, onSignedOut }: RunPageProps): ReactElement => {
  const { snapshot, connection } = feed
  if (snapshot === null) {
    return <main className="page">{connection === 'missing' ? <Missing /> : <p className="loading">Loading run…</p>}</main>
  }
  return <RunContent snapshot={snapshot} feed={feed} pane={pane} now={now} onSignedOut={onSignedOut} />
}
