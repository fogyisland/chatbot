import { WeChatAdapter } from '../src/platform/wechat/wechat.adapter';
import { createHash } from 'crypto';

function signParams(
  token: string,
  params: Record<string, string>,
): string {
  const sorted = [params.timestamp, params.nonce, params.encrypt]
    .sort()
    .join('');
  return createHash('sha1').update(sorted + token).digest('hex');
}

describe('WeChatAdapter', () => {
  const token = 'test_token';
  let adapter: WeChatAdapter;

  beforeEach(() => {
    adapter = new WeChatAdapter(token);
  });

  it('verifySignature: returns true when signature matches', () => {
    const params = { timestamp: '1700000000', nonce: 'abc', encrypt: 'msg' };
    const sig = signParams(token, params);
    expect(
      adapter.verifySignature({
        headers: {},
        query: {
          msg_signature: sig,
          timestamp: params.timestamp,
          nonce: params.nonce,
          encrypt: params.encrypt,
        },
        body: {},
      }),
    ).toBe(true);
  });

  it('verifySignature: returns false when signature mismatches', () => {
    expect(
      adapter.verifySignature({
        headers: {},
        query: {
          timestamp: '1',
          nonce: '2',
          encrypt: '3',
          msg_signature: 'bad',
        },
        body: {},
      }),
    ).toBe(false);
  });
});
