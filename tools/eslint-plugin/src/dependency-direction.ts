import { posix, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AST_NODE_TYPES, ASTUtils, ESLintUtils, type TSESTree } from '@typescript-eslint/utils'
import { allowedDependencies, isPackageDirectory, locatableDependencies } from './dependencies.js'
import { staticSource } from './syntax.js'
import { toPosix, workspaceRoot } from './workspace.js'

type MessageId =
  | 'forbiddenPackage'
  | 'locateOnlyPackage'
  | 'relativeIntoOwnImplementation'
  | 'relativeOutsidePackage'
  | 'unknownPackage'

type Reference = 'import' | 'locate'

interface PackageFile {
  readonly path: string
  readonly directory: string
  readonly productCode: boolean
}

interface RelativeViolation {
  readonly messageId: MessageId
  readonly target: string
}

const packagesDirectory = 'packages'
const scope = '@aang/'
const implementationDirectories: readonly string[] = ['src', 'dist']

const packageName = (directory: string): string => `${scope}${directory}`

const packageFile = (root: string, filename: string): PackageFile | undefined => {
  const path = toPosix(relative(root, filename))
  const [group, directory, ...rest] = path.split('/')
  if (group !== packagesDirectory || directory === undefined || rest.length === 0) {
    return undefined
  }
  return { path, directory, productCode: rest.length > 1 && rest[0] === 'src' }
}

const importedPackage = (source: string): string | undefined => {
  const specifier = toPosix(source)
  return specifier.startsWith(scope) ? specifier.slice(scope.length).split('/')[0] : undefined
}

const isInside = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`)

const isRelative = (source: string): boolean => /^\.\.?(?:[/\\]|$)/.test(source)

const urlTarget = (root: string, filename: string, source: string): string | undefined => {
  try {
    return toPosix(relative(root, fileURLToPath(new URL(source, pathToFileURL(filename)))))
  } catch {
    return undefined
  }
}

const isImportMeta = (node: TSESTree.Expression): boolean =>
  node.type === AST_NODE_TYPES.MetaProperty && node.meta.name === 'import' && node.property.name === 'meta'

export const dependencyDirection = ESLintUtils.RuleCreator.withoutDocs<[], MessageId>({
  meta: {
    type: 'problem',
    docs: { description: 'Enforce the ADR-0011 dependency direction between packages' },
    messages: {
      forbiddenPackage: '{{importer}} {{code}} may not import {{imported}}; allowed: {{allowed}}',
      locateOnlyPackage:
        '{{importer}} {{code}} may only locate {{imported}} with import.meta.resolve; it may not import its code',
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
    const root = workspaceRoot(context.filename)
    const file = root === undefined ? undefined : packageFile(root, context.filename)
    if (root === undefined || file === undefined) {
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
    const locatable = locatableDependencies(file.directory)
    const data = {
      importer: packageName(file.directory),
      code: file.productCode ? 'product code' : 'test code',
      allowed: allowed.length === 0 ? 'none' : allowed.map(packageName).join(', '),
    }

    const reachesOwnImplementation = (target: string): boolean =>
      implementationDirectories.some((directory) => isInside(target, `${ownDirectory}/${directory}`))

    const relativeTargets = (source: string): string[] => {
      const asPath = posix.join(posix.dirname(file.path), toPosix(source))
      const asUrl = urlTarget(root, context.filename, source)
      return asUrl === undefined ? [asPath] : [asUrl, asPath]
    }

    const relativeViolation = (target: string): RelativeViolation | undefined => {
      if (!isInside(target, ownDirectory)) {
        const [group, directory] = target.split('/')
        const reached = group === packagesDirectory && directory !== undefined ? packageName(directory) : target
        return { messageId: 'relativeOutsidePackage', target: reached }
      }
      return !file.productCode && reachesOwnImplementation(target)
        ? { messageId: 'relativeIntoOwnImplementation', target }
        : undefined
    }

    const checkRelative = (node: TSESTree.Node, source: string): void => {
      const [violation] = relativeTargets(source).flatMap((target) => relativeViolation(target) ?? [])
      if (violation !== undefined) {
        context.report({ node, messageId: violation.messageId, data: { ...data, target: violation.target, source } })
      }
    }

    const check = (node: TSESTree.Node, source: string | undefined, reference: Reference = 'import'): void => {
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
      if (locatable.some((name) => name === imported)) {
        if (reference === 'import') {
          context.report({ node, messageId: 'locateOnlyPackage', data: { ...data, imported: packageName(imported) } })
        }
        return
      }
      context.report({ node, messageId: 'forbiddenPackage', data: { ...data, imported: packageName(imported) } })
    }

    const isImportMetaResolve = (node: TSESTree.Expression): boolean =>
      node.type === AST_NODE_TYPES.MemberExpression &&
      isImportMeta(node.object) &&
      ASTUtils.getPropertyName(node, context.sourceCode.getScope(node)) === 'resolve'

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
      TSImportEqualsDeclaration: (node) => {
        if (node.moduleReference.type === AST_NODE_TYPES.TSExternalModuleReference) {
          check(node.moduleReference.expression, node.moduleReference.expression.value)
        }
      },
      CallExpression: (node) => {
        const [argument, parent] = node.arguments
        if (argument === undefined || argument.type === AST_NODE_TYPES.SpreadElement || !isImportMetaResolve(node.callee)) {
          return
        }
        const source = staticSource(argument)
        if (parent === undefined || (source !== undefined && !isRelative(source))) {
          check(argument, source, 'locate')
        }
      },
    }
  },
})
