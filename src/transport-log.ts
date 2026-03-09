import type { Update } from 'grammy/types';

function clip(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '<empty>';
  return normalized.length > max ? normalized.slice(0, max) + '…' : normalized;
}

function getTextLike(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function summarizeTextForLog(value: string | undefined, max = 160): string {
  return clip(value ?? '', max);
}

export function formatLogFields(fields: Record<string, unknown>): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (typeof value === 'string') return `${key}=${JSON.stringify(value)}`;
      return `${key}=${String(value)}`;
    });
}

export function summarizeTelegramUpdate(update: Update): Record<string, unknown> {
  if (update.message) {
    const messageText = getTextLike(update.message.text);
    return {
      updateId: update.update_id,
      kind: 'message',
      chat: update.message.chat.id,
      from: update.message.from?.id,
      msg: update.message.message_id,
      thread: update.message.message_thread_id,
      text: messageText ? clip(messageText) : undefined,
      hasPhoto: !!update.message.photo?.length,
      hasDocument: !!update.message.document,
      hasVoice: !!update.message.voice,
      hasAudio: !!update.message.audio,
      hasVideo: !!update.message.video,
      hasLocation: !!update.message.location,
      hasSticker: !!update.message.sticker,
    };
  }

  if (update.callback_query) {
    return {
      updateId: update.update_id,
      kind: 'callback_query',
      chat: update.callback_query.message?.chat.id,
      from: update.callback_query.from.id,
      msg: update.callback_query.message?.message_id,
      thread: (update.callback_query.message as { message_thread_id?: number } | undefined)?.message_thread_id,
      callbackId: update.callback_query.id,
      data: clip(update.callback_query.data ?? ''),
    };
  }

  if (update.inline_query) {
    return {
      updateId: update.update_id,
      kind: 'inline_query',
      from: update.inline_query.from.id,
      inlineQueryId: update.inline_query.id,
      query: clip(update.inline_query.query ?? ''),
    };
  }

  if (update.message_reaction) {
    return {
      updateId: update.update_id,
      kind: 'message_reaction',
      chat: update.message_reaction.chat.id,
      msg: update.message_reaction.message_id,
      reactions: update.message_reaction.new_reaction?.length ?? 0,
    };
  }

  return {
    updateId: update.update_id,
    kind: Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown',
  };
}

export function summarizeTelegramApiCall(method: string, payload: Record<string, unknown>): Record<string, unknown> {
  const replyParams = payload.reply_parameters as { message_id?: number } | undefined;
  return {
    method,
    chat: payload.chat_id,
    msg: payload.message_id,
    thread: payload.message_thread_id,
    replyTo: replyParams?.message_id,
    draftId: payload.draft_id,
    action: payload.action,
    callbackId: payload.callback_query_id,
    inlineQueryId: payload.inline_query_id,
    parseMode: payload.parse_mode,
    text: getTextLike(payload.text) ? clip(String(payload.text)) : undefined,
    caption: getTextLike(payload.caption) ? clip(String(payload.caption)) : undefined,
  };
}

export function summarizeTelegramApiResult(method: string, result: unknown): Record<string, unknown> {
  const record = (result as Record<string, unknown>) ?? {};
  return {
    method,
    ok: true,
    msg: record.message_id,
    chat: (record.chat as { id?: number } | undefined)?.id,
    thread: record.message_thread_id,
    inlineResultCount: Array.isArray(record) ? record.length : undefined,
  };
}

export function summarizeSdkEvent(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const text = getTextLike(data.deltaContent) ?? getTextLike(data.content) ?? getTextLike(data.text) ?? '';
  return {
    type,
    turnId: data.turnId,
    interactionId: data.interactionId,
    toolCallId: data.toolCallId,
    toolName: data.name ?? data.toolName,
    exitCode: data.exitCode,
    success: data.success,
    chars: text ? text.length : undefined,
    text: text ? clip(text) : undefined,
    currentTokens: data.currentTokens,
    tokenLimit: data.tokenLimit,
    messagesLength: data.messagesLength,
    title: getTextLike(data.title) ?? getTextLike(data.summary),
    message: getTextLike(data.message) ? clip(String(data.message)) : undefined,
  };
}