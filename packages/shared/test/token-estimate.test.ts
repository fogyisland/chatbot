import { estimateTokens } from '../src/token-estimate';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts pure CJK as 1 token per character', () => {
    const text = '你好世界'.repeat(25); // 100 CJK chars
    expect(estimateTokens(text)).toBe(100);
  });

  it('counts pure ASCII as chars/4', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('counts ASCII with ceil rounding', () => {
    const text = 'abc'; // 3 chars → ceil(3/4) = 1
    expect(estimateTokens(text)).toBe(1);
  });

  it('counts mixed CJK + ASCII as sum of both heuristics', () => {
    const text = '你好' + 'hello'; // 2 CJK + 5 ASCII → 2 + ceil(5/4) = 2 + 2 = 4
    expect(estimateTokens(text)).toBe(4);
  });

  it('counts Hiragana as CJK', () => {
    const text = 'こんにちは'; // 5 Hiragana chars
    expect(estimateTokens(text)).toBe(5);
  });

  it('counts Katakana as CJK', () => {
    const text = 'カタカナ'; // 4 Katakana chars
    expect(estimateTokens(text)).toBe(4);
  });

  it('counts Hangul as CJK', () => {
    const text = '안녕하세요'; // 5 Hangul chars
    expect(estimateTokens(text)).toBe(5);
  });
});
