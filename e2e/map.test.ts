import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { endpoints, type RunId, type RunSnapshot, type Stage } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import {
  branchStageTitles,
  continuedStageTitle,
  mainStageTitle,
  mergedStageTitle,
  nestedStageTitles,
  observerScenarios,
  preparationStageTitle,
  reportStageTitle,
  sampleScenarioManifest,
  splitStageTitles,
} from '@aang/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

const claudeRun = runId({ kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' })

const observed = { timeout: 30_000 }

test.use({ config: { watch: { all: true } } })

const map = (page: Page): Locator => page.getByRole('region', { name: 'Карта этапов' })

const stage = (page: Page, title: string | RegExp): Locator =>
  map(page).getByRole('group', { name: typeof title === 'string' ? `Этап «${title}»` : title })

const pingerTitle = /^Этап «pinger \(.+\)»$/

const edge = (page: Page, name: RegExp): Locator => map(page).getByRole('img', { name })

const edges = (page: Page): Locator => edge(page, /использует результат|начат после завершения/)

const box = async (locator: Locator): Promise<{ x: number; y: number; right: number; bottom: number }> => {
  const found = await locator.boundingBox()
  if (found === null) {
    throw new Error('the element has no box')
  }
  return { x: found.x, y: found.y, right: found.x + found.width, bottom: found.y + found.height }
}

const pick = (locator: Locator, title: string | RegExp): Locator => locator.getByRole('button', { name: title, exact: true })

const drag = async (page: Page, from: { x: number; y: number }, by: { x: number; y: number }): Promise<void> => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 8 })
  await page.mouse.up()
}

const near = (actual: { x: number; y: number }, expected: { x: number; y: number }): void => {
  expect(Math.abs(actual.x - expected.x), `x ${String(actual.x)} near ${String(expected.x)}`).toBeLessThanOrEqual(1)
  expect(Math.abs(actual.y - expected.y), `y ${String(actual.y)} near ${String(expected.y)}`).toBeLessThanOrEqual(1)
}

const versionShown = async (page: Page): Promise<number> =>
  Number(
    await page
      .locator('.facts > div', { has: page.getByRole('term').filter({ hasText: 'Версия карты' }) })
      .getByRole('definition')
      .textContent(),
  )

const crossings = async (page: Page): Promise<string[]> =>
  map(page).evaluate((region) => {
    const cards = [...region.querySelectorAll('.stage-card')].map((card) => ({
      title: card.querySelector('.stage-title')?.textContent ?? '',
      box: card.getBoundingClientRect(),
    }))
    return [...region.querySelectorAll<SVGPathElement>('.react-flow__edge path.map-route')].flatMap((path) => {
      const screen = path.getScreenCTM()
      const points: DOMPoint[] = []
      for (let along = 0; screen !== null && along <= path.getTotalLength(); along += 2) {
        const { x, y } = path.getPointAtLength(along)
        points.push(new DOMPoint(x, y).matrixTransform(screen))
      }
      return cards
        .filter(({ box }) =>
          points.some(
            ({ x, y }) => x > box.left + 1 && x < box.right - 1 && y > box.top + 1 && y < box.bottom - 1,
          ),
        )
        .map(({ title }) => `${path.textContent} × ${title}`)
    })
  })

const bashCall = 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'

const stampOf = (line: string | undefined): string | undefined => /"timestamp": "([^"]+)"/.exec(line ?? '')?.[1]

const withInstantCall = async (directory: string, call: string): Promise<string> => {
  const original = sampleScenarioManifest('claude-subagent')
  const manifest = JSON.parse(await readFile(original, 'utf8')) as { steps: Array<{ source?: string }> }
  const sources = [...new Set(manifest.steps.flatMap(({ source }) => (source === undefined ? [] : [source])))]
  const local = new Map(sources.map((source, index) => [source, `${String(index)}-${basename(source)}`]))
  await mkdir(directory, { recursive: true })
  for (const [source, name] of local) {
    const lines = (await readFile(join(dirname(original), ...source.split('/')), 'utf8')).split('\n')
    const started = stampOf(lines.find((line) => line.includes(`"id": "${call}"`)))
    const instant = lines.map((line) =>
      started !== undefined && line.includes(`"tool_use_id": "${call}"`)
        ? line.replace(/"timestamp": "[^"]+"/, `"timestamp": "${started}"`)
        : line,
    )
    await writeFile(join(directory, name), instant.join('\n'))
  }
  const file = join(directory, 'manifest.json')
  const steps = manifest.steps.map((step) =>
    step.source === undefined ? step : { ...step, source: local.get(step.source) },
  )
  await writeFile(file, JSON.stringify({ ...manifest, steps }))
  return file
}

const snapshotOf = async (page: Page, run: RunId): Promise<RunSnapshot> => {
  const response = await page.request.get(endpoints.run.path.replace(':run', run))
  expect(response.status()).toBe(200)
  return endpoints.run.response.parse(await response.json())
}

const stageTitled = (snapshot: RunSnapshot, title: string): Stage => {
  const found = snapshot.model.stages.find((candidate) => candidate.title === title)
  if (found === undefined) {
    throw new Error(`the run has no stage ${title}`)
  }
  return found
}

test('a run without stages explains that the observer builds the map', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${claudeRun}`)

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Claude Code, начат/)
  await expect(map(page)).toContainText(
    'Этапы строит наблюдатель. Карта появится после его первого ответа по этому прогону.',
  )
  await expect(map(page).getByRole('group')).toHaveCount(0)
})

test.describe('with the observer building the map', () => {
  test.skip(
    process.platform === 'win32',
    'on Windows the fake claude needs node with a script and cannot be the configured observer CLI',
  )
  test.use({ claudeScenario: observerScenarios['map-layout'].live })

  test('the live map nests stages, tells result dependencies from time order and labels every axis (E2E 1, map)', async ({
    page,
    player,
  }) => {
    const played = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })
    await page.goto(`/?run=${claudeRun}`)
    await played.play({ until: 'subagent' })

    await expect(stage(page, preparationStageTitle)).toBeVisible(observed)
    const preparation = stage(page, preparationStageTitle)
    await expect(preparation).toContainText('Выполнение: завершён')
    await expect(preparation).toContainText('Основание: интерпретация aang')
    await expect(preparation).toContainText('Решение человека: решения нет')
    await expect(preparation.getByRole('listitem')).toHaveCount(3)
    for (const axis of await preparation.getByRole('listitem').all()) {
      await expect(axis.locator('svg')).toHaveCount(1)
    }

    await played.play()
    await expect(stage(page, reportStageTitle)).toBeVisible(observed)
    const report = stage(page, reportStageTitle)
    const pinger = stage(page, pingerTitle)
    const main = stage(page, mainStageTitle)
    await expect(pinger).toBeVisible()
    await expect(report).toContainText('Выполнение: завершён')
    await expect(report).toContainText('Основание: заявление решателя')
    await expect(report).toContainText('Решение человека: ждёт решения')
    await expect(pinger).toContainText('агент: pinger')
    await expect(main).toContainText('3 подэтапа')
    await expect(map(page).getByText('3 этапа', { exact: true })).toHaveCount(0)
    await expect(map(page).getByText('4 этапа', { exact: true })).toBeVisible()

    const outer = await box(main)
    for (const inner of [preparation, pinger, report]) {
      const nested = await box(inner)
      expect(nested.x).toBeGreaterThan(outer.x)
      expect(nested.y).toBeGreaterThanOrEqual(outer.y)
      expect(nested.right).toBeLessThan(outer.right)
      expect(nested.bottom).toBeLessThanOrEqual(outer.bottom)
    }
    expect((await box(preparation)).right).toBeLessThan((await box(pinger)).x)
    expect((await box(pinger)).right).toBeLessThan((await box(report)).x)

    const dependency = edge(page, /^«Report» использует результат «pinger \(.+\)», основание: /)
    const order = edge(page, /^«pinger \(.+\)» начат после завершения «Preparation»$/)
    await expect(dependency).toHaveCount(1)
    await expect(order).toHaveCount(1)
    await expect(edge(page, /«Report» начат после/)).toHaveCount(0)
    await expect(edges(page)).toHaveCount(2)
    const dashes = async (line: Locator): Promise<string> =>
      line.locator('path').evaluate((path) => getComputedStyle(path).strokeDasharray)
    expect(await dashes(dependency)).toBe('none')
    expect(await dashes(order)).not.toBe('none')
    await expect(map(page).getByRole('list', { name: 'Линии карты' })).toHaveText(
      /использует результат.*позже по времени, без связи/,
    )

    const snapshot = await snapshotOf(page, claudeRun)
    for (const title of [mainStageTitle, preparationStageTitle, reportStageTitle]) {
      await expect(map(page).locator(`[data-id="${stageTitled(snapshot, title).id}"]`)).toHaveAttribute(
        'aria-label',
        `Этап «${title}»`,
      )
    }

    const collapse = main.getByRole('button', { name: `Свернуть «${mainStageTitle}»` })
    await expect(collapse).toHaveAttribute('aria-expanded', 'true')
    await collapse.click()
    const expand = main.getByRole('button', { name: `Развернуть «${mainStageTitle}»` })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    for (const hidden of [preparation, pinger, report]) {
      await expect(hidden).toHaveCount(0)
    }
    await expect(edges(page)).toHaveCount(0)
    await expect(main).toContainText('3 подэтапа')

    await expand.click()
    await expect(report).toBeVisible()
    await expect(dependency).toHaveCount(1)
    await expect(order).toHaveCount(1)

    const canvas = map(page).getByRole('application')
    const fitted = async (): Promise<boolean> => {
      const [frame, whole] = [await box(canvas), await box(main)]
      return whole.x >= frame.x && whole.y >= frame.y && whole.right <= frame.right && whole.bottom <= frame.bottom
    }
    const width = async (locator: Locator): Promise<number> => {
      const { x, right } = await box(locator)
      return right - x
    }
    const fittedWidth = await width(report)
    await expect.poll(fitted).toBe(true)
    await map(page).getByRole('button', { name: 'Приблизить' }).click()
    await expect.poll(async () => width(report)).toBeGreaterThan(fittedWidth)
    await map(page).getByRole('button', { name: 'Показать всю карту' }).click()
    await expect.poll(fitted).toBe(true)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(async () => {
        const [first, second, third] = [await box(preparation), await box(pinger), await box(report)]
        return first.bottom < second.y && second.bottom < third.y
      })
      .toBe(true)
    await expect.poll(fitted).toBe(true)
  })

  test('a preparation whose action took no time still precedes the subagent stage by a time-order line (E2E 1, map)', async ({
    page,
    player,
    profile,
  }) => {
    const manifest = await withInstantCall(join(profile.root, 'instant-call'), bashCall)
    const played = await player(manifest, { timeScale: 0, recordTime: 'playback' })
    await page.goto(`/?run=${claudeRun}`)
    await played.play({ until: 'subagent' })
    await expect(stage(page, preparationStageTitle)).toBeVisible(observed)
    await played.play()
    await expect(stage(page, reportStageTitle)).toBeVisible(observed)

    const bash = (await snapshotOf(page, claudeRun)).objects.actions.find(({ key }) => key.call === bashCall)
    expect(bash?.started_at).not.toBeNull()
    expect(bash?.ended_at).toBe(bash?.started_at)
    await expect(edge(page, /^«pinger \(.+\)» начат после завершения «Preparation»$/)).toHaveCount(1)
    await expect(edge(page, /^«Report» использует результат «pinger \(.+\)», основание: /)).toHaveCount(1)
    await expect(edges(page)).toHaveCount(2)
  })
})

test.describe('with the observer building two branches', () => {
  test.skip(
    process.platform === 'win32',
    'on Windows the fake claude needs node with a script and cannot be the configured observer CLI',
  )
  test.use({ claudeScenario: observerScenarios['map-branches'].live })

  test('lines between open branches and from a substage to its own stage go around every card (E2E 1, map)', async ({
    page,
    player,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })).play()
    await page.goto(`/?run=${claudeRun}`)
    const { build, compile, verify, test: check } = branchStageTitles
    await expect(stage(page, check)).toBeVisible(observed)
    for (const title of [build, compile, verify]) {
      await expect(stage(page, title)).toBeVisible()
    }

    const across = edge(page, /^«Test» использует результат «Compile», основание: /)
    const upward = edge(page, /^«Verify» использует результат «Test», основание: /)
    await expect(across).toHaveCount(1)
    await expect(upward).toHaveCount(1)
    await expect(edges(page)).toHaveCount(2)
    expect((await box(stage(page, compile))).right).toBeLessThan((await box(stage(page, check))).x)
    await expect.poll(async () => crossings(page)).toEqual([])

    const ownCard = await box(stage(page, verify).locator('.stage-card'))
    const substage = await box(stage(page, check))
    expect(ownCard.right).toBeLessThan(substage.x)

    await stage(page, verify).getByRole('button', { name: `Свернуть «${verify}»` }).click()
    await expect(stage(page, check)).toHaveCount(0)
    await expect(upward).toHaveCount(0)
    await expect(across).toHaveCount(0)
    await expect(edge(page, /^«Verify» использует результат «Compile», основание: /)).toHaveCount(1)
    await expect(edges(page)).toHaveCount(1)
    await expect.poll(async () => crossings(page)).toEqual([])

    await stage(page, verify).getByRole('button', { name: `Развернуть «${verify}»` }).click()
    await expect(upward).toHaveCount(1)
    await expect(across).toHaveCount(1)
    await expect(edges(page)).toHaveCount(2)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(async () => (await box(stage(page, compile))).bottom < (await box(stage(page, check))).y)
      .toBe(true)
    await expect.poll(async () => crossings(page)).toEqual([])
    await expect(edges(page)).toHaveCount(2)
  })
})

test.describe('with the observer building three levels', () => {
  test.skip(
    process.platform === 'win32',
    'on Windows the fake claude needs node with a script and cannot be the configured observer CLI',
  )
  test.use({ claudeScenario: observerScenarios['map-nested'].live })

  test('a stage whose result a substage and its own substage use opens into a whole map with both lines (E2E 1, map)', async ({
    page,
    player,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })).play()
    await page.goto(`/?run=${claudeRun}`)
    const { release, bundle, sign } = nestedStageTitles
    await expect(stage(page, bundle)).toBeVisible(observed)
    await expect(stage(page, release)).toBeVisible()
    await expect(stage(page, sign)).toHaveCount(0)

    const toBundle = edge(page, /^«Bundle» использует результат «Release», основание: /)
    const toSign = edge(page, /^«Sign» использует результат «Release», основание: /)
    await expect(toBundle).toHaveCount(1)
    await expect(edges(page)).toHaveCount(1)

    await stage(page, bundle).getByRole('button', { name: `Развернуть «${bundle}»` }).click()
    await expect(stage(page, sign)).toBeVisible()
    await expect(map(page).getByText('Карту не удалось разложить', { exact: false })).toHaveCount(0)
    await expect(toBundle).toHaveCount(1)
    await expect(toSign).toHaveCount(1)
    await expect(edges(page)).toHaveCount(2)
    await expect.poll(async () => crossings(page)).toEqual([])
    const ownCard = async (title: string): Promise<{ x: number; y: number; right: number; bottom: number }> =>
      box(stage(page, title).locator('.stage-card'))
    expect((await ownCard(release)).right).toBeLessThan((await box(stage(page, bundle))).x)
    expect((await ownCard(bundle)).right).toBeLessThan((await box(stage(page, sign))).x)

    await stage(page, bundle).getByRole('button', { name: `Свернуть «${bundle}»` }).click()
    await expect(stage(page, sign)).toHaveCount(0)
    await expect(toSign).toHaveCount(0)
    await expect(toBundle).toHaveCount(1)
    await expect(edges(page)).toHaveCount(1)
    await expect.poll(async () => crossings(page)).toEqual([])

    await stage(page, bundle).getByRole('button', { name: `Развернуть «${bundle}»` }).click()
    await expect(toSign).toHaveCount(1)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(async () => (await ownCard(bundle)).bottom < (await box(stage(page, sign))).y)
      .toBe(true)
    expect((await ownCard(release)).bottom).toBeLessThan((await box(stage(page, bundle))).y)
    await expect(map(page).getByText('Карту не удалось разложить', { exact: false })).toHaveCount(0)
    await expect.poll(async () => crossings(page)).toEqual([])
    await expect(edges(page)).toHaveCount(2)
  })
})

test.describe('with the observer revising the map', () => {
  test.skip(
    process.platform === 'win32',
    'on Windows the fake claude needs node with a script and cannot be the configured observer CLI',
  )
  test.use({ claudeScenario: observerScenarios['stage-succession'].live })

  test('new model versions keep the selected stage and the reading place, a replaced, split or merged stage hands the selection to its successor (E2E 14)', async ({
    page,
    player,
    fakeClaude,
  }) => {
    test.slow()
    const played = await player(sampleScenarioManifest('claude-compaction'), { timeScale: 0, recordTime: 'playback' })
    await page.setViewportSize({ width: 1280, height: 640 })
    await page.goto(`/?run=${claudeRun}&stage=gone`)
    await played.play({ until: 'subagent' })

    const main = stage(page, mainStageTitle)
    await expect(main).toBeVisible(observed)
    await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'false')
    const stageInAddress = (): string | null => new URL(page.url()).searchParams.get('stage')
    await expect.poll(stageInAddress).toBeNull()

    const canvas = map(page).getByRole('application')
    const placeOf = async (locator: Locator): Promise<{ x: number; y: number }> => {
      const [frame, card] = [await box(canvas), await box(locator.getByRole('article'))]
      return { x: card.x - frame.x, y: card.y - frame.y }
    }
    const settled = async (locator: Locator): Promise<{ x: number; y: number }> => {
      let last = await placeOf(locator)
      await expect
        .poll(async () => {
          const next = await placeOf(locator)
          const still = next.x === last.x && next.y === last.y
          last = next
          return still
        })
        .toBe(true)
      return last
    }
    await map(page).getByRole('button', { name: 'Приблизить' }).click()
    const fitted = await settled(main)
    const frame = await box(canvas)
    await drag(page, { x: frame.right - 24, y: frame.y + 24 }, { x: -60 - fitted.x, y: 0 })
    const read = await settled(main)
    near(read, { x: -60, y: fitted.y })
    await page.evaluate(() => {
      window.scrollTo(0, 96)
    })
    const scrolled = await page.evaluate(() => window.scrollY)
    expect(scrolled).toBeGreaterThan(0)
    const notice = map(page).getByRole('status')

    await played.play({ until: 'subagent-result' })
    const pinger = stage(page, pingerTitle)
    await expect(pinger).toBeVisible(observed)
    near(await settled(main), read)
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled)
    await expect(notice).toBeEmpty()

    await pick(main, mainStageTitle).click()
    await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'true')
    await expect(pick(pinger, /^pinger/)).toHaveAttribute('aria-pressed', 'false')
    expect(stageInAddress()).toBe(stageTitled(await snapshotOf(page, claudeRun), mainStageTitle).id)

    const nested = await versionShown(page)
    await played.play({ until: 'resume' })
    await expect.poll(async () => versionShown(page), observed).toBeGreaterThan(nested)
    await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'true')
    near(await settled(main), read)
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled)

    fakeClaude.setScenario(observerScenarios['stage-succession'].revised)
    await played.play({ until: 'continue' })
    const continued = stage(page, continuedStageTitle)
    await expect(continued).toBeVisible(observed)
    await expect(main).toHaveCount(0)
    await expect(pick(continued, continuedStageTitle)).toHaveAttribute('aria-pressed', 'true')
    await expect(notice).toHaveText(
      `Этап «${mainStageTitle}» заменён. Выбор перешёл к преемнику «${continuedStageTitle}».`,
    )
    const revised = await snapshotOf(page, claudeRun)
    expect(stageTitled(revised, mainStageTitle).lifecycle).toEqual({
      state: 'replaced',
      by: [stageTitled(revised, continuedStageTitle).id],
    })
    expect(stageInAddress()).toBe(stageTitled(revised, continuedStageTitle).id)
    const handed = await settled(continued)
    near(handed, read)

    fakeClaude.setScenario(observerScenarios['stage-succession'].split)
    await played.play({ until: 'compaction' })
    const [changesTitle, checksTitle] = splitStageTitles
    const changes = stage(page, changesTitle)
    const checks = stage(page, checksTitle)
    await expect(changes).toBeVisible(observed)
    await expect(checks).toBeVisible()
    await expect(continued).toHaveCount(0)
    await expect(pick(changes, changesTitle)).toHaveAttribute('aria-pressed', 'true')
    await expect(pick(checks, checksTitle)).toHaveAttribute('aria-pressed', 'false')
    await expect(notice).toHaveText(
      `Этап «${mainStageTitle}» заменён, затем разделён. Выбор перешёл к преемнику «${changesTitle}», другие преемники: «${checksTitle}».`,
    )
    expect(stageInAddress()).toBe(stageTitled(await snapshotOf(page, claudeRun), changesTitle).id)
    near(await settled(changes), handed)

    await map(page).getByRole('button', { name: 'Скрыть' }).click()
    await expect(notice).toBeEmpty()
    await expect(pick(changes, changesTitle)).toHaveAttribute('aria-pressed', 'true')

    const reopened = await page.context().newPage()
    await reopened.goto(page.url())
    await expect(pick(stage(reopened, changesTitle), changesTitle)).toHaveAttribute('aria-pressed', 'true', observed)
    await expect(map(reopened).getByRole('status')).toBeEmpty()
    await reopened.close()

    await pick(changes, changesTitle).press('Enter')
    await expect(pick(changes, changesTitle)).toHaveAttribute('aria-pressed', 'false')
    expect(stageInAddress()).toBeNull()
    await pinger.getByRole('list').click()
    await expect(pick(pinger, /^pinger/)).toHaveAttribute('aria-pressed', 'true')

    const checksAbove = await settled(checks)
    const splitFrame = await box(canvas)
    await drag(page, { x: splitFrame.right - 24, y: Math.max(splitFrame.y, 0) + 200 }, { x: 0, y: 120 - checksAbove.y })
    await pick(checks, checksTitle).click()
    await expect(pick(checks, checksTitle)).toHaveAttribute('aria-pressed', 'true')
    const changesPlace = await settled(changes)
    const checksPlace = await settled(checks)
    expect(Math.hypot(changesPlace.x - checksPlace.x, changesPlace.y - checksPlace.y)).toBeGreaterThan(100)

    fakeClaude.setScenario(observerScenarios['stage-succession'].merged)
    await played.play({ until: 'compact-boundary' })
    const merged = stage(page, mergedStageTitle)
    await expect(merged).toBeVisible(observed)
    await expect(changes).toHaveCount(0)
    await expect(checks).toHaveCount(0)
    await expect(pick(merged, mergedStageTitle)).toHaveAttribute('aria-pressed', 'true')
    await expect(notice).toHaveText(
      `Этап «${checksTitle}» объединён с другими. Выбор перешёл к преемнику «${mergedStageTitle}».`,
    )
    expect(stageInAddress()).toBe(stageTitled(await snapshotOf(page, claudeRun), mergedStageTitle).id)
    near(await settled(merged), checksPlace)

    const mergedFrame = await box(canvas)
    await drag(page, { x: mergedFrame.x + 300, y: Math.max(mergedFrame.y, 0) + 200 }, { x: 500, y: 0 })
    const aside = await settled(merged)
    near(aside, { x: checksPlace.x + 500, y: checksPlace.y })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(async () => {
        const [narrow, card] = [await box(canvas), await box(merged.getByRole('article'))]
        return Math.round(narrow.right - card.right)
      })
      .toBe(16)
    const revealed = await settled(merged)
    expect(Math.abs(revealed.y - aside.y)).toBeLessThanOrEqual(1)
  })
})
