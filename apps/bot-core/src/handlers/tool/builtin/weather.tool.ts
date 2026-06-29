import { ToolDef } from '../tool.handler';

export function weatherTool(): ToolDef {
  return {
    name: 'weather',
    description: 'Look up weather for a city. Args: "<city>"',
    rateLimit: 30,
    enabled: true,
    async execute(args, _ctx) {
      const city = args.trim();
      // Real impl calls a weather API. MVP placeholder.
      return { text: `${city} 当前天气:晴,25°C (占位数据,请配置真实 API)。` };
    },
  };
}
