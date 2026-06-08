import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BRAIN_PATH = resolve(__dirname, '..', '..', 'aphrodite-brain')

// ~4 chars per token estimate — conservative
const CHARS_PER_TOKEN = 4

interface BrainWriteOptions {
  type?: 'source' | 'entity' | 'concept' | 'analysis'
  role: string
  content: string
  title: string
}

// Pages relevant to each agent role for focused context loading
const ROLE_WIKI_HINTS: Record<string, string[]> = {
  founder: ['index.md'],
  cto: ['wiki/concepts', 'wiki/analysis', 'wiki/entities'],
  marketer: ['wiki/concepts', 'wiki/analysis'],
  po: ['wiki/entities', 'wiki/concepts'],
  coder: ['wiki/concepts', 'wiki/entities'],
}

export class BrainClient {
  private brainPath: string
  private maxContextTokens: number

  constructor(brainPath = BRAIN_PATH, maxContextTokens = 8000) {
    this.brainPath = brainPath
    this.maxContextTokens = maxContextTokens
  }

  loadContext(role: string): string {
    if (!existsSync(this.brainPath)) {
      console.warn(`⚠️  aphrodite-brain not found at ${this.brainPath} — running without brain context`)
      return ''
    }

    const sections: string[] = []
    const maxChars = this.maxContextTokens * CHARS_PER_TOKEN
    let totalChars = 0

    // Always load index.md first
    const indexPath = join(this.brainPath, 'index.md')
    if (existsSync(indexPath)) {
      const indexContent = readFileSync(indexPath, 'utf-8')
      sections.push(`### Index\n${indexContent}`)
      totalChars += indexContent.length
    }

    // Load role-relevant wiki pages
    const hints = ROLE_WIKI_HINTS[role] ?? ['wiki/concepts']
    for (const hint of hints) {
      if (totalChars >= maxChars) break
      const hintPath = join(this.brainPath, hint)
      if (!existsSync(hintPath)) continue

      const stat = statSync(hintPath)
      if (stat.isDirectory()) {
        const files = readdirSync(hintPath)
          .filter((f) => f.endsWith('.md'))
          .sort()
        for (const file of files) {
          if (totalChars >= maxChars) break
          const content = readFileSync(join(hintPath, file), 'utf-8')
          const remaining = maxChars - totalChars
          const truncated = content.length > remaining ? content.slice(0, remaining) + '\n...[truncado]' : content
          sections.push(`### ${file.replace('.md', '')}\n${truncated}`)
          totalChars += truncated.length
        }
      } else {
        const content = readFileSync(hintPath, 'utf-8')
        const remaining = maxChars - totalChars
        const truncated = content.length > remaining ? content.slice(0, remaining) + '\n...[truncado]' : content
        sections.push(truncated)
        totalChars += truncated.length
      }
    }

    return sections.join('\n\n---\n\n')
  }

  writeDecision(opts: BrainWriteOptions): void {
    const { type = 'analysis', role, content, title } = opts

    const today = new Date().toISOString().slice(0, 10)
    const targetPath = join(this.brainPath, 'wiki', 'analysis', `${role}-decisions-${today}.md`)

    const frontmatter = [
      '---',
      `type: ${type}`,
      'project: aphrodite',
      `source: agent-${role}`,
      `created: ${new Date().toISOString()}`,
      `tags: [auto-generated, ${role}]`,
      '---',
    ].join('\n')

    const entry = `\n\n## ${title}\n\n${content}\n`

    if (existsSync(targetPath)) {
      // Append to today's file
      appendFileSync(targetPath, entry, 'utf-8')
    } else {
      writeFileSync(targetPath, frontmatter + entry, 'utf-8')
    }

    // Append to log.md
    this.appendLog(role, title)
  }

  private appendLog(role: string, title: string): void {
    const logPath = join(this.brainPath, 'log.md')
    const today = new Date().toISOString().slice(0, 10)
    const entry = `## [${today}] agent-${role} | ${title}\n`
    appendFileSync(logPath, entry, 'utf-8')
  }

  validateFrontmatter(content: string, role: string): boolean {
    return (
      content.includes('type:') &&
      content.includes('project: aphrodite') &&
      content.includes(`source: agent-${role}`) &&
      content.includes('created:') &&
      content.includes('tags:')
    )
  }
}
