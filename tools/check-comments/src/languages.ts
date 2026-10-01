import { extname } from 'node:path'
import ts from 'typescript'
import { scanCss } from './css.js'
import { scanGo } from './go.js'
import type { ScanResult } from './scan.js'
import { scanSql } from './sql.js'
import { scanJson, scanTypeScript } from './typescript.js'
import { scanYaml } from './yaml.js'

export interface Language {
  readonly name: string
  readonly scan: (text: string, path: string) => ScanResult
}

const typeScript = (scriptKind: ts.ScriptKind): Language => ({ name: 'TypeScript', scan: scanTypeScript(scriptKind) })
const javaScript = (scriptKind: ts.ScriptKind): Language => ({ name: 'JavaScript', scan: scanTypeScript(scriptKind) })
const yaml: Language = { name: 'YAML', scan: scanYaml }

const languages: ReadonlyMap<string, Language> = new Map([
  ['.ts', typeScript(ts.ScriptKind.TS)],
  ['.mts', typeScript(ts.ScriptKind.TS)],
  ['.cts', typeScript(ts.ScriptKind.TS)],
  ['.tsx', typeScript(ts.ScriptKind.TSX)],
  ['.js', javaScript(ts.ScriptKind.JS)],
  ['.mjs', javaScript(ts.ScriptKind.JS)],
  ['.cjs', javaScript(ts.ScriptKind.JS)],
  ['.jsx', javaScript(ts.ScriptKind.JSX)],
  ['.go', { name: 'Go', scan: scanGo }],
  ['.sql', { name: 'SQL', scan: scanSql }],
  ['.yml', yaml],
  ['.yaml', yaml],
  ['.css', { name: 'CSS', scan: scanCss }],
  ['.json', { name: 'JSON', scan: scanJson }],
])

export const languageOf = (path: string): Language | undefined => languages.get(extname(path).toLowerCase())
