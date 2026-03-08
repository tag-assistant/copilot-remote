// Copilot Remote — Telegram Bridge
// Raw Telegram Bot API via fetch(). No grammy/telegraf.
import { markdownToHtml, markdownToText } from './format.js';
import { toTelegramReaction } from './emoji.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_INTERVAL = 1000;
const MAX_MESSAGE_LENGTH = 4096;
const DRAFT_ID_MAX = 2_147_483_647;
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
    | ((text: string, chatId: string, messageId: number, replyText?: string, replyToMsgId?: number) => void)
    | null = null;
  private onCallback: ((callbackId: string, data: string, chatId: string, messageId: number) => void) | null = null;
  private onReaction: ((emoji: string, chatId: string, messageId: number) => void) | null = null;
  private pairedUser: string | null = null;

  constructor(private config: TelegramConfig) {
    this.baseUrl = TELEGRAM_API + config.botToken;
    if (config.allowedUsers.length > 0) {
      this.pairedUser = config.allowedUsers[0];
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

          if (update.message?.text) {
            const msg = update.message;
            const userId = String(msg.from?.id);

            if (!this.pairedUser) {
              this.pairedUser = userId;
              console.log('[Telegram] Auto-paired with user ' + userId + ' (' + (msg.from?.first_name ?? '') + ')');
            }
            if (userId !== this.pairedUser) {
              await this.sendMessage(msg.chat.id, '⛔ This instance is paired with another user.');
              continue;
            }
            this.onMessage?.(
              msg.text,
              String(msg.chat.id),
              msg.message_id,
              msg.reply_to_message?.text,
              msg.reply_to_message?.message_id,
            );
          }

          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = String(cb.message?.chat?.id ?? '');
            const userId = String(cb.from?.id);
            if (userId === this.pairedUser && chatId) {
              this.onCallback?.(cb.id, cb.data ?? '', chatId, cb.message?.message_id ?? 0);
            }
            await this.api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {
              /* ignore */
            });
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
    opts?: { replyTo?: number; disableLinkPreview?: boolean },
  ): Promise<number | null> {
    const chunks = this.splitMessage(text);
    let lastMsgId: number | null = null;
    const extra: Record<string, any> = {};
    if (opts?.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (opts?.disableLinkPreview) extra.link_preview_options = { is_disabled: true };

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
      inline_keyboard: buttons.map((row) => row.map((btn) => ({ text: btn.text, callback_data: btn.data }))),
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
      ? { inline_keyboard: buttons.map((row) => row.map((btn) => ({ text: btn.text, callback_data: btn.data }))) }
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

  // ── Bot commands ──

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.api('setMyCommands', { commands }).catch(() => {
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
      allowed_updates: ['message', 'callback_query', 'message_reaction'],
    });
    return res.result ?? [];
  }

  private async api(method: string, body: any): Promise<any> {
    const res = await fetch(this.baseUrl + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (!json.ok) throw new Error('Telegram API error: ' + JSON.stringify(json));
    return json;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
