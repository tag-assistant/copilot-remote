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
    await this.bridge.startPolling();
  }

  stop() { this.bridge.stopPolling(); }

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
  sendTyping(chatId: string) { return this.bridge.sendTyping(chatId); }
  setReaction(chatId: string, msgId: number, emoji: string) { return this.bridge.setReaction(chatId, msgId, emoji); }
  removeReaction(chatId: string, msgId: number) { return this.bridge.removeReaction(chatId, msgId); }

  onMessage?: Client['onMessage'];
  onCallback?: Client['onCallback'];
  onReaction?: Client['onReaction'];
}
