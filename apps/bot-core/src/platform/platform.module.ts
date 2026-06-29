import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { WeChatAdapter } from './wechat/wechat.adapter';
import { WeChatController } from './wechat/wechat.controller';
import { TeamsAdapter } from './teams/teams.adapter';
import { TeamsController } from './teams/teams.controller';

@Module({
  controllers: [WeChatController, TeamsController],
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
  ],
  exports: [WeChatAdapter, TeamsAdapter],
})
export class PlatformModule {}
