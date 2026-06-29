import { ToolDef } from '../tool.handler';
import { LlmProvider } from '../../llm/llm.types';

export function translateTool(deps: { defaultModel: () => LlmProvider | null }): ToolDef {
  return {
    name: 'translate',
    description: 'Translate text between languages. Args: "<target_lang> <text>"',
    rateLimit: 20,
    enabled: true,
    async execute(args, _ctx) {
      const [lang, ...rest] = args.split(/\s+/);
      const text = rest.join(' ');
      const llm = deps.defaultModel();
      if (!llm) return { text: `翻译功能需要配置 LLM Provider。原文:${text} (→${lang})` };
      const r = await llm.chat({
        model: llm.defaultModel,
        systemPrompt: `You are a translator. Translate to ${lang}. Output only the translation.`,
        messages: [{ role: 'user', content: text }],
      });
      return { text: r.text };
    },
  };
}
