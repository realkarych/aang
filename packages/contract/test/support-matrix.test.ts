import { readFile } from 'node:fs/promises'
import { SupportMatrix, supportMatrixFormat, type SupportRow } from '@aang/contract'
import { describe, test } from 'vitest'
import { z } from 'zod'

const ClaudeInit = z.object({
  claude_code_version: z.string(),
  mcp_servers: z.array(z.object({ name: z.string(), source: z.string() })),
  plugins: z.array(z.object({ name: z.string(), source: z.string(), path: z.string() })),
  skills: z.array(z.string()),
})

const observerProfileInit = new URL(
  '../../../docs/research/samples/observer/claude-init-b-full-isolation.json',
  import.meta.url,
)

describe.concurrent('support matrix', () => {
  test('a row keeps the builtins the observer profile reports in system/init', async ({ expect }) => {
    const init = ClaudeInit.parse(JSON.parse(await readFile(observerProfileInit, 'utf8')))
    const row: SupportRow = {
      runtime: 'claude',
      surface: 'claude_cli',
      os: 'macos',
      placement: 'local',
      engine_version: init.claude_code_version,
      app_version: null,
      status: 'unverified',
      gaps: [],
      scenarios: {
        during_work: 'not_run',
        after_iteration: 'not_run',
        resume: 'not_run',
        compaction: 'not_run',
        child_sessions: 'not_run',
        reconnect: 'not_run',
      },
      observer: {
        admission: 'passed',
        cross_session_inbound: 'passed',
        builtins: {
          mcp_servers: init.mcp_servers,
          plugins: init.plugins.filter((plugin) => plugin.path === 'builtin'),
          skills: init.skills,
        },
      },
      verified_on: '2026-10-01',
    }
    const matrix = { format: supportMatrixFormat, rows: [row] }

    const restored = SupportMatrix.parse(JSON.parse(JSON.stringify(matrix)))

    expect(restored).toEqual(matrix)
    expect(restored.rows[0]?.observer.builtins.plugins.map((plugin) => plugin.source)).toEqual([
      'cc-plugin-agents-md@builtin',
      'cc-plugin-plugin-authoring@builtin',
    ])
  })
})
