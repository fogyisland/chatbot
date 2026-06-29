import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { WeChatAdapter } from './wechat/wechat.adapter';
import { WeChatController } from './wechat/wechat.controller';
import { TeamsAdapter } from './teams/teams.adapter';
import { TeamsController } from './teams/teams.controller';
import { DingTalkAdapter } from './dingtalk/dingtalk.adapter';
import { DingTalkController } from './dingtalk/dingtalk.controller';
import { PlatformAdapter, PLATFORM_ADAPTER } from './platform-adapter.interface';
import { PlatformName } from '@mpcb/shared';

@Module({
  controllers: [WeChatController, TeamsController, DingTalkController],
  providers: [
    {
      provide: WeChatAdapter,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        new WeChatAdapter(cfg.wechatToken, { apiBase: cfg.wechatApiBase }),
    },
    {
      provide: TeamsAdapter,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        new TeamsAdapter({
          appId: cfg.teamsAppId,
          appSecret: cfg.teamsAppSecret,
        }),
    },
    {
      provide: DingTalkAdapter,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        new DingTalkAdapter({
          appKey: cfg.dingtalkAppKey,
          appSecret: cfg.dingtalkAppSecret,
        }),
    },
    {
      // Multi-binding: every registered PlatformAdapter is exposed as an
      // array under the PLATFORM_ADAPTER token. Consumers build a
      // Map<PlatformName, PlatformAdapter> from this list at construction.
      provide: PLATFORM_ADAPTER,
      inject: [WeChatAdapter, TeamsAdapter, DingTalkAdapter],
      useFactory: (
        wechat: WeChatAdapter,
        teams: TeamsAdapter,
        dingtalk: DingTalkAdapter,
      ): PlatformAdapter[] => [wechat, teams, dingtalk],
    },
  ],
  exports: [WeChatAdapter, TeamsAdapter, DingTalkAdapter, PLATFORM_ADAPTER],
})
export class PlatformModule {}

/**
 * Build a Map<PlatformName, PlatformAdapter> from the multi-binding array.
 * Convenience helper for DI sites that want a lookup map rather than an array.
 */
export function buildAdapterMap(adapters: PlatformAdapter[]): Map<PlatformName, PlatformAdapter> {
  const m = new Map<PlatformName, PlatformAdapter>();
  for (const a of adapters) m.set(a.platform, a);
  return m;
}