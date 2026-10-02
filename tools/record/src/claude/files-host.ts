import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const [operation, source, destination] = process.argv.slice(2)
if (operation === 'remove' && source !== undefined) {
  await rm(source)
} else if (operation === 'move' && source !== undefined && destination !== undefined) {
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
} else {
  throw new Error('Usage: files-host remove <file> | move <file> <destination>')
}
