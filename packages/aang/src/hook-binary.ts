import { fileURLToPath } from 'node:url'

export const hookPlatform = `${process.platform}-${process.arch}`

export const missingHookBinary = `no aang-hook binary is installed for ${hookPlatform}; aang ships it as the optional dependency aang-hook-${hookPlatform} for darwin, linux and win32 on x64 and arm64, so reinstall aang without omitting optional dependencies`

const missingCodes: readonly unknown[] = ['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_IMPORT_NOT_DEFINED']

export const findHookBinary = (): string | undefined => {
  try {
    return fileURLToPath(import.meta.resolve(`#aang-hook-${hookPlatform}`))
  } catch (error) {
    if (error instanceof Error && 'code' in error && missingCodes.includes(error.code)) {
      return undefined
    }
    throw error
  }
}
