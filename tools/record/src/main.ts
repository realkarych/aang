import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { recordSession, type RecordContext } from './record.js'
import { RecordMetadata } from './schema.js'
import { verifyRecording } from './verify.js'

const Scenario = z.object({
  options: RecordMetadata.safeExtend({ fixturesRoot: z.string().min(1), hookBinary: z.string().min(1) }),
  run: z.custom<(context: RecordContext) => Promise<void>>((value) => typeof value === 'function'),
})

const main = async (): Promise<void> => {
  const [operation, path, ...extra] = process.argv.slice(2)
  if (!path || extra.length || (operation !== 'record' && operation !== 'verify')) {
    throw new Error('Usage: node tools/record/dist/main.js record <scenario.mjs> | verify <recording-directory>')
  }
  if (operation === 'verify') {
    await verifyRecording(resolve(path))
    return
  }
  const loaded: unknown = await import(pathToFileURL(resolve(path)).href)
  const scenario = Scenario.parse(loaded)
  process.stdout.write(`${await recordSession(scenario.options, scenario.run)}\n`)
}

try { await main() } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
