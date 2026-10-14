import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

export const repository = {
  root,
  catacomb: join(root, 'packages', 'catacomb'),
  hook: join(root, 'packages', 'hook'),
  observer: join(root, 'packages', 'observer'),
  storeSchema: join(root, 'packages', 'store', 'schema'),
  supportMatrix: join(root, 'support', 'matrix.json'),
}

export const catacombVersion = async (): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(repository.catacomb, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') {
    throw new Error(`${join(repository.catacomb, 'package.json')} has no version`)
  }
  return manifest.version
}
