export function formatPromptLogText(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (maxChars <= 0) return '';
  if (normalized.length <= maxChars) return normalized;
  const omitted = normalized.length - maxChars;
  return `${normalized.slice(0, maxChars)}…[+${omitted} chars]`;
}
