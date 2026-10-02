export const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined

export const isMissing = (error: unknown): boolean => errorCode(error) === 'ENOENT'

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const absent = (): null => null
