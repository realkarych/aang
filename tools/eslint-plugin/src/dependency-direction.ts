import { posix, relative } from 'node:path'
import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils'
import { allowedDependencies, isPackageDirectory } from './dependencies.js'

type MessageId = 'forbiddenPackage' | 'relativeIntoOwnImplementation' | 'relativeOutsidePackage' | 'unknownPackage'

interface PackageFile {
  readonly path: string
  readonly directory: string
  readonly productCode: boolean
}

const packagesDirectory = 'packages'
const scope = '@aang/'
const implementationDirectories: readonly string[] = ['src', 'dist']

const packageName = (directory: string): string => `${scope}${directory}`

const packageFile = (root: string, filename: string): PackageFile | undefined => {
  const path = relative(root, filename).replaceAll('\\', '/')
  const [group, directory, ...rest] = path.split('/')
  if (group !== packagesDirectory || directory === undefined || rest.length === 0) {
    return undefined
  }
  return { path, directory, productCode: rest.length > 1 && rest[0] === 'src' }
}

const importedPackage = (source: string): string | undefined =>
  source.startsWith(scope) ? source.slice(scope.length).split('/')[0] : undefined

const isInside = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`)

const isRelative = (source: string): boolean =>
  source === '.' || source === '..' || source.startsWith('./') || source.startsWith('../')

const staticSource = (node: TSESTree.Expression): string | undefined => {
  if (node.type === AST_NODE_TYPES.Literal) {
    return typeof node.value === 'string' ? node.value : undefined
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

export const dependencyDirection = ESLintUtils.RuleCreator.withoutDocs<[], MessageId>({
  meta: {
    type: 'problem',
    docs: { description: 'Enforce the ADR-0011 dependency direction between packages' },
    messages: {
      forbiddenPackage: '{{importer}} {{code}} may not import {{imported}}; allowed: {{allowed}}',
      relativeIntoOwnImplementation:
        "{{importer}} {{code}} may not reach {{target}} through the relative path '{{source}}'; import {{importer}} by name",
      relativeOutsidePackage:
        "{{importer}} {{code}} may not reach {{target}} through the relative path '{{source}}'; import other packages by name; allowed: {{allowed}}",
      unknownPackage: '{{directory}} is not in the ADR-0011 dependency table',
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => {
    const file = packageFile(context.cwd, context.filename)
    if (file === undefined) {
      return {}
    }
    const ownDirectory = `${packagesDirectory}/${file.directory}`
    if (!isPackageDirectory(file.directory)) {
      return {
        Program: (node) => {
          context.report({ node, messageId: 'unknownPackage', data: { directory: ownDirectory } })
        },
      }
    }
    const allowed = allowedDependencies(file.directory, file.productCode)
    const data = {
      importer: packageName(file.directory),
      code: file.productCode ? 'product code' : 'test code',
      allowed: allowed.length === 0 ? 'none' : allowed.map(packageName).join(', '),
    }

    const reachesOwnImplementation = (target: string): boolean =>
      implementationDirectories.some((directory) => isInside(target, `${ownDirectory}/${directory}`))

    const checkRelative = (node: TSESTree.Node, source: string): void => {
      const target = posix.join(posix.dirname(file.path), source)
      if (isInside(target, ownDirectory)) {
        if (!file.productCode && reachesOwnImplementation(target)) {
          context.report({ node, messageId: 'relativeIntoOwnImplementation', data: { ...data, target, source } })
        }
        return
      }
      const [group, directory] = target.split('/')
      const reached = group === packagesDirectory && directory !== undefined ? packageName(directory) : target
      context.report({ node, messageId: 'relativeOutsidePackage', data: { ...data, target: reached, source } })
    }

    const check = (node: TSESTree.Node, source: string | undefined): void => {
      if (source === undefined) {
        return
      }
      if (isRelative(source)) {
        checkRelative(node, source)
        return
      }
      const imported = importedPackage(source)
      if (imported === undefined || imported === file.directory || allowed.some((name) => name === imported)) {
        return
      }
      context.report({ node, messageId: 'forbiddenPackage', data: { ...data, imported: packageName(imported) } })
    }

    return {
      ImportDeclaration: (node) => {
        check(node.source, node.source.value)
      },
      ExportAllDeclaration: (node) => {
        check(node.source, node.source.value)
      },
      ExportNamedDeclaration: (node) => {
        if (node.source !== null) {
          check(node.source, node.source.value)
        }
      },
      ImportExpression: (node) => {
        check(node.source, staticSource(node.source))
      },
      TSImportType: (node) => {
        check(node.source, node.source.value)
      },
    }
  },
})
