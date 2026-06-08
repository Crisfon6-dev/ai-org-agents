import { OpenRouterClient } from './openrouter.js'
import { TaskPlan, createPlan, MAX_SUBTASKS } from './task-plan.js'

interface RawSubtask {
  agentName: string
  description: string
}

const DECOMPOSER_PROMPT = `Sos un planificador de tareas para un equipo de agentes AI.
Tu trabajo es descomponer una tarea compleja en subtareas ordenadas, asignadas a los agentes correctos.

AGENTES DISPONIBLES:
- po: define user stories, criterios de aceptación, scope de features
- cto: decisiones de arquitectura, diseño técnico, revisión de código
- marketer: copy, estrategia GTM, canales, posicionamiento
- coder: implementación de código, invoca Hermes para ejecutar cambios

REGLAS:
- Máximo ${MAX_SUBTASKS} subtareas
- El orden importa: primero se define (PO), luego se diseña (CTO), luego se implementa (Coder)
- Cada subtarea debe ser atómica y específica
- Solo usá los agentes que realmente se necesitan para esta tarea

Respondé SOLO con JSON válido, sin markdown:
{
  "goal": "<descripción breve del objetivo>",
  "subtasks": [
    {"agentName": "<agente>", "description": "<qué debe hacer este agente>"},
    ...
  ]
}`

export class TaskDecomposer {
  private llm: OpenRouterClient

  constructor(model: string) {
    this.llm = new OpenRouterClient(model)
  }

  async decompose(goal: string, availableAgents: string[]): Promise<TaskPlan | null> {
    try {
      const raw = await this.llm.chat(
        DECOMPOSER_PROMPT.replace('po, cto, marketer, coder', availableAgents.join(', ')),
        goal,
      )

      const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned) as { goal?: string; subtasks?: RawSubtask[] }

      if (!parsed.subtasks || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
        return null
      }

      if (parsed.subtasks.length > MAX_SUBTASKS) {
        return null // Signal to Founder that task is too large
      }

      // Filter out unknown agents
      const validSubtasks = parsed.subtasks.filter((s) =>
        availableAgents.includes(s.agentName) &&
        typeof s.description === 'string' &&
        s.description.trim().length > 0,
      )

      if (validSubtasks.length === 0) return null

      return createPlan(parsed.goal ?? goal, validSubtasks)
    } catch {
      return null
    }
  }
}
