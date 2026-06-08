export const MAX_SUBTASKS = 10
export const MAX_RETRIES = 2
export const SUBTASK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export type SubtaskStatus = 'pending' | 'running' | 'done' | 'failed'

export interface Subtask {
  id: number
  agentName: string
  description: string
  status: SubtaskStatus
  result?: string
  retries: number
}

export interface TaskPlan {
  goal: string
  subtasks: Subtask[]
  accumulatedContext: string
}

export function createPlan(goal: string, subtasks: Array<{ agentName: string; description: string }>): TaskPlan {
  return {
    goal,
    subtasks: subtasks.map((s, i) => ({
      id: i + 1,
      agentName: s.agentName,
      description: s.description,
      status: 'pending',
      retries: 0,
    })),
    accumulatedContext: '',
  }
}

export function planSummary(plan: TaskPlan): string {
  const agentChain = plan.subtasks.map((s) => s.agentName.toUpperCase()).join(' → ')
  return `${plan.subtasks.length} subtareas — ${agentChain}`
}

const MAX_ACCUMULATED_CONTEXT = 2000

export function appendContext(plan: TaskPlan, agentName: string, result: string): void {
  const snippet = result.length > 500 ? result.slice(0, 500) + '\n...[truncado]' : result
  const entry = `\n\n## ${agentName.toUpperCase()} completó:\n${snippet}`
  // Cap total accumulated context to avoid ballooning token costs
  const combined = plan.accumulatedContext + entry
  plan.accumulatedContext = combined.length > MAX_ACCUMULATED_CONTEXT
    ? combined.slice(-MAX_ACCUMULATED_CONTEXT)
    : combined
}
