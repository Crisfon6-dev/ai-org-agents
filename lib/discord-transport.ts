import {
  Client,
  GatewayIntentBits,
  TextChannel,
  ThreadChannel,
  Message,
  ChannelType,
  AttachmentBuilder,
} from 'discord.js'
import { Transport, IncomingMessage, MessageHandler, SendOptions } from './transport.js'

export class DiscordTransport implements Transport {
  private client: Client
  private listeners = new Map<string, MessageHandler>()
  private channelCache = new Map<string, TextChannel>()
  // threadId → parent channel name (so thread replies route to the right handler)
  private threadParentMap = new Map<string, string>()

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })
  }

  async connect(): Promise<void> {
    const token = process.env.DISCORD_TOKEN
    if (!token) throw new Error('DISCORD_TOKEN missing in .env.agents')

    this.client.on('messageCreate', (message: Message) => {
      if (message.author.bot) return

      let channelName: string
      let threadId: string | undefined

      if (message.channel.isThread()) {
        // Thread reply — route to the parent channel's handler
        const thread = message.channel as ThreadChannel
        threadId = thread.id
        channelName = this.threadParentMap.get(thread.id)
          ?? (thread.parent as TextChannel | null)?.name
          ?? 'unknown'
      } else {
        channelName = (message.channel as TextChannel).name ?? 'unknown'
      }

      console.log(`[discord] 📨 message in #${channelName}${threadId ? ` (thread)` : ''} from ${message.author.tag}: "${message.content.slice(0, 60)}"`)

      const handler = this.listeners.get(channelName)
      if (!handler) {
        console.log(`[discord] ⚠️  no handler for #${channelName} (registered: ${[...this.listeners.keys()].join(', ')})`)
        return
      }

      const incoming: IncomingMessage = {
        id: message.id,
        channelId: message.channelId,
        channelName,
        content: message.content,
        authorId: message.author.id,
        threadId,
      }
      handler(incoming).catch((err) =>
        console.error(`[discord-transport] handler error on #${channelName}:`, err),
      )
    })

    await this.client.login(token)
    console.log(`✓ Discord bot connected as ${this.client.user?.tag}`)
  }

  async disconnect(): Promise<void> {
    this.client.destroy()
  }

  onMessage(channelName: string, handler: MessageHandler): void {
    this.listeners.set(channelName, handler)
  }

  private splitMessage(content: string, maxLen = 1900): string[] {
    if (content.length <= maxLen) return [content]
    const chunks: string[] = []
    let remaining = content
    while (remaining.length > 0) {
      // Try to split at a newline near the limit
      let cut = maxLen
      const newline = remaining.lastIndexOf('\n', maxLen)
      if (newline > maxLen * 0.5) cut = newline + 1
      chunks.push(remaining.slice(0, cut))
      remaining = remaining.slice(cut)
    }
    return chunks
  }

  async send(channelName: string, content: string, options?: SendOptions): Promise<void> {
    const channel = await this.resolveChannel(channelName)
    if (!channel) {
      console.warn(`⚠️  Channel #${channelName} not found — skipping send`)
      return
    }

    const chunks = this.splitMessage(content)

    if (options?.threadId) {
      const thread = channel.threads.cache.get(options.threadId)
      if (thread) {
        for (const chunk of chunks) await thread.send(chunk)
        return
      }
    }

    if (options?.replyToMessageId && chunks.length > 0) {
      try {
        const msg = await channel.messages.fetch(options.replyToMessageId)
        await msg.reply(chunks[0])
        for (const chunk of chunks.slice(1)) await channel.send(chunk)
        return
      } catch {
        // Fallthrough to regular send if reply fails
      }
    }

    for (const chunk of chunks) await channel.send(chunk)
  }

  async createThread(channelName: string, messageId: string, name: string): Promise<string | null> {
    const channel = await this.resolveChannel(channelName)
    if (!channel) return null

    try {
      const message = await channel.messages.fetch(messageId)
      const thread = await message.startThread({
        name: name.slice(0, 100),
        autoArchiveDuration: 1440,
      })
      // Track thread → parent channel so replies route correctly
      this.threadParentMap.set(thread.id, channelName)
      return thread.id
    } catch (err) {
      console.warn(`⚠️  Could not create thread on #${channelName}: ${err}`)
      return null
    }
  }

  async sendFile(channelName: string, content: string, filename: string, options?: SendOptions): Promise<void> {
    const channel = await this.resolveChannel(channelName)
    if (!channel) {
      console.warn(`⚠️  Channel #${channelName} not found — skipping sendFile`)
      return
    }
    const attachment = new AttachmentBuilder(Buffer.from(content, 'utf-8'), { name: filename })
    if (options?.threadId) {
      const thread = channel.threads.cache.get(options.threadId)
      if (thread) {
        await thread.send({ files: [attachment] })
        return
      }
    }
    await channel.send({ files: [attachment] })
  }

  private async resolveChannel(channelName: string): Promise<TextChannel | null> {
    if (this.channelCache.has(channelName)) {
      return this.channelCache.get(channelName)!
    }

    const guildId = process.env.GUILD_ID
    if (!guildId) {
      console.warn('⚠️  GUILD_ID not set — cannot resolve channels by name')
      return null
    }

    const guild = this.client.guilds.cache.get(guildId)
    if (!guild) {
      console.warn(`⚠️  Guild ${guildId} not found in cache`)
      return null
    }

    const channel = guild.channels.cache.find(
      (c) => c.name === channelName && c.type === ChannelType.GuildText,
    ) as TextChannel | undefined

    if (!channel) {
      console.warn(`⚠️  Channel #${channelName} not found in server — agent will not listen/send there`)
      return null
    }

    this.channelCache.set(channelName, channel)
    return channel
  }
}
