import { MediaRef } from './platform';

export interface RichTextBlock {
  type: 'text' | 'link' | 'bold' | 'code';
  content: string;
  href?: string;
}

export interface CardPayload {
  title: string;
  fields: Array<{ label: string; value: string }>;
  footer?: string;
}

export interface NormalizedReply {
  text?: string;
  richText?: RichTextBlock[];
  card?: CardPayload;
  images?: MediaRef[];
  files?: MediaRef[];
  replyToMsgId?: string;
}
