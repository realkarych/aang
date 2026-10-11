import { endpoints, type RunId, type RunSnapshot, type Surface } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import {
  continuationQuestionText,
  continuedStageTitle,
  type LoadedManifest,
  loadManifest,
  mainStageTitle,
  type ObserverScenarioPhase,
  observerScenarios,
  type PlayerStep,
} from '@aang/testkit'
import type { APIRequestContext, Page } from '@playwright/test'
import { type AangFixtures, expect, getWithoutKeepAlive, type PlayerSettings, test } from './fixtures.js'
import { variantRecording } from './recordings.js'
import { change, mark, markButton, since, sinceTab } from './screens.js'
import { afterIterationVariants, skippedHere, type SurfaceVariant } from './variants.js'

interface Continuation {
  readonly variant: SurfaceVariant
  readonly scenario: string
  readonly firstToolAfterTheMark: string
}

interface Observer {
  readonly setScenario: (scenario: ObserverScenarioPhase) => void
}

const surfaceNames: Readonly<Record<Surface, string>> = {
  claude_cli: 'CLI',
  claude_desktop: 'Desktop',
  claude_sdk: 'SDK',
  codex_tui: 'TUI',
  codex_exec: 'CLI',
  codex_desktop: 'Desktop',
  codex_sdk: 'SDK',
}

const finalAnswerMessagesAfterTheQuestion: Readonly<Partial<Record<Surface, readonly string[]>>> = {
  codex_desktop: ['msg_aang_2', 'msg_aang_3'],
}

const playing = (runtime: SurfaceVariant['runtime'], scenario: string): readonly SurfaceVariant[] =>
  afterIterationVariants.filter((variant) => variant.runtime === runtime && variant.scenarios.includes(scenario))

const viewMark = 'view-mark'

const nothingChanged = 'Nothing changed since the mark.'

const observed = { timeout: 60_000 }

const playback: PlayerSettings = { timeScale: 0, recordTime: 'playback' }

const claudeFinalText = 'Read the notes, listed the project and wrote result.txt.'

const codexQuestionText = 'Which greeting should notes.txt use?'

const codexQuestionMessage = `${codexQuestionText}\n- hello\n- hi`

const codexFinalAnswer = 'done'

const hookPayload = (manifest: LoadedManifest, step: PlayerStep): Readonly<Record<string, unknown>> => {
  if (step.kind !== 'hook') {
    return {}
  }
  const payload: unknown = JSON.parse(manifest.sources.get(step.source)?.toString('utf8') ?? '{}')
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

const sessionOf = (manifest: LoadedManifest): string => {
  const [session] = manifest.steps.flatMap((step) => {
    const id = hookPayload(manifest, step).session_id
    return typeof id === 'string' ? [id] : []
  })
  expect(session, `${manifest.file} has a hook event with the session id`).toBeDefined()
  return session ?? ''
}

const markedBefore = (manifest: LoadedManifest, tool: string): LoadedManifest => {
  const first = manifest.steps.findIndex((step) => hookPayload(manifest, step).tool_name === tool)
  expect(first, `${manifest.file} calls ${tool} after its first step`).toBeGreaterThan(0)
  const steps = manifest.steps.flatMap((step, index): PlayerStep[] =>
    step.kind === 'otlp' ? [] : [index === first ? { ...step, label: viewMark } : step],
  )
  const used = new Set(steps.flatMap((step) => ('source' in step ? [step.source] : [])))
  return { file: manifest.file, steps, sources: new Map([...manifest.sources].filter(([source]) => used.has(source))) }
}

const snapshotOf = async (request: APIRequestContext, run: RunId): Promise<RunSnapshot | null> => {
  const response = await getWithoutKeepAlive(request, endpoints.run.path.replace(':run', run))
  return response.status() === 200 ? endpoints.run.response.parse(await response.json()) : null
}

const mapped = async (request: APIRequestContext, run: RunId): Promise<boolean> => {
  const snapshot = await snapshotOf(request, run)
  return (
    snapshot !== null &&
    snapshot.model.stages.some((stage) => stage.title === mainStageTitle) &&
    snapshot.summary.observer.pending_facts === 0
  )
}

const continuedAfterTheMark = async (
  page: Page,
  player: AangFixtures['player'],
  observer: Observer,
  { variant, scenario, firstToolAfterTheMark }: Continuation,
): Promise<string> => {
  const manifest = markedBefore(await loadManifest(variantRecording(variant, scenario)), firstToolAfterTheMark)
  const session = sessionOf(manifest)
  const run = runId({ kind: 'session', runtime: variant.runtime, session })
  const replay = await player(manifest, playback)
  await replay.play({ until: viewMark })

  await page.goto(`/?run=${run}&mode=changes`)
  await expect(since(page)).toContainText('The run is not marked as reviewed yet.')
  await expect.poll(() => mapped(page.request, run), observed).toBe(true)
  await markButton(page).click()
  await expect(mark(page)).toContainText('Reviewed just now')
  await expect(since(page)).toContainText(nothingChanged)

  observer.setScenario(observerScenarios['since-last-view'].after)
  await replay.play()
  return session
}

const expectReplacedStage = async (page: Page): Promise<void> => {
  const replaced = change(page, 'Revised decisions', `Stage "${mainStageTitle}"`)
  await expect(replaced).toContainText(`replaced by stage "${continuedStageTitle}"`, observed)
  await expect(replaced).toContainText('aang interpretation')
  await replaced.getByRole('button', { name: /^Grounds: / }).click()
  await expect(replaced).toContainText(/raw record #\d+/)
  await expect(change(page, 'Stages', `"${continuedStageTitle}"`)).toContainText('new')
}

const expectNewResult = async (page: Page, session: string, file: string, tool: string): Promise<void> => {
  const result = change(page, 'Outputs', file).filter({ hasText: `written by ${tool}` })
  await expect(result).toContainText('new version', observed)
  await expect(result).toContainText(`Session ${session.slice(0, 8)}, main agent`)
  await result.getByRole('button', { name: /^Grounds: / }).click()
  await expect(result).toContainText(/raw record #\d+/)
}

const expectObserverQuestion = async (page: Page): Promise<void> => {
  const question = change(page, 'Questions and requests', continuationQuestionText)
  await expect(question).toContainText('opened', observed)
  await expect(question).toContainText('from the observer')
}

const factsPath = endpoints.fact.path.replace(':id', '')

const expectCardsToOriginal = async (page: Page, text: string, count = 1): Promise<(string | null)[]> => {
  const cards = change(page, 'Solver results', text)
  await expect(cards).toHaveCount(count, observed)
  const messages: (string | null)[] = []
  for (const card of await cards.all()) {
    await expect(card).toContainText('new')
    await expect(card).toContainText(`stage "${continuedStageTitle}"`)
    const read = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith(factsPath))
    await card.getByRole('button', { name: 'Show original' }).click()
    const { fact } = endpoints.fact.response.parse(await (await read).json())
    const original = card.getByRole('figure')
    await expect(original.locator('mark')).toHaveText(text)
    await expect(original).toContainText('message')
    await expect(original).toContainText('solver')
    await expect(original).toContainText(`raw record #${String(fact.seq)}`)
    messages.push(fact.runtime_ids.message_id)
    await card.getByRole('button', { name: 'Hide original' }).click()
    await expect(original).toHaveCount(0)
  }
  return messages
}

const expectCountedChanges = async (page: Page): Promise<void> => {
  await expect(sinceTab(page)).toHaveAccessibleName(/^Since last review, \d+ changes?/)
}

const checkedOnThisOs = (variant: SurfaceVariant): void => {
  const reason = skippedHere(variant)
  test.skip(reason !== undefined, reason)
}

test.use({ config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } } })

test.describe('with the observer', () => {
  test.describe.configure({ timeout: 120_000 })

  test.describe('of Claude', () => {
    test.use({ claudeScenario: observerScenarios['since-last-view'].before })

    for (const variant of playing('claude', 'tools')) {
      test.describe(() => {
        checkedOnThisOs(variant)

        test(`Claude ${surfaceNames[variant.surface]}: a turn continued after the mark shows the replaced stage, the new result, the closed approvals, the observer question and the card to the original (E2E 4)`, async ({
          page,
          player,
          fakeClaude,
        }) => {
          const session = await continuedAfterTheMark(page, player, fakeClaude, {
            variant,
            scenario: 'tools',
            firstToolAfterTheMark: 'Write',
          })

          await expectReplacedStage(page)
          await expectNewResult(page, session, 'result.txt', 'Write')
          await expectNewResult(page, session, 'result.txt', 'Edit')
          for (const tool of ['Write', 'Edit']) {
            const approval = change(page, 'Questions and requests', `${tool}: `)
            await expect(approval).toContainText('Approval request')
            await expect(approval).toContainText('by aang rule')
            await expect(approval).toContainText('closed')
          }
          await expectObserverQuestion(page)
          await expectCardsToOriginal(page, claudeFinalText)
          await expectCountedChanges(page)
        })
      })
    }
  })

  test.describe('of Codex', () => {
    test.use({ codexScenario: observerScenarios['since-last-view'].before })

    for (const variant of playing('codex', 'tools')) {
      test.describe(() => {
        checkedOnThisOs(variant)

        test(`Codex ${surfaceNames[variant.surface]}: a turn continued after the mark shows the replaced stage and the new result (E2E 4)`, async ({
          page,
          player,
          fakeCodex,
        }) => {
          const session = await continuedAfterTheMark(page, player, fakeCodex, {
            variant,
            scenario: 'tools',
            firstToolAfterTheMark: 'apply_patch',
          })

          await expectReplacedStage(page)
          await expectNewResult(page, session, 'result.json', 'apply_patch')
          await expectCountedChanges(page)
        })
      })
    }

    for (const variant of playing('codex', 'question')) {
      test.describe(() => {
        checkedOnThisOs(variant)

        test(`Codex ${surfaceNames[variant.surface]}: a question asked after the mark shows the replaced stage, the solver and observer questions and the final text cards to the original (E2E 4)`, async ({
          page,
          player,
          fakeCodex,
        }) => {
          await continuedAfterTheMark(page, player, fakeCodex, {
            variant,
            scenario: 'question',
            firstToolAfterTheMark: 'request_user_input_async',
          })

          await expectReplacedStage(page)
          const asked = change(page, 'Questions and requests', codexQuestionText)
          await expect(asked).toContainText('opened', observed)
          await expect(asked).toContainText('Question')
          await expect(asked).toContainText('by aang rule')
          await expectObserverQuestion(page)
          await expectCardsToOriginal(page, codexQuestionMessage)
          const finalAnswers = finalAnswerMessagesAfterTheQuestion[variant.surface] ?? []
          const shown = await expectCardsToOriginal(page, codexFinalAnswer, finalAnswers.length)
          expect(shown.toSorted()).toEqual(finalAnswers)
          await expectCountedChanges(page)
        })
      })
    }
  })
})
