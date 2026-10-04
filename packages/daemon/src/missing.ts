const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export const ignoreMissing = <T>(error: unknown, fallback: T): T => {
  if (isMissing(error)) {
    return fallback
  }
  throw error
}
