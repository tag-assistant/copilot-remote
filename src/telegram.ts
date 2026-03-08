// Copilot Remote — Telegram Client (grammY)
import { Bot, type Context } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { autoRetry } from '@grammyjs/auto-retry';
import { hydrate, type HydrateFlavor } from '@grammyjs/hydrate';
import { hydrateFiles, type FileFlavor } from '@grammyjs/files';
import type { Transformer } from 'grammy';
import { markdownToHtml, markdownToText } from './format.js';
import { toTelegramReaction } from './emoji.js';
import { log } from './log.js';
import type { Client, MessageOptions, Button } from './client.js';

const MAX_MESSAGE_LENGTH = 4096;
const DRAFT_ID_MAX = 2_147_483_647;
let nextDraftId = 0;

type MyContext = HydrateFlavor<FileFlavor<Context>>;

export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
}

export class TelegramClient implements Client {
  readonly name = 'telegram';
  private bot: Bot<MyContext>;
  private runner: RunnerHandle | null = null;
  private pairedUser: string | null = null;
  private topicNames = new Map<string, string>();

  // Event handlers (set by bridge consumer)
  onMessage?: Client['onMessage'];
  onCallback?: Client['onCallback'];
  onReaction?: Client['onReaction'];
  onFile?: Client['onFile'];
  onInlineQuery?: Client['onInlineQuery'];

  constructor(private config: TelegramConfig) {
    this.bot = new Bot<MyContext>(config.botToken);

    // ── Plugins ──
    this.bot.api.config.use(autoRetry());
    const defaultParseMode: Transformer = (prev, method, payload, signal) => {
      if (!('parse_mode' in payload)) {
        (payload as Record<string, unknown>).parse_mode = 'HTML';
      }
      return prev(method, payload, signal);
    };
    this.bot.api.config.use(defaultParseMode);
    this.bot.api.config.use(hydrateFiles(config.botToken));
    this.bot.use(hydrate());

    if (config.allowedUsers.length > 0) {
      this.pairedUser = config.allowedUsers[0];
    }

    this.setupHandlers();

    this.bot.catch((err) => {
      log.error('[Telegram] Unhandled error:', err.message);
    });
  }

  private isAllowed(userId: number | undefined): boolean {
    const id = String(userId);
    if (!this.pairedUser) {
      this.pairedUser = id;
      console.log('[Telegram] Auto-paired with user ' + id);
      return true;
    }
    return id === this.pairedUser;
  }

  private setupHandlers(): void {
    // Auth middleware
    this.bot.use(async (ctx, next) => {
      if (!this.isAllowed(ctx.from?.id)) {
        if (ctx.chat?.type === 'private') {
          await ctx.reply('⛔ This instance is paired with another user.', { parse_mode: undefined });
        }
        return;
      }
      await next();
    });

    // Text messages
    this.bot.on('message:text', async (ctx) => {
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
      const chatId = String(ctx.callbackQuery.message?.chat?.id ?? '');
      if (!chatId) {
        await ctx.answerCallbackQuery();
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
      await ctx.answerCallbackQuery();
    });

    // Inline queries
    this.bot.on('inline_query', async (ctx) => {
      if (!ctx.inlineQuery.query?.trim()) return;
      this.onInlineQuery?.(ctx.inlineQuery.id, ctx.inlineQuery.query.trim());
    });

    // Reactions
    this.bot.on('message_reaction', async (ctx) => {
      const r = ctx.messageReaction;
      const chatId = String(r.chat?.id ?? '');
      const userId = String(r.user?.id ?? (r as Record<string, any>).actor_chat?.id ?? '');
      if (userId !== this.pairedUser || !chatId) return;
      const emojis = (r.new_reaction ?? []).filter((e) => e.type === 'emoji').map((e) => e.emoji);
      for (const emoji of emojis) this.onReaction?.(emoji, chatId, r.message_id);
    });
  }

  async start(): Promise<void> {
    // Register bot command menu
    await this.bot.api
      .setMyCommands([
        { command: 'new', description: 'Fresh session' },
        { command: 'stop', description: 'Kill session' },
        { command: 'cd', description: 'Change working directory' },
        { command: 'status', description: 'Model, mode, cwd, quota' },
        { command: 'config', description: 'Settings menu' },
        { command: 'plan', description: 'Plan mode' },
        { command: 'agent', description: 'Switch agent' },
        { command: 'compact', description: 'Compress context' },
        { command: 'help', description: 'All commands' },
      ])
      .catch(() => {});

    if (this.pairedUser) {
      console.log('[Telegram] Polling started — paired with user ' + this.pairedUser);
    } else {
      console.log('[Telegram] Polling started — waiting for first user to pair');
    }

    this.runner = run(this.bot, {
      runner: {
        fetch: {
          allowed_updates: ['message', 'callback_query', 'message_reaction', 'inline_query'],
        },
      },
    });

    await this.runner.task();
  }

  stop(): void {
    if (this.runner?.isRunning()) {
      this.runner.stop();
    }
  }

  // ── Messaging (HTML with plain text fallback) ──

  async sendMessage(chatId: string, text: string, opts?: MessageOptions): Promise<number | null> {
    const chunks = this.splitMessage(text);
    let lastMsgId: number | null = null;
    const extra: Record<string, unknown> = {};
    if (opts?.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (opts?.disableLinkPreview) extra.link_preview_options = { is_disabled: true };
    if (opts?.threadId) extra.message_thread_id = opts.threadId;

    for (const chunk of chunks) {
      const res = await this.sendText('sendMessage', { chat_id: chatId, ...extra }, chunk);
      lastMsgId = res?.message_id ?? null;
    }
    return lastMsgId;
  }

  async editMessage(chatId: string, msgId: number, text: string): Promise<void> {
    const truncated = text.slice(0, MAX_MESSAGE_LENGTH);
    await this.sendText('editMessageText', { chat_id: chatId, message_id: msgId }, truncated);
  }

  async sendButtons(chatId: string, text: string, buttons: Button[][], threadId?: number): Promise<number | null> {
    const markup = {
      inline_keyboard: buttons.map((row) =>
        row.map((btn) => ({
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

  async editButtons(chatId: string, msgId: number, text: string, buttons: Button[][]): Promise<void> {
    const markup = buttons.length
      ? {
          inline_keyboard: buttons.map((row) =>
            row.map((btn) => ({
              text: btn.text,
              callback_data: btn.data,
              ...(btn.style ? { style: btn.style } : {}),
            })),
          ),
        }
      : { inline_keyboard: [] };
    await this.sendText('editMessageText', { chat_id: chatId, message_id: msgId, reply_markup: markup }, text);
  }

  // ── Draft streaming ──

  private draftSupported: boolean | null = null;

  async sendDraft(chatId: string, draftId: number, text: string, threadId?: number): Promise<boolean> {
    if (this.draftSupported === false) return false;
    try {
      const params: Record<string, unknown> = {
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

  async sendTyping(chatId: string, threadId?: number): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
  }

  async setReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    const safe = toTelegramReaction(emoji);
    await this.bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: safe as never }]).catch(() => {});
  }

  async removeReaction(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.setMessageReaction(chatId, messageId, []).catch(() => {});
  }

  // ── File operations ──

  async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      const url =
        (file as any).getUrl?.() ??
        (file.file_path ? 'https://api.telegram.org/file/bot' + this.config.botToken + '/' + file.file_path : null);
      return url ?? null;
    } catch {
      return null;
    }
  }

  async sendDocument(chatId: string, url: string, filename: string, caption?: string): Promise<number | null> {
    try {
      const res = await this.bot.api.sendDocument(chatId, url, { caption: caption ?? filename });
      return res.message_id;
    } catch {
      return null;
    }
  }

  async sendPhoto(chatId: string, url: string, caption?: string): Promise<number | null> {
    try {
      const res = await this.bot.api.sendPhoto(chatId, url, { ...(caption ? { caption } : {}) });
      return res.message_id;
    } catch {
      return null;
    }
  }

  // ── Forum topics ──

  async createForumTopic(chatId: string, name: string): Promise<number | null> {
    try {
      const res = await this.bot.api.createForumTopic(chatId, name);
      return res.message_thread_id ?? null;
    } catch (e: unknown) {
      log.error('createForumTopic failed:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  async deleteForumTopic(chatId: string, threadId: number): Promise<void> {
    await this.bot.api.deleteForumTopic(chatId, threadId).catch(() => {});
  }

  async pinMessage(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.pinChatMessage(chatId, messageId, { disable_notification: true }).catch(() => {});
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }

  // ── Bot profile ──

  async setMyProfilePhoto(photoUrl: string): Promise<void> {
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

  async editReplyMarkup(chatId: string, messageId: number, buttons: any[][]): Promise<void> {
    await this.bot.api
      .editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: buttons as never } })
      .catch(() => {});
  }

  async answerInlineQuery(queryId: string, results: any[]): Promise<void> {
    await this.bot.api.answerInlineQuery(queryId, results, { cache_time: 0 }).catch(() => {});
  }

  getTopicName(sessionKey: string): string | undefined {
    return this.topicNames.get(sessionKey);
  }

  // ── Internal ──

  private async sendText(method: string, params: Record<string, unknown>, text: string): Promise<any> {
    try {
      return await (this.bot.api.raw as any)[method]({ ...params, text: markdownToHtml(text) });
    } catch {
      try {
        return await (this.bot.api.raw as any)[method]({
          ...params,
          text: markdownToText(text),
          parse_mode: undefined,
        });
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
