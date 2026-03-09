export interface PromptTimelineEntry {
  label: string;
  atMs: number;
  detail?: string;
}

export function formatPromptTimeline(entries: PromptTimelineEntry[]): string {
  return entries
    .map((entry) => `${entry.label}@${Math.round(entry.atMs)}ms${entry.detail ? `(${entry.detail})` : ''}`)
    .join(' -> ');
}
