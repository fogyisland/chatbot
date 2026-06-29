import { Injectable } from '@nestjs/common';
import { RouteDecision } from '@mpcb/shared';
import { NormalizedMessage } from '@mpcb/shared';
import { RouteContext, RouterConfig } from './router.types';

@Injectable()
export class RouterService {
  constructor(private readonly config: RouterConfig) {}

  async route(msg: NormalizedMessage, _ctx: RouteContext): Promise<RouteDecision> {
    const text = (msg.text || '').trim();

    // 1. Built-in commands: /cmd args
    if (text.startsWith('/')) {
      const rest = text.slice(1).trim();
      const [cmd, ...argParts] = rest.split(/\s+/);
      const handler = this.config.commands[cmd.toLowerCase()];
      if (handler) {
        return { kind: 'command', handler, args: argParts.join(' ') };
      }
      return { kind: 'unknown', reason: `unknown_command:${cmd}` };
    }

    // 2. Prefixes: kb: query, tool: name args, ask: prompt
    for (const [prefix, target] of Object.entries(this.config.prefixes)) {
      const m = text.match(new RegExp(`^${prefix}\\s*:\\s*(.+)$`, 'i'));
      if (m) {
        const payload = m[1].trim();
        if (target === 'kb') return { kind: 'kb', query: payload };
        if (target === 'tool') {
          const [toolName, ...args] = payload.split(/\s+/);
          return { kind: 'tool', toolName, args: args.join(' ') };
        }
        if (target === 'llm') return { kind: 'llm', prompt: payload };
      }
    }

    // 3. Default handler (or unknown if commandOnly)
    if (this.config.commandOnly) return { kind: 'unknown', reason: 'plain_text_in_command_only_mode' };
    return { kind: 'llm', prompt: text };
  }
}
