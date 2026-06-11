import { readFileSync } from 'fs'
import { resolve, dirname, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { z } from 'zod'

const AgentConfigSchema = z.object({
  role: z.enum(['orchestrator', 'specialist']),
  prompt: z.string(),
  // Legacy: single model for all complexity tiers
  model: z.string().optional(),
  // Adaptive model tiers (at least model_default or model must be present)
  model_fast: z.string().optional(),    // simple questions, factual lookups
  model_default: z.string().optional(), // standard analysis and recommendations
  model_deep: z.string().optional(),    // complex architecture / deep strategy
  model_vision: z.string().optional(),  // messages with image attachments (must support image input)
  discord_channel: z.string(),
  output_channel: z.string().optional(),
  can_write_brain: z.boolean().default(false),
  uses_hermes: z.boolean().default(false),
  // Discipline skills (Agent Skills standard) injected into the system prompt
  skills: z.array(z.string()).default([]),
}).refine(
  (d) => !!(d.model ?? d.model_default),
  { message: 'Agent must have at least one of: model, model_default' },
)

const OrgConfigSchema = z.object({
  // Path to the root of the project this agent team assists.
  // Relative paths are resolved from the agents/ directory. Default: '..' (parent of agents/)
  workspace: z.string().default('..'),
  project: z.object({
    name: z.string().default('AI Org Agents'),
    url: z.string().default('https://github.com/your-org/your-repo'),
    description: z.string().optional(),
  }).default({}),
  transport: z.object({
    type: z.enum(['discord', 'cli']),
  }),
  brain: z.object({
    path: z.string(),
    max_context_tokens: z.number().default(3000),
  }),
  // Discipline skills directory (Agent Skills standard, SKILL.md per skill).
  // Relative paths are resolved from the agents/ directory, like brain.path.
  skills: z.object({
    path: z.string().default('../.claude/skills'),
    max_context_tokens: z.number().default(2000),
  }).default({}),
  openrouter: z.object({
    base_url: z.string().default('https://openrouter.ai/api/v1'),
  }),
  agents: z.record(z.string(), AgentConfigSchema),
})

export type AgentConfig = z.infer<typeof AgentConfigSchema>
export type OrgConfig = z.infer<typeof OrgConfigSchema>

/** Resolves the workspace path to an absolute path from the agents/ directory */
export function resolveWorkspace(config: OrgConfig, agentsDir: string): string {
  if (isAbsolute(config.workspace)) return config.workspace
  return resolve(agentsDir, config.workspace)
}

export function loadConfig(configPath?: string): OrgConfig {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const path = configPath ?? resolve(__dirname, '..', 'config.yaml')
  const raw = yaml.load(readFileSync(path, 'utf-8'), { schema: yaml.CORE_SCHEMA })
  const result = OrgConfigSchema.safeParse(raw)

  if (!result.success) {
    console.error('❌ Invalid config.yaml:', result.error.format())
    process.exit(1)
  }

  const config = result.data

  // Validate: exactly one orchestrator
  const orchestrators = Object.entries(config.agents).filter(([, a]) => a.role === 'orchestrator')
  if (orchestrators.length !== 1) {
    console.error(`❌ config.yaml must have exactly 1 orchestrator agent, found ${orchestrators.length}`)
    process.exit(1)
  }

  // Validate: all prompt files exist
  for (const [name, agent] of Object.entries(config.agents)) {
    const promptPath = resolve(__dirname, '..', agent.prompt)
    try {
      readFileSync(promptPath)
    } catch {
      console.error(`❌ Missing prompt file for agent '${name}': ${promptPath}`)
      process.exit(1)
    }
  }

  return config
}

export function resolvePrompt(config: AgentConfig, configDir: string): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const path = resolve(__dirname, '..', config.prompt)
  return readFileSync(path, 'utf-8')
}
