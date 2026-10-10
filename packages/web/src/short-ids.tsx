import type { ReactElement } from 'react'

const derivedId = /\b[0-9a-f]{32}\b/

const derivedIds = new RegExp(derivedId.source, 'g')

const splitIds = new RegExp(`(${derivedId.source})`)

const shortId = (id: string): string => id.slice(0, 8)

export const shortIds = (text: string): string => text.replace(derivedIds, shortId)

export const fullHint = (text: string): string | undefined => (derivedId.test(text) ? text : undefined)

export const StageName = ({ title }: { readonly title: string }): ReactElement => (
  <span title={fullHint(title)}>{`«${shortIds(title)}»`}</span>
)

export const ShortIds = ({ text }: { readonly text: string }): ReactElement => (
  <>
    {text.split(splitIds).map((part, index) =>
      index % 2 === 0 ? (
        part
      ) : (
        <span key={index} title={part}>
          {shortId(part)}
        </span>
      ),
    )}
  </>
)
