import 'dotenv/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { loadConfig, resolvePrompt, resolveWorkspace } from './lib/config.js'
import { BrainClient } from './lib/brain.js'
import { SkillsLoader } from './lib/skills.js'
import { AgentBase, AgentContext } from './lib/agent-base.js'
import { FounderAgent } from './lib/founder-agent.js'
import { CoderAgent } from './lib/coder-agent.js'
import { DiscordTransport } from './lib/discord-transport.js'
import { CliTransport } from './lib/cli-transport.js'
import type { Transport } from './lib/transport.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const config = loadConfig()

  // Transport: env override > config.yaml
  const transportType = process.env.TRANSPORT ?? config.transport.type
  const transport: Transport =
    transportType === 'cli' ? new CliTransport() : new DiscordTransport()

  const workspace = resolveWorkspace(config, __dirname)
  // brain.path: if absolute use as-is, otherwise resolve relative to agents/ dir
  const brainPath = config.brain.path.startsWith('/') ? config.brain.path : resolve(__dirname, config.brain.path)
  const brain = new BrainClient(brainPath, config.brain.max_context_tokens)

  // skills.path: same resolution rule as brain.path
  const skillsPath = config.skills.path.startsWith('/') ? config.skills.path : resolve(__dirname, config.skills.path)
  const skills = new SkillsLoader(skillsPath, config.skills.max_context_tokens)

  // Build the orchestrator (founder) first
  const founderEntry = Object.entries(config.agents).find(([, a]) => a.role === 'orchestrator')!
  const [founderName, founderConfig] = founderEntry

  const project = { name: config.project.name, url: config.project.url }

  const founderCtx: AgentContext = {
    name: founderName,
    config: founderConfig,
    systemPrompt: resolvePrompt(founderConfig, __dirname),
    transport,
    brain,
    skills,
    project,
  }

  const founder = new FounderAgent(founderCtx, founderConfig.output_channel ?? 'ai-team-output')

  // Build all specialists
  const specialists = new Map<string, AgentBase>()

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.role !== 'specialist') continue

    const ctx: AgentContext = {
      name,
      config: agentConfig,
      systemPrompt: resolvePrompt(agentConfig, __dirname),
      transport,
      brain,
      skills,
      project,
    }

    const agent = agentConfig.uses_hermes
      ? new CoderAgent(ctx, founderConfig.output_channel ?? 'ai-team-output', workspace)
      : new AgentBase(ctx)

    specialists.set(name, agent)
    founder.registerSpecialist(name, agent)
  }

  // Connect transport
  await transport.connect()

  // Initialize all agents (registers Discord listeners)
  await founder.init()
  for (const agent of specialists.values()) {
    await agent.init()
  }

  console.log(`\n🚀 ${config.project.name} Agents running (transport: ${transportType})`)
  console.log(`   Workspace: ${workspace}`)
  console.log(`   Agents: ${founderName} + ${[...specialists.keys()].join(', ')}`)

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n⏹  Shutting down...')
    await transport.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
