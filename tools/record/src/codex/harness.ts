import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Surface } from '@aang/contract'
import type { RunOutput } from '../record.js'
import type { Scenario, ScenarioSession } from '../scenario.js'
import { writeCodexHome } from './home.js'
import { check } from './rollout.js'
import { type ResponsesStub, type StubScript, startResponsesStub } from './stub.js'
import { startTelemetryTap, type TelemetryTap } from './telemetry.js'

export interface StubContext {
  readonly session: ScenarioSession
  readonly stub: ResponsesStub
  readonly telemetry: TelemetryTap
}

export interface StubScenario {
  readonly name: string
  readonly surface: Surface
  readonly expectedFacts: readonly string[]
  readonly script: StubScript | ((session: ScenarioSession) => StubScript)
  readonly trust?: boolean
  readonly run: (context: StubContext) => Promise<void>
}

export const hostScript = (name: string): string => fileURLToPath(new URL(`./${name}.js`, import.meta.url))

const trustHooks = async (session: ScenarioSession): Promise<void> => {
  await session.run(process.execPath, [hostScript('trust-host'), session.engine.executable, join(session.codex, 'config.toml')])
}

export const stubScenario = (definition: StubScenario): Scenario => ({
  name: definition.name,
  surface: definition.surface,
  models: ['stub'],
  expectedFacts: definition.expectedFacts,
  run: async (session) => {
    const script = typeof definition.script === 'function' ? definition.script(session) : definition.script
    const stub = await startResponsesStub(script, join(session.work, 'responses.jsonl'))
    const telemetry = await startTelemetryTap(session.otlp)
    try {
      await writeCodexHome(session.codex, { provider: stub.url, otlp: telemetry.endpoint, hook: session.hook, spool: session.spool })
      if (definition.trust === true) await trustHooks(session)
      await definition.run({ session, stub, telemetry })
      check(stub.failures.length === 0, `the model stub answered every request (${stub.failures.join('; ')})`)
    } finally {
      await telemetry.close()
      await stub.close()
    }
  },
})

const execFlags: readonly string[] = ['--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust']

export const codexExec = (session: ScenarioSession, args: readonly string[]): Promise<RunOutput> =>
  session.run(session.engine.executable, ['exec', ...execFlags, ...args], { env: { OTEL_BLRP_SCHEDULE_DELAY: '200' } })

export const codexCommand = (session: ScenarioSession, args: readonly string[]): Promise<RunOutput> =>
  session.run(session.engine.executable, args)
