import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createProfile, leaseSpool, readSpool } from '@aang/testkit'
import { test } from 'vitest'

const hookCommand = fileURLToPath(new URL('../dist/hook.js', import.meta.url))

test('aang-hook hands its arguments and stdin to the aang-hook binary of this platform and keeps the hook contract', async ({
  expect,
  onTestFinished,
}) => {
  const profile = await createProfile()
  onTestFinished(() => profile.dispose())
  await leaseSpool(profile.spool)
  const payload = JSON.stringify({ hook_event_name: 'Notification', session_id: 'aang-hook-command' })
  const child = spawn(process.execPath, [hookCommand, 'claude', 'plugin', profile.spool], {
    env: profile.env,
    stdio: 'pipe',
    windowsHide: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stdin.end(payload)

  const [code] = (await once(child, 'close')) as [number | null]

  expect({ code, output }).toEqual({ code: 0, output: '' })
  expect(
    (await readSpool(profile.spool)).map(({ header, payload: body }) => [header.runtime, header.registration, body.toString()]),
  ).toEqual([['claude', 'plugin', payload]])
})
