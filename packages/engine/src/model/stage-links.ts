import type { Link, StageId } from '@aang/contract'

export type StageLink = Extract<Link, { stage: StageId }>

export const stageLinkKey = (link: StageLink): string => {
  const target = (() => {
    switch (link.kind) {
      case 'assignment':
        return [link.action]
      case 'participation':
        return [link.agent]
      case 'artifact':
        return [link.version, link.direction]
      case 'dependency':
        return [link.depends_on, link.via]
    }
  })()
  return JSON.stringify([link.run, link.kind, link.stage, ...target])
}
