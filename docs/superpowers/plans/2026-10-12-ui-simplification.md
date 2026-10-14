# UI Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the catacomb web UI to a chat list, a full-screen stage map and a collapsible chat panel, as decided by the owner.

**Architecture:** Web-only rework of `packages/web` plus one read-model field (`RunSummary.cwd`). The map, chat, SSE feed and API stay; the views around them are deleted. Each task is one PR of the stack described in the spec, with its own E2E cycle.

**Tech Stack:** React 19, Vite 8, `@xyflow/react` 12 + `elkjs`, plain CSS, Zod contracts, Playwright E2E with `@catacomb/testkit` fake observer scenarios, pnpm, Node 26.

**Spec:** `docs/superpowers/specs/2026-10-12-ui-simplification-design.md`

## Global Constraints

- No comments or docstrings in any source file (AGENTS.md). Explanations go to ADRs, READMEs and PR descriptions.
- E2E first; unit tests only for an atomic fragment E2E cannot cover (AGENTS.md, ADR-0012). Mocks only at external boundaries; the observer LLM is faked through `@catacomb/testkit` scenarios.
- Colour is always paired with an icon or label (RFC §5).
- Backend change is limited to `RunSummary.cwd` (spec D4, D9). No endpoint, table, observer behaviour or CLI command is removed. The chat system prompt may be adjusted only if Task 5 shows filter requests do not produce view rules.
- `localStorage` access is wrapped in try/catch; the UI works without it.
- Implementation PRs merge only after the owner approves ADR-0015 (Task 1), and each PR gets a Codex cross-review (AGENTS.md).
- The web is served from `packages/web/dist` by the daemon: run `pnpm build` before any `pnpm e2e` run.
- The verification bar before every commit: `pnpm typecheck && pnpm lint` and the E2E files the task touches.

## Review Focus

- Health dot noise: `status.not_observable` always lists cloud surfaces, so the `coverage` lamp is always `caution`. The dot must ignore the `coverage` lamp, or it is lit on every healthy install. Pinned in Task 6.
- Rule-based attention items (questions, permissions from hooks) have `stage: null`. They must appear in the header chip, not disappear because no node owns them. Pinned in Task 5.
- A view rule can hide the stage that is selected in `&stage=`. The chat must keep the stage scope and the summary readable, and "whole run" must still clear it. Pinned in Task 5.
- Chat panel collapsed state with `localStorage` throwing (private mode): the panel must render expanded and toggle in memory. Pinned in Task 3.
- Old bookmarked URLs with `view=usage` or `mode=changes`: they must open the list or the run, not a blank page. Pinned in Task 3.

---

### Task 1: ADR-0015 and scope amendments

**Files:**
- Create: `docs/adr/0015-ui-simplification.md`
- Modify: `rfc.md` (§4 interface bullet, §5 interface section)
- Modify: `docs/plan/mvp.md` (H.* items, RFC scenario coverage table, new stage "UI simplification")
- Modify: `docs/adr/0008-*.md`, `docs/adr/0009-*.md`, `docs/adr/0010-*.md` (a "Superseded in part by ADR-0015" line under the title)

**Interfaces:**
- Produces: the approved decision record that the later PR descriptions reference.

- [ ] **Step 1: Write ADR-0015**

Follow the structure of the existing ADRs (read `docs/adr/0008-*.md` first and copy its headings). Content:

```markdown
# ADR-0015. UI simplification

Status: proposed (owner approval required)

## Context

The run screen shows a status strip, a facts header, an attention zone, the map, chat with a view-rules list, trace, plan history and "Since last review"; a stage inspector and a usage page sit beside it. The owner wants a chat list, a full-screen stage map and a collapsible chat panel only.

## Decision

1. Screens: chat list (`/`) and chat (`/?run=<id>[&stage=<id>]`). Usage pages, `mode=changes` and the stage inspector are removed from the UI.
2. Map nodes stay observer stages. A card shows name, execution state, basis and an attention badge. The human-decision axis, origin, counts and participants leave the card.
3. The chat panel is on the right of the map and collapses to a rail. Selecting a stage narrows the chat and shows a stage summary at its top.
4. Narrowing the map to a goal uses the existing chat view rules. Active rules are chips above the map; ✕ revokes the rule.
5. Attention: a badge on the stage, a "waiting for you" chip in the header for items without a stage, a count in the chat list. No attention zone; no viewed or dismiss controls.
6. Observation health: one dot in the header, only when a non-coverage lamp is not normal; the popover lists the problems. `catacomb status` keeps the details.
7. Trace, plan history, "Since last review" and the usage page are removed from the UI. `catacomb usage` stays.
8. `RunSummary` gains `cwd`: the root session's working directory, shown as the project folder in the chat list.
9. The backend, API, tables and observer are unchanged. Endpoints used only by removed views stay served.

## Consequences

- Supersedes in ADR-0008: the attention zone, "Since last view", the view-rules list and the status-bar clauses. Chat with citations, map version binding and view rules as a mechanism stay.
- Supersedes in ADR-0009: the usage UI. The three ledgers and `catacomb usage` stay.
- Supersedes in ADR-0010: the display of the unverified-version and unrecognized-records signals in the status bar; they move into the health dot popover.
- E2E scenarios of removed views are deleted; the RFC scenario coverage table in `docs/plan/mvp.md` is rewritten.
- RFC §2 "returning to results" loses its dedicated mode; the chat answers "what changed" questions.
```

- [ ] **Step 2: Amend `rfc.md` §4 and §5**

In §4, replace the interface bullet's list (stage map / attention zone / inspector / chat / changes mode) with: "stage map with attention badges and a collapsible chat panel; chat narrows to a stage and narrows the map through view rules (ADR-0015)". In §5, delete the paragraphs about the attention zone, the inspector and the changes mode; keep map and chat paragraphs; add one paragraph stating decisions 3–6 of ADR-0015 in RFC wording.

- [ ] **Step 3: Amend `docs/plan/mvp.md`**

Mark H.1 (status bar), H.2/H.3 (attention zone), H.6 (inspector), H.7 (Since last review), H.8 (view-rules list), H.9 and U.1 (usage UI), K.2's list part as "superseded by ADR-0015". Add a stage "UI simplification (ADR-0015)" listing Tasks 2–7 of this plan. Rewrite the RFC scenario coverage table rows that pointed to removed E2E files so they point to the new scenarios named in Tasks 3–7.

- [ ] **Step 4: Add the supersede line to ADR-0008, 0009, 0010**

Under each title add: `Superseded in part by [ADR-0015](0015-ui-simplification.md).`

- [ ] **Step 5: Verify and commit**

Run: `pnpm lint:comments`
Expected: PASS (docs are not checked for comments, but the command must stay green).

```bash
git add docs/adr rfc.md docs/plan/mvp.md
git commit -m "ADR-0015: UI simplification"
```

- [ ] **Step 6: Stop for owner approval**

Implementation PRs (Tasks 2–7) may be developed, but they merge only after the owner sets ADR-0015 to accepted.

---

### Task 2: `RunSummary.cwd`

**Files:**
- Modify: `packages/contract/src/api.ts:190-209` (`RunSummary`)
- Modify: `packages/engine/src/read/summary.ts:88-115` (`summaryOf`)
- Test: `e2e/runs.test.ts`
- Modify: any test or fixture that builds a literal `RunSummary` (find with `grep -rn "start_pruned:" packages e2e tools --include=*.ts`)

**Interfaces:**
- Produces: `RunSummary.cwd: string | null`, the root session's `cwd`.

- [ ] **Step 1: Write the failing test**

Append to `e2e/runs.test.ts` (reuse its existing imports and `test.use`; add `claudeOriginal`, `runOf` from `./samples.js` and `sampleScenarioManifest` from `@catacomb/testkit` if not imported):

```ts
test('a run summary carries the working directory of its root session', async ({ daemon, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  const run = runOf(claudeOriginal)
  await expect
    .poll(async () => {
      const { runs } = endpoints.runs.response.parse(await (await daemon.request(endpoints.runs.path)).json())
      return runs.find(({ id }) => id === run)?.cwd ?? null
    })
    .toMatch(/\S/)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && pnpm e2e e2e/runs.test.ts`
Expected: FAIL (typecheck error "Property 'cwd' does not exist", or the poll times out with `null`).

- [ ] **Step 3: Implement**

In `packages/contract/src/api.ts`, inside `RunSummary` after `root_session: SessionId,`:

```ts
  cwd: text.nullable(),
```

In `packages/engine/src/read/summary.ts`, inside the object returned by `summaryOf`, after `root_session: run.root_session,`:

```ts
    cwd: sessions.find(({ id }) => id === run.root_session)?.cwd ?? null,
```

Update every literal `RunSummary` found by the grep above with `cwd: null` (or the session's cwd where the test builds sessions).

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm typecheck && pnpm test && pnpm e2e e2e/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contract packages/engine e2e/runs.test.ts
git commit -m "Run summary: the root session's working directory (ADR-0015)"
```

---

### Task 3: Two-column run screen, collapsible chat, removal of the lower sections and usage

**Files:**
- Create: `packages/web/src/chat-dock.tsx`
- Create: `packages/web/src/dock.css`
- Modify: `packages/web/src/run-page.tsx` (remove `Facts`, `AttentionZone` stays for now, remove `ViewRules`, `SinceLastView`, `Trace`, `PlanFacts`; new layout)
- Modify: `packages/web/src/app.tsx` (remove usage screens and the Usage link; masthead "← Chats" crumb)
- Modify: `packages/web/src/route.ts` (drop `usage` route, `RunMode`, `mode`)
- Modify: `packages/web/src/styles.css` (remove `.facts`, `.run-talk`, `.run-body` rules; add `.run-screen` grid)
- Delete: `since.tsx`, `since.css`, `changes.tsx`, `use-changes.ts`, `trace.tsx`, `action-input.ts`, `plan-facts.tsx`, `usage-page.tsx`, `usage.css`, `view-rules.tsx` and every helper left without importers (check with `pnpm lint:eslint` unused-import errors and `grep -rln`)
- Delete tests: `e2e/facts-view.test.ts`, `e2e/since-last-view.test.ts`, `e2e/since-last-view-variants.test.ts`, `e2e/usage.test.ts`
- Modify tests: `e2e/screens.ts` (remove `fact`, `trace`, `sessionOf`, `agentsOf`, `stepsOf`, `step`, `plan`, `currentPlan`, `modes`, `sinceTab`, `traceTab`, `mark`, `markButton`, `since`, `sinceSection`, `change`; add `dock`), `e2e/shell.test.ts`, `e2e/codex.test.ts`, `e2e/restart.test.ts`, `e2e/chat.test.ts`, `e2e/map.test.ts` (replace `fact(page, 'Map version')`/`versionShown` with an API read of `summary.version`)
- Create test: `e2e/layout.test.ts`

**Interfaces:**
- Produces: `ChatDock` component `({ children: ReactNode }) => ReactElement` rendering `<aside aria-label="Chat panel">` with a toggle button named "Collapse chat" / "Expand chat"; storage key `catacomb:chat-collapsed`.
- Produces: `Route = { screen: 'runs' } | { screen: 'run'; run: RunId }`; `runHref(run)`, `stageHref(run, stage)`, `selectStage`, `replaceStage` keep their names without the `mode` parameter.
- Produces in `e2e/screens.ts`: `dock(page): Locator` = `page.getByRole('complementary', { name: 'Chat panel' })`, `versionOf(daemon, run): Promise<number>`.

- [ ] **Step 1: Write the failing E2E**

Create `e2e/layout.test.ts`:

```ts
import { runId } from '@catacomb/contract/ids'
import { sampleScenarioManifest } from '@catacomb/testkit'
import { expect, test } from './fixtures.js'
import { dock } from './screens.js'

const claudeRun = runId({ kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' })

test.use({ config: { watch: { all: true } } })

test('the run screen is the map with the chat panel beside it and nothing else', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/?run=${claudeRun}`)

  await expect(page.getByRole('region', { name: 'Stage map' })).toBeVisible()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Sessions and agents' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Solver plan' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'View rules' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Run view' })).toHaveCount(0)
  await expect(page.locator('dl.facts')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Usage' })).toHaveCount(0)

  const map = await page.getByRole('region', { name: 'Stage map' }).boundingBox()
  const panel = await dock(page).boundingBox()
  expect(map !== null && panel !== null && panel.x >= map.x + map.width - 1).toBe(true)
})

test('the collapsed chat panel stays collapsed after a reload', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/?run=${claudeRun}`)

  await dock(page).getByRole('button', { name: 'Collapse chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeHidden()
  await page.reload()
  await expect(dock(page).getByRole('button', { name: 'Expand chat' })).toBeVisible()
  await dock(page).getByRole('button', { name: 'Expand chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
})

test('the chat panel works when the browser refuses storage', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
  })
  await page.goto(`/?run=${claudeRun}`)

  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
  await dock(page).getByRole('button', { name: 'Collapse chat' }).click()
  await expect(dock(page).getByRole('button', { name: 'Expand chat' })).toBeVisible()
})

test('on a narrow screen the chat opens over the map and closes again', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto(`/?run=${claudeRun}`)

  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeHidden()
  await dock(page).getByRole('button', { name: 'Expand chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
  await dock(page).getByRole('button', { name: 'Collapse chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeHidden()
})

test('old usage and changes links open the remaining screens', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto('/?view=usage')
  await expect(page.getByRole('link', { name: 'catacomb' })).toBeVisible()
  await expect(page.getByText('No runs yet').or(page.locator(`a[href="?run=${claudeRun}"]`))).toBeVisible()
  await page.goto(`/?run=${claudeRun}&mode=changes`)
  await expect(page.getByRole('region', { name: 'Stage map' })).toBeVisible()
})
```

Add to `e2e/screens.ts`:

```ts
export const dock = (page: Page): Locator => page.getByRole('complementary', { name: 'Chat panel' })
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && pnpm e2e e2e/layout.test.ts`
Expected: FAIL: no `complementary` named "Chat panel".

- [ ] **Step 3: Implement `ChatDock`**

Create `packages/web/src/chat-dock.tsx`:

```tsx
import { type ReactElement, type ReactNode, useEffect, useState } from 'react'
import './dock.css'

const collapsedKey = 'catacomb:chat-collapsed'
const wideQuery = '(min-width: 1100px)'

const storedCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(collapsedKey) === 'true'
  } catch {
    return false
  }
}

const storeCollapsed = (collapsed: boolean): void => {
  try {
    window.localStorage.setItem(collapsedKey, String(collapsed))
  } catch {
    return
  }
}

const useWide = (): boolean => {
  const [wide, setWide] = useState(() => window.matchMedia(wideQuery).matches)
  useEffect(() => {
    const query = window.matchMedia(wideQuery)
    const update = (): void => {
      setWide(query.matches)
    }
    query.addEventListener('change', update)
    return () => {
      query.removeEventListener('change', update)
    }
  }, [])
  return wide
}

export const ChatDock = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const wide = useWide()
  const [collapsedWide, setCollapsedWide] = useState(storedCollapsed)
  const [openNarrow, setOpenNarrow] = useState(false)
  const collapsed = wide ? collapsedWide : !openNarrow
  const toggle = (): void => {
    if (wide) {
      storeCollapsed(!collapsedWide)
      setCollapsedWide(!collapsedWide)
    } else {
      setOpenNarrow(!openNarrow)
    }
  }
  return (
    <aside className="chat-dock" aria-label="Chat panel" data-collapsed={collapsed} data-wide={wide}>
      <button type="button" className="dock-toggle" aria-expanded={!collapsed} onClick={toggle}>
        {collapsed ? 'Expand chat' : 'Collapse chat'}
      </button>
      <div className="dock-body" hidden={collapsed}>
        {children}
      </div>
    </aside>
  )
}
```

Create `packages/web/src/dock.css`:

```css
.chat-dock {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--line);
  background: var(--paper);
}

.chat-dock[data-wide='true'][data-collapsed='false'] {
  width: 380px;
}

.chat-dock[data-wide='true'][data-collapsed='true'] {
  width: 40px;
}

.chat-dock[data-wide='false'] {
  position: fixed;
  right: 0;
  bottom: 0;
  z-index: 20;
}

.chat-dock[data-wide='false'][data-collapsed='false'] {
  top: var(--masthead-height);
  width: min(380px, 100vw);
}

.dock-toggle {
  align-self: flex-start;
  margin: 8px;
}

.chat-dock[data-collapsed='true'] .dock-toggle {
  writing-mode: vertical-rl;
}

.dock-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
```

Use the colour and size variables that `styles.css` already defines; if `--line`, `--paper` or `--masthead-height` do not exist under those names, use the existing equivalents (`grep -n -- '--' packages/web/src/styles.css | head -40`) and define `--masthead-height` on `:root` from the masthead's height.

- [ ] **Step 4: Rewrite `RunContent` in `run-page.tsx`**

Delete `RunLink`, `Facts`, the imports of `ViewRules`, `SinceLastView`, `Trace`, `PlanFacts`, `usageHref`, `absoluteTime`, `Moment`, `ExecutionBadge`, `FreshnessBadge`, `supportModeLabel`. `RunContent` becomes:

```tsx
const RunContent = ({ snapshot, feed, now, onSignedOut }: RunContentProps): ReactElement => {
  const choice = useStageChoice(snapshot)
  return (
    <div className="run-screen-body">
      <div className="run-main">
        <AttentionZone snapshot={snapshot} now={now} handlers={{ onView: feed.noteView, onSignedOut }} />
        <MapSection snapshot={snapshot} choice={choice} />
      </div>
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
```

Remove `runs` from `RunContentProps` and `RunPageProps`; the run goal moves to the masthead (Step 5). Keep `Missing` and `RunTitle`; `RunTitle` is used by the masthead.

In `styles.css` add:

```css
.run-screen-body {
  display: flex;
  height: calc(100vh - var(--masthead-height));
  min-height: 0;
}

.run-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.run-main .map {
  flex: 1;
  min-height: 0;
}
```

and delete the `.facts`, `.run-talk`, `.run-body`, `.run-head` rule blocks. In `map.css`, make the map canvas fill its section (`.map { display: flex; flex-direction: column } .map .react-flow { flex: 1 }`; adapt to the current selectors).

- [ ] **Step 5: Slim `app.tsx` and `route.ts`**

In `route.ts`: delete `usagePeriods`, `UsagePeriod`, `usageView`, `isPeriod`, `RunMode`, `usageHref`, `viewHref`, `modeOf`, `useRoutedMode`, `useSwitchMode`, and the `usage` member of `Route`. New bodies:

```ts
export type Route = { readonly screen: 'runs' } | { readonly screen: 'run'; readonly run: RunId }

const routeOf = (search: string): Route => {
  const parsed = RunId.safeParse(new URLSearchParams(search).get('run'))
  return parsed.success ? { screen: 'run', run: parsed.data } : { screen: 'runs' }
}

export const runHref = (run: RunId): string => `?${new URLSearchParams({ run }).toString()}`

export const stageHref = (run: RunId, stage: StageId): string => `?${new URLSearchParams({ run, stage }).toString()}`

const stageLocation = (run: RunId, stage: StageId | null): string =>
  stage === null ? runHref(run) : stageHref(run, stage)
```

`/?view=usage` without `run` now routes to the list; `&mode=changes` is ignored.

In `app.tsx`: delete `UsageScreen`, `RunUsageScreen`, `OverviewBody`, `RunUsageBody`, `useUsageReport`, `usagePollMs` and the usage imports; the `Shell` switch keeps `runs` and `run`. `Masthead` loses the `usage` prop and the Usage link; replace the breadcrumb list with:

```tsx
const Masthead = ({ title }: { readonly title: string | null }): ReactElement => {
  const navigate = useNavigate()
  return (
    <header className="masthead">
      <a className="wordmark" href={listHref} onClick={navigate}>
        catacomb
      </a>
      {title === null ? null : (
        <nav className="masthead-nav" aria-label="Navigation">
          <a href={listHref} onClick={navigate}>
            ← Chats
          </a>
          <h1 className="masthead-title" title={title}>
            {title}
          </h1>
        </nav>
      )}
    </header>
  )
}
```

`ListScreen` renders `<Masthead title={null} />`; `RunScreen` renders `<Masthead title={title ?? 'Run'} />`. Keep `StatusStrip` and `StageInspector` in place for now (Tasks 4 and 6 remove them). Fix every `runHref(run, mode)`/`stageHref(..., mode)` call site the compiler reports.

- [ ] **Step 6: Delete the removed views and their tests**

```bash
cd packages/web/src
git rm since.tsx since.css changes.tsx use-changes.ts trace.tsx action-input.ts plan-facts.tsx usage-page.tsx usage.css view-rules.tsx
cd ../../..
git rm e2e/facts-view.test.ts e2e/since-last-view.test.ts e2e/since-last-view-variants.test.ts e2e/usage.test.ts
```

Then run `pnpm typecheck` and delete every export and file reported as unused (`grep -rln "<name>" packages/web/src` to confirm no importer). `view.css` is still imported by `view-rules.tsx` only: delete it if nothing else imports it. In `api.ts` delete `readChanges`, `markViewed`, `readUsage`, `readRaw` if no importer remains.

- [ ] **Step 7: Repair the remaining E2E files**

- `e2e/screens.ts`: delete the helpers listed in **Files**; add:

```ts
export const versionOf = async (daemon: RunningDaemon, run: RunId): Promise<number> =>
  endpoints.run.response.parse(await (await daemon.request(endpoints.run.path.replace(':run', run))).json()).summary
    .version
```

(import `endpoints` from `@catacomb/contract` and `RunningDaemon` from `@catacomb/testkit`).
- `e2e/map.test.ts`, `e2e/chat.test.ts`: replace `versionShown(page)`/`versionNow(page)`/`fact(page, 'Map version')` with `versionOf(daemon, claudeRun)`; delete assertions on `.facts`.
- `e2e/chat.test.ts`: delete `rules`/`activeRules` assertions (Task 5 adds chips); keep the chat assertions.
- `e2e/shell.test.ts`, `e2e/codex.test.ts`: delete tests and assertions whose subject is the trace, plan facts or facts list; keep run-list, live stream, sign-in and lamps assertions (Task 6 rewrites lamps).
- `e2e/restart.test.ts`: delete the "view mark" assertions; keep the restart and view-rule persistence checked through the API.

Each deleted assertion must be listed in the PR description with the reason "view removed by ADR-0015".

- [ ] **Step 8: Run the tests**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm e2e`
Expected: PASS for the whole suite.

- [ ] **Step 9: Commit**

```bash
git add -A packages/web e2e
git commit -m "Web: map and collapsible chat panel; remove trace, plan facts, since-last-view and usage (ADR-0015)"
```

---

### Task 4: Remove the inspector; stage selection focuses the chat

**Files:**
- Create: `packages/web/src/stage-summary.tsx`
- Modify: `packages/web/src/chat-panel.tsx` (render `StageSummary` above the log when a stage is chosen; replace `attentionAnchor` links with plain text)
- Modify: `packages/web/src/app.tsx` (remove `StageInspector`, `useClickedPlaceKept`, `data-inspecting`)
- Delete: `stage-inspector.tsx`, `stage-history.tsx`, `stage-artifacts.tsx`, `stage-criteria.tsx`, `grounds.tsx`, `change-grounds.tsx`, `fact-excerpt.ts`, `inspector.css`, `use-stage.ts` (if unused) and helpers left without importers
- Delete tests: `e2e/inspector.test.ts`, `e2e/inspector-selection.test.ts`
- Modify tests: `e2e/map.test.ts` (replace `inspected(page)` with the stage summary), `e2e/surfaces.test.ts` (drop inspector-grounds assertions)
- Create test: `e2e/stage-focus.test.ts`

**Interfaces:**
- Consumes: `StageChoice` from `map-section.tsx` (`selection: StageSelection | null`, `choose(stage | null)`).
- Produces: `StageSummary` `({ stage: Stage; open: readonly AttentionItem[]; onClear: () => void }) => ReactElement`, rendered as `<section aria-label="Selected stage">` with a button "Whole run".

- [ ] **Step 1: Write the failing E2E**

Create `e2e/stage-focus.test.ts`:

```ts
import { endpoints } from '@catacomb/contract'
import { runId } from '@catacomb/contract/ids'
import { mainStageTitle, observerScenarios, preparationStageTitle, sampleScenarioManifest } from '@catacomb/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { dock } from './screens.js'

const claudeRun = runId({ kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' })
const observed = { timeout: 30_000 }

const map = (page: Page): Locator => page.getByRole('region', { name: 'Stage map' })
const stage = (page: Page, title: string): Locator => map(page).getByRole('group', { name: `Stage "${title}"` })
const selected = (page: Page): Locator => dock(page).getByRole('region', { name: 'Selected stage' })

test.use({ config: { watch: { all: true } } })

test.describe('with the observer building the map', () => {
  test.skip(process.platform === 'win32', 'the fake claude cannot be the observer CLI on Windows')
  test.use({ claudeScenario: observerScenarios['map-layout'].live })

  test('clicking a stage shows its summary in the chat panel and narrows the chat; whole run clears it', async ({
    page,
    player,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${claudeRun}`)
    await expect(stage(page, preparationStageTitle)).toBeVisible(observed)

    await stage(page, preparationStageTitle).getByRole('button', { name: preparationStageTitle, exact: true }).click()
    await expect(page).toHaveURL(/[?&]stage=/)
    await expect(selected(page).getByRole('heading')).toHaveText(preparationStageTitle)
    await expect(selected(page)).toContainText('Execution: done')
    await expect(dock(page).getByText(`About: ${preparationStageTitle}`)).toBeVisible()
    await expect(page.getByRole('complementary', { name: /inspector/i })).toHaveCount(0)

    await selected(page).getByRole('button', { name: 'Whole run' }).click()
    await expect(page).not.toHaveURL(/[?&]stage=/)
    await expect(selected(page)).toHaveCount(0)
  })

  test('a stage link opened directly selects the stage and shows its summary', async ({ page, player, daemon }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${claudeRun}`)
    await expect(stage(page, mainStageTitle)).toBeVisible(observed)
    const snapshot = endpoints.run.response.parse(
      await (await daemon.request(endpoints.run.path.replace(':run', claudeRun))).json(),
    )
    const main = snapshot.model.stages.find(({ title }) => title === mainStageTitle)
    expect(main).toBeDefined()
    await page.goto(`/?run=${claudeRun}&stage=${main?.id ?? ''}`)
    await expect(selected(page).getByRole('heading')).toHaveText(mainStageTitle)
  })
})
```

Check the chat panel's current scope label text (`grep -n "chat-scope" -A12 packages/web/src/chat-panel.tsx`) and use its exact wording instead of `About: <title>` if it differs.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && pnpm e2e e2e/stage-focus.test.ts`
Expected: FAIL: no region "Selected stage".

- [ ] **Step 3: Implement `StageSummary`**

Create `packages/web/src/stage-summary.tsx`:

```tsx
import type { AttentionItem, Stage } from '@catacomb/contract'
import type { ReactElement } from 'react'
import { BasisBadge, ExecutionBadge } from './badges.js'
import { attentionKindLabel } from './labels.js'
import { StageName } from './short-ids.js'

export const StageSummary = ({
  stage,
  open,
  onClear,
}: {
  readonly stage: Stage
  readonly open: readonly AttentionItem[]
  readonly onClear: () => void
}): ReactElement => (
  <section className="stage-summary" aria-label="Selected stage">
    <header className="stage-summary-head">
      <h2 className="stage-summary-title">
        <StageName title={stage.title} />
      </h2>
      <button type="button" className="stage-summary-clear" onClick={onClear}>
        Whole run
      </button>
    </header>
    <p className="stage-summary-axes">
      <span className="visually-hidden">Execution: </span>
      <ExecutionBadge execution={stage.execution.value} />
      <span className="visually-hidden">Basis: </span>
      <BasisBadge basis={stage.execution.basis} />
    </p>
    {stage.summary === null ? null : <p className="stage-summary-text">{stage.summary}</p>}
    {open.length === 0 ? null : (
      <ul className="stage-summary-waiting" aria-label="Waiting for you">
        {open.map((item) => (
          <li key={item.id}>{`${attentionKindLabel[item.kind]}: ${item.text}`}</li>
        ))}
      </ul>
    )}
  </section>
)
```

Add to `chat.css`:

```css
.stage-summary {
  padding: 12px;
  border-bottom: 1px solid var(--line);
}

.stage-summary-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.stage-summary-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

In `ChatPanel`, above the `<ol className="chat-log">`, render:

```tsx
{choice.selection === null ? null : (
  <StageSummary
    stage={choice.selection.stage}
    open={snapshot.attention.items.filter(
      ({ stage, resolution }) => stage === choice.selection?.stage.id && resolution === 'open',
    )}
    onClear={() => {
      choice.choose(null)
    }}
  />
)}
```

Replace `QuestionCite`'s `<a href={'#' + attentionAnchor(item.id)}>` with the `<span className="chat-cite">` branch it already has for closed items, and remove the `attentionAnchor` import (the zone is removed in Task 5).

- [ ] **Step 4: Remove the inspector**

In `app.tsx`, `RunScreen` renders only `<RunPage …/>` inside the generation and agents contexts; delete `useClickedPlaceKept`, `ClickedPlace`, `close`, the `StageInspector` import and the `data-inspecting` attribute. Then:

```bash
cd packages/web/src
git rm stage-inspector.tsx stage-history.tsx stage-artifacts.tsx stage-criteria.tsx grounds.tsx change-grounds.tsx fact-excerpt.ts inspector.css
cd ../../..
git rm e2e/inspector.test.ts e2e/inspector-selection.test.ts
```

Run `pnpm typecheck`; delete `use-stage.ts`, `readStage` in `api.ts` and other exports the compiler or `grep` shows unused.

- [ ] **Step 5: Repair `map.test.ts` and `surfaces.test.ts`**

Replace `inspected(page)` (the inspector heading) with `page.getByRole('complementary', { name: 'Chat panel' }).getByRole('region', { name: 'Selected stage' }).getByRole('heading')`. In `surfaces.test.ts`, delete the inspector grounds assertions of E2E 1 and keep the map nesting assertions.

- [ ] **Step 6: Run the tests**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm e2e`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/web e2e
git commit -m "Web: stage selection focuses the chat with a stage summary; remove the inspector (ADR-0015)"
```

---

### Task 5: Node card, attention badges and filter chips; remove the attention zone

**Files:**
- Modify: `packages/web/src/map-node.tsx` (card contents; badge)
- Modify: `packages/web/src/map-graph.ts` (`MapStage` gains `waiting: number`)
- Create: `packages/web/src/filter-chips.tsx`
- Modify: `packages/web/src/map-section.tsx` (render `FilterChips` in the map head; drop the "Stage map" counts that duplicate chips)
- Modify: `packages/web/src/app.tsx` (header "waiting for you" chip for stage-less items)
- Modify: `packages/web/src/run-page.tsx` (remove `AttentionZone`)
- Delete: `attention-zone.tsx` and helpers left without importers (`ZoneGlyph`, `ZoneMark` in `glyphs.tsx`, attention-view labels, `markAttentionViewed`, `dismissAttention` in `api.ts`)
- Delete tests: `e2e/attention-zone.test.ts`
- Modify tests: `e2e/map.test.ts` (card axes), `e2e/chat.test.ts` (rules → chips), `e2e/screens.ts` (remove `zone`, `openItems`, `zoneItem`, `historyToggle`, `history`; add `chips`, `waitingChip`)
- Create test: `e2e/attention-badges.test.ts`

**Interfaces:**
- Consumes: `StageSummary` from Task 4, `dock` from Task 3.
- Produces: `MapStage.waiting: number`; `FilterChips` `({ snapshot: RunSnapshot; onSignedOut: () => void }) => ReactElement | null` rendering `<ul aria-label="Active filters">` with one `<li>` per rule and a button named `Remove filter: <rule text>`; header chip `<p aria-label="Waiting for you">`.

- [ ] **Step 1: Write the failing E2E**

Create `e2e/attention-badges.test.ts`:

```ts
import { runId } from '@catacomb/contract/ids'
import { checksBlockerText, checksStageTitle, observerScenarios, sampleScenarioManifest } from '@catacomb/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { claudeOriginal, runOf } from './samples.js'
import { dock } from './screens.js'

const observed = { timeout: 30_000 }
const map = (page: Page): Locator => page.getByRole('region', { name: 'Stage map' })
const stage = (page: Page, title: string): Locator => map(page).getByRole('group', { name: `Stage "${title}"` })

test.use({ config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } } })

test.describe('with the observer opening attention items', () => {
  test.skip(process.platform === 'win32', 'the fake claude cannot be the observer CLI on Windows')
  test.use({ claudeScenario: observerScenarios['attention-zone'].live })

  test('a stage with an open item carries a waiting badge and lists the item when selected', async ({
    page,
    player,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)

    const checks = stage(page, checksStageTitle)
    await expect(checks.getByLabel('Waiting for you')).toHaveText('1', observed)
    await expect(page.getByRole('region', { name: 'Attention', exact: true })).toHaveCount(0)
    await checks.getByRole('button', { name: checksStageTitle, exact: true }).click()
    await expect(
      dock(page).getByRole('region', { name: 'Selected stage' }).getByRole('list', { name: 'Waiting for you' }),
    ).toContainText(checksBlockerText)
  })
})

test('a question without a stage is counted in the header and listed on hover', async ({ page, player }) => {
  const played = await player(sampleScenarioManifest('claude-ask'), { timeScale: 0 })
  await played.play()
  const run = runOf(played.manifest)
  await page.goto(`/?run=${run}`)

  const waiting = page.getByRole('banner').getByLabel('Waiting for you')
  await expect(waiting).toContainText('1', observed)
  await waiting.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()
})
```

`claude-ask` stands for the recorded sample with an unanswered `AskUserQuestion` that `attention-zone.test.ts` uses (`grep -n "sampleScenarioManifest(" e2e/attention-zone.test.ts`); use that exact sample name and its `runOf` helper. Copy that test's setup lines verbatim before deleting the file.

Add the filter chip scenario to `e2e/chat.test.ts`, replacing the old `activeRules` test (it already uses `observerScenarios.chat` with `chat-collapse-reviewers`):

```ts
test('a filter asked in the chat shows as a chip over the map and removing it restores the map', async ({ page, player }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${claudeRun}`)
  await expect(map(page).getByRole('group').first()).toBeVisible(observed)

  await ask(page, 'Collapse the reviewers')
  const chips = map(page).getByRole('list', { name: 'Active filters' }).getByRole('listitem')
  await expect(chips).toHaveCount(1, observed)
  await chips.first().getByRole('button', { name: /^Remove filter: / }).click()
  await expect(chips).toHaveCount(0, observed)
})

test('a filter that hides the selected stage keeps the stage summary and whole run clears it', async ({ page, player }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${claudeRun}`)
  await expect(stage(page, preparationStageTitle)).toBeVisible(observed)
  await pick(stage(page, preparationStageTitle), preparationStageTitle).click()
  const selected = page.getByRole('complementary', { name: 'Chat panel' }).getByRole('region', { name: 'Selected stage' })
  await expect(selected).toBeVisible()

  await ask(page, 'Collapse the reviewers')
  await expect(map(page).getByRole('list', { name: 'Active filters' }).getByRole('listitem')).toHaveCount(1, observed)
  await expect(selected.getByRole('heading')).toHaveText(preparationStageTitle)
  await selected.getByRole('button', { name: 'Whole run' }).click()
  await expect(selected).toHaveCount(0)
})
```

Use the exact question text that the existing view-rule test in `chat.test.ts` sends to trigger `chat-collapse-reviewers`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm build && pnpm e2e e2e/attention-badges.test.ts e2e/chat.test.ts`
Expected: FAIL: no "Waiting for you" label, no "Active filters" list.

- [ ] **Step 3: Count waiting items per stage in `map-graph.ts`**

Where `MapStage` objects are built from `snapshot.model.stages`, add:

```ts
const waitingByStage = (items: readonly AttentionItem[]): ReadonlyMap<StageId, number> => {
  const counts = new Map<StageId, number>()
  for (const { stage, resolution } of items) {
    if (stage !== null && resolution === 'open') {
      counts.set(stage, (counts.get(stage) ?? 0) + 1)
    }
  }
  return counts
}
```

and set `waiting: waitingByStage(snapshot.attention.items).get(stage.id) ?? 0` on each `MapStage`. Add `readonly waiting: number` to the `MapStage` interface.

- [ ] **Step 4: Rewrite the card in `map-node.tsx`**

`StageCard` body after the header becomes:

```tsx
      <ul className="stage-axes">
        <li>
          <span className="visually-hidden">Execution: </span>
          <ExecutionBadge execution={stage.execution.value} />
        </li>
        <li>
          <span className="visually-hidden">Basis: </span>
          <BasisBadge basis={stage.execution.basis} />
        </li>
      </ul>
      {node.waiting === 0 ? null : (
        <p className="stage-waiting" aria-label="Waiting for you" title={`Waiting for you: ${String(node.waiting)}`}>
          {node.waiting}
        </p>
      )}
      {view.folded === null ? null : (
        <p className="stage-meta">
          <span className="stage-folded" title={totalsText(view.folded)}>
            {`collapsed by a filter: ${totalsText(view.folded)}`}
          </span>
        </p>
      )}
```

Delete `agentLabel`, `team`, the `DecisionBadge`, `stageOriginLabel`, `actionForms`, `substageForms`, `agentRoleLabel`, `serviceAgentLabel`, `detailLevelLabel` imports. In `map.css` add `.stage-waiting` as a small pill using the existing warning tone variable and an `AttentionGlyph` is not needed: the number plus the label satisfies RFC §5.

- [ ] **Step 5: Implement `FilterChips`**

Create `packages/web/src/filter-chips.tsx`:

```tsx
import type { RunSnapshot, ViewRuleId } from '@catacomb/contract'
import { type ReactElement, useState } from 'react'
import { failureText, revokeViewRule, SignedOut } from './api.js'
import { fullHint, shortIds, useKnownAgents } from './short-ids.js'
import { ruleText } from './view-labels.js'

export const FilterChips = ({
  snapshot,
  onSignedOut,
}: {
  readonly snapshot: RunSnapshot
  readonly onSignedOut: () => void
}): ReactElement | null => {
  const agents = useKnownAgents()
  const [removing, setRemoving] = useState<ReadonlySet<ViewRuleId>>(() => new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const { rules } = snapshot.view
  if (rules.length === 0 && failure === null) {
    return null
  }
  const remove = async (id: ViewRuleId): Promise<void> => {
    setFailure(null)
    setRemoving((current) => new Set(current).add(id))
    try {
      await revokeViewRule(snapshot.summary.id, id)
    } catch (error) {
      setRemoving((current) => new Set([...current].filter((known) => known !== id)))
      if (error instanceof SignedOut) {
        onSignedOut()
        return
      }
      setFailure(failureText(error))
    }
  }
  return (
    <div className="filters">
      <ul className="filter-chips" aria-label="Active filters">
        {rules.map(({ rule }) => {
          const full = ruleText(rule, snapshot.model.stages)
          const text = shortIds(full, agents)
          return (
            <li key={rule.id} className="filter-chip" title={fullHint(full, agents)}>
              <span>{`Filter: ${text}`}</span>
              <button
                type="button"
                aria-label={`Remove filter: ${text}`}
                disabled={removing.has(rule.id)}
                onClick={() => {
                  void remove(rule.id)
                }}
              >
                ✕
              </button>
            </li>
          )
        })}
      </ul>
      {failure === null ? null : (
        <p className="filters-error" role="alert">
          {`Filter not removed: ${failure}`}
        </p>
      )}
    </div>
  )
}
```

Render `<FilterChips snapshot={snapshot} onSignedOut={onSignedOut} />` in `MapSection`'s header (add `onSignedOut` to `MapSection` props and pass it from `RunContent`). Delete the `hidden by view rules` count paragraph. Move the chip styles (`.filters`, `.filter-chips`, `.filter-chip`) into `map.css`, reusing any rules from the deleted `view.css` that still apply.

- [ ] **Step 6: Header waiting chip**

In `app.tsx`, extend `Masthead` with `waiting: readonly AttentionItem[]` and render, after the title:

```tsx
{waiting.length === 0 ? null : (
  <p className="masthead-waiting" aria-label="Waiting for you">
    <span>{waiting.length}</span>
    <span role="tooltip" className="masthead-tooltip">
      {waiting.map(({ id, kind, text }) => (
        <span key={id}>{`${attentionKindLabel[kind]}: ${text}`}</span>
      ))}
    </span>
  </p>
)}
```

`RunScreen` passes `feed.snapshot?.attention.items.filter(({ stage, resolution }) => stage === null && resolution === 'open') ?? []`; `ListScreen` passes `[]`. In `styles.css`, `.masthead-tooltip` is hidden until `.masthead-waiting:hover` or `:focus-within` (give the chip `tabIndex={0}`).

- [ ] **Step 7: Remove the attention zone**

Remove `AttentionZone` from `RunContent`. Then:

```bash
git rm packages/web/src/attention-zone.tsx e2e/attention-zone.test.ts
```

Run `pnpm typecheck` and delete unused exports (`ZoneGlyph`, `ZoneMark`, `markAttentionViewed`, `dismissAttention`, zone labels, `noteView` in `use-run-feed.ts` if unused). Update `e2e/screens.ts` as listed in **Files**. In `e2e/map.test.ts` replace `Human decision:` and `agent: pinger` and `3 substages` assertions with:

```ts
    await expect(preparation.getByRole('listitem')).toHaveCount(2)
    await expect(preparation).not.toContainText('Human decision')
```

- [ ] **Step 8: Run the tests**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm e2e`
Expected: PASS. If the filter chip test fails because the fake chat scenario did not produce a rule, inspect the request the test sends; the fake does not depend on the prompt. Prompt tuning for real "show only X" requests is a manual check in Step 9.

- [ ] **Step 9: Manual check of a real filter request**

With a real `claude` CLI as the observer (`catacomb start` from this branch's build, `catacomb watch` a project, run a short session), ask in the chat: "show only the stages about tests". Expected: the answer carries a view rule and a chip appears. If no rule is produced in three attempts, edit `chatSystemPrompt` in `packages/observer/src/prompt.ts` to state that requests to show only, hide, focus on or group parts of the map must be answered with a `view_rule`, rebuild and repeat. Record the outcome in the PR description.

- [ ] **Step 10: Commit**

```bash
git add -A packages/web packages/observer e2e
git commit -m "Web: compact stage card with attention badges, filter chips; remove the attention zone (ADR-0015)"
```

---

### Task 6: Health dot replaces the status strip

**Files:**
- Create: `packages/web/src/health-dot.tsx`
- Modify: `packages/web/src/lamps.ts` (export `problemsOf`)
- Modify: `packages/web/src/app.tsx` (render `HealthDot` in `Masthead`; remove `StatusStrip`)
- Delete: `packages/web/src/status-strip.tsx` and its CSS block in `styles.css` (`.annunciator`, `.lamps`, `.lamp*`)
- Modify tests: `e2e/shell.test.ts`, `e2e/codex.test.ts` (lamp assertions → dot), `e2e/screens.ts` (remove `strip`, `lamp`, `lampDetails`; add `healthDot`, `healthProblems`)

**Interfaces:**
- Consumes: `lampsOf(input): Lamp[]`, `Lamp`, `LampId`.
- Produces: `problemsOf(lamps: readonly Lamp[]): Lamp[]` = lamps with `level !== 'normal'` and `id !== 'coverage'`; `HealthDot` `({ lamps: readonly Lamp[] }) => ReactElement | null` rendering a button named `Observation problems: <n>` that toggles `<div role="region" aria-label="Observation problems">`.

- [ ] **Step 1: Write the failing E2E**

In `e2e/screens.ts`:

```ts
export const healthDot = (page: Page): Locator =>
  page.getByRole('banner').getByRole('button', { name: /^Observation problems: / })

export const healthProblems = async (page: Page): Promise<Locator> => {
  if ((await healthDot(page).getAttribute('aria-expanded')) !== 'true') {
    await healthDot(page).click()
  }
  return page.getByRole('region', { name: 'Observation problems', exact: true })
}
```

In `e2e/shell.test.ts`, convert each existing lamp test: where it asserted a lamp in a normal state, assert `await expect(healthDot(page)).toHaveCount(0)`; where it asserted a lamp in caution or warning with a text, assert `await expect(await healthProblems(page)).toContainText('<same text>')`. Add:

```ts
test('a healthy install shows no health dot even though cloud surfaces are not observable', async ({ page, daemon }) => {
  const { not_observable: surfaces } = endpoints.status.response.parse(
    await (await daemon.request(endpoints.status.path)).json(),
  )
  expect(surfaces.length).toBeGreaterThan(0)
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'catacomb' })).toBeVisible()
  await expect(healthDot(page)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Observation status' })).toHaveCount(0)
})
```

If the test daemon profile reports no `not_observable` surfaces, drop the `toBeGreaterThan(0)` line and keep the dot assertion.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm build && pnpm e2e e2e/shell.test.ts`
Expected: FAIL: the status strip is still present, no health dot.

- [ ] **Step 3: Implement**

In `lamps.ts`:

```ts
export const problemsOf = (lamps: readonly Lamp[]): Lamp[] =>
  lamps.filter(({ id, level }) => level !== 'normal' && id !== 'coverage')
```

Create `packages/web/src/health-dot.tsx`:

```tsx
import { type ReactElement, useId, useState } from 'react'
import { LevelGlyph } from './glyphs.js'
import { type Lamp, problemsOf } from './lamps.js'

const worst = (lamps: readonly Lamp[]): Lamp['level'] =>
  lamps.some(({ level }) => level === 'warning') ? 'warning' : 'caution'

export const HealthDot = ({ lamps }: { readonly lamps: readonly Lamp[] }): ReactElement | null => {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const problems = problemsOf(lamps)
  if (problems.length === 0) {
    return null
  }
  return (
    <div className="health">
      <button
        type="button"
        className="health-dot"
        data-level={worst(problems)}
        aria-label={`Observation problems: ${String(problems.length)}`}
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <LevelGlyph level={worst(problems)} />
      </button>
      {open ? (
        <div id={panel} className="health-panel" role="region" aria-label="Observation problems">
          <ul>
            {problems.flatMap((lamp) => [
              <li key={lamp.id} data-level={lamp.level}>
                <LevelGlyph level={lamp.level} />
                <span>{`${lamp.label}: ${lamp.value}`}</span>
              </li>,
              ...lamp.details.map((detail, index) => (
                <li key={`${lamp.id}-${String(index)}`} data-level={detail.level} className="health-detail">
                  <span>{detail.text}</span>
                </li>
              )),
            ])}
          </ul>
          <p className="health-note">
            Details: <code>catacomb status</code>
          </p>
        </div>
      ) : null}
    </div>
  )
}
```

In `app.tsx`, pass `lamps` into `Masthead` and render `<HealthDot lamps={lamps} />` at the right end of the header; delete every `<StatusStrip …/>` and its import; `git rm packages/web/src/status-strip.tsx`; delete the strip CSS. Style `.health-panel` as an absolutely positioned popover under the dot in `styles.css`.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/web e2e
git commit -m "Web: a health dot in the header replaces the status strip (ADR-0015)"
```

---

### Task 7: Compact chat list and the web README

**Files:**
- Modify: `packages/web/src/run-list.tsx` (table → list)
- Modify: `packages/web/src/styles.css` (`.runs` table rules → `.chats` list rules)
- Modify: `packages/web/README.md` (screen spec rewritten for the new UI)
- Modify tests: `e2e/screens.ts` (`runRowOf` → list item), `e2e/shell.test.ts`
- Create test: in `e2e/shell.test.ts`

**Interfaces:**
- Consumes: `RunSummary.cwd` (Task 2).
- Produces: `<ul aria-label="Chats">` with one `<li>` per run; the whole row is one link `a[href="?run=<id>"]`. `runRowOf(page, run)` = `page.getByRole('list', { name: 'Chats' }).getByRole('listitem').filter({ has: page.locator('a[href="?run=' + run + '"]') })`.

- [ ] **Step 1: Write the failing E2E**

In `e2e/screens.ts` replace `runRowOf` with:

```ts
export const runRowOf = (page: Page, run: RunId): Locator =>
  page
    .getByRole('list', { name: 'Chats' })
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="?run=${run}"]`) })
```

Add to `e2e/shell.test.ts`:

```ts
test('a chat row shows the goal, the project folder, the state and the time, newest first', async ({ page, player, daemon }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  const run = runOf(claudeOriginal)
  const { runs } = endpoints.runs.response.parse(await (await daemon.request(endpoints.runs.path)).json())
  const summary = runs.find(({ id }) => id === run)
  expect(summary?.cwd).toBeTruthy()
  const folder = (summary?.cwd ?? '').split(/[\\/]/).filter(Boolean).slice(-2).join('/')

  await page.goto('/')
  const row = runRowOf(page, run)
  await expect(row).toContainText(claudeGoal)
  await expect(row).toContainText(folder)
  await expect(row.getByTitle(summary?.cwd ?? '')).toBeVisible()
  await expect(row).toContainText(/ago|just now/)
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(row).not.toContainText('Waiting for you')
})
```

Add a waiting-count row assertion to `e2e/attention-badges.test.ts` (Task 5's stage-less question test), after the header check:

```ts
  await page.goto('/')
  await expect(runRowOf(page, run)).toContainText('Waiting for you: 1')
```

Check `relativeTime` in `format.ts` for its exact wording and adjust the `/ago|just now/` pattern to it.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm build && pnpm e2e e2e/shell.test.ts e2e/attention-badges.test.ts`
Expected: FAIL: no list named "Chats".

- [ ] **Step 3: Implement the list**

Replace `RunRow`, `RunTable` and `forkOrigin` in `run-list.tsx` with:

```tsx
const folderOf = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

const ChatRow = ({ run, now }: { readonly run: RunSummary; readonly now: bigint }): ReactElement => {
  const navigate = useNavigate()
  const title = runTitle(run)
  const waiting = run.attention.waiting_for_human
  return (
    <li className="chat-row">
      <a className="chat-row-link" href={runHref(run.id)} onClick={navigate} title={title ?? undefined}>
        <span className="chat-row-goal">{title ?? <span className="untitled">{untitledRun(run)}</span>}</span>
        {run.cwd === null ? null : (
          <span className="chat-row-folder" title={run.cwd}>
            {folderOf(run.cwd)}
          </span>
        )}
        <ExecutionBadge execution={run.execution} />
        {waiting === 0 ? null : <span className="chat-row-waiting">{`Waiting for you: ${String(waiting)}`}</span>}
        <Moment at={run.last_event_at} now={now} />
      </a>
    </li>
  )
}

const ChatRows = ({ runs, now }: { readonly runs: readonly RunSummary[]; readonly now: bigint }): ReactElement => (
  <ul className="chats" aria-label="Chats">
    {[...runs]
      .sort((left, right) => (left.last_event_at === right.last_event_at ? 0 : left.last_event_at > right.last_event_at ? -1 : 1))
      .map((run) => (
        <ChatRow key={run.id} run={run} now={now} />
      ))}
  </ul>
)
```

and render `<ChatRows runs={runs} now={now} />` in `RunList` in place of `RunTable`. Remove now-unused imports (`AttentionBadge`, `FreshnessBadge`, `supportModeLabel`, `dayTime` if unused). In `styles.css`, replace the `.runs` table blocks with a flex row (`.chat-row-link { display: flex; gap: 12px; align-items: baseline }`, goal `flex: 1` with ellipsis, folder in the muted mono font).

- [ ] **Step 4: Rewrite `packages/web/README.md`**

Replace sections H.1–H.11 with: Header (wordmark, back link, goal, waiting chip, health dot), Chat list, Chat screen (map, node card, filter chips, chat panel, stage summary, narrow layout), and a short "Removed by ADR-0015" list. Keep the build and development sections.

- [ ] **Step 5: Run the full verification**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm coverage`
Expected: all PASS; coverage report shows no uncovered business logic in the new web files (`chat-dock.tsx`, `stage-summary.tsx`, `filter-chips.tsx`, `health-dot.tsx`, `run-list.tsx`).

- [ ] **Step 6: Commit**

```bash
git add -A packages/web e2e
git commit -m "Web: compact chat list with the project folder; README for the simplified UI (ADR-0015)"
```

---

## Self-review notes

- Spec coverage: D1/D3 → Task 5 (chips, prompt check); D2 → no change; D4 → Global Constraints; D5 → Task 5 (badge, header chip), Task 7 (list count); D6 → Task 4; D7 → Task 5; D8 → Task 6; D9 → Tasks 2, 7; D10 → Task 3; D11 → Task 1.
- Review Focus pins: coverage lamp → Task 6 healthy-install test; stage-less items → Task 5 header test; hidden selected stage → Task 5 chat test; storage refusal → Task 3; old URLs → Task 3.
