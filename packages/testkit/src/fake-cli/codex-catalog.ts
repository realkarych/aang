import type { JsonValue } from '@aang/contract'

interface ModelTraits {
  readonly slug: string
  readonly displayName: string
  readonly priority: number
  readonly toolMode: string | null
  readonly multiAgentVersion: string | null
  readonly applyPatchToolType: string | null
  readonly experimentalSupportedTools: readonly string[]
  readonly useResponsesLite: boolean
}

const reasoningLevels = ['low', 'medium', 'high', 'xhigh'].map((effort) => ({
  effort,
  description: `${effort} reasoning depth`,
}))

const catalogEntry = (traits: ModelTraits): JsonValue => ({
  slug: traits.slug,
  display_name: traits.displayName,
  description: `${traits.displayName} served by the fake codex`,
  default_reasoning_level: 'low',
  supported_reasoning_levels: reasoningLevels,
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: traits.priority,
  additional_speed_tiers: [],
  service_tiers: [],
  availability_nux: null,
  upgrade: null,
  model_messages: null,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  default_reasoning_summary: 'none',
  support_verbosity: true,
  default_verbosity: 'low',
  apply_patch_tool_type: traits.applyPatchToolType,
  web_search_tool_type: 'text_and_image',
  truncation_policy: { mode: 'tokens', limit: 10_000 },
  supports_image_detail_original: true,
  context_window: 272_000,
  max_context_window: 872_000,
  comp_hash: '3000',
  effective_context_window_percent: 95,
  experimental_supported_tools: [...traits.experimentalSupportedTools],
  input_modalities: ['text', 'image'],
  supports_search_tool: true,
  supports_experimental_context: false,
  use_responses_lite: traits.useResponsesLite,
  supports_reasoning_effort_updates: true,
  node_repl_auto_review_required: true,
  node_repl_disabled: false,
  tool_mode: traits.toolMode,
  multi_agent_version: traits.multiAgentVersion,
  multi_agent_reasoning_effort: 'xhigh',
  base_instructions: `You are Codex, an agent based on ${traits.displayName}.`,
})

export const bundledCatalog = (): JsonValue => ({
  models: [
    catalogEntry({
      slug: 'gpt-6.1-sol',
      displayName: 'GPT-6.1-Sol',
      priority: 1,
      toolMode: 'code_mode_only',
      multiAgentVersion: 'v2',
      applyPatchToolType: 'freeform',
      experimentalSupportedTools: ['send_user_message_async', 'clock'],
      useResponsesLite: true,
    }),
    catalogEntry({
      slug: 'gpt-5.5',
      displayName: 'GPT-5.5',
      priority: 2,
      toolMode: null,
      multiAgentVersion: null,
      applyPatchToolType: 'freeform',
      experimentalSupportedTools: [],
      useResponsesLite: false,
    }),
  ],
})

export const toolFreeTraits = ['tool_mode', 'multi_agent_version', 'apply_patch_tool_type'] as const
