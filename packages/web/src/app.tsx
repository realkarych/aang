import type { RunId, StatusResponse } from '@aang/contract'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { readRuns, readStatus } from './api.js'
import { nowNs } from './format.js'
import { type FocusedRun, lampsOf } from './lamps.js'
import { listHref, selectStage, useNavigate, useRoutedRun, useRoutedStage } from './route.js'
import { RunList, runTitle, untitledRun } from './run-list.js'
import { RunPage } from './run-page.js'
import { StageInspector } from './stage-inspector.js'
import { StatusStrip } from './status-strip.js'
import { type Polled, usePolled } from './use-polled.js'
import { SignedOutContext } from './use-read.js'
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

const Masthead = ({ trail }: { readonly trail: string | null }): ReactElement => {
  const navigate = useNavigate()
  return (
    <header className="masthead">
      <a className="wordmark" href={listHref} onClick={navigate}>
        aang
      </a>
      <nav aria-label="Навигация">
        <ol className="trail">
          <li>
            <a href={listHref} onClick={navigate} aria-current={trail === null ? 'page' : undefined}>
              Прогоны
            </a>
          </li>
          {trail === null ? null : (
            <li aria-current="page" className="trail-here">
              {trail}
            </li>
          )}
        </ol>
      </nav>
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
  useTitle('Прогоны — aang')
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
      <Masthead trail={null} />
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

const RunScreen = ({ run, status, now, onSignedOut }: ScreenProps & { readonly run: RunId }): ReactElement => {
  const feed = useRunFeed(run, onSignedOut)
  const stage = useRoutedStage()
  const close = useCallback(() => {
    selectStage(run, null)
  }, [run])
  const snapshot = feed.snapshot
  const title = snapshot === null ? null : (runTitle(snapshot.summary) ?? untitledRun(snapshot.summary))
  useTitle(`${title ?? 'Прогон'} — aang`)
  const focused: FocusedRun | null =
    snapshot === null
      ? null
      : { summary: snapshot.summary, sessions: snapshot.objects.sessions, gaps: snapshot.objects.gaps }
  const lamps = lampsOf({
    status: status.value,
    statusFailing: status.failing,
    runs: null,
    runsFailing: false,
    focus: { connection: feed.connection, run: focused },
    now,
  })
  return (
    <>
      <Masthead trail={title ?? 'Прогон'} />
      <StatusStrip lamps={lamps} />
      <main className="page run-screen" data-inspecting={stage !== null}>
        <RunPage feed={feed} now={now} />
        {stage === null ? null : (
          <SignedOutContext value={onSignedOut}>
            <StageInspector
              key={stage}
              run={run}
              stage={stage}
              feed={feed}
              onSignedOut={onSignedOut}
              onClose={close}
            />
          </SignedOutContext>
        )}
      </main>
    </>
  )
}

const SignedOutScreen = (): ReactElement => {
  useTitle('Вход не выполнен — aang')
  return (
    <main className="page signed-out">
      <h1>Вход не выполнен</h1>
      <p>
        Сессия входа закончилась или токен aang заменён. Выполните в терминале <code>aang open</code> и откройте
        полученную ссылку в этом браузере.
      </p>
    </main>
  )
}

const Shell = ({ onSignedOut }: { readonly onSignedOut: () => void }): ReactElement => {
  const run = useRoutedRun()
  const status = usePolled(readStatus, onSignedOut)
  const now = useNow()
  return run === null ? (
    <ListScreen status={status} now={now} onSignedOut={onSignedOut} />
  ) : (
    <RunScreen key={run} run={run} status={status} now={now} onSignedOut={onSignedOut} />
  )
}

export const App = (): ReactElement => {
  const [signedOut, setSignedOut] = useState(false)
  const onSignedOut = useCallback(() => {
    setSignedOut(true)
  }, [])
  return signedOut ? <SignedOutScreen /> : <Shell onSignedOut={onSignedOut} />
}
