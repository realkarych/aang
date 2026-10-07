import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'

const claudeProjectName = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const resolved = (path: string): readonly string[] => {
  try {
    return [path, realpathSync(path), realpathSync.native(path)]
  } catch {
    return [path]
  }
}

const formsOf = (path: string): readonly string[] =>
  resolved(path).flatMap((each) => [
    each,
    JSON.stringify(each).slice(1, -1),
    each.replaceAll('\\', '/'),
    claudeProjectName(each),
  ])

const roots: readonly (readonly [string, string])[] = [
  [tmpdir(), '<tmp>'],
  [homedir(), '~'],
]

const forms = roots.flatMap(([path, placeholder]) => formsOf(path).map((form) => [form, placeholder] as const))

const replacements: readonly (readonly [RegExp, string])[] = forms
  .filter(([form], index) => forms.findIndex(([other]) => other === form) === index)
  .sort(([left], [right]) => right.length - left.length)
  .map(([form, placeholder]) => [new RegExp(literal(form), process.platform === 'win32' ? 'gi' : 'g'), placeholder])

const userPaths: readonly (readonly [RegExp, string])[] = [
  [/\/(?:Users|home)\/[^/"\s<>]/, 'a home directory'],
  [/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/"\s<>]/i, 'a Windows home directory'],
  [/\/var\/folders\//, 'a macOS temporary directory'],
  [/(?:^|[\\/"])(?:-private)?-var-folders-/, 'the Claude project name of a macOS temporary directory'],
  [/(?:^|[\\/"])-(?:Users|home)-[A-Za-z0-9]/, 'the Claude project name of a home directory'],
  [/(?:^|[\\/"])[A-Za-z]--Users-[A-Za-z0-9]/i, 'the Claude project name of a Windows home directory'],
]

export const redact = (text: string): string =>
  replacements.reduce((current, [pattern, placeholder]) => current.replace(pattern, placeholder), text)

export const unredactedPaths = (text: string): readonly string[] =>
  userPaths.flatMap(([pattern, kind]) => (pattern.test(text) ? [kind] : []))
