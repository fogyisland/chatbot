export type RouteDecision =
  | { kind: 'command'; handler: 'help' | 'clear' | 'status' | 'forget'; args: string }
  | { kind: 'kb'; query: string; topK?: number }
  | { kind: 'tool'; toolName: string; args: string }
  | { kind: 'llm'; prompt: string; systemPrompt?: string }
  | { kind: 'unknown'; reason: string };
