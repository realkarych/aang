import type { AttentionItem, RunId, RunSnapshot, StatusResponse } from '@aang/contract'
import { type ReactElement, useCallback, useEffect, useId, useMemo, useState } from 'react'
import { readRuns, readStatus } from './api.js'
import { nowNs } from './format.js'
import { LevelGlyph } from './glyphs.js'
import { attentionKindLabel } from './labels.js'
import { type FocusedRun, lampsOf } from './lamps.js'
import { waitingOffMap } from './map-graph.js'
import { listHref, useNavigate, useRoute } from './route.js'
import { RunList, runTitle, untitledRun } from './run-list.js'
import { RunPage } from './run-page.js'
import { agentIds, KnownAgents } from './short-ids.js'
import { StatusStrip } from './status-strip.js'
import { type Polled, usePolled } from './use-polled.js'
import { useRunFeed } from './use-run-feed.js'

const useNow = (intervalMs = 1_000): bigint => {
  const [now, setNow] = useState(nowNs)
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(nowNs())
    }, intervalMs)
    return () => {
      clearInterval(timer)
    }
  }, [intervalMs])
  return now
}

const useTitle = (title: string): void => {
  useEffect(() => {
    document.title = title
  }, [title])
}

const noWaiting: readonly AttentionItem[] = []

const WaitingChip = ({ waiting }: { readonly waiting: readonly AttentionItem[] }): ReactElement => {
  const tip = useId()
  const [quiet, setQuiet] = useState(false)
  const speak = (): void => {
    setQuiet(false)
  }
  return (
    <span className="masthead-waiting" data-quiet={quiet} onMouseLeave={speak}>
      <button
        type="button"
        aria-describedby={tip}
        onBlur={speak}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setQuiet(true)
          }
        }}
      >
        <span className="visually-hidden">Waiting for you: </span>
        <LevelGlyph level="caution" />
        {waiting.length}
      </button>
      <span role="tooltip" id={tip} className="masthead-tooltip">
        {waiting.map(({ id, kind, text }) => (
          <span key={id}>{`${attentionKindLabel[kind]}: ${text}`}</span>
        ))}
      </span>
    </span>
  )
}

const Masthead = ({
  title,
  waiting,
}: {
  readonly title: string | null
  readonly waiting: readonly AttentionItem[]
}): ReactElement => {
  const navigate = useNavigate()
  return (
    <header className="masthead">
      <a className="wordmark" href={listHref} onClick={navigate}>
        aang
      </a>
      {title === null ? null : (
        <nav className="masthead-nav" aria-label="Navigation">
          <a href={listHref} onClick={navigate}>
            ← Chats
          </a>
          <h1 className="masthead-title" title={title}>
            {title}
          </h1>
          {waiting.length === 0 ? null : <WaitingChip waiting={waiting} />}
        </nav>
      )}
    </header>
  )
}

interface ScreenProps {
  readonly status: Polled<StatusResponse>
  readonly now: bigint
  readonly onSignedOut: () => void
}

const ListScreen = ({ status, now, onSignedOut }: ScreenProps): ReactElement => {
  const runs = usePolled(readRuns, onSignedOut)
  useTitle('Runs — aang')
  const lamps = lampsOf({
    status: status.value,
    statusFailing: status.failing,
    runs: runs.value?.runs ?? null,
    runsFailing: runs.failing,
    focus: null,
    now,
  })
  return (
    <>
      <Masthead title={null} waiting={noWaiting} />
      <StatusStrip lamps={lamps} />
      <main className="page">
        <RunList
          runs={runs.value?.runs ?? null}
          failing={runs.failing}
          watch={status.value?.watch ?? null}
          now={now}
        />
      </main>
    </>
  )
}

const snapshotTitle = (snapshot: RunSnapshot | null): string | null =>
  snapshot === null ? null : (runTitle(snapshot.summary) ?? untitledRun(snapshot.summary))

const focusOf = (snapshot: RunSnapshot | null): FocusedRun | null =>
  snapshot === null
    ? null
    : { summary: snapshot.summary, sessions: snapshot.objects.sessions, gaps: snapshot.objects.gaps }

const RunScreen = ({ run, status, now, onSignedOut }: ScreenProps & { readonly run: RunId }): ReactElement => {
  const feed = useRunFeed(run, onSignedOut)
  const runs = usePolled(readRuns, onSignedOut)
  const agents = useMemo(() => agentIds(feed.snapshot?.objects.agents ?? []), [feed.snapshot])
  const title = snapshotTitle(feed.snapshot)
  const waiting = useMemo(() => (feed.snapshot === null ? noWaiting : waitingOffMap(feed.snapshot)), [feed.snapshot])
  useTitle(`${title ?? 'Run'} — aang`)
  const lamps = lampsOf({
    status: status.value,
    statusFailing: status.failing,
    runs: null,
    runsFailing: runs.failing,
    focus: { connection: feed.connection, run: focusOf(feed.snapshot) },
    now,
  })
  return (
    <>
      <Masthead title={title ?? 'Run'} waiting={waiting} />
      <StatusStrip lamps={lamps} />
      <div className="run-screen">
        <KnownAgents value={agents}>
          <RunPage feed={feed} now={now} onSignedOut={onSignedOut} />
        </KnownAgents>
      </div>
    </>
  )
}

const SignedOutScreen = (): ReactElement => {
  useTitle('Signed out — aang')
  return (
    <main className="page signed-out">
      <h1>Signed out</h1>
      <p>
        The sign-in session ended or the aang token was replaced. Run <code>aang open</code> in a terminal and open the
        link it prints in this browser.
      </p>
    </main>
  )
}

const Shell = ({ onSignedOut }: { readonly onSignedOut: () => void }): ReactElement => {
  const route = useRoute()
  const status = usePolled(readStatus, onSignedOut)
  const now = useNow()
  switch (route.screen) {
    case 'runs':
      return <ListScreen status={status} now={now} onSignedOut={onSignedOut} />
    case 'run':
      return <RunScreen key={route.run} run={route.run} status={status} now={now} onSignedOut={onSignedOut} />
  }
}

export const App = (): ReactElement => {
  const [signedOut, setSignedOut] = useState(false)
  const onSignedOut = useCallback(() => {
    setSignedOut(true)
  }, [])
  return signedOut ? <SignedOutScreen /> : <Shell onSignedOut={onSignedOut} />
}
