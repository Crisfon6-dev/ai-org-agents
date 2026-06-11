import { AgentConfig } from './config.js'
import { Transport, IncomingMessage, ImageAttachment } from './transport.js'
import { BrainClient } from './brain.js'
import { SkillsLoader } from './skills.js'
import { OpenRouterClient, buildUserContent } from './openrouter.js'
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
  skills?: SkillsLoader
  project?: ProjectMeta
}

export class AgentBase {
  readonly name: string
  readonly config: AgentConfig

  protected transport: Transport
  protected brain: BrainClient
  protected skillsLoader?: SkillsLoader
  protected llm: OpenRouterClient
  protected systemPrompt: string
  protected brainContext: string = ''
  protected skillsContext: string = ''
  /** false by default (delegated mode) — set to true in subclasses that invoke real execution */
  protected executionCapable = false

  constructor(ctx: AgentContext) {
    this.name = ctx.name
    this.config = ctx.config
    this.transport = ctx.transport
    this.brain = ctx.brain
    this.skillsLoader = ctx.skills
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
    if (this.skillsLoader && this.config.skills.length) {
      this.skillsContext = this.skillsLoader.load(this.config.skills)
    }
    this.transport.onMessage(this.config.discord_channel, (msg) => this.handleMessage(msg))
    console.log(`✓ [${this.name}] listening on #${this.config.discord_channel}`)
  }

  /** Handle an incoming Discord message — override in subclasses for custom behavior */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Immediate feedback per spec
    await this.transport.send(msg.channelId, '⏳ Procesando...', { replyToMessageId: msg.id })

    try {
      const response = await this.process(msg.content, undefined, msg.attachments)

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
  async process(userMessage: string, modelOverride?: string, attachments?: ImageAttachment[]): Promise<string> {
    // Image attachments require a vision-capable model — text-only models 404 on image blocks
    const visionModel = attachments?.length ? this.config.model_vision : undefined
    const llm = visionModel
      ? new OpenRouterClient(visionModel)
      : modelOverride
        ? new OpenRouterClient(modelOverride)
        : this.llm
    const fullSystemPrompt = this.buildSystemPrompt()
    const userContent = buildUserContent(userMessage, attachments)
    const response = await llm.chat(fullSystemPrompt, userContent)

    const result = validator.validate(response, this.name, this.executionCapable)
    if (!result.valid && result.disclaimer) {
      return response + DISCLAIMER_MARKER + result.disclaimer
    }
    return response
  }

  protected buildSystemPrompt(): string {
    const parts: string[] = []
    if (this.brainContext) parts.push(`## Contexto del proyecto\n\n${this.brainContext}`)
    if (this.skillsContext) parts.push(`## Skills de disciplina\n\n${this.skillsContext}`)
    parts.push(this.systemPrompt)
    return parts.join('\n\n---\n\n')
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

  /** Post-execution gap capture: asks a cheap model what DOMAIN knowledge was missing,
   *  stages it in the discipline skill's LEARNINGS.md, and mirrors it to the brain
   *  (tag: skill-gap). Never throws — a failed capture must not affect the main task. */
  protected async captureSkillGaps(taskDescription: string, outcome: string): Promise<void> {
    if (!this.skillsLoader || !this.config.skills.length) return
    try {
      const model = this.config.model_fast ?? this.config.model_default ?? this.config.model!
      const llm = new OpenRouterClient(model)
      const prompt = `Acabás de completar esta tarea como agente ${this.name}:
${taskDescription.slice(0, 600)}

Resultado/contexto final:
${outcome.slice(0, 1500)}

¿Faltó conocimiento de DOMINIO del proyecto (convenciones, paths, decisiones, patrones del repo) que hubiera hecho la tarea más directa?
Respondé SOLO JSON: {"gap": "<conocimiento faltante en 1-3 oraciones>" | null, "skill": "<una de: ${this.config.skills.join(', ')}>"}
Si no faltó nada relevante: {"gap": null}`

      const raw = await llm.chat('Sos un auditor de gaps de conocimiento de dominio. Respondés únicamente JSON válido.', prompt)
      const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned) as { gap?: string | null; skill?: string }
      if (!parsed.gap) return

      const skill = this.config.skills.includes(parsed.skill ?? '') ? parsed.skill! : this.config.skills[0]
      this.skillsLoader.appendLearning(skill, parsed.gap, this.name)
      this.brain.writeDecision({
        role: this.name,
        title: `skill-gap: ${skill}`,
        content: parsed.gap,
        tags: ['skill-gap'],
      })
      console.log(`📌 [${this.name}] gap de dominio staged en ${skill}/LEARNINGS.md`)
    } catch (err) {
      console.warn(`⚠️  [${this.name}] gap-capture falló (no afecta la tarea): ${err instanceof Error ? err.message : String(err)}`)
    }
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
