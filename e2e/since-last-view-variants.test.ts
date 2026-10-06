import { endpoints, type RunId, type RunSnapshot, type Runtime } from '@aang/contract'
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
import { type AangFixtures, expect, type PlayerSettings, test } from './fixtures.js'
import { recording } from './recordings.js'
import { change, mark, markButton, since, sinceTab } from './screens.js'

interface Surface {
  readonly name: string
  readonly surface: string
  readonly version: string
  readonly checkedOnWindows: boolean
}

interface CodexSurface extends Surface {
  readonly finalAnswersAfterTheQuestion: number
}

interface Continuation {
  readonly runtime: Runtime
  readonly surface: Surface
  readonly scenario: string
  readonly firstToolAfterTheMark: string
}

interface Observer {
  readonly setScenario: (scenario: ObserverScenarioPhase) => void
}

const claudeSurfaces: readonly Surface[] = [
  { name: 'SDK', surface: 'claude_sdk', version: '2.1.289', checkedOnWindows: true },
  { name: 'Desktop', surface: 'claude_desktop', version: '2.1.286', checkedOnWindows: false },
]

const codexSurfaces: readonly CodexSurface[] = [
  { name: 'CLI', surface: 'codex_exec', version: '0.160.0', checkedOnWindows: true, finalAnswersAfterTheQuestion: 0 },
  { name: 'SDK', surface: 'codex_sdk', version: '0.160.0', checkedOnWindows: true, finalAnswersAfterTheQuestion: 0 },
  {
    name: 'Desktop',
    surface: 'codex_desktop',
    version: '0.159.2',
    checkedOnWindows: false,
    finalAnswersAfterTheQuestion: 2,
  },
]

const viewMark = 'view-mark'

const nothingChanged = 'С отметки ничего не изменилось.'

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
  const response = await request.get(endpoints.run.path.replace(':run', run))
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
  { runtime, surface: { surface, version }, scenario, firstToolAfterTheMark }: Continuation,
): Promise<string> => {
  const manifest = markedBefore(
    await loadManifest(recording(runtime, version, surface, scenario)),
    firstToolAfterTheMark,
  )
  const session = sessionOf(manifest)
  const run = runId({ kind: 'session', runtime, session })
  const replay = await player(manifest, playback)
  await replay.play({ until: viewMark })

  await page.goto(`/?run=${run}&mode=changes`)
  await expect(since(page)).toContainText('Прогон ещё не отмечен просмотренным.')
  await expect.poll(() => mapped(page.request, run), observed).toBe(true)
  await markButton(page).click()
  await expect(mark(page)).toContainText('Просмотрен только что')
  await expect(since(page)).toContainText(nothingChanged)

  observer.setScenario(observerScenarios['since-last-view'].after)
  await replay.play()
  return session
}

const expectReplacedStage = async (page: Page): Promise<void> => {
  const replaced = change(page, 'Пересмотренные решения', `Этап «${mainStageTitle}»`)
  await expect(replaced).toContainText(`заменён этапом «${continuedStageTitle}»`, observed)
  await expect(replaced).toContainText('интерпретация aang')
  await replaced.getByRole('button', { name: /^Основания: / }).click()
  await expect(replaced).toContainText(/сырая запись № \d+/)
  await expect(change(page, 'Этапы', `«${continuedStageTitle}»`)).toContainText('новый')
}

const expectNewResult = async (page: Page, session: string, file: string, tool: string): Promise<void> => {
  const result = change(page, 'Результаты', file).filter({ hasText: `записал ${tool}` })
  await expect(result).toContainText('новая версия', observed)
  await expect(result).toContainText(`Сессия ${session.slice(0, 8)}, основной агент`)
  await result.getByRole('button', { name: /^Основания: / }).click()
  await expect(result).toContainText(/сырая запись № \d+/)
}

const expectObserverQuestion = async (page: Page): Promise<void> => {
  const question = change(page, 'Вопросы и запросы', continuationQuestionText)
  await expect(question).toContainText('открыт', observed)
  await expect(question).toContainText('от наблюдателя')
}

const expectCardsToOriginal = async (page: Page, text: string, count = 1): Promise<void> => {
  const cards = change(page, 'Итоги решателя', text)
  await expect(cards).toHaveCount(count, observed)
  for (const card of await cards.all()) {
    await expect(card).toContainText('новая')
    await expect(card).toContainText(`этап «${continuedStageTitle}»`)
    await card.getByRole('button', { name: 'Показать в оригинале' }).click()
    const original = card.getByRole('figure')
    await expect(original.locator('mark')).toHaveText(text)
    await expect(original).toContainText('сообщение')
    await expect(original).toContainText('решатель')
    await card.getByRole('button', { name: 'Скрыть оригинал' }).click()
    await expect(original).toHaveCount(0)
  }
}

const expectCountedChanges = async (page: Page): Promise<void> => {
  await expect(sinceTab(page)).toHaveAccessibleName(/^С последнего просмотра, \d+ изменени/)
}

const checkedOnThisOs = ({ checkedOnWindows }: Surface): void => {
  test.skip(
    process.platform === 'win32' && !checkedOnWindows,
    'Desktop on Windows is not checked in the MVP (ADR-0013, decision 3)',
  )
}

test.use({ config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } } })

test.describe('with the observer', () => {
  test.describe.configure({ timeout: 120_000 })

  test.describe('of Claude', () => {
    test.use({ claudeScenario: observerScenarios['since-last-view'].before })

    for (const surface of claudeSurfaces) {
      test.describe(() => {
        checkedOnThisOs(surface)

        test(`Claude ${surface.name}: a turn continued after the mark shows the replaced stage, the new result, the closed approvals, the observer question and the card to the original (E2E 4)`, async ({
          page,
          player,
          fakeClaude,
        }) => {
          const session = await continuedAfterTheMark(page, player, fakeClaude, {
            runtime: 'claude',
            surface,
            scenario: 'tools',
            firstToolAfterTheMark: 'Write',
          })

          await expectReplacedStage(page)
          await expectNewResult(page, session, 'result.txt', 'Write')
          await expectNewResult(page, session, 'result.txt', 'Edit')
          for (const tool of ['Write', 'Edit']) {
            const approval = change(page, 'Вопросы и запросы', `${tool}: `)
            await expect(approval).toContainText('Запрос одобрения')
            await expect(approval).toContainText('по правилу aang')
            await expect(approval).toContainText('закрыт')
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

    for (const surface of codexSurfaces) {
      test.describe(() => {
        checkedOnThisOs(surface)

        test(`Codex ${surface.name}: a turn continued after the mark shows the replaced stage and the new result (E2E 4)`, async ({
          page,
          player,
          fakeCodex,
        }) => {
          const session = await continuedAfterTheMark(page, player, fakeCodex, {
            runtime: 'codex',
            surface,
            scenario: 'tools',
            firstToolAfterTheMark: 'apply_patch',
          })

          await expectReplacedStage(page)
          await expectNewResult(page, session, 'result.json', 'apply_patch')
          await expectCountedChanges(page)
        })
      })
    }

    for (const surface of codexSurfaces) {
      test.describe(() => {
        checkedOnThisOs(surface)

        test(`Codex ${surface.name}: a question asked after the mark shows the replaced stage, the solver and observer questions and the final text cards to the original (E2E 4)`, async ({
          page,
          player,
          fakeCodex,
        }) => {
          await continuedAfterTheMark(page, player, fakeCodex, {
            runtime: 'codex',
            surface,
            scenario: 'question',
            firstToolAfterTheMark: 'request_user_input_async',
          })

          await expectReplacedStage(page)
          const asked = change(page, 'Вопросы и запросы', codexQuestionText)
          await expect(asked).toContainText('открыт', observed)
          await expect(asked).toContainText('Вопрос')
          await expect(asked).toContainText('по правилу aang')
          await expectObserverQuestion(page)
          await expectCardsToOriginal(page, codexQuestionMessage)
          await expectCardsToOriginal(page, codexFinalAnswer, surface.finalAnswersAfterTheQuestion)
          await expectCountedChanges(page)
        })
      })
    }
  })
})
