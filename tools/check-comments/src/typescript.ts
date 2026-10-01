import { basename } from 'node:path'
import ts from 'typescript'
import { comments, failure, type ScanResult } from './scan.js'

interface CommentToken {
  readonly start: number
  readonly text: string
}

const referenceDirective = /^\/\/\/\s*<reference\s.*\/>\s*$/

const commentKinds: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
])

const scannedComments = (scanner: ts.Scanner): CommentToken[] => {
  const found: CommentToken[] = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (commentKinds.has(kind)) {
      found.push({ start: scanner.getTokenStart(), text: scanner.getTokenText() })
    }
  }
  return found
}

const leaves = (node: ts.Node, sourceFile: ts.SourceFile): ts.Node[] => {
  const children = node.getChildren(sourceFile)
  return children.length === 0 ? [node] : children.flatMap((child) => leaves(child, sourceFile))
}

const triviaComments = (sourceFile: ts.SourceFile): CommentToken[] => {
  const byStart = new Map<number, CommentToken>()
  for (const leaf of leaves(sourceFile, sourceFile)) {
    const start = leaf.getStart(sourceFile)
    if (start > leaf.pos) {
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        false,
        ts.LanguageVariant.Standard,
        sourceFile.text,
        undefined,
        leaf.pos,
        start - leaf.pos,
      )
      for (const comment of scannedComments(scanner)) {
        byStart.set(comment.start, comment)
      }
    }
  }
  return [...byStart.values()].sort((left, right) => left.start - right.start)
}

const syntaxErrors = (sourceFile: ts.SourceFile): readonly ts.DiagnosticWithLocation[] => {
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, types: [] }
  const host: ts.CompilerHost = { ...ts.createCompilerHost(options), getSourceFile: () => sourceFile }
  return ts.createProgram({ rootNames: [sourceFile.fileName], options, host }).getSyntacticDiagnostics(sourceFile)
}

export const scanTypeScript =
  (scriptKind: ts.ScriptKind) =>
  (text: string, path: string): ScanResult => {
    const sourceFile = ts.createSourceFile(
      `/${basename(path)}`,
      text,
      { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
      false,
      scriptKind,
    )
    const [error] = syntaxErrors(sourceFile)
    if (error) {
      return failure(error.start, ts.flattenDiagnosticMessageText(error.messageText, ' '))
    }
    const firstTokenStart = sourceFile.getStart(sourceFile)
    return comments(
      triviaComments(sourceFile)
        .filter((comment) => !(comment.start < firstTokenStart && referenceDirective.test(comment.text)))
        .map((comment) => comment.start),
    )
  }

export const scanJson = (text: string): ScanResult => {
  let error: ScanResult | undefined
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
    (message, _length, argument: unknown) => {
      error ??= failure(scanner.getTokenEnd(), message.message.replace('{0}', String(argument)))
    },
  )
  const found = scannedComments(scanner)
  return error ?? comments(found.map((comment) => comment.start))
}
