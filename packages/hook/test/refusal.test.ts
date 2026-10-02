import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spoolLayout } from '@aang/contract'
import { test } from 'vitest'
import { cleanExit, createSpool, type HookStdin, nowSeconds, runHook, type Spool } from './hook.js'

interface RefusalCase {
  readonly name: string
  readonly leases?: readonly number[]
  readonly prepare?: (spool: Spool) => Promise<void>
  readonly args?: (spool: Spool) => readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: HookStdin
  readonly posixOnly?: boolean
}

const missingSpool = (spool: Spool): string => join(spool.root, 'missing')
const fileSpool = (spool: Spool): string => join(spool.root, 'file')

const oversizedPayload = Buffer.from(JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) }))

const cases: readonly RefusalCase[] = [
  { name: 'no arguments', args: () => [] },
  { name: 'runtime and tag without a spool path', args: (spool) => spool.args().slice(0, 2) },
  { name: 'an extra argument', args: (spool) => [...spool.args(), 'extra'] },
  { name: 'an unknown runtime', args: (spool) => ['gemini', 'plugin', spool.path] },
  { name: 'an unknown registration tag', args: (spool) => ['claude', 'project', spool.path] },
  { name: 'the AANG_OBSERVER marker', env: { AANG_OBSERVER: '1' } },
  { name: 'the aang-observer entrypoint', env: { CLAUDE_CODE_ENTRYPOINT: 'aang-observer' } },
  { name: 'the stop marker next to an active lease', prepare: (spool) => spool.add(spoolLayout.stoppedMarker) },
  { name: 'no lease', leases: [] },
  { name: 'only an expired lease', leases: [nowSeconds() - 60] },
  { name: 'a lease file without an expiry', leases: [], prepare: (spool) => spool.add(`${spoolLayout.leasePrefix}soon`) },
  { name: 'a spool that does not exist', args: (spool) => ['claude', 'plugin', missingSpool(spool)] },
  {
    name: 'a spool path that is a regular file',
    prepare: (spool) => writeFile(fileSpool(spool), ''),
    args: (spool) => ['claude', 'plugin', fileSpool(spool)],
  },
  { name: 'a spool that cannot be written', prepare: (spool) => spool.denyWrites() },
  { name: 'a spool without its temporary directory', prepare: (spool) => spool.remove(spoolLayout.temporaryDirectory) },
  { name: 'a spool without its ready directory', prepare: (spool) => spool.remove(spoolLayout.readyDirectory) },
  { name: 'empty stdin', stdin: Buffer.alloc(0) },
  { name: 'stdin attached to the null device', stdin: 'ignored' },
  { name: 'a closed stdin descriptor', stdin: 'closed', posixOnly: true },
]

test.for(cases)(
  'exits 0 silently without writing an event on $name',
  async (refusal, { expect, onTestFinished, skip }) => {
    skip(refusal.posixOnly === true && process.platform === 'win32', 'closing descriptor 0 is a POSIX shell feature')
    const spool = await createSpool(onTestFinished, refusal.leases === undefined ? {} : { leases: refusal.leases })
    await refusal.prepare?.(spool)

    const result = await runHook(refusal.args?.(spool) ?? spool.args(), {
      env: refusal.env ?? {},
      stdin: refusal.stdin ?? oversizedPayload,
    })

    expect(result).toEqual(cleanExit)
    expect(await spool.entries()).toEqual({ ready: [], pending: [] })
    expect(existsSync(missingSpool(spool))).toBe(false)
  },
)
