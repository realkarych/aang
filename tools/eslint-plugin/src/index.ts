import type { TSESLint } from '@typescript-eslint/utils'
import { dependencyDirection } from './dependency-direction.js'
import { esmOnly } from './esm-only.js'

export interface CompatiblePlugin {
  readonly meta: { readonly name: string }
}

const plugin = {
  meta: { name: '@aang/eslint-plugin' },
  rules: { 'dependency-direction': dependencyDirection, 'esm-only': esmOnly },
} satisfies TSESLint.FlatConfig.Plugin

const compatiblePlugin: CompatiblePlugin = plugin

export default compatiblePlugin
