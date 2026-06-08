import { OpenRouterClient } from './openrouter.js'

export type IntentCategory = 'technical' | 'product' | 'marketing' | 'implementation' | 'unknown'
export type Complexity = 'simple' | 'medium' | 'complex'

export interface RoutingDecision {
  category: IntentCategory
  agentName: string
  reasoning: string
  complexity: Complexity
}

const ROUTER_SYSTEM_PROMPT = `Sos un clasificador de intent y complejidad para un equipo de agentes AI.
Tu trabajo es clasificar el mensaje del usuario en una categoría Y un nivel de complejidad.

CATEGORÍAS:
- technical: arquitectura, stack, bugs, performance, code review, infraestructura
- product: features nuevas, priorización, roadmap, user stories, UX/UI
- marketing: copy, posicionamiento, canales, GTM, naming, adquisición de usuarios
- implementation: código a escribir o cambiar de forma concreta (una tarea específica de dev)

COMPLEJIDAD:
- simple: pregunta factual, definición, lookup, respuesta esperada < 3 oraciones. Ej: "¿qué hace X?", "¿cuál es el nombre de Y?"
- medium: análisis, comparación, recomendación con trade-offs, user story estándar. Ej: "¿qué es mejor A o B?", "redactame una user story para X"
- complex: diseño arquitectónico, estrategia completa, decisión mayor con múltiples sistemas, spec end-to-end. Ej: "diseñame la arquitectura de X", "planificá el lanzamiento completo de Y"

Respondé SOLO con JSON válido, sin markdown, sin explicaciones:
{"category": "<categoría>", "complexity": "<simple|medium|complex>", "reasoning": "<una oración explicando por qué>"}`

const CATEGORY_TO_AGENT: Record<IntentCategory, string> = {
  technical: 'cto',
  product: 'po',
  marketing: 'marketer',
  implementation: 'coder',
  unknown: 'founder',
}

export class Router {
  private llm: OpenRouterClient

  constructor(model: string) {
    this.llm = new OpenRouterClient(model)
  }

  async classify(message: string): Promise<RoutingDecision> {
    try {
      const raw = await this.llm.chat(ROUTER_SYSTEM_PROMPT, message)
      const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned) as { category: string; complexity: string; reasoning: string }

      const category = this.validateCategory(parsed.category)
      const complexity = this.validateComplexity(parsed.complexity)
      return {
        category,
        agentName: CATEGORY_TO_AGENT[category],
        reasoning: parsed.reasoning ?? '',
        complexity,
      }
    } catch {
      return { category: 'unknown', agentName: 'founder', reasoning: 'Classification failed', complexity: 'medium' }
    }
  }

  private validateCategory(raw: string): IntentCategory {
    const valid: IntentCategory[] = ['technical', 'product', 'marketing', 'implementation']
    return valid.includes(raw as IntentCategory) ? (raw as IntentCategory) : 'unknown'
  }

  private validateComplexity(raw: string): Complexity {
    const valid: Complexity[] = ['simple', 'medium', 'complex']
    return valid.includes(raw as Complexity) ? (raw as Complexity) : 'medium'
  }
}
