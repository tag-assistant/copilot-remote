// Copilot Remote — Telegram Client (grammY)
import { Bot, GrammyError, HttpError, type Context, InputFile } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { autoRetry } from '@grammyjs/auto-retry';
import { hydrate, type HydrateFlavor } from '@grammyjs/hydrate';
import { hydrateFiles, type FileFlavor } from '@grammyjs/files';
import type { Transformer } from 'grammy';
import { markdownToHtml, markdownToText, markdownToTelegramChunks } from './format.js';
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
  profilePhoto?: string;
}

type RawApi = Record<string, (...args: unknown[]) => unknown>;

export class TelegramClient implements Client {
  readonly name = 'telegram';
  private bot: Bot<MyContext>;
  private runner: RunnerHandle | null = null;
  private pairedUser: string | null = null;
  private topicNames = new Map<string, string>();
  private msgThreadMap = new Map<number, number>(); // msgId → threadId for callback resolution

  // Event handlers (set by bridge consumer)
  onMessage?: Client['onMessage'];
  onCallback?: Client['onCallback'];
  onReaction?: Client['onReaction'];
  onFile?: Client['onFile'];
  onInlineQuery?: Client['onInlineQuery'];

  /** Expose bot API for draft stream integration. */
  get api() { return this.bot.api; }

  /** Typed accessor for raw API methods (avoids repeated casts). */
  private get raw(): RawApi { return this.bot.api.raw as RawApi; }

  constructor(private config: TelegramConfig) {
    this.bot = new Bot<MyContext>(config.botToken);

    // ── Plugins ──
    this.bot.api.config.use(apiThrottler());
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 30 }));
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
      const e = err.error;
      if (e instanceof GrammyError) {
        log.error('[Telegram] API error:', e.description);
      } else if (e instanceof HttpError) {
        log.error('[Telegram] Network error:', e.message);
      } else {
        log.error('[Telegram] Handler error:', e);
      }
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

    // Text messages — fire-and-forget to enable parallel thread processing
    this.bot.on('message:text', (ctx) => {
      const threadId = ctx.message.message_thread_id;
      if (threadId) {
        const topicKey = ctx.chat.id + ':' + threadId;
        const topicCreated = ctx.message.reply_to_message?.forum_topic_created;
        if (topicCreated?.name && !this.topicNames.has(topicKey)) {
          this.topicNames.set(topicKey, topicCreated.name);
        }
      }

      // Do NOT await — let handlePrompt run in background so other updates process immediately
      void this.onMessage?.(
        ctx.message.text,
        String(ctx.chatId),
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
        this.onFile?.(fileId, fileName, caption, String(ctx.chatId), msg.message_id, msg.message_thread_id);
      }
    });

    // Stickers → forward emoji/description as text
    this.bot.on('message:sticker', async (ctx) => {
      const sticker = ctx.message.sticker;
      const emoji = sticker.emoji ?? '';
      const desc = emoji ? `[Sticker: ${emoji}]` : '[Sticker]';
      const threadId = ctx.message.message_thread_id;
      this.onMessage?.(desc, String(ctx.chatId), ctx.message.message_id, undefined, undefined, threadId);
    });

    // Video and video notes → download and forward as file
    this.bot.on(['message:video', 'message:video_note'], async (ctx) => {
      const msg = ctx.message;
      const video = msg.video ?? msg.video_note;
      if (!video) return;
      const fileId = video.file_id;
      const fileName = (msg.video as { file_name?: string })?.file_name ?? 'video.mp4';
      const caption = (msg as { caption?: string }).caption ?? '';
      this.onFile?.(fileId, fileName, caption, String(ctx.chatId), msg.message_id, msg.message_thread_id);
    });

    // Location → forward as text
    this.bot.on('message:location', async (ctx) => {
      const loc = ctx.message.location;
      const text = `User shared location: ${loc.latitude}, ${loc.longitude}`;
      const threadId = ctx.message.message_thread_id;
      this.onMessage?.(text, String(ctx.chatId), ctx.message.message_id, undefined, undefined, threadId);
    });

    // Callback queries
    this.bot.on('callback_query:data', async (ctx) => {
      const chatId = String(ctx.chatId ?? '');
      const msg = ctx.msg;
      const msgId = msg?.message_id ?? 0;
      // msg.date > 0 means it's a full Message (not InaccessibleMessage), which has message_thread_id
      const grammyThreadId =
        msg && msg.date > 0 ? (msg as unknown as { message_thread_id?: number }).message_thread_id : undefined;
      const mapThreadId = this.msgThreadMap.get(msgId);
      const threadId = grammyThreadId ?? mapThreadId;
      log.info(
        `Callback: chat=${chatId} threadId=${threadId} (grammy=${grammyThreadId} map=${mapThreadId}) msgId=${msgId} data=${ctx.callbackQuery.data}`,
      );
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }

      try {
        await this.onCallback?.(ctx.callbackQuery.id, ctx.callbackQuery.data, chatId, msg?.message_id ?? 0, threadId);
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
      const chatId = String(ctx.chatId ?? '');
      const threadId = (r as unknown as Record<string, unknown>)?.message_thread_id as number | undefined;
      const userId = String(ctx.from?.id ?? (r as unknown as Record<string, { id?: number }>).actor_chat?.id ?? '');
      if (userId !== this.pairedUser || !chatId) return;
      const emojis = (r.new_reaction ?? []).filter((e) => e.type === 'emoji').map((e) => e.emoji);
      for (const emoji of emojis) this.onReaction?.(emoji, chatId, r.message_id, threadId);
    });
  }

  async start(): Promise<void> {
    // Register bot command menu
    await this.bot.api
      .setMyCommands([
        { command: 'new', description: 'Start fresh session' },
        { command: 'config', description: 'Settings & preferences' },
        { command: 'status', description: 'Session info & quota' },
        { command: 'sessions', description: 'List & resume sessions' },
        { command: 'agent', description: 'Switch agent' },
        { command: 'prompt', description: 'Run a prompt file' },
        { command: 'search', description: 'Search session history' },
        { command: 'tools', description: 'Manage tools' },
        { command: 'usage', description: 'Usage & token stats' },
        { command: 'research', description: 'Deep research a topic' },
        { command: 'cd', description: 'Change working directory' },
        { command: 'abort', description: 'Cancel current operation' },
        { command: 'compact', description: 'Compress context window' },
        { command: 'plan', description: 'View/manage plan' },
        { command: 'diff', description: 'Review uncommitted changes' },
        { command: 'review', description: 'Code review recent changes' },
        { command: 'files', description: 'List workspace files' },
        { command: 'skills', description: 'List available skills' },
        { command: 'mcp', description: 'MCP server status' },
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

    // Set profile photo if configured
    const photoPath = this.config.profilePhoto;
    if (photoPath) this.setMyProfilePhoto(photoPath).catch(() => {});

    await this.runner.task();
  }

  stop(): void {
    if (this.runner?.isRunning()) {
      this.runner.stop();
    }
  }

  // ── Messaging (HTML with plain text fallback) ──

  async sendMessage(chatId: string, text: string, opts?: MessageOptions): Promise<number | null> {
    // Split at the markdown IR level to avoid breaking mid-HTML tag.
    // Ported from OpenClaw's renderTelegramChunksWithinHtmlLimit (MIT).
    const chunks = markdownToTelegramChunks(text, MAX_MESSAGE_LENGTH);
    let lastMsgId: number | null = null;
    const extra: Record<string, unknown> = {};
    if (opts?.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (opts?.disableLinkPreview) extra.link_preview_options = { is_disabled: true };
    if (opts?.threadId) extra.message_thread_id = opts.threadId;

    for (const chunk of chunks) {
      try {
        const res = await this.raw['sendMessage']({
          chat_id: chatId,
          ...extra,
          text: chunk.html,
          parse_mode: 'HTML',
        });
        lastMsgId = (res as { message_id?: number })?.message_id ?? null;
      } catch {
        // Fallback: send as plain text if HTML fails
        try {
          const res = await this.raw['sendMessage']({
            chat_id: chatId,
            ...extra,
            text: chunk.text,
            parse_mode: undefined,
          });
          lastMsgId = (res as { message_id?: number })?.message_id ?? null;
        } catch {
          // Skip failed chunk
        }
      }
    }
    if (lastMsgId && opts?.threadId) this.msgThreadMap.set(lastMsgId, opts.threadId);
    return lastMsgId;
  }

  async editMessage(chatId: string, msgId: number, text: string): Promise<void> {
    // Render to HTML first, then check length. If too long, truncate at IR level.
    const chunks = markdownToTelegramChunks(text, MAX_MESSAGE_LENGTH);
    const chunk = chunks[0]; // edit can only update one message — use first chunk
    if (!chunk) return;
    try {
      await this.raw['editMessageText']({
        chat_id: chatId, message_id: msgId, text: chunk.html, parse_mode: 'HTML',
      });
    } catch {
      try {
        await this.raw['editMessageText']({
          chat_id: chatId, message_id: msgId, text: chunk.text, parse_mode: undefined,
        });
      } catch { /* ignore edit failures during streaming */ }
    }
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
    const msgId = res?.message_id ?? null;
    if (msgId && threadId) this.msgThreadMap.set(msgId, threadId);
    return msgId;
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

  private draftDisabledChats = new Set<string>();

  async sendDraft(chatId: string, draftId: number, text: string, threadId?: number): Promise<boolean> {
    if (this.draftDisabledChats.has(chatId)) return false;
    // Drafts only work in DMs — skip supergroups immediately
    if (chatId.startsWith('-')) {
      this.draftDisabledChats.add(chatId);
      return false;
    }
    try {
      const params: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
        text: markdownToHtml(text),
        parse_mode: 'HTML',
      };
      if (threadId) params.message_thread_id = threadId;
      const resp = await fetch(
        `https://api.telegram.org/bot${this.config.botToken}/sendMessageDraft`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: globalThis.AbortSignal.timeout(2000), // 2s timeout — don't block streaming
        },
      );
      const json = (await resp.json()) as { ok?: boolean; description?: string };
      if (!json.ok) throw new Error(json.description ?? 'sendMessageDraft failed');
      return true;
    } catch (e) {
      const msg = String(e);
      log.debug('sendMessageDraft failed:', msg);
      if (/unknown method|not (found|available|supported)|can't be used|can be used only|PEER_INVALID/i.test(msg)) {
        this.draftDisabledChats.add(chatId); // disable for THIS chat only
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
        // grammY hydrate plugin adds getUrl() at runtime
        (file as unknown as { getUrl?: () => string }).getUrl?.() ??
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

  async sendPhoto(chatId: string, fileOrUrl: string | Buffer, caption?: string, threadId?: number): Promise<number | null> {
    try {
      const source = Buffer.isBuffer(fileOrUrl) ? new InputFile(fileOrUrl, 'image.png')
        : fileOrUrl.startsWith('/') ? new InputFile(fileOrUrl) : fileOrUrl;
      const res = await this.bot.api.sendPhoto(chatId, source, {
        ...(caption ? { caption } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
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

  async editForumTopic(chatId: string, threadId: number, name: string): Promise<void> {
    try {
      await this.bot.api.editForumTopic(chatId, threadId, { name });
    } catch { /* best-effort */ }
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

  private profilePhotoSet = false;

  async setMyProfilePhoto(pathOrUrl: string): Promise<void> {
    if (this.profilePhotoSet) return;
    try {
      // Check if photo is already set
      const me = await this.bot.api.raw.getUserProfilePhotos({ user_id: this.bot.botInfo.id, limit: 1 });
      if (me.total_count > 0) {
        this.profilePhotoSet = true;
        return;
      }
      let buffer: Buffer;
      if (pathOrUrl.startsWith('http')) {
        const res = await fetch(pathOrUrl);
        buffer = Buffer.from(await res.arrayBuffer());
      } else {
        const fs = await import('fs');
        buffer = fs.readFileSync(pathOrUrl);
      }
      await this.bot.api.raw.setMyProfilePhoto({ photo: { type: 'static', photo: new InputFile(buffer, 'avatar.jpg') } });
      this.profilePhotoSet = true;
    } catch (e) {
      log.debug('setMyProfilePhoto failed:', e);
    }
  }

  async answerCallback(callbackId: string, text?: string, showAlert = false): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackId, { text, show_alert: showAlert }).catch(() => {});
  }

  async editReplyMarkup(chatId: string, messageId: number, buttons: Button[][]): Promise<void> {
    await this.bot.api
      .editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: buttons as never } })
      .catch(() => {});
  }

  async answerInlineQuery(queryId: string, results: Record<string, unknown>[]): Promise<void> {
    await this.bot.api
      .answerInlineQuery(queryId, results as unknown as Parameters<typeof this.bot.api.answerInlineQuery>[1], {
        cache_time: 0,
      })
      .catch(() => {});
  }

  getTopicName(sessionKey: string): string | undefined {
    return this.topicNames.get(sessionKey);
  }

  // ── Internal ──

  private async sendText(
    method: string,
    params: Record<string, unknown>,
    text: string,
  ): Promise<{ message_id?: number } | null> {
    try {
      return await this.raw[method]({ ...params, text: markdownToHtml(text) }) as { message_id?: number } | null;
    } catch {
      try {
        return await this.raw[method]({
          ...params,
          text: markdownToText(text),
          parse_mode: undefined,
        }) as { message_id?: number } | null;
      } catch {
        return null;
      }
    }
  }


}
