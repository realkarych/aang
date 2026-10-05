import type { RunId, RunSnapshot, RunSummary, StatusResponse, UsageReport } from '@aang/contract'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { readRuns, readStatus, readUsage } from './api.js'
import { nowNs } from './format.js'
import { type FocusedRun, lampsOf } from './lamps.js'
import { listHref, runHref, type UsagePeriod, usageHref, useNavigate, useRoute } from './route.js'
import { RunList, runTitle, untitledRun } from './run-list.js'
import { Missing, RunPage } from './run-page.js'
import { StatusStrip } from './status-strip.js'
import { RunUsagePage, UsageOverview, usageQuery } from './usage-page.js'
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

interface Crumb {
  readonly label: string
  readonly href?: string
}

const Masthead = ({
  trail,
  usage = true,
}: {
  readonly trail: readonly Crumb[]
  readonly usage?: boolean
}): ReactElement => {
  const navigate = useNavigate()
  return (
    <header className="masthead">
      <a className="wordmark" href={listHref} onClick={navigate}>
        aang
      </a>
      <nav className="masthead-nav" aria-label="Навигация">
        <ol className="trail">
          <li>
            <a href={listHref} onClick={navigate} aria-current={trail.length === 0 ? 'page' : undefined}>
              Прогоны
            </a>
          </li>
          {trail.map(({ label, href }) =>
            href === undefined ? (
              <li key={label} aria-current="page" className="trail-here">
                {label}
              </li>
            ) : (
              <li key={label} className="trail-step">
                <a href={href} onClick={navigate}>
                  {label}
                </a>
              </li>
            ),
          )}
        </ol>
        {usage ? (
          <a className="masthead-usage" href={usageHref(null)} onClick={navigate}>
            Расход
          </a>
        ) : null}
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
      <Masthead trail={[]} />
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
  const title = snapshotTitle(feed.snapshot)
  useTitle(`${title ?? 'Прогон'} — aang`)
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
      <Masthead trail={[{ label: title ?? 'Прогон' }]} />
      <StatusStrip lamps={lamps} />
      <main className="page">
        <RunPage feed={feed} runs={runs.value?.runs ?? null} now={now} onSignedOut={onSignedOut} />
      </main>
    </>
  )
}

const usagePollMs = 5_000

interface UsageScope {
  readonly run: RunId | null
  readonly period: UsagePeriod
  readonly onSignedOut: () => void
}

const useUsageReport = ({ run, period, onSignedOut }: UsageScope): Polled<UsageReport> => {
  const load = useCallback((signal: AbortSignal) => readUsage(usageQuery(period, run, nowNs()), signal), [period, run])
  return usePolled(load, onSignedOut, usagePollMs)
}

const OverviewBody = ({ runs, ...scope }: UsageScope & { readonly runs: readonly RunSummary[] }): ReactElement => {
  const report = useUsageReport(scope)
  return <UsageOverview report={report.value} failing={report.failing} runs={runs} period={scope.period} />
}

const RunUsageBody = ({
  run,
  snapshot,
  runs,
  ...scope
}: UsageScope & {
  readonly run: RunId
  readonly snapshot: RunSnapshot | null
  readonly runs: readonly RunSummary[]
}): ReactElement => {
  const report = useUsageReport({ run, ...scope })
  return (
    <RunUsagePage
      run={run}
      report={report.value}
      failing={report.failing}
      snapshot={snapshot}
      runs={runs}
      period={scope.period}
    />
  )
}

const UsageScreen = ({
  period,
  status,
  now,
  onSignedOut,
}: ScreenProps & { readonly period: UsagePeriod }): ReactElement => {
  const runs = usePolled(readRuns, onSignedOut)
  useTitle('Расход — aang')
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
      <Masthead trail={[{ label: 'Расход' }]} usage={false} />
      <StatusStrip lamps={lamps} />
      <main className="page">
        <OverviewBody key={period} run={null} period={period} runs={runs.value?.runs ?? []} onSignedOut={onSignedOut} />
      </main>
    </>
  )
}

const RunUsageScreen = ({
  run,
  period,
  status,
  now,
  onSignedOut,
}: ScreenProps & { readonly run: RunId; readonly period: UsagePeriod }): ReactElement => {
  const feed = useRunFeed(run, onSignedOut)
  const runs = usePolled(readRuns, onSignedOut)
  const title = snapshotTitle(feed.snapshot)
  useTitle(`Расход: ${title ?? 'прогон'} — aang`)
  const lamps = lampsOf({
    status: status.value,
    statusFailing: status.failing,
    runs: null,
    runsFailing: false,
    focus: { connection: feed.connection, run: focusOf(feed.snapshot) },
    now,
  })
  return (
    <>
      <Masthead trail={[{ label: title ?? 'Прогон', href: runHref(run) }, { label: 'Расход' }]} />
      <StatusStrip lamps={lamps} />
      <main className="page">
        {feed.connection === 'missing' ? (
          <Missing />
        ) : (
          <RunUsageBody
            key={period}
            run={run}
            period={period}
            snapshot={feed.snapshot}
            runs={runs.value?.runs ?? []}
            onSignedOut={onSignedOut}
          />
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
  const route = useRoute()
  const status = usePolled(readStatus, onSignedOut)
  const now = useNow()
  switch (route.screen) {
    case 'runs':
      return <ListScreen status={status} now={now} onSignedOut={onSignedOut} />
    case 'run':
      return <RunScreen key={route.run} run={route.run} status={status} now={now} onSignedOut={onSignedOut} />
    case 'usage':
      return route.run === null ? (
        <UsageScreen period={route.period} status={status} now={now} onSignedOut={onSignedOut} />
      ) : (
        <RunUsageScreen
          key={route.run}
          run={route.run}
          period={route.period}
          status={status}
          now={now}
          onSignedOut={onSignedOut}
        />
      )
  }
}

export const App = (): ReactElement => {
  const [signedOut, setSignedOut] = useState(false)
  const onSignedOut = useCallback(() => {
    setSignedOut(true)
  }, [])
  return signedOut ? <SignedOutScreen /> : <Shell onSignedOut={onSignedOut} />
}
