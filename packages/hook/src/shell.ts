export const posixQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export const powerShellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

const unquote = (word: string): string =>
  word.replace(
    /'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|([^'"\\]+)/g,
    (_match, single?: string, double?: string, escaped?: string, plain?: string) =>
      single ?? double?.replace(/\\([\\"$`])/g, '$1') ?? escaped ?? plain ?? '',
  )

export const leadingWords = (command: string, count: number): string[] => {
  const word = /\s*((?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|[^\s'"\\])+)/y
  const words: string[] = []
  for (let match = word.exec(command); match?.[1] !== undefined && words.length < count; match = word.exec(command)) {
    words.push(unquote(match[1]))
  }
  return words
}
