import { execFileSync } from 'child_process'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentBase, AgentContext } from './agent-base.js'
import { IncomingMessage } from './transport.js'

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

    // Direct mode: Hermes actually executes — allow action claims in responses
    this.executionCapable = true
    try {
      await this.runHermesFlow(msg.content, msg.channelName)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await this.transport.send(msg.channelName, `❌ Coder error: ${error}`)
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
  override async process(userMessage: string): Promise<string> {
    if (this.config.uses_hermes && this.looksLikeImplementationTask(userMessage)) {
      return this.buildTaskSpec(userMessage)
    }
    return super.process(userMessage)
  }

  private async runHermesFlow(task: string, channelName: string): Promise<void> {
    // 1. Build the task spec
    await this.transport.send(channelName, '📝 Generando task spec...')
    const taskSpec = await this.buildTaskSpec(task)

    // 2. Write to .hermes/current-task.md
    writeFileSync(this.hermesTaskFile, taskSpec, 'utf-8')
    await this.transport.send(channelName, '⚙️ Invocando Hermes...')

    // 3. Invoke Hermes one-shot
    const output = this.invokeHermes()

    // 4. Save output
    writeFileSync(this.hermesOutputFile, output, 'utf-8')

    // 5. Get git diff summary
    const diffSummary = this.getGitDiff()

    // 6. Post result to dev-channel
    const resultMsg = [
      `✅ **Hermes completó la implementación**`,
      '',
      diffSummary ? `**Cambios:**\n\`\`\`\n${diffSummary}\n\`\`\`` : '_Sin cambios detectados_',
      '',
      `**Output completo**: en \`.hermes/last-output.md\``,
    ].join('\n')

    await this.transport.send(channelName, resultMsg)

    // 7. Write to brain
    if (this.config.can_write_brain) {
      this.brain.writeDecision({
        role: this.name,
        title: this.extractTitle(task),
        content: `Task implementada via Hermes.\n\n${diffSummary}`,
      })
    }
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

  private invokeHermes(): string {
    // Read task spec in Node — pass as argument array (no shell, no injection risk)
    const taskSpec = readFileSync(this.hermesTaskFile, 'utf-8')
    try {
      const output = execFileSync('hermes', ['-z', taskSpec], {
        cwd: this.repoRoot,
        timeout: 300_000,
        encoding: 'utf-8',
      })
      return output
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; message?: string }
      const output = (execError.stdout ?? '') + (execError.stderr ?? '')
      if (output) return output
      throw new Error(`Hermes exited with error: ${execError.message ?? String(err)}`)
    }
  }

  private getGitDiff(): string {
    try {
      return execFileSync('git', ['diff', '--stat', 'HEAD'], {
        cwd: this.repoRoot,
        encoding: 'utf-8',
      }).trim()
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
