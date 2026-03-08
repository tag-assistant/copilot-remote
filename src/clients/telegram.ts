// Copilot Remote — Telegram Client Adapter
// Wraps TelegramBridge to implement the Client interface.
import { TelegramBridge, type TelegramConfig } from '../telegram.js';
import type { Client, MessageOptions, Button } from '../client.js';

export class TelegramClient implements Client {
  readonly name = 'telegram';
  private bridge: TelegramBridge;

  constructor(config: TelegramConfig) {
    this.bridge = new TelegramBridge(config);
  }

  async start() {
    this.bridge.setMessageHandler((text, chatId, msgId, replyText, replyToMsgId) => {
      this.onMessage?.(text, chatId, msgId, replyText, replyToMsgId);
    });
    this.bridge.setCallbackHandler((cbId, data, chatId, msgId) => {
      this.onCallback?.(cbId, data, chatId, msgId);
    });
    this.bridge.setReactionHandler((emoji, chatId, msgId) => {
      this.onReaction?.(emoji, chatId, msgId);
    });
    this.bridge.setFileHandler((fileId, fileName, caption, chatId, msgId, threadId) => {
      this.onFile?.(fileId, fileName, caption, chatId, msgId, threadId);
    });
    this.bridge.setInlineQueryHandler((queryId, query) => {
      this.onInlineQuery?.(queryId, query);
    });

    // Register bot command menu
    await this.bridge.setMyCommands([
      { command: 'new', description: 'Fresh session' },
      { command: 'topic', description: 'Create forum topic (multi-session)' },
      { command: 'stop', description: 'Kill session' },
      { command: 'cd', description: 'Change working directory' },
      { command: 'status', description: 'Model, mode, cwd, quota' },
      { command: 'config', description: 'Settings menu' },
      { command: 'plan', description: 'Plan mode' },
      { command: 'agent', description: 'Switch agent' },
      { command: 'compact', description: 'Compress context' },
      { command: 'help', description: 'All commands' },
    ]);

    await this.bridge.startPolling();
  }

  stop() {
    this.bridge.stopPolling();
  }

  sendMessage(chatId: string, text: string, opts?: MessageOptions) {
    return this.bridge.sendMessage(chatId, text, opts);
  }
  editMessage(chatId: string, msgId: number, text: string) {
    return this.bridge.editMessage(chatId, msgId, text);
  }
  sendButtons(chatId: string, text: string, buttons: Button[][]) {
    return this.bridge.sendMessageWithButtons(chatId, text, buttons);
  }
  editButtons(chatId: string, msgId: number, text: string, buttons: Button[][]) {
    return this.bridge.editMessageButtons(chatId, msgId, text, buttons);
  }
  sendTyping(chatId: string) {
    return this.bridge.sendTyping(chatId);
  }
  setReaction(chatId: string, msgId: number, emoji: string) {
    return this.bridge.setReaction(chatId, msgId, emoji);
  }
  removeReaction(chatId: string, msgId: number) {
    return this.bridge.removeReaction(chatId, msgId);
  }
  sendDraft(chatId: string, draftId: number, text: string, threadId?: number) {
    return this.bridge.sendDraft(chatId, draftId, text, threadId);
  }
  allocateDraftId() {
    return this.bridge.allocateDraftId();
  }
  getFileUrl(fileId: string) {
    return this.bridge.getFileUrl(fileId);
  }
  sendDocument(chatId: string, url: string, filename: string, caption?: string) {
    return this.bridge.sendDocument(chatId, url, filename, caption);
  }
  sendPhoto(chatId: string, url: string, caption?: string) {
    return this.bridge.sendPhoto(chatId, url, caption);
  }
  createForumTopic(chatId: string, name: string) {
    return this.bridge.createForumTopic(chatId, name);
  }
  deleteForumTopic(chatId: string, threadId: number) {
    return this.bridge.deleteForumTopic(chatId, threadId);
  }
  pinMessage(chatId: string, messageId: number) {
    return this.bridge.pinMessage(chatId, messageId);
  }
  deleteMessage(chatId: string, messageId: number) {
    return this.bridge.deleteMessage(chatId, messageId);
  }
  sendReplyKeyboard(chatId: string, text: string, keyboard: string[][], opts?: any) {
    return this.bridge.sendReplyKeyboard(chatId, text, keyboard, opts);
  }
  removeReplyKeyboard(chatId: string, text: string) {
    return this.bridge.removeReplyKeyboard(chatId, text);
  }
  answerCallback(callbackId: string, text?: string, showAlert?: boolean) {
    return this.bridge.answerCallback(callbackId, text, showAlert);
  }
  editReplyMarkup(chatId: string, messageId: number, buttons: any[][]) {
    return this.bridge.editReplyMarkup(chatId, messageId, buttons);
  }
  setMyProfilePhoto(photoUrl: string) {
    return this.bridge.setMyProfilePhoto(photoUrl);
  }
  answerInlineQuery(queryId: string, results: any[]) {
    return this.bridge.answerInlineQuery(queryId, results);
  }

  onMessage?: Client['onMessage'];
  onCallback?: Client['onCallback'];
  onReaction?: Client['onReaction'];
  onFile?: Client['onFile'];
  onInlineQuery?: Client['onInlineQuery'];
}
