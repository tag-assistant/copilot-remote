// Copilot Remote — Client Interface
// Each platform adapter implements this.

export interface MessageOptions {
  replyTo?: number;
  disableLinkPreview?: boolean;
  threadId?: number;
}

export interface Button {
  text: string;
  data: string;
  style?: string;
}

export interface Client {
  readonly name: string;

  // Lifecycle
  start(): Promise<void>;
  stop(): void;

  // Messaging
  sendMessage(chatId: string, text: string, opts?: MessageOptions): Promise<number | null>;
  editMessage(chatId: string, msgId: number, text: string): Promise<void>;
  sendButtons(chatId: string, text: string, buttons: Button[][], threadId?: number): Promise<number | null>;
  editButtons(chatId: string, msgId: number, text: string, buttons: Button[][]): Promise<void>;

  // Presence
  sendTyping(chatId: string, threadId?: number): Promise<void>;
  setReaction(chatId: string, msgId: number, emoji: string): Promise<void>;
  removeReaction(chatId: string, msgId: number): Promise<void>;

  // Draft streaming (optional — platforms that support native streaming)
  sendDraft?(chatId: string, draftId: number, text: string, threadId?: number): Promise<boolean>;
  allocateDraftId?(): number;

  // File operations (optional)
  getFileUrl?(fileId: string): Promise<string | null>;
  sendDocument?(chatId: string, url: string, filename: string, caption?: string): Promise<number | null>;
  sendPhoto?(chatId: string, url: string, caption?: string): Promise<number | null>;

  // Forum topics (optional)
  createForumTopic?(chatId: string, name: string): Promise<number | null>;
  deleteForumTopic?(chatId: string, threadId: number): Promise<void>;
  pinMessage?(chatId: string, messageId: number): Promise<void>;
  deleteMessage?(chatId: string, messageId: number): Promise<void>;

  // Reply keyboard (optional)
  sendReplyKeyboard?(
    chatId: string,
    text: string,
    keyboard: string[][],
    opts?: { oneTime?: boolean; resize?: boolean; placeholder?: string },
  ): Promise<number | null>;
  removeReplyKeyboard?(chatId: string, text: string): Promise<number | null>;

  // Advanced (optional)
  answerCallback?(callbackId: string, text?: string, showAlert?: boolean): Promise<void>;
  editReplyMarkup?(chatId: string, messageId: number, buttons: any[][]): Promise<void>;
  setMyProfilePhoto?(photoUrl: string): Promise<void>;
  answerInlineQuery?(queryId: string, results: any[]): Promise<void>;
  getTopicName?(sessionKey: string): string | undefined;

  // Event handlers (set by bridge)
  onMessage?: (
    text: string,
    chatId: string,
    msgId: number,
    replyText?: string,
    replyToMsgId?: number,
    threadId?: number,
  ) => Promise<void>;
  onCallback?: (callbackId: string, data: string, chatId: string, msgId: number) => Promise<void>;
  onReaction?: (emoji: string, chatId: string, msgId: number) => Promise<void>;
  onFile?: (
    fileId: string,
    fileName: string,
    caption: string,
    chatId: string,
    msgId: number,
    threadId?: number,
  ) => Promise<void>;
  onInlineQuery?: (queryId: string, query: string) => Promise<void>;
}
