import { takeCoverage } from 'node:v8'
import { afterAll } from 'vitest'

afterAll(() => {
  takeCoverage()
})
