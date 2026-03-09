import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Update } from 'grammy/types';
import {
  formatLogFields,
  summarizeSdkEvent,
  summarizeTelegramApiCall,
  summarizeTelegramUpdate,
  summarizeTextForLog,
} from '../transport-log.js';

describe('transport-log', () => {
  it('summarizes Telegram message updates', () => {
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 99,
        date: 1,
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: { id: 456, is_bot: false, first_name: 'Tester' },
        text: 'hello there',
      },
    } as unknown as Update;

    assert.deepEqual(summarizeTelegramUpdate(update), {
      updateId: 1,
      kind: 'message',
      chat: 123,
      from: 456,
      msg: 99,
      thread: undefined,
      text: 'hello there',
      hasPhoto: false,
      hasDocument: false,
      hasVoice: false,
      hasAudio: false,
      hasVideo: false,
      hasLocation: false,
      hasSticker: false,
    });
  });

  it('summarizes Telegram API call payloads', () => {
    assert.deepEqual(
      summarizeTelegramApiCall('sendMessage', {
        chat_id: '123',
        message_thread_id: 77,
        reply_parameters: { message_id: 55 },
        parse_mode: 'HTML',
        text: 'hello world',
      }),
      {
        method: 'sendMessage',
        chat: '123',
        msg: undefined,
        thread: 77,
        replyTo: 55,
        draftId: undefined,
        action: undefined,
        callbackId: undefined,
        inlineQueryId: undefined,
        parseMode: 'HTML',
        text: 'hello world',
        caption: undefined,
      },
    );
  });

  it('summarizes SDK events', () => {
    assert.deepEqual(
      summarizeSdkEvent('assistant.message_delta', {
        turnId: 'turn-1',
        interactionId: 'ix-1',
        deltaContent: 'partial response',
      }),
      {
        type: 'assistant.message_delta',
        turnId: 'turn-1',
        interactionId: 'ix-1',
        toolCallId: undefined,
        toolName: undefined,
        exitCode: undefined,
        success: undefined,
        chars: 16,
        text: 'partial response',
        currentTokens: undefined,
        tokenLimit: undefined,
        messagesLength: undefined,
        title: undefined,
        message: undefined,
      },
    );
  });

  it('formats log fields predictably', () => {
    assert.deepEqual(formatLogFields({ chat: 123, text: 'hello', ok: true }), [
      'chat=123',
      'text="hello"',
      'ok=true',
    ]);
  });

  it('clips long text summaries', () => {
    assert.equal(summarizeTextForLog('abcdefghij', 5), 'abcde…');
  });
});
