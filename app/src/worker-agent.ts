// The real assistant: sends the message to the Worker, which asks the model and returns tool calls. The Worker holds the
// Anthropic key; the browser never sees it.

import { SignedOut } from './api.js'
import type { Agent, AgentRequest, AssistAnswer, AssistRequest, ToolCall } from './agent.js'

export class WorkerAgent implements Agent {
  constructor(private base = '/api') {}

  async respond(request: AgentRequest): Promise<ToolCall[]> {
    let response: Response
    try {
      response = await fetch(`${this.base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    } catch {
      throw new Error('Der Server ist nicht erreichbar.')
    }
    const data = (await response.json().catch(() => ({}))) as { calls?: ToolCall[]; error?: string }
    if (response.status === 401) throw new SignedOut()
    if (!response.ok || !Array.isArray(data.calls)) throw new Error(data.error ?? `Der Server antwortete mit ${response.status}.`)
    return data.calls
  }

  async assist(request: AssistRequest, signal?: AbortSignal): Promise<AssistAnswer> {
    const response = await fetch(`${this.base}/assist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal })
    if (response.status === 401) throw new SignedOut()
    const data = (await response.json().catch(() => ({}))) as Partial<AssistAnswer> & { error?: string }
    if (!response.ok || typeof data.fields !== 'object' || data.fields === null) throw new Error(data.error ?? `Der Server antwortete mit ${response.status}.`)
    return { type: data.type, fields: data.fields, source: data.source }
  }
}
