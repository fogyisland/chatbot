import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
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
}