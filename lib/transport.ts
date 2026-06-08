export interface IncomingMessage {
  id: string
  channelId: string
  channelName: string
  content: string
  authorId: string
  threadId?: string
}

export interface SendOptions {
  replyToMessageId?: string
  threadId?: string
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>

export interface Transport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** Register a listener for a specific channel name */
  onMessage(channelName: string, handler: MessageHandler): void
  /** Send a message to a channel by name */
  send(channelName: string, content: string, options?: SendOptions): Promise<void>
  /** Create a thread on a message and return the thread ID */
  createThread(channelName: string, messageId: string, name: string): Promise<string | null>
  /** Send a file attachment to a channel (or thread) */
  sendFile(channelName: string, content: string, filename: string, options?: SendOptions): Promise<void>
}
