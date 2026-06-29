export type PlatformName = 'wechat' | 'teams' | 'dingtalk';
export type ChatType = 'group' | 'direct';
export type MediaType = 'image' | 'file' | 'audio' | 'video';

export interface MediaRef {
  platformMediaId: string;
  url?: string;
}

export interface Attachment {
  type: MediaType;
  url: string;
  filename?: string;
  sizeBytes?: number;
}

export interface ChatTarget {
  chatId: string;
  chatType: ChatType;
}
