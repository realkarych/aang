import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const licenseFile = /^licen[cs]e(?:\.(?:md|txt))?$/i
const separator = `\n${'-'.repeat(72)}\n\n`

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly license?: unknown
}

const notice = async (directory: string): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as PackageManifest
  const file = (await readdir(directory)).find((name) => licenseFile.test(name))
  if (file === undefined) {
    throw new Error(`the bundled package in ${directory} has no license file`)
  }
  const text = (await readFile(join(directory, file), 'utf8')).trim()
  return `${String(manifest.name)} ${String(manifest.version)}\nLicense: ${String(manifest.license)}\n\n${text}\n`
}

export const thirdPartyLicensesFile = 'THIRD_PARTY_LICENSES'

export const writeThirdPartyLicenses = async (packageDirectory: string, bundled: readonly string[]): Promise<void> => {
  const notices = await Promise.all(bundled.map(notice))
  await writeFile(join(packageDirectory, thirdPartyLicensesFile), notices.join(separator))
}
