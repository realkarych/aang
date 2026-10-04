import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { endpoints, type RunId, type RunSnapshot, type Stage } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import {
  branchStageTitles,
  mainStageTitle,
  observerScenarios,
  preparationStageTitle,
  reportStageTitle,
  sampleScenarioManifest,
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
