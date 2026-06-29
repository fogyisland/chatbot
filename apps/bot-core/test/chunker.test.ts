import { chunkText } from '../src/handlers/kb/chunker';

describe('chunkText', () => {
  it('returns a single chunk when text fits', () => {
    const chunks = chunkText('hello world', 512, 64);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe('hello world');
  });

  it('splits long text into overlapping chunks', () => {
    const long = 'a'.repeat(2000);
    const chunks = chunkText(long, 512, 64);
    expect(chunks.length).toBeGreaterThan(3);
    // Each chunk ≤ 512 chars
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(512);
  });

  it('preserves sentence boundaries when possible', () => {
    const text = '第一句。第二句比较长很长。第三句。';
    const chunks = chunkText(text, 8, 2);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(8);
  });
});
