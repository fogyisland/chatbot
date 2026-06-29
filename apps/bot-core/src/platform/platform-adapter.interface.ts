import {
  PlatformName,
  NormalizedMessage,
  NormalizedReply,
  ChatTarget,
  MediaType,
  MediaRef,
} from '@mpcb/shared';

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  query: Record<string, string | string[] | undefined>;
}

export interface SendResult {
  ok: boolean;
  platformMessageId?: string;
  error?: string;
}

export interface PlatformAdapter {
  readonly platform: PlatformName;
  parseInbound(req: RawRequest): Promise<NormalizedMessage>;
  verifySignature(req: RawRequest): boolean;
  sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult>;
  uploadMedia(buffer: Buffer, type: MediaType): Promise<MediaRef>;
}

export const PLATFORM_ADAPTER = Symbol('PLATFORM_ADAPTER');