import { appendFile } from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import { setTimeout as delay } from 'node:timers/promises'
import { type EnvProbeRecord, probedEnvNames } from './probe-env.js'

const field = (payload: unknown, name: string): string | null => {
  if (typeof payload !== 'object' || payload === null || !(name in payload)) {
    return null
  }
  const value: unknown = (payload as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : null
}

const parsePayload = (input: string): unknown => {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

const recordEnvironment = async (input: string, logFile: string): Promise<void> => {
  const payload = parsePayload(input)
  const record: EnvProbeRecord = {
    received_at: new Date().toISOString(),
    session_id: field(payload, 'session_id'),
    hook_event_name: field(payload, 'hook_event_name'),
    source: field(payload, 'source'),
    env: Object.fromEntries(
      probedEnvNames.flatMap((name) => {
        const value = process.env[name]
        return value === undefined ? [] : [[name, value]]
      }),
    ),
  }
  await appendFile(logFile, `${JSON.stringify(record)}\n`)
}

const [mode = '', argument = ''] = process.argv.slice(2)
const input = await text(process.stdin).catch(() => '')

if (mode === 'env') {
  await recordEnvironment(input, argument).catch(() => undefined)
} else if (mode === 'fail') {
  process.stderr.write('aang D.7: deliberate hook failure, exit code 1\n')
  process.exitCode = 1
} else if (mode === 'hang') {
  await delay(Number(argument) * 1000)
}
