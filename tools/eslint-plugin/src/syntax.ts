import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils'

export const staticSource = (node: TSESTree.Expression): string | undefined => {
  if (node.type === AST_NODE_TYPES.Literal) {
    return typeof node.value === 'string' ? node.value : undefined
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

export const templateHead = (node: TSESTree.Expression): string | undefined =>
  node.type === AST_NODE_TYPES.TemplateLiteral ? (node.quasis[0]?.value.cooked ?? undefined) : undefined
