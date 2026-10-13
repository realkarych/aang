import { endpoints, type RunId } from '@aang/contract'
import type { RunningDaemon } from '@aang/testkit'
import { expect, type Locator, type Page } from '@playwright/test'

export const healthDot = (page: Page): Locator =>
  page.getByRole('banner').getByRole('button', { name: /^Observation problems: / })

export const healthProblems = async (page: Page): Promise<Locator> => {
  if ((await healthDot(page).getAttribute('aria-expanded')) !== 'true') {
    await healthDot(page).click()
  }
  return page.getByRole('region', { name: 'Observation problems', exact: true })
}

export const healthLacks = async (page: Page, text: string, options: { timeout?: number } = {}): Promise<void> => {
  const region = page.getByRole('region', { name: 'Observation problems', exact: true })
  await expect
    .poll(async () => {
      if ((await healthDot(page).count()) === 0) {
        return 'no health dot'
      }
      if ((await region.count()) === 0) {
        await healthDot(page)
          .click({ timeout: 1_000 })
          .catch(() => undefined)
        return 'health dot closed'
      }
      const shown = (await region.textContent({ timeout: 1_000 }).catch(() => null)) ?? text
      return shown.includes(text) ? shown : 'without the text'
    }, options)
    .toMatch(/^(no health dot|without the text)$/)
}

export const runRowOf = (page: Page, run: RunId): Locator =>
  page.getByRole('row').filter({ has: page.locator(`a[href="?run=${run}"]`) })

export const waitingChip = (page: Page): Locator =>
  page.getByRole('banner').getByRole('button', { name: /^Waiting for you: \d+$/ })

export const waitingFor = (page: Page): Locator => page.getByRole('banner').getByRole('tooltip', { includeHidden: true })

export const chips = (page: Page): Locator =>
  page
    .getByRole('region', { name: 'Stage map' })
    .getByRole('list', { name: 'Active filters', exact: true })
    .getByRole('listitem')

export const textShown = async (scope: Locator, text: string): Promise<boolean> => {
  await scope.scrollIntoViewIfNeeded()
  return scope.evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(wanted) ?? -1
      if (start < 0) {
        continue
      }
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + wanted.length)
      const shown = range.getBoundingClientRect()
      if (shown.height === 0) {
        return false
      }
      for (let box = node.parentElement; box !== null; box = box.parentElement) {
        const style = getComputedStyle(box)
        if (style.overflowX === 'visible' && style.overflowY === 'visible') {
          continue
        }
        const frame = box.getBoundingClientRect()
        if (
          shown.top < frame.top - 0.5 ||
          shown.bottom > frame.bottom + 0.5 ||
          shown.left < frame.left - 0.5 ||
          shown.right > frame.right + 0.5
        ) {
          return false
        }
      }
      return true
    }
    return false
  }, text)
}

export const dock = (page: Page): Locator => page.getByRole('complementary', { name: 'Chat panel' })

export const versionOf = async (daemon: RunningDaemon, run: RunId): Promise<number> =>
  endpoints.run.response.parse(await (await daemon.request(endpoints.run.path.replace(':run', run))).json()).summary
    .version
