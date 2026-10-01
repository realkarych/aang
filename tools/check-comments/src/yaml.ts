import { Composer, Parser, type CST } from 'yaml'
import { comments, failure, type ScanResult } from './scan.js'

const itemTokens = (item: CST.CollectionItem): CST.SourceToken[] => [
  ...item.start,
  ...sourceTokens(item.key),
  ...(item.sep ?? []),
  ...sourceTokens(item.value),
]

const sourceTokens = (token: CST.Token | null | undefined): CST.SourceToken[] => {
  if (!token) {
    return []
  }
  switch (token.type) {
    case 'document':
      return [...token.start, ...sourceTokens(token.value), ...(token.end ?? [])]
    case 'doc-end':
    case 'alias':
    case 'scalar':
    case 'single-quoted-scalar':
    case 'double-quoted-scalar':
      return token.end ?? []
    case 'block-scalar':
      return token.props.flatMap(sourceTokens)
    case 'block-map':
    case 'block-seq':
      return token.items.flatMap(itemTokens)
    case 'flow-collection':
      return [token.start, ...token.items.flatMap(itemTokens), ...token.end]
    case 'directive':
    case 'error':
      return []
    default:
      return [token]
  }
}

export const scanYaml = (text: string): ScanResult => {
  const tokens = [...new Parser().parse(text)]
  const [error] = [...new Composer().compose(tokens, true, text.length)].flatMap((document) => document.errors)
  if (error) {
    return failure(error.pos[0], error.message)
  }
  return comments(
    tokens
      .flatMap(sourceTokens)
      .filter((token) => token.type === 'comment')
      .map((token) => token.offset),
  )
}
