import { existsSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AST_NODE_TYPES, ASTUtils, ESLintUtils, TSESLint, type TSESTree } from '@typescript-eslint/utils'
import { allowedDependencies, isPackageDirectory } from './dependencies.js'

type MessageId = 'forbiddenPackage' | 'relativeIntoOwnImplementation' | 'relativeOutsidePackage' | 'unknownPackage'

interface PackageFile {
  readonly path: string
  readonly directory: string
  readonly productCode: boolean
}

interface RelativeViolation {
  readonly messageId: MessageId
  readonly target: string
}

const workspaceMarker = 'pnpm-workspace.yaml'
const packagesDirectory = 'packages'
const scope = '@aang/'
const implementationDirectories: readonly string[] = ['src', 'dist']
const createRequireName = 'createRequire'
const globalRequireName = 'require'

const packageName = (directory: string): string => `${scope}${directory}`

const toPosix = (path: string): string => path.replaceAll('\\', '/')

const workspaceRoot = (filename: string): string | undefined => {
  let directory = dirname(filename)
  while (!existsSync(join(directory, workspaceMarker))) {
    const parent = dirname(directory)
    if (parent === directory) {
      return undefined
    }
    directory = parent
  }
  return directory
}

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

const staticSource = (node: TSESTree.Expression): string | undefined => {
  if (node.type === AST_NODE_TYPES.Literal) {
    return typeof node.value === 'string' ? node.value : undefined
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

const isImportMeta = (node: TSESTree.Expression): boolean =>
  node.type === AST_NODE_TYPES.MetaProperty && node.meta.name === 'import' && node.property.name === 'meta'

const exportedName = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
  node.type === AST_NODE_TYPES.Identifier ? node.name : node.value

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

    const variableOf = (node: TSESTree.Identifier): TSESLint.Scope.Variable | null =>
      ASTUtils.findVariable(context.sourceCode.getScope(node), node)

    const isCreateRequire = (node: TSESTree.Expression): boolean => {
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        return ASTUtils.getPropertyName(node, context.sourceCode.getScope(node)) === createRequireName
      }
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return false
      }
      const definition = variableOf(node)?.defs[0]
      const name = definition?.node.type === AST_NODE_TYPES.ImportSpecifier ? exportedName(definition.node.imported) : node.name
      return name === createRequireName
    }

    const isLoader = (node: TSESTree.Expression, visited: ReadonlySet<TSESLint.Scope.Variable>): boolean => {
      if (node.type === AST_NODE_TYPES.CallExpression) {
        return isCreateRequire(node.callee)
      }
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return false
      }
      const variable = variableOf(node)
      if (variable === null || variable.defs.length === 0) {
        return node.name === globalRequireName
      }
      const [definition] = variable.defs
      return (
        !visited.has(variable) &&
        definition?.type === TSESLint.Scope.DefinitionType.Variable &&
        definition.node.init !== null &&
        isLoader(definition.node.init, new Set([...visited, variable]))
      )
    }

    const isResolver = (node: TSESTree.Expression): boolean =>
      node.type === AST_NODE_TYPES.MemberExpression &&
      ASTUtils.getPropertyName(node, context.sourceCode.getScope(node)) === 'resolve' &&
      (isImportMeta(node.object) || isLoader(node.object, new Set()))

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
      CallExpression: (node) => {
        const [argument] = node.arguments
        if (
          argument !== undefined &&
          argument.type !== AST_NODE_TYPES.SpreadElement &&
          (isLoader(node.callee, new Set()) || isResolver(node.callee))
        ) {
          check(argument, staticSource(argument))
        }
      },
    }
  },
})
