import { appendFile } from 'node:fs/promises'
import { z } from 'zod'
import { startAppServer } from './rpc.js'

const Listing = z.looseObject({
  data: z.array(z.looseObject({
    hooks: z.array(z.looseObject({ key: z.string(), eventName: z.string(), currentHash: z.string(), trustStatus: z.string() })),
  })).length(1),
})

const [codex, config, ...extra] = process.argv.slice(2)
if (codex === undefined || config === undefined || extra.length > 0) throw new Error('Usage: trust-host <codex> <config.toml>')

const listHooks = async (): Promise<z.infer<typeof Listing>['data'][number]['hooks']> => {
  const server = await startAppServer(codex, ['app-server'], { name: 'aang_record', title: 'aang record', version: '0.0.0' }, () => undefined)
  try {
    const listing = Listing.parse(await Promise.race([server.request('hooks/list', {}), server.failed]))
    return listing.data[0]?.hooks ?? []
  } finally {
    await server.close()
  }
}

const untrusted = (await listHooks()).filter((hook) => hook.trustStatus !== 'trusted')
await appendFile(config, untrusted.map((hook) => `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`).join(''))
const hooks = await listHooks()
const events = hooks.filter((hook) => hook.trustStatus === 'trusted').map((hook) => hook.eventName).sort()
process.stdout.write(`${JSON.stringify({ hooks: hooks.length, trusted: events })}\n`)
if (hooks.length === 0 || events.length !== hooks.length) process.exitCode = 1
