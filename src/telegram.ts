// Copilot Remote — Telegram Bridge
// Raw Telegram Bot API via fetch(). No grammy/telegraf.
import { markdownToHtml, markdownToText } from './format.js';
import { toTelegramReaction } from './emoji.js';
import { log } from './log.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_INTERVAL = 1000;
const MAX_MESSAGE_LENGTH = 4096;
const DRAFT_ID_MAX = 2_147_483_647;
const OFFSET_FILE = join(process.env.HOME ?? '/tmp', '.copilot-remote', 'poll-offset');
let nextDraftId = 0;

export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
}

export class TelegramBridge {
  private baseUrl: string;
  private offset = 0;
  private polling = false;
  private onMessage:
    | ((
        text: string,
        chatId: string,
        messageId: number,
        replyText?: string,
        replyToMsgId?: number,
        threadId?: number,
      ) => void)
    | null = null;
  private onCallback: ((callbackId: string, data: string, chatId: string, messageId: number) => void) | null = null;
  private onReaction: ((emoji: string, chatId: string, messageId: number) => void) | null = null;
  private onFile:
    | ((
        fileId: string,
        fileName: string,
        caption: string,
        chatId: string,
        messageId: number,
        threadId?: number,
      ) => void)
    | null = null;
  private onInlineQuery: ((queryId: string, query: string) => void) | null = null;
  private pairedUser: string | null = null;
  public topicNames = new Map<string, string>(); // "chatId:threadId" → topic name

  constructor(private config: TelegramConfig) {
    this.baseUrl = TELEGRAM_API + config.botToken;
    if (config.allowedUsers.length > 0) {
      this.pairedUser = config.allowedUsers[0];
    }
    // Restore poll offset from disk
    try {
      this.offset = parseInt(readFileSync(OFFSET_FILE, 'utf-8').trim(), 10) || 0;
    } catch {
      /* ignore */
    }
  }

  setMessageHandler(handler: typeof this.onMessage): void {
    this.onMessage = handler;
  }
  setCallbackHandler(handler: typeof this.onCallback): void {
    this.onCallback = handler;
  }
  setReactionHandler(handler: typeof this.onReaction): void {
    this.onReaction = handler;
  }
  setFileHandler(handler: typeof this.onFile): void {
    this.onFile = handler;
  }
  setInlineQueryHandler(handler: typeof this.onInlineQuery): void {
    this.onInlineQuery = handler;
  }

  async startPolling(): Promise<void> {
    this.polling = true;
    if (this.pairedUser) {
      console.log('[Telegram] Polling started — paired with user ' + this.pairedUser);
    } else {
      console.log('[Telegram] Polling started — waiting for first user to pair');
    }

    while (this.polling) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.saveOffset();

          if (update.message?.text) {
            const msg = update.message;
            const userId = String(msg.from?.id);

            if (!this.pairedUser) {
              this.pairedUser = userId;
              console.log('[Telegram] Auto-paired with user ' + userId + ' (' + (msg.from?.first_name ?? '') + ')');
            }
            if (userId !== this.pairedUser) {
              if (msg.chat.type === 'private') {
                await this.sendMessage(msg.chat.id, '⛔ This instance is paired with another user.');
              }
              continue;
            }
            this.onMessage?.(
              msg.text,
              String(msg.chat.id),
              msg.message_id,
              msg.reply_to_message?.text,
              msg.reply_to_message?.message_id,
              msg.message_thread_id,
            );
            // Track topic name from forum_topic_created service message
            if (msg.message_thread_id) {
              const topicKey = msg.chat.id + ':' + msg.message_thread_id;
              const topicCreated = msg.reply_to_message?.forum_topic_created;
              if (topicCreated?.name && !this.topicNames.has(topicKey)) {
                this.topicNames.set(topicKey, topicCreated.name);
              }
            }
          } else if (
            update.message &&
            (update.message.photo || update.message.document || update.message.voice || update.message.audio)
          ) {
            const msg = update.message;
            const userId = String(msg.from?.id);
            if (userId !== this.pairedUser) continue;

            // Get file_id: largest photo, document, voice, or audio
            const fileId =
              msg.voice?.file_id ??
              msg.audio?.file_id ??
              msg.document?.file_id ??
              msg.photo?.[msg.photo.length - 1]?.file_id;
            const fileName = msg.document?.file_name ?? msg.audio?.file_name ?? (msg.voice ? 'voice.oga' : 'photo.jpg');
            const caption = msg.caption ?? '';
            if (fileId) {
              this.onFile?.(fileId, fileName, caption, String(msg.chat.id), msg.message_id, msg.message_thread_id);
            }
          }

          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = String(cb.message?.chat?.id ?? '');
            const userId = String(cb.from?.id);
            if (userId === this.pairedUser && chatId) {
              // Let handler answer with custom text/alert; fall back to empty answer
              try {
                await this.onCallback?.(cb.id, cb.data ?? '', chatId, cb.message?.message_id ?? 0);
              } catch {
                /* ignore handler errors */
              }
            }
            // Always answer to dismiss the loading indicator
            await this.api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {
              /* ignore */
            });
          }

          if (update.inline_query) {
            const iq = update.inline_query;
            const userId = String(iq.from?.id);
            if (userId === this.pairedUser && iq.query?.trim()) {
              this.onInlineQuery?.(iq.id, iq.query.trim());
            }
          }

          if (update.message_reaction) {
            const r = update.message_reaction;
            const chatId = String(r.chat?.id ?? '');
            const userId = String(r.user?.id ?? r.actor_chat?.id ?? '');
            const emojis = (r.new_reaction ?? []).filter((e: any) => e.type === 'emoji').map((e: any) => e.emoji);
            if (userId === this.pairedUser && chatId) {
              for (const emoji of emojis) this.onReaction?.(emoji, chatId, r.message_id);
            }
          }
        }
      } catch (err) {
        console.error('[Telegram] Poll error:', err);
      }
      await sleep(POLL_INTERVAL);
    }
  }

  stopPolling(): void {
    this.polling = false;
  }

  // ── Messaging (HTML with plain text fallback) ──

  async sendMessage(
    chatId: string | number,
    text: string,
    opts?: { replyTo?: number; disableLinkPreview?: boolean; threadId?: number },
  ): Promise<number | null> {
    const chunks = this.splitMessage(text);
    let lastMsgId: number | null = null;
    const extra: Record<string, any> = {};
    if (opts?.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (opts?.disableLinkPreview) extra.link_preview_options = { is_disabled: true };
    if (opts?.threadId) extra.message_thread_id = opts.threadId;

    for (const chunk of chunks) {
      const res = await this.sendText('sendMessage', { chat_id: chatId, ...extra }, chunk);
      lastMsgId = res?.result?.message_id ?? null;
    }
    return lastMsgId;
  }

  async editMessage(chatId: string | number, messageId: number, text: string): Promise<void> {
    const truncated = text.slice(0, MAX_MESSAGE_LENGTH);
    await this.sendText('editMessageText', { chat_id: chatId, message_id: messageId }, truncated);
  }

  async sendMessageWithButtons(
    chatId: string | number,
    text: string,
    buttons: { text: string; data: string }[][],
  ): Promise<number | null> {
    const markup = {
      inline_keyboard: buttons.map((row) =>
        row.map((btn: any) => ({
          text: btn.text,
          callback_data: btn.data,
          ...(btn.style ? { style: btn.style } : {}),
        })),
      ),
    };
    const res = await this.sendText('sendMessage', { chat_id: chatId, reply_markup: markup }, text);
    return res?.result?.message_id ?? null;
  }

  async editMessageButtons(
    chatId: string | number,
    messageId: number,
    text: string,
    buttons?: { text: string; data: string }[][],
  ): Promise<void> {
    const markup = buttons
      ? {
          inline_keyboard: buttons.map((row) =>
            row.map((btn: any) => ({
              text: btn.text,
              callback_data: btn.data,
              ...(btn.style ? { style: btn.style } : {}),
            })),
          ),
        }
      : { inline_keyboard: [] };
    await this.sendText('editMessageText', { chat_id: chatId, message_id: messageId, reply_markup: markup }, text);
  }

  // ── Draft streaming (native Telegram streaming) ──

  private draftSupported: boolean | null = null; // null = unknown, try first

  async sendDraft(chatId: string | number, draftId: number, text: string, threadId?: number): Promise<boolean> {
    if (this.draftSupported === false) return false;
    try {
      const params: Record<string, any> = {
        chat_id: chatId,
        draft_id: draftId,
        text: markdownToHtml(text),
        parse_mode: 'HTML',
      };
      if (threadId) params.message_thread_id = threadId;
      await this.api('sendMessageDraft', params);
      this.draftSupported = true;
      return true;
    } catch (e) {
      const msg = String(e);
      if (/unknown method|not (found|available|supported)|can't be used|can be used only/i.test(msg)) {
        this.draftSupported = false;
      }
      return false;
    }
  }

  allocateDraftId(): number {
    nextDraftId = nextDraftId >= DRAFT_ID_MAX ? 1 : nextDraftId + 1;
    return nextDraftId;
  }

  // ── Presence ──

  async sendTyping(chatId: string | number): Promise<void> {
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {
      /* ignore */
    });
  }

  async setReaction(chatId: string | number, messageId: number, emoji: string): Promise<void> {
    const safe = toTelegramReaction(emoji);
    await this.api('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: safe }],
    }).catch(() => {
      /* ignore */
    });
  }

  async removeReaction(chatId: string | number, messageId: number): Promise<void> {
    await this.api('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [] }).catch(() => {
      /* ignore */
    });
  }

  // ── File operations ──

  async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const res = await this.api('getFile', { file_id: fileId });
      const filePath = res.result?.file_path;
      if (!filePath) return null;
      return 'https://api.telegram.org/file/bot' + this.config.botToken + '/' + filePath;
    } catch {
      return null;
    }
  }

  async sendDocument(chatId: string | number, url: string, filename: string, caption?: string): Promise<number | null> {
    const res = await this.api('sendDocument', {
      chat_id: chatId,
      document: url,
      caption: caption ?? filename,
    }).catch(() => null);
    return res?.result?.message_id ?? null;
  }

  async sendPhoto(chatId: string | number, url: string, caption?: string): Promise<number | null> {
    const res = await this.api('sendPhoto', {
      chat_id: chatId,
      photo: url,
      ...(caption ? { caption } : {}),
    }).catch(() => null);
    return res?.result?.message_id ?? null;
  }

  // ── Forum topics ──

  async createForumTopic(chatId: string | number, name: string): Promise<number | null> {
    try {
      const res = await this.api('createForumTopic', { chat_id: chatId, name });
      return res.result?.message_thread_id ?? null;
    } catch (e: any) {
      log.error('createForumTopic failed:', e?.message ?? e);
      return null;
    }
  }

  async deleteForumTopic(chatId: string | number, threadId: number): Promise<void> {
    await this.api('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId }).catch(() => {
      /* ignore */
    });
  }

  async pinMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.api('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true }).catch(
      () => {
        /* ignore */
      },
    );
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.api('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {
      /* ignore */
    });
  }

  async sendTypingToThread(chatId: string | number, threadId: number): Promise<void> {
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing', message_thread_id: threadId }).catch(() => {
      /* ignore */
    });
  }

  // ── Bot commands & profile ──

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.api('setMyCommands', { commands }).catch(() => {
      /* ignore */
    });
  }

  async setMyProfilePhoto(photoUrl: string): Promise<void> {
    // Download photo then upload as multipart
    try {
      const res = await fetch(photoUrl);
      const buffer = Buffer.from(await res.arrayBuffer());
      const boundary = '----CopilotRemote' + Date.now();
      const body =
        '--' +
        boundary +
        '\r\n' +
        'Content-Disposition: form-data; name="photo"; filename="avatar.png"\r\n' +
        'Content-Type: image/png\r\n\r\n';
      const end = '\r\n--' + boundary + '--\r\n';
      const payload = Buffer.concat([Buffer.from(body), buffer, Buffer.from(end)]);
      await fetch(this.baseUrl + '/setMyProfilePhoto', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: payload,
      });
    } catch {
      /* ignore */
    }
  }

  async answerCallback(callbackId: string, text?: string, showAlert = false): Promise<void> {
    await this.api('answerCallbackQuery', {
      callback_query_id: callbackId,
      ...(text ? { text, show_alert: showAlert } : {}),
    }).catch(() => {
      /* ignore */
    });
  }

  async editReplyMarkup(chatId: string | number, messageId: number, buttons: any[][]): Promise<void> {
    await this.api('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons },
    }).catch(() => {
      /* ignore */
    });
  }

  async sendReplyKeyboard(
    chatId: string | number,
    text: string,
    keyboard: string[][],
    opts?: { oneTime?: boolean; resize?: boolean; placeholder?: string },
  ): Promise<number | null> {
    const res = await this.sendText(
      'sendMessage',
      {
        chat_id: chatId,
        reply_markup: {
          keyboard: keyboard.map((row) => row.map((t) => ({ text: t }))),
          one_time_keyboard: opts?.oneTime ?? false,
          resize_keyboard: opts?.resize ?? true,
          input_field_placeholder: opts?.placeholder,
        },
      },
      text,
    );
    return res?.result?.message_id ?? null;
  }

  async removeReplyKeyboard(chatId: string | number, text: string): Promise<number | null> {
    const res = await this.sendText(
      'sendMessage',
      {
        chat_id: chatId,
        reply_markup: { remove_keyboard: true },
      },
      text,
    );
    return res?.result?.message_id ?? null;
  }

  async answerInlineQuery(queryId: string, results: any[]): Promise<void> {
    await this.api('answerInlineQuery', {
      inline_query_id: queryId,
      results,
      cache_time: 0,
    }).catch(() => {
      /* ignore */
    });
  }

  // ── Internal ──

  private async sendText(method: string, params: Record<string, any>, text: string): Promise<any> {
    // Try HTML first, fall back to plain text
    return this.api(method, { ...params, text: markdownToHtml(text), parse_mode: 'HTML' }).catch(() =>
      this.api(method, { ...params, text: markdownToText(text) }).catch(() => null),
    );
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.3) splitAt = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  private async getUpdates(): Promise<any[]> {
    const res = await this.api('getUpdates', {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ['message', 'callback_query', 'message_reaction', 'inline_query'],
    });
    return res.result ?? [];
  }

  private saveOffset(): void {
    try {
      mkdirSync(dirname(OFFSET_FILE), { recursive: true });
      writeFileSync(OFFSET_FILE, String(this.offset));
    } catch {
      /* ignore */
    }
  }

  private async api(method: string, body: any, retries = 3): Promise<any> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.baseUrl + '/' + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as any;
        if (!json.ok) {
          // Rate limit — retry with backoff
          if (json.error_code === 429) {
            const wait = (json.parameters?.retry_after ?? 5) * 1000;
            await sleep(wait);
            continue;
          }
          throw new Error('Telegram API error: ' + JSON.stringify(json));
        }
        return json;
      } catch (err) {
        if (attempt === retries) throw err;
        // Network error — exponential backoff
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
