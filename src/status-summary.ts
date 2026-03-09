import { TOOL_LABELS } from './constants.js';

type ToolArguments = Record<string, unknown> | undefined;

interface AssistantPlanToolRequestLike {
  name?: string;
  arguments?: ToolArguments;
}

export interface AssistantPlanSummary {
  intentText?: string;
  thinkingSummary?: string;
  activeToolStatus?: string;
}

export interface ToolStatusSummary {
  label: string;
  detail?: string;
  statusLine: string;
}

export interface SubagentStatusSummary {
  statusLine: string;
}

function getString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clip(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? normalized.slice(0, max) + '…' : normalized;
}

function toInlineCode(text: string, max = 80): string {
  const safe = clip(text.replace(/`/g, ''), max);
  return safe ? `\`${safe}\`` : '';
}

function summarizeReasoning(value: string, max = 220): string {
  const [firstParagraph] = value
    .split(/\n\s*\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return clip(firstParagraph ?? value, max);
}

function humanizeAgentName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function formatToolStatus(toolName: string, args?: ToolArguments): ToolStatusSummary {
  const description = getString(args?.description);
  const command = getString(args?.command);
  const url = getString(args?.url);
  const filePath = getString(args?.file_path) ?? getString(args?.path);
  const pattern = getString(args?.pattern) ?? getString(args?.query);
  const agentType = getString(args?.agent_type);
  const prompt = getString(args?.prompt);

  const label = TOOL_LABELS[toolName] ?? (toolName === 'task' ? '🤖 Agent' : '🔧 ' + toolName);

  let detail: string | undefined;
  switch (toolName) {
    case 'task':
      detail = description
        ?? (agentType ? `\`${clip(agentType, 48)}\` agent` : undefined)
        ?? (prompt ? clip(prompt, 96) : undefined);
      break;
    case 'bash':
    case 'run_bash':
      detail = description ?? (command ? toInlineCode(command, 96) : undefined);
      break;
    case 'web_fetch':
    case 'web_search':
      detail = description ?? (url ? toInlineCode(url, 96) : undefined) ?? (pattern ? toInlineCode(pattern, 72) : undefined);
      break;
    case 'view':
    case 'read_file':
    case 'edit_file':
    case 'create_file':
    case 'write_file':
    case 'delete_file':
    case 'list_dir':
      detail = description ?? (filePath ? toInlineCode(filePath, 88) : undefined);
      break;
    case 'grep_search':
    case 'search':
    case 'glob':
      detail = description ?? (pattern ? toInlineCode(pattern, 72) : undefined) ?? (filePath ? toInlineCode(filePath, 72) : undefined);
      break;
    default:
      detail = description
        ?? (command ? toInlineCode(command, 88) : undefined)
        ?? (filePath ? toInlineCode(filePath, 88) : undefined)
        ?? (url ? toInlineCode(url, 88) : undefined)
        ?? (pattern ? toInlineCode(pattern, 72) : undefined)
        ?? (agentType ? `\`${clip(agentType, 48)}\`` : undefined)
        ?? (prompt ? clip(prompt, 96) : undefined);
      break;
  }

  return {
    label,
    detail,
    statusLine: detail ? `${label} ${detail}` : label,
  };
}

export function extractAssistantPlan(input: {
  content?: string;
  reasoningText?: string;
  toolRequests?: AssistantPlanToolRequestLike[];
}): AssistantPlanSummary {
  const toolRequests = (input.toolRequests ?? []).filter((toolRequest): toolRequest is AssistantPlanToolRequestLike & { name: string } => typeof toolRequest?.name === 'string');
  const intentRequest = toolRequests.find((toolRequest) => toolRequest.name === 'report_intent');
  const actionableRequest = toolRequests.find((toolRequest) => toolRequest.name !== 'report_intent');
  const intentText = getString(intentRequest?.arguments?.intent) ?? getString(intentRequest?.arguments?.message);
  const reasoningSummary = getString(input.reasoningText)
    ?? (toolRequests.length ? getString(input.content) : undefined);

  return {
    intentText,
    thinkingSummary: reasoningSummary ? summarizeReasoning(reasoningSummary) : undefined,
    activeToolStatus: actionableRequest ? formatToolStatus(actionableRequest.name, actionableRequest.arguments).statusLine : undefined,
  };
}

export function formatSubagentStatus(input: {
  agentName?: string;
  agentDisplayName?: string;
  agentDescription?: string;
}): SubagentStatusSummary {
  const displayName = getString(input.agentDisplayName)
    ?? (getString(input.agentName) ? humanizeAgentName(getString(input.agentName)!) : undefined)
    ?? 'Agent';
  return {
    statusLine: `🤖 Starting ${clip(displayName, 72)}`,
  };
}

export function summarizeToolCompletionDetail(detail: string | undefined, max = 120): string | undefined {
  const normalized = getString(detail);
  if (!normalized) return undefined;
  if (/^Intent logged$/i.test(normalized)) return undefined;
  if (/^Content type .*?cannot be simplified to markdown\./i.test(normalized) || /^Contents of https?:\/\//i.test(normalized)) {
    return 'Fetched content';
  }
  return clip(normalized, max);
}