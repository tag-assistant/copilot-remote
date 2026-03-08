// ============================================================
// Copilot Remote — Telegram Bridge
// ============================================================
// Connects a Copilot CLI session to Telegram using the Bot API.
// Lightweight — uses fetch() directly, no grammy/telegraf dep.
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_INTERVAL = 1000;
const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[]; // empty = auto-pair first user
}

export class TelegramBridge {
  private baseUrl: string;
  private offset = 0;
  private polling = false;
  private onMessage: ((text: string, chatId: string, messageId: number) => void) | null = null;
  private onCallback: ((callbackId: string, data: string, chatId: string, messageId: number) => void) | null = null;
  private pairedUser: string | null = null;

  constructor(private config: TelegramConfig) {
    this.baseUrl = TELEGRAM_API + config.botToken;
    if (config.allowedUsers.length > 0) {
      this.pairedUser = config.allowedUsers[0];
    }
  }

  setMessageHandler(handler: (text: string, chatId: string, messageId: number) => void): void {
    this.onMessage = handler;
  }

  setCallbackHandler(handler: (callbackId: string, data: string, chatId: string, messageId: number) => void): void {
    this.onCallback = handler;
  }

  async startPolling(): Promise<void> {
    this.polling = true;

    if (this.pairedUser) {
      console.log('[Telegram] Polling started — paired with user ' + this.pairedUser);
      // Notify paired user we're online
      await this.sendMessage(this.pairedUser, '⚡ Copilot Remote is online.').catch(() => {});
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

            // Auto-pair first user
            if (!this.pairedUser) {
              this.pairedUser = userId;
              console.log('[Telegram] Auto-paired with user ' + userId + ' (' + (msg.from?.first_name ?? '') + ')');
            }

            if (userId !== this.pairedUser) {
              await this.sendMessage(msg.chat.id, '⛔ This instance is paired with another user.');
              continue;
            }

            this.onMessage?.(msg.text, String(msg.chat.id), msg.message_id);
          }

          // Handle callback queries (inline button presses)
          if (update.callback_query) {
            const cb = update.callback_query;
            const cbChatId = String(cb.message?.chat?.id ?? '');
            const cbMsgId = cb.message?.message_id ?? 0;
            const userId = String(cb.from?.id);

            if (userId === this.pairedUser && cbChatId) {
              this.onCallback?.(cb.id, cb.data ?? '', cbChatId, cbMsgId);
            }
            // Always answer to dismiss loading state
            await this.api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
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

  async sendMessage(chatId: string | number, text: string, replyTo?: number): Promise<number | null> {
    // Split long messages
    const chunks = this.splitMessage(text);
    let lastMsgId: number | null = null;

    for (const chunk of chunks) {
      const res = await this.api('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
        ...(replyTo ? { reply_to_message_id: replyTo } : {}),
      }).catch(async () => {
        // Markdown parse failed — retry without parse_mode
        return await this.api('sendMessage', {
          chat_id: chatId,
          text: chunk,
          ...(replyTo ? { reply_to_message_id: replyTo } : {}),
        });
      });
      lastMsgId = res?.result?.message_id ?? null;
    }

    return lastMsgId;
  }

  async editMessage(chatId: string | number, messageId: number, text: string): Promise<void> {
    const truncated = text.slice(0, MAX_MESSAGE_LENGTH);
    await this.api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: truncated,
      parse_mode: 'Markdown',
    }).catch(async () => {
      // Markdown failed or message not modified
      await this.api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: truncated,
      }).catch(() => {}); // swallow "message not modified" errors
    });
  }

  async sendTyping(chatId: string | number): Promise<void> {
    await this.api('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    }).catch(() => {});
  }

  async setReaction(chatId: string | number, messageId: number, emoji: string): Promise<void> {
    await this.api('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    }).catch(() => {});
  }

  async removeReaction(chatId: string | number, messageId: number): Promise<void> {
    await this.api('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [],
    }).catch(() => {});
  }

  async sendMessageWithButtons(chatId: string | number, text: string, buttons: { text: string; data: string }[][]): Promise<number | null> {
    const res = await this.api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: buttons.map(row =>
          row.map(btn => ({ text: btn.text, callback_data: btn.data }))
        ),
      },
    }).catch(async () => {
      return await this.api('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: buttons.map(row =>
            row.map(btn => ({ text: btn.text, callback_data: btn.data }))
          ),
        },
      });
    });
    return res?.result?.message_id ?? null;
  }

  async editMessageButtons(chatId: string | number, messageId: number, text: string, buttons?: { text: string; data: string }[][]): Promise<void> {
    const markup = buttons ? {
      inline_keyboard: buttons.map(row =>
        row.map(btn => ({ text: btn.text, callback_data: btn.data }))
      ),
    } : { inline_keyboard: [] };

    await this.api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      reply_markup: markup,
    }).catch(async () => {
      await this.api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: markup,
      }).catch(() => {});
    });
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

      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
        // No good newline break — split at space
        splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
      }
      if (splitAt < MAX_MESSAGE_LENGTH * 0.3) {
        // Just hard split
        splitAt = MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  private async getUpdates(): Promise<any[]> {
    const res = await this.api('getUpdates', {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
    });
    return res.result ?? [];
  }

  private async api(method: string, body: any): Promise<any> {
    const res = await fetch(this.baseUrl + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json() as any;
    if (!json.ok) {
      throw new Error('Telegram API error: ' + JSON.stringify(json));
    }
    return json;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
