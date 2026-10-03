export const posixQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

const plainWord = /^[A-Za-z0-9_./:@%+,=-]+$/

export const consoleWord = (value: string): string =>
  plainWord.test(value) ? value : process.platform === 'win32' ? powershellQuote(value) : posixQuote(value)

export const consoleCommand = (words: readonly string[]): string => words.map(consoleWord).join(' ')
