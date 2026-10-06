import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

export const repository = {
  root,
  aang: join(root, 'packages', 'aang'),
  hook: join(root, 'packages', 'hook'),
  storeSchema: join(root, 'packages', 'store', 'schema'),
  supportMatrix: join(root, 'support', 'matrix.json'),
}

export const aangVersion = async (): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(repository.aang, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') {
    throw new Error(`${join(repository.aang, 'package.json')} has no version`)
  }
  return manifest.version
}
