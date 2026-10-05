import {
  ActionId,
  AgentId,
  ArtifactId,
  ArtifactVersionId,
  AttentionItemId,
  BindingId,
  CardId,
  ChatMessageId,
  CriterionId,
  FactId,
  GapId,
  GitSnapshotId,
  LinkId,
  MessageId,
  ObserverCallId,
  QuestionId,
  RunId,
  SessionId,
  StageId,
  UsageRecordId,
  ViewRuleId,
} from '@aang/contract'
import { z } from 'zod'

export type OnId = (id: string, path: string) => unknown

const idSchemas: ReadonlySet<z.ZodType> = new Set<z.ZodType>([
  ActionId,
  AgentId,
  ArtifactId,
  ArtifactVersionId,
  AttentionItemId,
  BindingId,
  CardId,
  ChatMessageId,
  CriterionId,
  FactId,
  GapId,
  GitSnapshotId,
  LinkId,
  MessageId,
  ObserverCallId,
  QuestionId,
  RunId,
  SessionId,
  StageId,
  UsageRecordId,
  ViewRuleId,
])

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const tagged = (option: z.ZodType, discriminator: string, tag: unknown): boolean => {
  const field = option instanceof z.ZodObject ? (option.shape as Readonly<Record<string, z.ZodType>>)[discriminator] : undefined
  return field instanceof z.ZodLiteral && field.values.has(tag as z.core.util.Literal)
}

const optionOf = (schema: z.ZodUnion, value: unknown): z.ZodType | undefined => {
  const options = schema.options as readonly z.ZodType[]
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const { discriminator } = schema.def
    return isObject(value) ? options.find((option) => tagged(option, discriminator, value[discriminator])) : undefined
  }
  return options.find((option) => option.safeParse(value).success)
}

export const mapIds = (schema: z.ZodType, value: unknown, onId: OnId, path: string): unknown => {
  if (value === null || value === undefined) {
    return value
  }
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    return mapIds(schema.unwrap() as z.ZodType, value, onId, path)
  }
  if (schema instanceof z.ZodUnion) {
    const option = optionOf(schema, value)
    return option === undefined ? value : mapIds(option, value, onId, path)
  }
  if (schema instanceof z.ZodIntersection) {
    return mapIds(schema.def.right as z.ZodType, mapIds(schema.def.left as z.ZodType, value, onId, path), onId, path)
  }
  if (typeof value === 'string') {
    return idSchemas.has(schema) ? onId(value, path) : value
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item: unknown) => mapIds(schema.element as z.ZodType, item, onId, `${path}[]`))
  }
  if (schema instanceof z.ZodObject && isObject(value)) {
    const shape = schema.shape as Readonly<Record<string, z.ZodType>>
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => {
        const field = shape[key]
        return [key, field === undefined ? member : mapIds(field, member, onId, `${path}.${key}`)]
      }),
    )
  }
  return value
}
