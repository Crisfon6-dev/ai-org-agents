import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { join } from 'path'

// ~4 chars per token estimate — conservative (same heuristic as BrainClient)
const CHARS_PER_TOKEN = 4

interface LoadedSkill {
  name: string
  description: string
  body: string
}

/** Loads discipline skills (SKILL.md, Agent Skills standard) as prompt context.
 *  Skills live at <skillsPath>/<name>/SKILL.md with frontmatter: name, description.
 *  Invalid or missing skills are skipped with a warning — never fatal at startup. */
export class SkillsLoader {
  private skillsPath: string
  private maxContextTokens: number

  constructor(skillsPath: string, maxContextTokens = 2000) {
    this.skillsPath = skillsPath
    this.maxContextTokens = maxContextTokens
  }

  /** Returns the combined skills context, truncated to the token budget.
   *  Headers (name + description) of ALL skills are always preserved;
   *  bodies are truncated in order against the remaining budget. */
  load(names: string[]): string {
    if (!names.length) return ''

    const skills: LoadedSkill[] = []
    for (const name of names) {
      const skillFile = join(this.skillsPath, name, 'SKILL.md')
      if (!existsSync(skillFile)) {
        console.warn(`⚠️  [skills] Skill '${name}' not found at ${skillFile} — skipping`)
        continue
      }
      const parsed = this.parseSkill(readFileSync(skillFile, 'utf-8'))
      if (!parsed) {
        console.warn(`⚠️  [skills] Skill '${name}' has invalid frontmatter (missing name/description) — skipping`)
        continue
      }
      skills.push(parsed)
    }

    if (!skills.length) return ''

    const maxChars = this.maxContextTokens * CHARS_PER_TOKEN
    const headers = skills.map((s) => `### ${s.name}\n_${s.description}_`)
    const headerChars = headers.reduce((sum, h) => sum + h.length, 0)

    let remaining = Math.max(0, maxChars - headerChars)
    let truncatedChars = 0

    const sections = skills.map((skill, i) => {
      const body = skill.body.trim()
      if (body.length <= remaining) {
        remaining -= body.length
        return `${headers[i]}\n\n${body}`
      }
      truncatedChars += body.length - remaining
      const cut = body.slice(0, remaining)
      remaining = 0
      return cut ? `${headers[i]}\n\n${cut}\n...[truncado]` : headers[i]
    })

    if (truncatedChars > 0) {
      console.warn(
        `⚠️  [skills] Budget de ${this.maxContextTokens} tokens excedido — ` +
        `~${Math.ceil(truncatedChars / CHARS_PER_TOKEN)} tokens de skills truncados`,
      )
    }

    return sections.join('\n\n---\n\n')
  }

  /** Stages a domain-knowledge gap in the skill's LEARNINGS.md.
   *  Promotion into SKILL.md is human-curated at wave retros — never automatic. */
  appendLearning(skillName: string, gap: string, sourceRole: string): void {
    const dir = join(this.skillsPath, skillName)
    if (!existsSync(dir)) {
      console.warn(`⚠️  [skills] Cannot stage learning — skill '${skillName}' not found at ${dir}`)
      return
    }
    const file = join(dir, 'LEARNINGS.md')
    const date = new Date().toISOString().slice(0, 10)
    const entry = `\n## [${date}] agent-${sourceRole}\n\n${gap}\n`
    if (existsSync(file)) {
      appendFileSync(file, entry, 'utf-8')
    } else {
      const header =
        `# Learnings staging — ${skillName}\n\n` +
        `Gaps de conocimiento de dominio capturados automáticamente post-ejecución.\n` +
        `Promoción curada al body del SKILL.md en cada retro de Ola (ver agents/README.md).\n`
      writeFileSync(file, header + entry, 'utf-8')
    }
  }

  private parseSkill(raw: string): LoadedSkill | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)
    if (!match) return null

    const frontmatter = match[1]
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    if (!name || !description) return null

    return { name, description, body: raw.slice(match[0].length) }
  }
}
