import {
  chatOutputJsonSchema,
  observerOperations,
  observerOutputJsonSchema,
  type LlmJsonSchema,
} from '@aang/contract'
import { describe, test } from 'vitest'

type Schema = LlmJsonSchema

interface Located {
  readonly path: string
  readonly node: Schema | boolean
}

const allowedKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'enum',
  'const',
])

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const children = (path: string, node: Schema): Located[] => [
  ...Object.entries(node.properties ?? {}).map(([key, child]) => ({ path: `${path}/properties/${key}`, node: child })),
  ...(node.items === undefined || Array.isArray(node.items) ? [] : [{ path: `${path}/items`, node: node.items }]),
  ...(isSchema(node.additionalProperties)
    ? [{ path: `${path}/additionalProperties`, node: node.additionalProperties }]
    : []),
  ...(node.anyOf ?? []).map((child, index) => ({ path: `${path}/anyOf/${String(index)}`, node: child })),
]

const everyNode = ({ path, node }: Located): Located[] => [
  { path, node },
  ...(isSchema(node) ? children(path, node).flatMap(everyNode) : []),
]

const typesOf = (node: Schema): readonly unknown[] =>
  node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type]

const objectViolations = (path: string, node: Schema): string[] => [
  ...(node.additionalProperties === false ? [] : [`${path}: object without additionalProperties: false`]),
  ...(node.properties === undefined || Object.keys(node.properties).length === 0
    ? [`${path}: object without properties is a free dictionary`]
    : []),
  ...(JSON.stringify([...(node.required ?? [])].sort()) === JSON.stringify(Object.keys(node.properties ?? {}).sort())
    ? []
    : [`${path}: not every property is required`]),
]

const strictModeViolations = ({ path, node }: Located): string[] =>
  !isSchema(node)
    ? [`${path}: boolean schema accepts anything`]
    : [
        ...Object.keys(node)
          .filter((keyword) => !allowedKeywords.has(keyword))
          .map((keyword) => `${path}: keyword ${keyword} is outside the strict subset`),
        ...(node.type === undefined && node.anyOf === undefined ? [`${path}: node constrains nothing`] : []),
        ...(typesOf(node).includes('object') ? objectViolations(path, node) : []),
        ...(typesOf(node).includes('array') && !isSchema(node.items)
          ? [`${path}: array without a single items schema`]
          : []),
        ...(node.anyOf ?? [])
          .filter((member) => member.anyOf !== undefined || member.type === undefined)
          .map(() => `${path}: anyOf member without its own type`),
      ]

const variantConsts = (union: Schema | undefined, discriminator: string): unknown[] =>
  (union?.anyOf ?? [])
    .map((member) => member.properties?.[discriminator])
    .map((field) => (isSchema(field) ? field.const : undefined))

const property = (node: Schema | undefined, key: string): Schema | undefined => {
  const value = node?.properties?.[key]
  return isSchema(value) ? value : undefined
}

const llmSchemas = [
  { name: 'observer output', generate: observerOutputJsonSchema },
  { name: 'chat output', generate: chatOutputJsonSchema },
]

describe('LLM output schemas fit the strict subset of both CLIs (ADR-0007)', () => {
  test.for(llmSchemas)('$name is an object at the root', ({ generate }, { expect }) => {
    const schema = generate()

    expect(schema.type).toBe('object')
    expect(schema.anyOf).toBeUndefined()
  })

  test.for(llmSchemas)('$name has no keyword or shape outside the strict subset', ({ generate }, { expect }) => {
    expect(everyNode({ path: '#', node: generate() }).flatMap(strictModeViolations)).toEqual([])
  })
})

describe('observer output follows the ADR-0007 protocol', () => {
  const schema = observerOutputJsonSchema()
  const operations = property(schema, 'ops')?.items

  test('the answer is base version, operations and needs', ({ expect }) => {
    expect(Object.keys(schema.properties ?? {})).toEqual(['base_version', 'ops', 'needs'])
    expect(property(schema, 'base_version')?.type).toBe('integer')
  })

  test('operations are closed anyOf variants, one per ADR-0007 operation', ({ expect }) => {
    expect(isSchema(operations) ? variantConsts(operations, 'op') : []).toEqual([...observerOperations])
  })

  test('every operation carries fact evidence and a short rationale', ({ expect }) => {
    const members = isSchema(operations) ? (operations.anyOf ?? []) : []

    expect(members.map((member) => [property(member, 'evidence')?.items, property(member, 'rationale')?.type])).toEqual(
      observerOperations.map(() => [{ type: 'string' }, 'string']),
    )
  })

  test('needs ask for raw records, actions, saved artifact versions and context records', ({ expect }) => {
    const needs = property(schema, 'needs')?.items

    expect(isSchema(needs) ? variantConsts(needs, 'kind') : []).toEqual([
      'raw_record',
      'action',
      'artifact_version',
      'context',
    ])
  })
})

describe('chat output follows the ADR-0008 protocol', () => {
  const schema = chatOutputJsonSchema()

  test('the answer is needs, answer, citations, insufficient data and a view rule', ({ expect }) => {
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'needs',
      'answer',
      'citations',
      'insufficient_data',
      'view_rule',
    ])
    expect(property(schema, 'answer')?.type).toEqual(['string', 'null'])
  })

  test('needs ask for stages, facts, raw records, actions, journal records and saved artifact versions', ({
    expect,
  }) => {
    const needs = property(schema, 'needs')?.items

    expect(isSchema(needs) ? variantConsts(needs, 'kind') : []).toEqual([
      'stage',
      'fact',
      'raw_record',
      'action',
      'journal',
      'artifact_version',
    ])
  })

  test('citations point at stages, facts, actions, artifact versions and questions', ({ expect }) => {
    const citations = property(schema, 'citations')?.items

    expect(isSchema(citations) ? variantConsts(citations, 'kind') : []).toEqual([
      'stage',
      'fact',
      'action',
      'artifact_version',
      'question',
    ])
  })

  test('the proposed view rule is one of the closed actions or null', ({ expect }) => {
    const rule = property(schema, 'view_rule')

    expect(variantConsts(rule, 'action')).toEqual(['collapse', 'hide', 'group', 'detail', undefined])
    expect(rule?.anyOf?.at(-1)).toEqual({ type: 'null' })
  })
})
