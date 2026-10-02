import { RegistrationTag, Runtime, SpoolEnvKey, spoolFormat, type SpoolEnv, type SpoolHeader } from '@aang/contract'

export type SpoolFile =
  | { readonly header: SpoolHeader; readonly payload: string }
  | { readonly header: null; readonly reason: string }

const malformed = (reason: string): SpoolFile => ({ header: null, reason })

export const parseSpoolFile = (bytes: Buffer): SpoolFile => {
  const lineEnd = bytes.indexOf(spoolFormat.headerLineTerminator)
  if (lineEnd < 0) {
    return malformed('no header line')
  }
  const [magic, runtime, registration, ...rest] = bytes
    .toString('utf8', 0, lineEnd)
    .split(spoolFormat.headerFieldSeparator)
  if (magic !== spoolFormat.magic || rest.length > 0) {
    return malformed('unknown header line')
  }
  const parsedRuntime = Runtime.safeParse(runtime)
  const parsedRegistration = RegistrationTag.safeParse(registration)
  if (!parsedRuntime.success || !parsedRegistration.success) {
    return malformed('unknown runtime or registration tag')
  }
  const env: SpoolEnv = {}
  let position = lineEnd + 1
  for (;;) {
    const entryEnd = bytes.indexOf(spoolFormat.envEntryTerminator, position)
    if (entryEnd < 0) {
      return malformed('unterminated header')
    }
    if (entryEnd === position) {
      return {
        header: { runtime: parsedRuntime.data, registration: parsedRegistration.data, env },
        payload: bytes.toString('utf8', entryEnd + 1),
      }
    }
    const entry = bytes.toString('utf8', position, entryEnd)
    const separator = entry.indexOf(spoolFormat.envAssignment)
    if (separator <= 0) {
      return malformed('invalid environment entry')
    }
    const key = SpoolEnvKey.safeParse(entry.slice(0, separator))
    if (key.success) {
      env[key.data] = entry.slice(separator + 1)
    }
    position = entryEnd + 1
  }
}
