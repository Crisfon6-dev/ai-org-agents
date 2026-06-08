export interface ActionClaim {
  type: 'file-creation' | 'command-execution' | 'code-modification' | 'file-existence'
  match: string
}

export interface ValidationResult {
  valid: boolean
  claims: ActionClaim[]
  disclaimer?: string
}

// Marker appended to process() responses when a disclaimer is needed
export const DISCLAIMER_MARKER = '\n\n<!-- QUALITY_HARNESS_DISCLAIMER -->'

// Note: \b doesn't work reliably with accented chars (é, í, ó) in JS regex.
// Patterns use (?:^|[\s,]) as word boundary prefix and (?=[\s,.]|$) as suffix.
const ACTION_PATTERNS: Array<{ type: ActionClaim['type']; pattern: RegExp }> = [
  {
    type: 'file-creation',
    pattern: /(?:^|[\s,])(cre[eé]|guard[eé]|escrib[ií]|gener[eé]|created?|saved?|wrote|generated?)\s.{0,60}(archivo|file|\.md|\.ts|\.json|\.yaml|\.env)/im,
  },
  {
    type: 'command-execution',
    pattern: /(?:^|[\s,])(ejecut[eé]|corr[ií]|invoqu[eé]|llam[eé]|executed?|invoked?|called?)\s.{0,60}(hermes|comando|command|script|funci[oó]n|function)/im,
  },
  {
    type: 'code-modification',
    pattern: /(?:^|[\s,])(modifiqu[eé]|actualic[eé]|cambi[eé]|edit[eé]|modified?|updated?|changed?|edited?)\s.{0,60}(c[oó]digo|code|archivo|file|base de datos|database)/im,
  },
  {
    type: 'file-existence',
    pattern: /(el archivo (est[aá]|se encuentra) en|the file is at|lo encontr[aá]s en|pod[eé]s encontrarlo en)\s+[`~\/\w]/i,
  },
]

export class ResponseValidator {
  validate(response: string, agentName: string, executionCapable: boolean): ValidationResult {
    if (executionCapable) {
      // Agent can actually execute — no claims to flag
      return { valid: true, claims: [] }
    }

    const claims = this.detectActionClaims(response)
    if (claims.length === 0) {
      return { valid: true, claims: [] }
    }

    const disclaimer = this.buildDisclaimer(agentName, claims)
    return { valid: false, claims, disclaimer }
  }

  private detectActionClaims(response: string): ActionClaim[] {
    const found: ActionClaim[] = []
    for (const { type, pattern } of ACTION_PATTERNS) {
      const match = response.match(pattern)
      if (match) {
        found.push({ type, match: match[0] })
      }
    }
    return found
  }

  private buildDisclaimer(agentName: string, claims: ActionClaim[]): string {
    const claimTypes = [...new Set(claims.map((c) => c.type))]
    const descriptions = claimTypes.map((t) => {
      switch (t) {
        case 'file-creation': return 'crear/guardar archivos'
        case 'command-execution': return 'ejecutar comandos'
        case 'code-modification': return 'modificar código'
        case 'file-existence': return 'garantizar la existencia de archivos'
      }
    })

    return (
      `⚠️ **Nota de calidad**: ${agentName.toUpperCase()} mencionó ${descriptions.join(', ')} ` +
      `en su respuesta, pero en modo delegado no tiene capacidad de ejecución real. ` +
      `El contenido es texto generado, no una acción efectuada. ` +
      `Para ejecución real, escribí la tarea en **#dev-channel**.`
    )
  }
}
