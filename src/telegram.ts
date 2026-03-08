// Copilot Remote — Telegram Bridge (grammY)
import { Bot, type Context } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { markdownToHtml, markdownToText } from './format.js';
import { toTelegramReaction } from './emoji.js';
import { log } from './log.js';

const MAX_MESSAGE_LENGTH = 4096;
const DRAFT_ID_MAX = 2_147_483_647;
let nextDraftId = 0;

export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
}

export class TelegramBridge {
  private bot: Bot;
  private runner: RunnerHandle | null = null;
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
  public topicNames = new Map<string, string>();

  constructor(private config: TelegramConfig) {
    this.bot = new Bot(config.botToken);
    if (config.allowedUsers.length > 0) {
      this.pairedUser = config.allowedUsers[0];
    }
    this.setupHandlers();
  }

  private isAllowed(userId: number | undefined, chatType: string): boolean {
    const id = String(userId);
    if (!this.pairedUser) {
      this.pairedUser = id;
      console.log('[Telegram] Auto-paired with user ' + id);
      return true;
    }
    return id === this.pairedUser;
  }

  private setupHandlers(): void {
    // Text messages
    this.bot.on('message:text', async (ctx) => {
      const userId = ctx.from?.id;
      if (!this.isAllowed(userId, ctx.chat.type)) {
        if (ctx.chat.type === 'private') {
          await ctx.reply('⛔ This instance is paired with another user.');
        }
        return;
      }

      // Track topic name
      const threadId = ctx.message.message_thread_id;
      if (threadId) {
        const topicKey = ctx.chat.id + ':' + threadId;
        const topicCreated = ctx.message.reply_to_message?.forum_topic_created;
        if (topicCreated?.name && !this.topicNames.has(topicKey)) {
          this.topicNames.set(topicKey, topicCreated.name);
        }
      }

      this.onMessage?.(
        ctx.message.text,
        String(ctx.chat.id),
        ctx.message.message_id,
        ctx.message.reply_to_message?.text,
        ctx.message.reply_to_message?.message_id,
        threadId,
      );
    });

    // Photos, documents, voice, audio
    this.bot.on(['message:photo', 'message:document', 'message:voice', 'message:audio'], async (ctx) => {
      const userId = ctx.from?.id;
      if (!this.isAllowed(userId, ctx.chat.type)) return;

      const msg = ctx.message;
      const fileId =
        msg.voice?.file_id ?? msg.audio?.file_id ?? msg.document?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id;
      const fileName = msg.document?.file_name ?? msg.audio?.file_name ?? (msg.voice ? 'voice.oga' : 'photo.jpg');
      const caption = msg.caption ?? '';
      if (fileId) {
        this.onFile?.(fileId, fileName, caption, String(ctx.chat.id), msg.message_id, msg.message_thread_id);
      }
    });

    // Callback queries
    this.bot.on('callback_query:data', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = String(ctx.callbackQuery.message?.chat?.id ?? '');
      if (!this.isAllowed(userId, 'callback') || !chatId) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }

      try {
        await this.onCallback?.(
          ctx.callbackQuery.id,
          ctx.callbackQuery.data,
          chatId,
          ctx.callbackQuery.message?.message_id ?? 0,
        );
      } catch {
        /* ignore handler errors */
      }
      // Always answer to dismiss loading
      await ctx.answerCallbackQuery().catch(() => {});
    });

    // Inline queries
    this.bot.on('inline_query', async (ctx) => {
      const userId = ctx.from?.id;
      if (!this.isAllowed(userId, 'inline') || !ctx.inlineQuery.query?.trim()) return;
      this.onInlineQuery?.(ctx.inlineQuery.id, ctx.inlineQuery.query.trim());
    });

    // Reactions
    this.bot.on('message_reaction', async (ctx) => {
      const r = ctx.messageReaction;
      const chatId = String(r.chat?.id ?? '');
      const userId = String(r.user?.id ?? (r as any).actor_chat?.id ?? '');
      if (userId !== this.pairedUser || !chatId) return;
      const emojis = (r.new_reaction ?? []).filter((e) => e.type === 'emoji').map((e) => e.emoji);
      for (const emoji of emojis) this.onReaction?.(emoji, chatId, r.message_id);
    });
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
    if (this.pairedUser) {
      console.log('[Telegram] Polling started — paired with user ' + this.pairedUser);
    } else {
      console.log('[Telegram] Polling started — waiting for first user to pair');
    }

    // Use @grammyjs/runner for concurrent update handling
    this.runner = run(this.bot, {
      runner: {
        fetch: {
          allowed_updates: ['message', 'callback_query', 'message_reaction', 'inline_query'],
        },
      },
    });

    // Block until runner stops
    await this.runner.task();
  }

  stopPolling(): void {
    if (this.runner?.isRunning()) {
      this.runner.stop();
    }
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
      lastMsgId = res?.message_id ?? null;
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
    threadId?: number,
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
    const res = await this.sendText(
      'sendMessage',
      { chat_id: chatId, reply_markup: markup, ...(threadId ? { message_thread_id: threadId } : {}) },
      text,
    );
    return res?.message_id ?? null;
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

  // ── Draft streaming ──

  private draftSupported: boolean | null = null;

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
      await (this.bot.api.raw as any).sendMessageDraft(params);
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

  async sendTyping(chatId: string | number, threadId?: number): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
  }

  async setReaction(chatId: string | number, messageId: number, emoji: string): Promise<void> {
    const safe = toTelegramReaction(emoji);
    await this.bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: safe as any }]).catch(() => {});
  }

  async removeReaction(chatId: string | number, messageId: number): Promise<void> {
    await this.bot.api.setMessageReaction(chatId, messageId, []).catch(() => {});
  }

  // ── File operations ──

  async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;
      return 'https://api.telegram.org/file/bot' + this.config.botToken + '/' + file.file_path;
    } catch {
      return null;
    }
  }

  async sendDocument(chatId: string | number, url: string, filename: string, caption?: string): Promise<number | null> {
    try {
      const res = await this.bot.api.sendDocument(chatId, url, { caption: caption ?? filename });
      return res.message_id;
    } catch {
      return null;
    }
  }

  async sendPhoto(chatId: string | number, url: string, caption?: string): Promise<number | null> {
    try {
      const res = await this.bot.api.sendPhoto(chatId, url, { ...(caption ? { caption } : {}) });
      return res.message_id;
    } catch {
      return null;
    }
  }

  // ── Forum topics ──

  async createForumTopic(chatId: string | number, name: string): Promise<number | null> {
    try {
      const res = await this.bot.api.createForumTopic(chatId, name);
      return res.message_thread_id ?? null;
    } catch (e: any) {
      log.error('createForumTopic failed:', e?.message ?? e);
      return null;
    }
  }

  async deleteForumTopic(chatId: string | number, threadId: number): Promise<void> {
    await this.bot.api.deleteForumTopic(chatId, threadId).catch(() => {});
  }

  async pinMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.bot.api.pinChatMessage(chatId, messageId, { disable_notification: true }).catch(() => {});
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }

  async sendTypingToThread(chatId: string | number, threadId: number): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
  }

  // ── Bot commands & profile ──

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.bot.api.setMyCommands(commands).catch(() => {});
  }

  async setMyProfilePhoto(photoUrl: string): Promise<void> {
    // grammY doesn't have a direct helper; use raw API
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
      await fetch('https://api.telegram.org/bot' + this.config.botToken + '/setMyProfilePhoto', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: payload,
      });
    } catch {
      /* ignore */
    }
  }

  async answerCallback(callbackId: string, text?: string, showAlert = false): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackId, { text, show_alert: showAlert }).catch(() => {});
  }

  async editReplyMarkup(chatId: string | number, messageId: number, buttons: any[][]): Promise<void> {
    await this.bot.api
      .editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: buttons } })
      .catch(() => {});
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
    return res?.message_id ?? null;
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
    return res?.message_id ?? null;
  }

  async answerInlineQuery(queryId: string, results: any[]): Promise<void> {
    await this.bot.api.answerInlineQuery(queryId, results, { cache_time: 0 }).catch(() => {});
  }

  // ── Internal ──

  private async sendText(method: string, params: Record<string, any>, text: string): Promise<any> {
    try {
      return await (this.bot.api.raw as any)[method]({ ...params, text: markdownToHtml(text), parse_mode: 'HTML' });
    } catch {
      try {
        return await (this.bot.api.raw as any)[method]({ ...params, text: markdownToText(text) });
      } catch {
        return null;
      }
    }
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
}
