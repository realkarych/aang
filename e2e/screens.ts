import type { RunId } from '@aang/contract'
import type { Locator, Page } from '@playwright/test'

export const strip = (page: Page): Locator => page.getByRole('region', { name: 'Состояние наблюдения' })

export const lamp = (page: Page, label: string): Locator =>
  strip(page)
    .getByRole('listitem')
    .filter({ has: page.getByText(label, { exact: true }) })

export const fact = (page: Page, term: string): Locator =>
  page
    .getByRole('article')
    .locator('dl > div')
    .filter({ has: page.getByRole('term').getByText(term, { exact: true }) })
    .getByRole('definition')

export const runRowOf = (page: Page, run: RunId): Locator =>
  page.getByRole('row').filter({ has: page.locator(`a[href="?run=${run}"]`) })

export const zone = (page: Page): Locator => page.getByRole('region', { name: 'Внимание', exact: true })

export const openItems = (page: Page): Locator =>
  zone(page).getByRole('list', { name: 'Открытые пункты', exact: true }).getByRole('listitem')

export const zoneItem = (page: Page, kind: string): Locator => openItems(page).filter({ hasText: kind })

export const trace = (page: Page): Locator => page.getByRole('region', { name: 'Сессии и агенты', exact: true })

export const sessionOf = (page: Page, session: string): Locator =>
  trace(page).getByRole('listitem', { name: `Сессия ${session.slice(0, 8)}`, exact: true })

export const agentsOf = (page: Page, session: string): Locator =>
  trace(page).getByRole('list', { name: `Агенты: Сессия ${session.slice(0, 8)}`, exact: true })

export const stepsOf = (page: Page, agent: string): Locator =>
  trace(page).getByRole('list', { name: `Шаги: ${agent}`, exact: true })

export const step = (page: Page, agent: string, text: string): Locator =>
  stepsOf(page, agent).getByRole('listitem').filter({ hasText: text })

export const plan = (page: Page): Locator => page.getByRole('region', { name: 'План решателя', exact: true })

export const currentPlan = (page: Page): Locator =>
  plan(page).getByRole('list', { name: 'Текущий план', exact: true })

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

export const historyToggle = (page: Page): Locator => zone(page).getByRole('button', { name: /^История: / })

export const history = (page: Page): Locator =>
  zone(page).getByRole('list', { name: 'История зоны внимания', exact: true }).getByRole('listitem')

export const modes = (page: Page): Locator => page.getByRole('navigation', { name: 'Вид прогона' })

export const sinceTab = (page: Page): Locator => modes(page).getByRole('link', { name: /^С последнего просмотра/ })

export const traceTab = (page: Page): Locator => modes(page).getByRole('link', { name: 'Ход прогона', exact: true })

export const mark = (page: Page): Locator => page.getByRole('group', { name: 'Отметка просмотра', exact: true })

export const markButton = (page: Page): Locator => mark(page).getByRole('button', { name: 'Отметить просмотренным' })

export const since = (page: Page): Locator => page.getByRole('region', { name: 'С последнего просмотра', exact: true })

export const sinceSection = (page: Page, title: string): Locator =>
  since(page).getByRole('region', { name: title, exact: true })

export const change = (page: Page, section: string, text: string): Locator =>
  sinceSection(page, section)
    .locator(':scope > ol > li, :scope > ul > li')
    .filter({ hasText: text })

export const lampDetails = async (page: Page, label: string): Promise<Locator> => {
  const button = lamp(page, label).getByRole('button')
  if ((await button.getAttribute('aria-expanded')) !== 'true') {
    await button.click()
  }
  return page.getByRole('region', { name: `${label}: подробности`, exact: true })
}
