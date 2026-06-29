import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { WeChatAdapter } from './wechat/wechat.adapter';
import { WeChatController } from './wechat/wechat.controller';
import { TeamsAdapter } from './teams/teams.adapter';
import { TeamsController } from './teams/teams.controller';
import { DingTalkAdapter } from './dingtalk/dingtalk.adapter';
import { DingTalkController } from './dingtalk/dingtalk.controller';

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
  ],
  exports: [WeChatAdapter, TeamsAdapter, DingTalkAdapter],
})
export class PlatformModule {}
