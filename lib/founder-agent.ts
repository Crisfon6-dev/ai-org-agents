import { AgentBase, AgentContext } from './agent-base.js'
import { AgentConfig } from './config.js'
import { Router, Complexity } from './router.js'
import { TaskDecomposer } from './task-decomposer.js'
import { TaskPlan, appendContext, planSummary, MAX_SUBTASKS, MAX_RETRIES } from './task-plan.js'
import { IncomingMessage } from './transport.js'
import { DISCLAIMER_MARKER } from './response-validator.js'

const AGENTIC_VERBS = /\b(implementá|implementa|planificá|planifica|construí|construye|completá|completa|desarrollá|desarrolla|build|implement|create|develop|execute|ejecuta|ejecutá)\b/i

export class FounderAgent extends AgentBase {
  private router: Router
  private decomposer: TaskDecomposer
  private specialists = new Map<string, AgentBase>()
  private outputChannel: string

  constructor(ctx: AgentContext, outputChannel: string) {
    super(ctx)
    // Router uses model_fast (Flash) — classifying intent is a structured JSON task
    const routerModel = ctx.config.model_fast ?? ctx.config.model_default ?? ctx.config.model!
    // Decomposer + summarizer use model_default (Llama) — strategic reasoning needs quality
    const reasoningModel = ctx.config.model_default ?? ctx.config.model!
    this.router = new Router(routerModel)
    this.decomposer = new TaskDecomposer(reasoningModel)
    this.outputChannel = outputChannel
  }

  registerSpecialist(name: string, agent: AgentBase): void {
    this.specialists.set(name, agent)
  }

  override async handleMessage(msg: IncomingMessage): Promise<void> {
    // 1. Use existing thread (conversation continuation) or create a new one
    const shortTitle = msg.content.slice(0, 80).replace(/\n/g, ' ')
    const threadId = msg.threadId
      ?? await this.transport.createThread(msg.channelName, msg.id, shortTitle)

    // reply helper: uses thread if available, falls back to reply-in-channel
    const reply = async (content: string) => {
      if (threadId) {
        await this.transport.send(msg.channelName, content, { threadId })
      } else {
        await this.transport.send(msg.channelName, content, { replyToMessageId: msg.id })
      }
    }

    // 2. Immediate feedback inside the thread
    await reply('⏳ Procesando...')

    try {
      // 3. Classify intent + complexity
      const decision = await this.router.classify(msg.content)
      const specialist = this.specialists.get(decision.agentName)

      if (!specialist || decision.agentName === 'founder') {
        const response = await this.process(msg.content)
        await reply(this.formatResponse(response))
        return
      }

      // 3b. Agentic loop detection: complex task with action verb → decompose + iterate
      if (this.requiresAgenticLoop(msg.content, decision.complexity)) {
        await this.handleAgenticTask(msg.content, reply)
        return
      }

      // 4. Select model tier based on complexity (adaptive routing)
      const modelForTask = this.selectModel(specialist.config, decision.complexity)
      const modelLabel = this.shortModelName(modelForTask)

      // 4b. Delegation notice — includes complexity tier and model selected
      await reply(
        `→ Derivado a **${specialist.name.toUpperCase()}** [${decision.complexity} · ${modelLabel}]\n\n_${decision.reasoning}_`,
      )

      // 5. Archive copy: post task to specialist's channel
      await this.transport.send(
        specialist.config.discord_channel,
        `📋 **Tarea delegada por Founder:**\n\n${msg.content}`,
      )

      // 6. Get specialist response with adaptive model (may include disclaimer marker)
      const rawResponse = await specialist.process(msg.content, modelForTask)
      const [response, disclaimer] = rawResponse.includes(DISCLAIMER_MARKER)
        ? rawResponse.split(DISCLAIMER_MARKER)
        : [rawResponse, undefined]

      // 7. Post specialist response in thread (file if structured, text if short)
      //    + archive copy in specialist channel
      const title = this.extractTitle(msg.content)
      const formatted = specialist['formatResponse'](response) as string
      if (this.isStructured(response)) {
        const filename = this.buildFilename(specialist.name, title)
        await this.transport.sendFile(
          msg.channelName,
          response,
          filename,
          threadId ? { threadId } : undefined,
        )
      } else {
        await reply(formatted)
      }
      await this.transport.send(
        specialist.config.discord_channel,
        formatted,
      )

      // 7b. Post disclaimer if validator flagged action claims
      if (disclaimer) {
        await reply(disclaimer.trim())
      }

      // 8. Write to brain
      if (specialist.config.can_write_brain) {
        this.brain.writeDecision({
          role: specialist.name,
          title: this.extractTitle(msg.content),
          content: response,
        })
      }

      // 9. Consolidated summary in thread
      const summary = await this.summarize(msg.content, specialist.name, response)
      await reply(summary)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await reply(`❌ Error procesando tu pedido: ${error}`)
      await this.transport.send(
        'agent-logs',
        `[founder] Error\n\`\`\`\n${err instanceof Error ? err.stack : error}\n\`\`\``,
      )
    }
  }

  private requiresAgenticLoop(content: string, complexity: Complexity): boolean {
    return complexity === 'complex' && AGENTIC_VERBS.test(content)
  }

  private async handleAgenticTask(goal: string, reply: (msg: string) => Promise<void>): Promise<void> {
    const availableAgents = [...this.specialists.keys()]
    const plan = await this.decomposer.decompose(goal, availableAgents)

    if (!plan) {
      await reply('❌ No pude descomponer la tarea en un plan válido. Intentá dividirla en partes más específicas.')
      return
    }

    if (plan.subtasks.length > MAX_SUBTASKS) {
      await reply(`⚠️ Esta tarea requiere más de ${MAX_SUBTASKS} pasos. Dividila en partes más pequeñas.`)
      return
    }

    await reply(`📋 **Plan creado:** ${planSummary(plan)}`)
    await this.runTaskPlan(plan, reply)

    const done = plan.subtasks.filter((s) => s.status === 'done').length
    const failed = plan.subtasks.filter((s) => s.status === 'failed').length
    await reply(`🎯 **Plan completado:** ${done}/${plan.subtasks.length} subtareas exitosas${failed > 0 ? `, ${failed} fallidas` : ''}`)
  }

  private async runTaskPlan(plan: TaskPlan, reply: (msg: string) => Promise<void>): Promise<void> {
    const total = plan.subtasks.length

    for (const subtask of plan.subtasks) {
      subtask.status = 'running'
      await reply(`⚙️ [${subtask.id}/${total}] **${subtask.agentName.toUpperCase()}**: ${subtask.description}`)

      let lastError = ''
      while (subtask.retries <= MAX_RETRIES) {
        try {
          const specialist = this.specialists.get(subtask.agentName)
          if (!specialist) {
            throw new Error(`Agente '${subtask.agentName}' no encontrado`)
          }

          // Use model_default for loop subtasks — only the final coder step warrants deep
          const loopComplexity = subtask.agentName === 'coder' ? 'complex' : 'medium'
          const modelForTask = this.selectModel(specialist.config, loopComplexity)
          const result = await specialist.executeSubtask(subtask.description, plan.accumulatedContext, modelForTask)

          subtask.result = result
          subtask.status = 'done'
          appendContext(plan, subtask.agentName, result)

          // Archive copy to specialist channel + brain
          await this.transport.send(specialist.config.discord_channel, `**[Loop agentic – subtarea ${subtask.id}]**\n\n${result}`)
          if (specialist.config.can_write_brain) {
            this.brain.writeDecision({ role: specialist.name, title: subtask.description, content: result })
          }

          await reply(`✅ [${subtask.id}/${total}] **${subtask.agentName.toUpperCase()}** completó`)
          break
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          subtask.retries++
          if (subtask.retries <= MAX_RETRIES) {
            await reply(`⚠️ [${subtask.id}] ${subtask.agentName.toUpperCase()} falló, reintentando (${subtask.retries}/${MAX_RETRIES})...`)
          }
        }
      }

      if (subtask.status !== 'done') {
        subtask.status = 'failed'
        await reply(`❌ [${subtask.id}/${total}] **${subtask.agentName.toUpperCase()}** falló después de ${MAX_RETRIES} reintentos: ${lastError}`)
      }
    }
  }

  private selectModel(config: AgentConfig, complexity: Complexity): string | undefined {
    switch (complexity) {
      case 'simple':  return config.model_fast ?? config.model_default ?? config.model
      case 'medium':  return config.model_default ?? config.model_fast ?? config.model
      case 'complex': return config.model_deep ?? config.model_default ?? config.model
    }
  }

  private shortModelName(model: string | undefined): string {
    if (!model) return 'default'
    const known: Record<string, string> = {
      'deepseek/deepseek-v4-pro':                      'deepseek-pro',
      'deepseek/deepseek-v4-flash':                    'deepseek-flash',
      'deepseek/deepseek-r1:free':                     'r1-free',
      'meta-llama/llama-3.3-70b-instruct':             'llama-70b',
      'meta-llama/llama-3.3-70b-instruct:free':        'llama-70b-free',
      'qwen/qwen3-coder:free':                         'qwen3-coder-free',
    }
    return known[model] ?? (model.split('/').pop() ?? model).slice(0, 18)
  }

  private async summarize(originalMessage: string, agentName: string, response: string): Promise<string> {
    const prompt = `El agente ${agentName.toUpperCase()} respondió a este pedido del usuario.
Hacé un resumen ejecutivo de 2-4 oraciones de la respuesta. En español rioplatense. Sin markdown extra.

Pedido original: ${originalMessage.slice(0, 200)}
Respuesta del agente: ${response.slice(0, 800)}`

    try {
      const summary = await this.llm.chat(this.systemPrompt, prompt)
      return `**Resumen [${agentName.toUpperCase()}]:**\n\n${summary}`
    } catch {
      return `**[${agentName.toUpperCase()}]** respondió. Ver #${this.specialists.get(agentName)?.config.discord_channel ?? agentName} para el detalle completo.`
    }
  }
}
