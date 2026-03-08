// Markdown → Telegram HTML formatting (powered by markdown-it IR pipeline)
// Re-exports the new formatter while maintaining backward compatibility.

import { markdownToTelegramHtml, markdownToTelegramChunks } from './format/telegram.js';
import { markdownToIR } from './format/ir.js';

export { markdownToTelegramHtml, markdownToTelegramChunks };
export type { TelegramFormattedChunk } from './format/telegram.js';

/** Convert markdown to Telegram-safe HTML (backward-compatible wrapper). */
export function markdownToHtml(md: string): string {
  return markdownToTelegramHtml(md);
}

/** Strip markdown to plain text (backward-compatible wrapper). */
export function markdownToText(md: string): string {
  const ir = markdownToIR(md ?? '', {
    linkify: false,
    enableSpoilers: false,
    headingStyle: 'none',
  });
  return ir.text;
}
