export function chunkText(text: string, maxChunkSize = 512, overlap = 64): string[] {
  if (!text) return [];
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChunkSize, text.length);

    // Try to break at sentence boundary
    if (end < text.length) {
      const slice = text.slice(start, end);
      const lastBreak = Math.max(
        slice.lastIndexOf('。'),
        slice.lastIndexOf('.'),
        slice.lastIndexOf('!'),
        slice.lastIndexOf('?'),
        slice.lastIndexOf('\n'),
      );
      if (lastBreak > maxChunkSize / 2) {
        end = start + lastBreak + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
