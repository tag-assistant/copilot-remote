/**
 * Simple text chunking utility.
 * Splits text at paragraph/word boundaries within a character limit.
 */

export function chunkText(text: string, limit: number): string[] {
  if (!text) return [];
  if (limit <= 0 || text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // Find best break point: prefer last newline, then last whitespace
    let breakIdx = -1;
    let lastWhitespace = -1;

    for (let i = window.length - 1; i > 0; i--) {
      if (window[i] === '\n' && breakIdx < 0) {
        breakIdx = i;
        break;
      }
      if (lastWhitespace < 0 && /\s/.test(window[i]!)) {
        lastWhitespace = i;
      }
    }

    if (breakIdx <= 0) breakIdx = lastWhitespace > 0 ? lastWhitespace : limit;

    const chunk = remaining.slice(0, breakIdx).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);

    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]!);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}
