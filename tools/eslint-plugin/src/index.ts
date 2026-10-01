import type { TSESLint } from '@typescript-eslint/utils'
import { dependencyDirection } from './dependency-direction.js'

export interface CompatiblePlugin {
  readonly meta: { readonly name: string }
}

const plugin = {
  meta: { name: '@aang/eslint-plugin' },
  rules: { 'dependency-direction': dependencyDirection },
} satisfies TSESLint.FlatConfig.Plugin

const compatiblePlugin: CompatiblePlugin = plugin

export default compatiblePlugin
