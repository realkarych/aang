import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const workspaceMarker = 'pnpm-workspace.yaml'

export const toPosix = (path: string): string => path.replaceAll('\\', '/')

export const workspaceRoot = (filename: string): string | undefined => {
  let directory = dirname(filename)
  while (!existsSync(join(directory, workspaceMarker))) {
    const parent = dirname(directory)
    if (parent === directory) {
      return undefined
    }
    directory = parent
  }
  return directory
}
