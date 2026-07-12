import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);
  private static readonly DEFAULT_HISTORY_BUDGET_RATIO = 0.5;
  private historyBudgetRatioWarned = false;
  get nodeEnv(): string {
    return process.env.NODE_ENV ?? 'development';
  }
  get botPort(): number {
    return Number(process.env.BOT_PORT ?? 3000);
  }
  get mysqlHost(): string {
    return process.env.MYSQL_HOST ?? 'localhost';
  }
  get mysqlPort(): number {
    return Number(process.env.MYSQL_PORT ?? 3306);
  }
  get mysqlUser(): string {
    return process.env.MYSQL_USER ?? 'mpcb';
  }
  get mysqlPassword(): string {
    return process.env.MYSQL_PASSWORD ?? 'mpcb_pw';
  }
  get mysqlDatabase(): string {
    return process.env.MYSQL_DATABASE ?? 'mpcb';
  }
  get redisHost(): string {
    return process.env.REDIS_HOST ?? 'localhost';
  }
  get redisPort(): number {
    return Number(process.env.REDIS_PORT ?? 6379);
  }
  get qdrantUrl(): string {
    return process.env.QDRANT_URL ?? 'http://localhost:6333';
  }
  get anthropicApiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  }
  get openaiApiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }
  get dashscopeApiKey(): string | undefined {
    return process.env.DASHSCOPE_API_KEY;
  }
  get deepseekApiKey(): string | undefined {
    return process.env.DEEPSEEK_API_KEY;
  }
  get wechatToken(): string {
    return process.env.WECHAT_TOKEN ?? '';
  }
  get wechatApiBase(): string {
    return process.env.WECHAT_API_BASE ?? 'https://qyapi.weixin.qq.com';
  }
  get wechatCorpId(): string {
    return process.env.WECHAT_CORP_ID ?? '';
  }
  get wechatCorpSecret(): string {
    return process.env.WECHAT_CORP_SECRET ?? '';
  }
  get adminApiToken(): string {
    return process.env.ADMIN_API_TOKEN ?? '';
  }
  get teamsAppId(): string {
    return process.env.TEAMS_APP_ID ?? '';
  }
  get teamsAppSecret(): string {
    return process.env.TEAMS_APP_SECRET ?? '';
  }
  get dingtalkAppKey(): string {
    return process.env.DINGTALK_APP_KEY ?? '';
  }
  get dingtalkAppSecret(): string {
    return process.env.DINGTALK_APP_SECRET ?? '';
  }
  get historyTokenBudget(): number {
    const raw = process.env.HISTORY_TOKEN_BUDGET;
    if (raw === undefined) return 6000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 6000;
  }

  get historyBudgetRatio(): number {
    const raw = process.env.HISTORY_BUDGET_RATIO;
    if (raw === undefined) return ConfigService.DEFAULT_HISTORY_BUDGET_RATIO;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      if (!this.historyBudgetRatioWarned) {
        this.historyBudgetRatioWarned = true;
        this.logger.warn(
          `HISTORY_BUDGET_RATIO=${JSON.stringify(raw)} invalid; ` +
          `falling back to ${ConfigService.DEFAULT_HISTORY_BUDGET_RATIO}. ` +
          `Expected 0 <= ratio <= 1.`,
        );
      }
      return ConfigService.DEFAULT_HISTORY_BUDGET_RATIO;
    }
    return n;
  }

  /**
   * v0.6: opt-in gate for sliding-window summarization.
   * When false (default), loadOrBuildHistory degrades to loadHistory-only.
   * Truthy values: 1, true, yes, on (case-insensitive). Anything else → false.
   */
  get enableSummarization(): boolean {
    const raw = process.env.ENABLE_SUMMARIZATION;
    if (raw === undefined) return false;
    return /^(1|true|yes|on)$/i.test(raw);
  }

  /**
   * v0.6: ordered list of summarizer provider-name strings.
   * Default: ['claude-haiku', 'openai-mini'] (cheap model classes).
   * Parsed from SUMMARIZER_PROVIDERS env (comma-separated, trimmed, empty filtered).
   * Provider-name strings map to registered LlmProvider instances in SummarizerModule.
   */
  get summarizerProviderChain(): string[] {
    const raw = process.env.SUMMARIZER_PROVIDERS;
    if (raw === undefined || raw.trim() === '') {
      return ['claude-haiku', 'openai-mini'];
    }
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * v0.6: context-window budget for the summarizer small-LLM input pre-trim guard.
   * Default: 100_000 tokens (cheap-model safe).
   * Invalid env (NaN, < 0) → 100_000.
   */
  get summarizerContextWindow(): number {
    const raw = process.env.SUMMARIZER_CONTEXT_WINDOW;
    if (raw === undefined) return 100_000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 100_000;
  }
}
