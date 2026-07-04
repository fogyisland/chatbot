import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  PlatformName,
  NormalizedMessage,
  NormalizedReply,
  ChatTarget,
  MediaType,
  MediaRef,
} from '@mpcb/shared';
import {
  PlatformAdapter,
  RawRequest,
  SendResult,
} from '../platform-adapter.interface';

/** WeChat corp access_token TTL is 7200s; refresh ~60s early. */
const ACCESS_TOKEN_TTL_MS = (7200 - 60) * 1000;
/** Errcodes that indicate the cached access_token has expired or is invalid. */
const TOKEN_EXPIRED_ERRCODES = new Set([40001, 40014, 42001]);

interface AccessTokenCache {
  token: string;
  /** epoch ms when the token must be re-fetched */
  expiresAt: number;
}

export interface WeChatAdapterOptions {
  accessToken?: string;
  apiBase?: string;
  corpId?: string;
  corpSecret?: string;
  /** Override for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to Date.now */
  now?: () => number;
}

@Injectable()
export class WeChatAdapter implements PlatformAdapter {
  readonly platform: PlatformName = 'wechat';
  private readonly logger = new Logger(WeChatAdapter.name);
  private cache: AccessTokenCache | null = null;
  /** Used to deduplicate concurrent token fetches. */
  private inflight: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly token: string,
    private readonly options: WeChatAdapterOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    // Allow tests to seed a token directly; production path populates via fetchAccessToken().
    if (options.accessToken) {
      this.cache = {
        token: options.accessToken,
        expiresAt: this.now() + ACCESS_TOKEN_TTL_MS,
      };
    }
  }

  verifySignature(req: RawRequest): boolean {
    const signature = String(req.query.msg_signature ?? '');
    const timestamp = String(req.query.timestamp ?? '');
    const nonce = String(req.query.nonce ?? '');
    const encrypt = String(req.query.encrypt ?? '');
    if (!signature || !timestamp || !nonce || !encrypt) return false;
    const sorted = [timestamp, nonce, encrypt].sort().join('');
    const computed = createHash('sha1').update(sorted + this.token).digest('hex');
    return computed === signature;
  }

  async parseInbound(req: RawRequest): Promise<NormalizedMessage> {
    const body = req.body as any;
    const inner = body?.xml ?? {};
    return {
      msgId: String(inner.MsgId ?? ''),
      platform: 'wechat',
      chatId: String(inner.FromUserName ?? ''),
      chatType: 'group',
      senderId: String(inner.FromUserName ?? ''),
      senderName: 'unknown',
      text: String(inner.Content ?? ''),
      mentions: [],
      attachments: [],
      rawTimestamp: Date.now(),
    };
  }

  /**
   * Fetch a fresh access_token from the WeChat API. Caches for ~7140s.
   * Concurrent callers share a single in-flight request.
   */
  async fetchAccessToken(): Promise<string> {
    const corpId = this.options.corpId ?? '';
    const corpSecret = this.options.corpSecret ?? '';
    if (!corpId || !corpSecret) {
      throw new Error('wechat corp credentials missing (WECHAT_CORP_ID / WECHAT_CORP_SECRET)');
    }
    // Serve from cache when still valid (the 7200s TTL minus the 60s safety margin).
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.token;
    if (this.inflight) return this.inflight;

    const apiBase = this.options.apiBase ?? 'https://qyapi.weixin.qq.com';
    const url = `${apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
    this.inflight = (async () => {
      try {
        const res = await this.fetchImpl(url, { method: 'GET' });
        const json: any = await res.json();
        if (json?.errcode && json.errcode !== 0) {
          throw new Error(`wechat gettoken errcode=${json.errcode} errmsg=${json.errmsg}`);
        }
        const token = String(json?.access_token ?? '');
        if (!token) throw new Error('wechat gettoken returned empty access_token');
        const expiresIn = Number(json?.expires_in ?? 7200);
        this.cache = { token, expiresAt: this.now() + expiresIn * 1000 };
        return token;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Test-only: inspect the cache directly. */
  getCachedAccessToken(): AccessTokenCache | null {
    return this.cache;
  }

  /** Returns a non-empty cached token or fetches a fresh one. */
  private async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.token;
    return this.fetchAccessToken();
  }

  async sendReply(reply: NormalizedReply, target: ChatTarget): Promise<SendResult> {
    if (!reply.text) return { ok: true };
    const apiBase = this.options.apiBase ?? 'https://qyapi.weixin.qq.com';

    const attempt = async (): Promise<{ errcode: number; errmsg?: string }> => {
      const accessToken = await this.getAccessToken();
      const url = `${apiBase}/cgi-bin/message/custom/send?access_token=${accessToken}`;
      const body: any = {
        touser: target.chatId,
        msgtype: 'text',
        text: { content: reply.text },
      };
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: any = await res.json();
      return { errcode: Number(json?.errcode ?? -1), errmsg: json?.errmsg };
    };

    try {
      let result = await attempt();
      // Refresh-on-expiry: if the cached token is stale, drop cache and retry once.
      if (TOKEN_EXPIRED_ERRCODES.has(result.errcode)) {
        this.logger.warn(`wechat access_token expired (errcode=${result.errcode}); refreshing`);
        this.cache = null;
        result = await attempt();
      }
      if (result.errcode === 0) return { ok: true };
      return { ok: false, error: `errcode=${result.errcode} errmsg=${result.errmsg ?? ''}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async uploadMedia(_buffer: Buffer, _type: MediaType): Promise<MediaRef> {
    return { platformMediaId: '' };
  }
}