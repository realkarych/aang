type HookOs = 'darwin' | 'linux' | 'win32'
type HookCpu = 'x64' | 'arm64'

export interface HookPlatform {
  readonly os: HookOs
  readonly cpu: HookCpu
}

const goos: Readonly<Record<HookOs, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const goarch: Readonly<Record<HookCpu, string>> = { x64: 'amd64', arm64: 'arm64' }

export const hookPlatforms: readonly HookPlatform[] = (['darwin', 'linux', 'win32'] as const).flatMap((os) =>
  (['x64', 'arm64'] as const).map((cpu) => ({ os, cpu })),
)

export const hookPackageName = ({ os, cpu }: HookPlatform): string => `aang-hook-${os}-${cpu}`

export const hookBinaryName = ({ os }: HookPlatform): string => (os === 'win32' ? 'aang-hook.exe' : 'aang-hook')

export const goTarget = ({ os, cpu }: HookPlatform): { readonly GOOS: string; readonly GOARCH: string } => ({
  GOOS: goos[os],
  GOARCH: goarch[cpu],
})
