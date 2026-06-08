export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class OpenRouterClient {
  private model: string
  private baseUrl: string
  private apiKey: string
  private projectName: string
  private projectUrl: string

  constructor(
    model: string,
    baseUrl = 'https://openrouter.ai/api/v1',
    projectName = 'AI Org Agents',
    projectUrl = 'https://github.com/your-org/your-repo',
  ) {
    this.model = model
    this.baseUrl = baseUrl
    this.projectName = projectName
    this.projectUrl = projectUrl
    const key = process.env.OPENROUTER_API_KEY
    if (!key) throw new Error('OPENROUTER_API_KEY missing in environment')
    this.apiKey = key
  }

  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]
    return this.complete(messages)
  }

  async complete(messages: LLMMessage[], retryCount = 0): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.projectUrl,
        'X-Title': this.projectName,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
      }),
    })

    if (res.status === 429) {
      const body = await res.text()
      const retryAfter = this.parseRetryAfter(body, res.headers)

      // If using a :free model, fall back to the paid version of the SAME model
      // (same quality, dedicated access, minimal cost — e.g. Llama 70B paid = $0.07/1M)
      if (this.model.endsWith(':free') && retryCount === 0) {
        const paidVersion = this.model.replace(/:free$/, '')
        console.warn(`[openrouter] rate limit on ${this.model} (upstream congestion) → using paid ${paidVersion}`)
        const fallbackClient = new OpenRouterClient(paidVersion, this.baseUrl)
        return fallbackClient.complete(messages, 1)
      }

      if (retryAfter <= 15 && retryCount < 2) {
        // Short wait on paid model → retry silently
        console.warn(`[openrouter] rate limit on ${this.model}, retrying in ${retryAfter}s (${retryCount + 1}/2)`)
        await new Promise((r) => setTimeout(r, retryAfter * 1000))
        return this.complete(messages, retryCount + 1)
      }

      // Long wait or out of retries → surface to user
      throw new Error(
        `⏱️ Rate limit en ${this.model} — esperá ${retryAfter}s y volvé a intentarlo.\n` +
        `(Si pasa seguido, recargá créditos en https://openrouter.ai/settings/billing)`,
      )
    }

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OpenRouter error ${res.status}: ${body}`)
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: { content: string | null }
        finish_reason: string
      }>
      error?: { message: string; code?: number }
    }

    if (data.error) {
      throw new Error(`OpenRouter API error: ${data.error.message} (code: ${data.error.code ?? 'unknown'})`)
    }

    const choice = data.choices?.[0]
    const content = choice?.message?.content

    if (!content) {
      const reason = choice?.finish_reason ?? 'unknown'
      if (reason === 'content_filter') {
        throw new Error(`OpenRouter: content blocked by model moderation (finish_reason: content_filter). Try rephrasing or switching model.`)
      }
      throw new Error(`OpenRouter: empty response (finish_reason: ${reason}, model: ${this.model})`)
    }
    return content
  }

  private parseRetryAfter(body: string, headers: Headers): number {
    // Try Retry-After header first
    const headerVal = headers.get('Retry-After')
    if (headerVal) {
      const parsed = parseInt(headerVal, 10)
      if (!isNaN(parsed)) return Math.min(parsed, 60)
    }
    // Try retry_after_seconds in JSON body
    try {
      const parsed = JSON.parse(body) as { error?: { metadata?: { retry_after_seconds?: number } } }
      const seconds = parsed?.error?.metadata?.retry_after_seconds
      if (typeof seconds === 'number') return Math.min(seconds + 2, 60)
    } catch { /* ignore */ }
    return 25 // safe default
  }
}
