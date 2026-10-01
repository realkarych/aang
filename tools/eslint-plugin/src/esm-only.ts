import { extname, relative } from 'node:path'
import { AST_NODE_TYPES, ESLintUtils, type TSESLint, type TSESTree } from '@typescript-eslint/utils'
import { staticSource } from './syntax.js'
import { toPosix, workspaceRoot } from './workspace.js'

type MessageId = 'builtinModuleLoader' | 'commonJsFile' | 'commonJsGlobal' | 'importRequire' | 'moduleBuiltin'

const codeGroups: readonly string[] = ['packages', 'tools']
const sourceDirectory = 'src'
const moduleBuiltins: readonly string[] = ['module', 'node:module']
const commonJsGlobals: readonly string[] = ['require', 'module']
const commonJsExtensions: readonly string[] = ['.cjs', '.cts']
const remedy = 'the project is ESM-only, load modules with import and import()'

const isSourceCode = (root: string, filename: string): boolean => {
  const [group, , area, ...rest] = toPosix(relative(root, filename)).split('/')
  return codeGroups.some((name) => name === group) && area === sourceDirectory && rest.length > 0
}

const globalReferences = (scope: TSESLint.Scope.Scope): readonly TSESLint.Scope.Reference[] => [
  ...scope.through,
  ...scope.variables.filter((variable) => variable.defs.length === 0).flatMap((variable) => variable.references),
]

export const esmOnly = ESLintUtils.RuleCreator.withoutDocs<[], MessageId>({
  meta: {
    type: 'problem',
    docs: { description: 'Keep package source code ESM-only: no CommonJS loaders and no node:module' },
    messages: {
      builtinModuleLoader: `package code may not use process.getBuiltinModule; ${remedy}`,
      commonJsFile: 'package code may not be a CommonJS {{extension}} file; the project is ESM-only',
      commonJsGlobal: `package code may not use the CommonJS global {{name}}; ${remedy}`,
      importRequire: `package code may not use import = require(); ${remedy}`,
      moduleBuiltin: `package code may not import '{{source}}'; ${remedy}`,
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => {
    const root = workspaceRoot(context.filename)
    if (root === undefined || !isSourceCode(root, context.filename)) {
      return {}
    }

    const checkSource = (node: TSESTree.Node, source: string | undefined): void => {
      if (source !== undefined && moduleBuiltins.includes(source)) {
        context.report({ node, messageId: 'moduleBuiltin', data: { source } })
      }
    }

    const reportedLoaderPositions = new Set<number>()
    const reportBuiltinModuleLoader = (node: TSESTree.Node): void => {
      const [start] = node.range
      if (!reportedLoaderPositions.has(start)) {
        reportedLoaderPositions.add(start)
        context.report({ node, messageId: 'builtinModuleLoader' })
      }
    }

    return {
      Program: (node) => {
        const extension = extname(context.filename)
        if (commonJsExtensions.includes(extension)) {
          context.report({ node, messageId: 'commonJsFile', data: { extension } })
        }
        for (const { identifier } of globalReferences(context.sourceCode.getScope(node))) {
          if (commonJsGlobals.includes(identifier.name)) {
            context.report({ node: identifier, messageId: 'commonJsGlobal', data: { name: identifier.name } })
          }
        }
      },
      ImportDeclaration: (node) => {
        checkSource(node.source, node.source.value)
      },
      ExportAllDeclaration: (node) => {
        checkSource(node.source, node.source.value)
      },
      ExportNamedDeclaration: (node) => {
        if (node.source !== null) {
          checkSource(node.source, node.source.value)
        }
      },
      ImportExpression: (node) => {
        checkSource(node.source, staticSource(node.source))
      },
      TSImportType: (node) => {
        checkSource(node.source, node.source.value)
      },
      TSImportEqualsDeclaration: (node) => {
        if (node.moduleReference.type === AST_NODE_TYPES.TSExternalModuleReference) {
          context.report({ node, messageId: 'importRequire' })
        }
      },
      'Identifier[name="getBuiltinModule"]': reportBuiltinModuleLoader,
      'Literal[value="getBuiltinModule"]': reportBuiltinModuleLoader,
      'TemplateElement[value.cooked="getBuiltinModule"]': reportBuiltinModuleLoader,
    }
  },
})
