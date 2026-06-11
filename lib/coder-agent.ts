import { execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentBase, AgentContext } from './agent-base.js'
import { IncomingMessage, ImageAttachment } from './transport.js'

export class CoderAgent extends AgentBase {
  private outputChannel: string
  private repoRoot: string
  private hermesTaskFile: string
  private hermesOutputFile: string

  constructor(ctx: AgentContext, outputChannel: string, workspace: string) {
    super(ctx)
    this.outputChannel = outputChannel
    this.repoRoot = workspace
    this.hermesTaskFile = join(workspace, '.hermes', 'current-task.md')
    this.hermesOutputFile = join(workspace, '.hermes', 'last-output.md')
  }

  override async handleMessage(msg: IncomingMessage): Promise<void> {
    await this.transport.send(msg.channelName, '⏳ Construyendo task spec para Hermes...', {
      replyToMessageId: msg.id,
    })

    const threadId = await this.transport.createThread(
      msg.channelName,
      msg.id,
      `coder-${msg.content.slice(0, 40).replace(/\s+/g, '-').toLowerCase()}`,
    )

    // Direct mode: Hermes actually executes — allow action claims in responses
    this.executionCapable = true
    try {
      await this.runHermesFlow(msg.content, msg.channelName, threadId ?? undefined)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await this.transport.send(msg.channelName, `❌ Coder error: ${error}`, threadId ? { threadId } : undefined)
      await this.transport.send(
        this.outputChannel,
        `⚠️ **El Coder necesita tu atención** — Hermes falló.\n\nError: ${error}`,
      )
      await this.transport.send(
        'agent-logs',
        `[coder] Hermes failed\n\`\`\`\n${err instanceof Error ? err.stack : error}\n\`\`\``,
      )
    } finally {
      // Restore to delegated-mode default after execution
      this.executionCapable = false
    }
  }

  /** Agentic loop execution: builds task spec with context, invokes Hermes, returns output */
  override async executeSubtask(description: string, accumulatedContext: string): Promise<string> {
    this.executionCapable = true
    try {
      const taskSpec = await this.buildTaskSpecWithContext(description, accumulatedContext)
      writeFileSync(this.hermesTaskFile, taskSpec, 'utf-8')
      const output = this.invokeHermes()
      writeFileSync(this.hermesOutputFile, output, 'utf-8')
      const diff = this.getGitDiff()
      return [
        '✅ Hermes completó la implementación',
        diff ? `\nCambios:\n${diff}` : '\nSin cambios detectados en git',
      ].join('\n')
    } finally {
      this.executionCapable = false
    }
  }

  /** Can also be called directly by FounderAgent.process() for simple task queries */
  override async process(userMessage: string, modelOverride?: string, attachments?: ImageAttachment[]): Promise<string> {
    if (this.config.uses_hermes && this.looksLikeImplementationTask(userMessage)) {
      // Building a spec describes future actions — not actual execution, so skip the validator check
      this.executionCapable = true
      try {
        return await this.buildTaskSpec(userMessage)
      } finally {
        this.executionCapable = false
      }
    }
    return super.process(userMessage, modelOverride, attachments)
  }

  private async runHermesFlow(task: string, channelName: string, threadId?: string): Promise<void> {
    const send = (content: string) =>
      this.transport.send(channelName, content, threadId ? { threadId } : undefined)

    const MAX_ITERATIONS = 10
    let iteration = 0
    let accumulatedContext = ''

    await send('📝 Generando task spec...')

    while (iteration < MAX_ITERATIONS) {
      iteration++

      const taskSpec = await this.buildTaskSpecWithContext(task, accumulatedContext)
      writeFileSync(this.hermesTaskFile, taskSpec, 'utf-8')

      if (iteration > 1) {
        await send(`🔄 Iteración ${iteration}/${MAX_ITERATIONS} — continuando implementación...`)
      } else {
        await send('⚙️ Invocando Hermes...')
      }

      const output = this.invokeHermes()
      writeFileSync(this.hermesOutputFile, output, 'utf-8')

      const diffSummary = this.getGitDiff()
      accumulatedContext += `\n\n### Iteración ${iteration}\n${output.slice(0, 1500)}`

      const done = await this.isTaskComplete(task, accumulatedContext, diffSummary)
      if (done) {
        const resultMsg = [
          `✅ **Hermes completó la implementación**${iteration > 1 ? ` (${iteration} iteraciones)` : ''}`,
          '',
          diffSummary ? `**Cambios:**\n\`\`\`\n${diffSummary}\n\`\`\`` : '_Sin cambios detectados_',
          '',
          `**Output completo**: en \`.hermes/last-output.md\``,
        ].join('\n')
        await send(resultMsg)
        if (this.config.can_write_brain) {
          this.brain.writeDecision({
            role: this.name,
            title: this.extractTitle(task),
            content: `Task implementada via Hermes (${iteration} iteraciones).\n\n${diffSummary}`,
          })
        }
        // Self-improvement: stage domain-knowledge gaps observed during this run
        await this.captureSkillGaps(task, accumulatedContext)
        return
      }
    }

    await send(
      `⚠️ **Hermes alcanzó el límite de ${MAX_ITERATIONS} iteraciones** sin completar la tarea.\n` +
      `Revisá \`.hermes/last-output.md\` y quebrá la tarea en partes más pequeñas.`,
    )

  }

  private async buildTaskSpec(task: string): Promise<string> {
    return this.buildTaskSpecWithContext(task, '')
  }

  private async buildTaskSpecWithContext(task: string, context: string): Promise<string> {
    const templatePath = join(this.repoRoot, '.hermes', 'task-spec-template.md')
    const templateHint = existsSync(templatePath)
      ? `\n\nTemplate de referencia:\n${readFileSync(templatePath, 'utf-8').slice(0, 2000)}`
      : ''

    const contextSection = context
      ? `\n\nContexto del equipo (decisiones previas a tener en cuenta):\n${context.slice(0, 3000)}`
      : ''

    const prompt = `Construí una task spec completa para implementar la siguiente tarea en el proyecto Aphrodite AI.
La spec DEBE tener exactamente 6 secciones en este orden:
1. ## Objetivo — qué hay que implementar y por qué (1-3 oraciones)
2. ## Contexto de arquitectura — bounded context, patrones relevantes, extractos de código
3. ## Archivos a crear/modificar — paths exactos con descripción
4. ## Pasos de implementación — pasos numerados, atómicos
5. ## Patrones obligatorios — reglas del repo
6. ## Criterios de aceptación — verificables por tests o build

Tarea a implementar: ${task}${contextSection}${templateHint}`

    return this.llm.chat(this.buildSystemPrompt(), prompt)
  }

  private async isTaskComplete(task: string, accumulatedContext: string, diffSummary: string): Promise<boolean> {
    const prompt = `Estás evaluando si una tarea de implementación está COMPLETA.

Tarea original: ${task}

Contexto de lo que se hizo hasta ahora:
${accumulatedContext.slice(-2000)}

Cambios en el código (git diff):
${diffSummary || '(sin cambios detectados)'}

Respondé SOLO con JSON: {"complete": true/false, "reason": "<1 oración explicando por qué>"}
Si los criterios de aceptación de la tarea están cumplidos → complete: true
Si falta trabajo significativo por hacer → complete: false`

    try {
      const raw = await this.llm.chat(this.buildSystemPrompt(), prompt)
      const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned) as { complete?: boolean }
      return parsed.complete === true
    } catch {
      // On parse error, assume incomplete to keep iterating
      return false
    }
  }

  private invokeHermes(): string {
    // Read task spec in Node — pass as argument array (no shell, no injection risk)
    const taskSpec = readFileSync(this.hermesTaskFile, 'utf-8')
    // Preload discipline skills (verified: `--skills` accepts comma-separated names).
    // Requires skills synced to ~/.hermes/skills/aphrodite — see scripts/sync-hermes-skills.sh
    const skillArgs = this.config.skills.length ? ['--skills', this.config.skills.join(',')] : []
    try {
      const output = execFileSync('hermes', ['-z', taskSpec, ...skillArgs], {
        cwd: this.repoRoot,
        // No timeout — tasks run until Hermes finishes
        encoding: 'utf-8',
      })
      // Detect Hermes "no final response" soft-failure (exit 0 but no real work done)
      if (output.includes('no final response was produced')) {
        throw new Error(`Hermes no produjo una respuesta final. Revisá el log en .hermes/last-output.md`)
      }
      return output
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; message?: string }
      // Re-throw if already an Error (from the soft-failure check above)
      if (err instanceof Error && !execError.stdout && !execError.stderr) throw err
      const output = (execError.stdout ?? '') + (execError.stderr ?? '')
      if (output.includes('no final response was produced')) {
        throw new Error(`Hermes no produjo una respuesta final. Revisá el log en .hermes/last-output.md`)
      }
      if (output) return output
      throw new Error(`Hermes exited with error: ${execError.message ?? String(err)}`)
    }
  }

  private getGitDiff(): string {
    try {
      // Show only changes introduced since Hermes started (staged + unstaged vs last commit)
      // Use --cached + working tree diff to avoid showing pre-existing uncommitted changes
      const staged = execFileSync('git', ['diff', '--cached', '--stat'], {
        cwd: this.repoRoot,
        encoding: 'utf-8',
      }).trim()
      const unstaged = execFileSync('git', ['diff', '--stat'], {
        cwd: this.repoRoot,
        encoding: 'utf-8',
      }).trim()
      return [staged, unstaged].filter(Boolean).join('\n')
    } catch {
      return ''
    }
  }

  private looksLikeImplementationTask(message: string): boolean {
    const keywords = ['implementá', 'crea', 'agrega', 'modifica', 'arreglá', 'fix', 'implement', 'create', 'add', 'update']
    const lower = message.toLowerCase()
    return keywords.some((k) => lower.includes(k))
  }
}
