interface JsonParseContext {
  readonly source?: string
}

const bigintExponent = 'E0'

const { rawJSON } = JSON as JSON & { readonly rawJSON: (text: string) => unknown }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

const replaceBigint = (_key: string, member: unknown): unknown =>
  typeof member === 'bigint' ? rawJSON(`${member.toString()}${bigintExponent}`) : member

const reviveBigint = (_key: string, member: unknown, context?: JsonParseContext): unknown => {
  const source = context?.source
  return typeof member === 'number' && source?.endsWith(bigintExponent) === true
    ? BigInt(source.slice(0, -bigintExponent.length))
    : member
}

export const encodeJson = (value: unknown): string => JSON.stringify(value, replaceBigint)

export const decodeJson = (text: string): unknown => JSON.parse(text, reviveBigint)

export const encodeText = (text: string): Uint8Array => textEncoder.encode(text)

export const decodeText = (bytes: Uint8Array): string => textDecoder.decode(bytes)

export const encodeFlag = (flag: boolean): number => (flag ? 1 : 0)
