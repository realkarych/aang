import type { ApiErrorCode } from '@catacomb/contract'

export class AdminError extends Error {
  override readonly name = 'AdminError'

  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message)
  }
}
