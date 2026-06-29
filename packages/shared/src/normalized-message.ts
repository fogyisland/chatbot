import { Attachment, ChatType, PlatformName } from './platform';

export interface NormalizedMessage {
  msgId: string;
  platform: PlatformName;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName: string;
  text: string;
  mentions: string[];
  attachments: Attachment[];
  rawTimestamp: number;
}
