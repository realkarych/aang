export interface ExecutableTarget {
  readonly os: string
  readonly cpu: string
}

const elfMachines: Readonly<Record<number, string>> = { 0x3e: 'x64', 0xb7: 'arm64' }
const machOCpuTypes: Readonly<Record<number, string>> = { 0x01000007: 'x64', 0x0100000c: 'arm64' }
const peMachines: Readonly<Record<number, string>> = { 0x8664: 'x64', 0xaa64: 'arm64' }

const portableExecutableHeader = (bytes: Buffer): number | undefined => {
  if (bytes.toString('latin1', 0, 2) !== 'MZ') {
    return undefined
  }
  const header = bytes.readUInt32LE(0x3c)
  return bytes.toString('latin1', header, header + 4) === 'PE\0\0' ? header : undefined
}

export const executableTarget = (bytes: Buffer): ExecutableTarget | undefined => {
  if (bytes.toString('latin1', 0, 4) === '\x7fELF') {
    return { os: 'linux', cpu: elfMachines[bytes.readUInt16LE(18)] ?? 'unknown' }
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    return { os: 'darwin', cpu: machOCpuTypes[bytes.readUInt32LE(4)] ?? 'unknown' }
  }
  const header = portableExecutableHeader(bytes)
  return header === undefined ? undefined : { os: 'win32', cpu: peMachines[bytes.readUInt16LE(header + 4)] ?? 'unknown' }
}
