import * as readline from 'readline'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Transport, IncomingMessage, ImageAttachment, MessageHandler, SendOptions } from './transport.js'

const CLI_FILE_DIR = '/tmp/aphrodite-agents'

const IMAGE_URL_RE = /https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?/gi

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Extract image URLs from a typed message into ImageAttachment[], mirroring Discord attachment capture */
function extractImageAttachments(content: string): ImageAttachment[] {
  const attachments: ImageAttachment[] = []
  for (const match of content.matchAll(IMAGE_URL_RE)) {
    const url = match[0]
    const ext = match[1].toLowerCase()
    attachments.push({
      url,
      contentType: IMAGE_CONTENT_TYPES[ext] ?? 'image/png',
      name: url.split('/').pop()?.split('?')[0] ?? 'image',
    })
  }
  return attachments
}

/**
 * CLI transport for local development without Discord.
 * Routes messages to agents by typing: <channel> <message>
 * e.g.: "ai-team-input ¿cuál es el mejor approach para caché?"
 */
export class CliTransport implements Transport {
  private listeners = new Map<string, MessageHandler>()
  private rl: readline.Interface | null = null
  private msgCounter = 0

  async connect(): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    console.log('\n🖥️  CLI Transport active. Format: <channel-name> <message>')
    console.log('   Channels: ai-team-input, cto-channel, marketing-channel, po-channel, dev-channel')
    console.log('   Example: ai-team-input ¿cuál es el mejor enfoque para caché?\n')

    this.rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      const spaceIdx = trimmed.indexOf(' ')
      if (spaceIdx === -1) {
        console.log('Usage: <channel-name> <message>')
        return
      }

      const channelName = trimmed.slice(0, spaceIdx)
      const content = trimmed.slice(spaceIdx + 1)
      const handler = this.listeners.get(channelName)

      if (!handler) {
        console.log(`No agent listening on #${channelName}`)
        return
      }

      const attachments = extractImageAttachments(content)
      const msg: IncomingMessage = {
        id: `cli-${++this.msgCounter}`,
        channelId: channelName,
        channelName,
        content,
        authorId: 'founder',
        ...(attachments.length > 0 ? { attachments } : {}),
      }

      handler(msg).catch((err) => console.error(`[cli-transport] Error:`, err))
    })
  }

  async disconnect(): Promise<void> {
    this.rl?.close()
  }

  onMessage(channelName: string, handler: MessageHandler): void {
    this.listeners.set(channelName, handler)
  }

  async send(channelName: string, content: string, _options?: SendOptions): Promise<void> {
    console.log(`\n📤 [#${channelName}]\n${content}\n`)
  }

  async createThread(_channelName: string, _messageId: string, name: string): Promise<string | null> {
    console.log(`\n🧵 Thread: ${name}`)
    return null
  }

  async sendFile(_channelName: string, content: string, filename: string, _options?: SendOptions): Promise<void> {
    mkdirSync(CLI_FILE_DIR, { recursive: true })
    const filepath = join(CLI_FILE_DIR, filename)
    writeFileSync(filepath, content, 'utf-8')
    console.log(`\n📎 File saved: ${filepath}`)
  }
}
