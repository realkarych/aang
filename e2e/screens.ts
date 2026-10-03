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

export const zoneItem = (page: Page, kind: string): Locator =>
  zone(page).getByRole('listitem').filter({ hasText: kind })

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
