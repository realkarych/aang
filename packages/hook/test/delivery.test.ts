import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type RegistrationTag, type Runtime, SpoolFileName, spoolEnvKeys, spoolLayout } from '@aang/contract'
import { test } from 'vitest'
import { cleanExit, createSpool, nowSeconds, runHook, typicalEnv, typicalPayload, withoutNames } from './hook.js'

const registrations: readonly { readonly runtime: Runtime; readonly tag: RegistrationTag }[] = [
  { runtime: 'claude', tag: 'plugin' },
  { runtime: 'codex', tag: 'user' },
]

const forwardedEnv: Readonly<Record<string, string>> = Object.fromEntries(
  spoolEnvKeys.map((name, index) => [name, `${name.toLowerCase()} ${String(index)}`]),
)

test.for(registrations)(
  '$runtime event from the $tag registration lands in spool/new with its header, forwarded variables and stdin unchanged',
  async ({ runtime, tag }, { expect, onTestFinished }) => {
    const spool = await createSpool(onTestFinished)
    const payload = Buffer.concat([typicalPayload, Buffer.from('\r\n\u0000\u00ff', 'latin1')])
    const env = {
      ...forwardedEnv,
      CLAUDE_PROJECT_DIR: '/work/Имя Фамилия/a=b',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      AANG_HOME: '/home/user/.aang',
    }

    const result = await runHook(spool.args(runtime, tag), { env, stdin: payload })

    expect(result).toEqual(cleanExit)
    expect(withoutNames(await spool.events())).toEqual([
      {
        header: {
          runtime,
          registration: tag,
          env: { ...forwardedEnv, CLAUDE_PROJECT_DIR: '/work/Имя Фамилия/a=b' },
        },
        payload,
      },
    ])
    expect((await spool.entries()).pending).toEqual([])
  },
)

test('without forwarded variables the header is the registration line and an empty entry', async ({
  expect,
  onTestFinished,
}) => {
  const spool = await createSpool(onTestFinished)

  const result = await runHook(spool.args('codex', 'user'))

  expect(result).toEqual(cleanExit)
  const [name] = (await spool.entries()).ready
  expect(name).toBeDefined()
  const bytes = await readFile(join(spool.path, spoolLayout.readyDirectory, name ?? ''))
  expect(bytes).toEqual(Buffer.concat([Buffer.from('aang-spool/1 codex user\n\u0000'), typicalPayload]))
})

test('spool path with spaces and non-ASCII characters is used exactly as given', async ({
  expect,
  onTestFinished,
}) => {
  const spool = await createSpool(onTestFinished, { location: join('Имя Фамилия', 'aang home', 'spool') })

  const result = await runHook(spool.args(), { env: typicalEnv })

  expect(result).toEqual(cleanExit)
  expect(withoutNames(await spool.events())).toEqual([
    {
      header: { runtime: 'claude', registration: 'plugin', env: typicalEnv },
      payload: typicalPayload,
    },
  ])
})

test('identical events get separate files whose names are valid spool file names', async ({
  expect,
  onTestFinished,
}) => {
  const spool = await createSpool(onTestFinished)

  const first = await runHook(spool.args(), { env: typicalEnv })
  const second = await runHook(spool.args(), { env: typicalEnv })

  expect([first, second]).toEqual([cleanExit, cleanExit])
  const events = await spool.events()
  expect(events).toHaveLength(2)
  expect(new Set(events.map((event) => SpoolFileName.parse(event.name))).size).toBe(2)
  expect(events.map((event) => event.payload)).toEqual([typicalPayload, typicalPayload])
})

test('an active lease among expired ones is enough to write', async ({ expect, onTestFinished }) => {
  const now = nowSeconds()
  const spool = await createSpool(onTestFinished, { leases: [now - 7200, now - 60, now + 60] })

  const result = await runHook(spool.args())

  expect(result).toEqual(cleanExit)
  expect(await spool.events()).toHaveLength(1)
})

test('stdin of tens of megabytes is streamed into the event completely', async ({ expect, onTestFinished }) => {
  const spool = await createSpool(onTestFinished)
  const chunkSize = 1024 * 1024
  const chunkCount = 48
  const sent = createHash('sha256')
  const chunks = function* (): Generator<Buffer> {
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = randomBytes(chunkSize)
      sent.update(chunk)
      yield chunk
    }
  }

  const result = await runHook(spool.args(), { stdin: chunks() })

  expect(result).toEqual(cleanExit)
  const [event] = await spool.events()
  expect(event?.payload.length).toBe(chunkSize * chunkCount)
  expect(createHash('sha256').update(event?.payload ?? Buffer.alloc(0)).digest('hex')).toBe(sent.digest('hex'))
}, 120_000)
