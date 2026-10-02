import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import { FakeCall } from './scenario.js'

const scenarioFile = (state: string): string => join(state, 'scenario.json')
const callsDirectory = (state: string): string => join(state, 'calls')
const repliesDirectory = (state: string): string => join(state, 'replies')

const recordSuffix = '.json'
const claimSuffix = '.claim'

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const numbered = (sequence: number): string => String(sequence).padStart(6, '0')

const claim = (directory: string): number => {
  mkdirSync(directory, { recursive: true })
  const claimed = readdirSync(directory).filter((name) => name.endsWith(claimSuffix)).length
  for (let sequence = claimed + 1; ; sequence += 1) {
    try {
      closeSync(openSync(join(directory, `${numbered(sequence)}${claimSuffix}`), 'wx'))
      return sequence
    } catch (error) {
      if (!isCode(error, 'EEXIST')) {
        throw error
      }
    }
  }
}

const writeAtomically = (path: string, content: string): void => {
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, path)
}

export const writeScenario = (state: string, scenario: unknown): void => {
  mkdirSync(state, { recursive: true })
  writeAtomically(scenarioFile(state), JSON.stringify(scenario, null, 2))
}

export const readScenario = <S extends z.ZodType>(state: string, schema: S): z.output<S> => {
  try {
    return schema.parse(JSON.parse(readFileSync(scenarioFile(state), 'utf8')))
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return schema.parse({})
    }
    throw error
  }
}

export const claimCall = (state: string): number => claim(callsDirectory(state))

export const claimReply = (state: string): number => claim(repliesDirectory(state)) - 1

export const writeCall = (state: string, call: FakeCall): void => {
  writeAtomically(join(callsDirectory(state), `${numbered(call.sequence)}${recordSuffix}`), JSON.stringify(call))
}

export const readCalls = (state: string): FakeCall[] => {
  try {
    return readdirSync(callsDirectory(state))
      .filter((name) => name.endsWith(recordSuffix))
      .sort()
      .map((name) => FakeCall.parse(JSON.parse(readFileSync(join(callsDirectory(state), name), 'utf8'))))
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
}
