import { Module } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import { WeChatAdapter } from './wechat/wechat.adapter';
import { WeChatController } from './wechat/wechat.controller';

@Module({
  controllers: [WeChatController],
  providers: [
    {
      provide: WeChatAdapter,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        new WeChatAdapter(cfg.wechatToken),
    },
  ],
  exports: [WeChatAdapter],
})
export class PlatformModule {}