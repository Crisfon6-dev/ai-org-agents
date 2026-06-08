import { AgentConfig } from './config.js'
import { Transport, IncomingMessage } from './transport.js'
import { BrainClient } from './brain.js'
import { OpenRouterClient } from './openrouter.js'
import { ResponseValidator, DISCLAIMER_MARKER } from './response-validator.js'

const validator = new ResponseValidator()

export interface ProjectMeta {
  name: string
  url: string
}

export interface AgentContext {
  name: string
  config: AgentConfig
  systemPrompt: string
  transport: Transport
  brain: BrainClient
  project?: ProjectMeta
}

export class AgentBase {
  readonly name: string
  readonly config: AgentConfig

  protected transport: Transport
  protected brain: BrainClient
  protected llm: OpenRouterClient
  protected systemPrompt: string
  protected brainContext: string = ''
  /** false by default (delegated mode) — set to true in subclasses that invoke real execution */
  protected executionCapable = false

  constructor(ctx: AgentContext) {
    this.name = ctx.name
    this.config = ctx.config
    this.transport = ctx.transport
    this.brain = ctx.brain
    // Use model_default as the primary; fall back to legacy model field
    this.llm = new OpenRouterClient(
      ctx.config.model_default ?? ctx.config.model!,
      undefined,
      ctx.project?.name,
      ctx.project?.url,
    )
    this.systemPrompt = ctx.systemPrompt
  }

  async init(): Promise<void> {
    this.brainContext = this.brain.loadContext(this.name)
    this.transport.onMessage(this.config.discord_channel, (msg) => this.handleMessage(msg))
    console.log(`✓ [${this.name}] listening on #${this.config.discord_channel}`)
  }

  /** Handle an incoming Discord message — override in subclasses for custom behavior */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Immediate feedback per spec
    await this.transport.send(msg.channelId, '⏳ Procesando...', { replyToMessageId: msg.id })

    try {
      const response = await this.process(msg.content)

      const threadId = await this.transport.createThread(
        msg.channelName,
        msg.id,
        `${this.name}-${new Date().toISOString().slice(0, 10)}`,
      )

      await this.transport.send(
        msg.channelName,
        this.formatResponse(response),
        threadId ? { threadId } : undefined,
      )

      if (this.config.can_write_brain) {
        this.brain.writeDecision({
          role: this.name,
          title: this.extractTitle(msg.content),
          content: response,
        })
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await this.transport.send(msg.channelName, `❌ Error en ${this.name}: ${error}`)
      await this.transport.send(
        'agent-logs',
        `[${this.name}] Error\n\`\`\`\n${err instanceof Error ? err.stack : error}\n\`\`\``,
      )
    }
  }

  /** Process a message and return the response — can be called directly by the Founder.
   *  modelOverride: if provided, uses a temporary LLM client with that model (adaptive routing). */
  async process(userMessage: string, modelOverride?: string): Promise<string> {
    const llm = modelOverride ? new OpenRouterClient(modelOverride) : this.llm
    const fullSystemPrompt = this.buildSystemPrompt()
    const response = await llm.chat(fullSystemPrompt, userMessage)

    const result = validator.validate(response, this.name, this.executionCapable)
    if (!result.valid && result.disclaimer) {
      return response + DISCLAIMER_MARKER + result.disclaimer
    }
    return response
  }

  protected buildSystemPrompt(): string {
    if (!this.brainContext) return this.systemPrompt
    return `## Contexto del proyecto\n\n${this.brainContext}\n\n---\n\n${this.systemPrompt}`
  }

  protected formatResponse(response: string): string {
    return `**[${this.name.toUpperCase()}]**\n\n${response}`
  }

  protected extractTitle(userMessage: string): string {
    return userMessage.slice(0, 80).replace(/\n/g, ' ').trim()
  }

  /** True when the response is structured enough to warrant a .md file attachment */
  protected isStructured(content: string): boolean {
    return (
      content.length > 800 ||
      (content.match(/^#{2,3} /m) ?? []).length >= 2 ||
      content.includes('| ') ||
      content.includes('- [ ]')
    )
  }

  /** Execute a subtask within an agentic loop — override in subclasses for custom execution.
   *  Default: LLM call with accumulated context injected into system prompt. */
  async executeSubtask(description: string, accumulatedContext: string, modelOverride?: string): Promise<string> {
    const llm = modelOverride ? new OpenRouterClient(modelOverride) : this.llm
    const systemPrompt = accumulatedContext
      ? `${this.buildSystemPrompt()}\n\n## Contexto acumulado del equipo\n${accumulatedContext}`
      : this.buildSystemPrompt()

    const response = await llm.chat(systemPrompt, description)
    const result = validator.validate(response, this.name, this.executionCapable)
    return result.valid ? response : response + (result.disclaimer ? `\n\n${result.disclaimer}` : '')
  }

  /** Generates a semantic filename: <role>-<slug>.md */
  protected buildFilename(role: string, title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 40)
      .replace(/-+$/, '')
    return `${role}-${slug}.md`
  }
}
