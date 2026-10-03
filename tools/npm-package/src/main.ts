import { parseArgs } from 'node:util'
import { buildNpmPackages } from './build.js'

const usage = 'usage: node tools/npm-package/dist/main.js --out <directory>\n'

const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true })

if (values.out === undefined) {
  process.stderr.write(usage)
  process.exitCode = 2
} else {
  for (const packed of await buildNpmPackages(values.out)) {
    process.stdout.write(`${packed.tarball}\n`)
  }
}
