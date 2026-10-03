import { writeSync } from 'node:fs'
import { openStore } from '@aang/store'
import { startEngine } from './harness.ts'

const [, , home] = process.argv

if (home === undefined) {
  throw new Error('usage: reparse-process <home>')
}

const engine = startEngine(openStore({ home }), { all: true })
writeSync(1, 'ready\n')
await engine.reparse()
