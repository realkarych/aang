import { endpoints, type RunsResponse } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { sampleScenarioManifest } from '@aang/testkit'
import { expect, getWithoutKeepAlive, test } from './fixtures.js'

const session = { kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' } as const

test.use({ config: { watch: { all: true } } })

test('a sample played into the profile becomes a run listed by /api/runs for the signed-in user only', async ({
  player,
  page,
  request,
}) => {
  const listRuns = async (): Promise<RunsResponse> => {
    const response = await getWithoutKeepAlive(page.request, endpoints.runs.path)
    expect(response.status()).toBe(200)
    return endpoints.runs.response.parse(await response.json())
  }
  expect((await listRuns()).runs).toEqual([])

  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()

  await expect
    .poll(async () => (await listRuns()).runs.map(({ id, agents }) => ({ id, agents })), { timeout: 30_000 })
    .toEqual([{ id: runId(session), agents: 2 }])
  expect((await listRuns()).runs).toMatchObject([
    { runtime: 'claude', root_session: objectId(session), sessions: 1, support_modes: ['files_only'] },
  ])
  expect((await getWithoutKeepAlive(request, endpoints.runs.path)).status()).toBe(401)
})
