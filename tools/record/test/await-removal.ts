import { stat, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const [started = '', ...paths] = process.argv.slice(2)
const listed = (path: string): Promise<boolean> =>
  stat(path).then(() => true, (error: unknown) => !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
await writeFile(started, '')
while ((await Promise.all(paths.map(listed))).some(Boolean)) await setTimeout(25)
