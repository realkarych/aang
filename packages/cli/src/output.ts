export interface Output {
  readonly out: (line: string) => void
  readonly error: (line: string) => void
}

export const processOutput: Output = {
  out: (line) => {
    process.stdout.write(`${line}\n`)
  },
  error: (line) => {
    process.stderr.write(`${line}\n`)
  },
}

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))
