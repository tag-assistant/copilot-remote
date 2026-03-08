// Copilot Remote — Custom tools for Copilot SDK
// These tools are registered with the session so Copilot can interact with Telegram.
import { defineTool } from '@github/copilot-sdk';

export interface TelegramToolCallbacks {
  sendNotification: (text: string) => Promise<void>;
  sendFile: (path: string, caption?: string) => Promise<void>;
  sendPhoto: (pathOrUrl: string, caption?: string) => Promise<void>;
  sendLocation: (lat: number, lon: number, title?: string) => Promise<void>;
  sendPoll: (question: string, options: string[], isAnonymous?: boolean, allowsMultiple?: boolean) => Promise<void>;
  sendVoice: (path: string, caption?: string) => Promise<void>;
  pinMessage: (messageId: number) => Promise<void>;
  createTopic: (name: string, iconColor?: number) => Promise<number>;
  react: (messageId: number, emoji: string) => Promise<void>;
  sendContact: (phone: string, firstName: string, lastName?: string) => Promise<void>;
}

export function createTelegramTools(cb: TelegramToolCallbacks) {
  return [
    defineTool('send_notification', {
      description: 'Send a notification message to the user on Telegram.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string', description: 'The notification message' } },
        required: ['message'],
      },
      handler: async (args: { message: string }) => { await cb.sendNotification(args.message); return { success: true }; },
    }),

    defineTool('send_file', {
      description: 'Send a file (document, audio, video, image) to the user on Telegram. Use for any file the user needs delivered.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          caption: { type: 'string', description: 'Optional caption' },
        },
        required: ['path'],
      },
      handler: async (args: { path: string; caption?: string }) => { await cb.sendFile(args.path, args.caption); return { success: true }; },
    }),

    defineTool('send_photo', {
      description: 'Send a photo/image to the user. Supports local file paths or URLs. Use for screenshots, generated images, charts, diagrams.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path or URL to the image' },
          caption: { type: 'string', description: 'Optional caption' },
        },
        required: ['path'],
      },
      handler: async (args: { path: string; caption?: string }) => { await cb.sendPhoto(args.path, args.caption); return { success: true }; },
    }),

    defineTool('send_location', {
      description: 'Send a location pin to the user on Telegram. Use when sharing coordinates, addresses, or places.',
      parameters: {
        type: 'object',
        properties: {
          latitude: { type: 'number', description: 'Latitude' },
          longitude: { type: 'number', description: 'Longitude' },
          title: { type: 'string', description: 'Optional venue name or description' },
        },
        required: ['latitude', 'longitude'],
      },
      handler: async (args: { latitude: number; longitude: number; title?: string }) => {
        await cb.sendLocation(args.latitude, args.longitude, args.title);
        return { success: true };
      },
    }),

    defineTool('send_poll', {
      description: 'Create a poll in the Telegram chat. Use for quick votes, decisions, or gathering preferences.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The poll question' },
          options: { type: 'array', items: { type: 'string' }, description: 'Poll options (2-10)' },
          anonymous: { type: 'boolean', description: 'Anonymous voting (default true)' },
          multiple: { type: 'boolean', description: 'Allow multiple answers (default false)' },
        },
        required: ['question', 'options'],
      },
      handler: async (args: { question: string; options: string[]; anonymous?: boolean; multiple?: boolean }) => {
        await cb.sendPoll(args.question, args.options, args.anonymous, args.multiple);
        return { success: true };
      },
    }),

    defineTool('send_voice', {
      description: 'Send a voice message (audio recorded as voice note) to the user. Use for audio responses or TTS output.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the audio file (ogg/opus preferred)' },
          caption: { type: 'string', description: 'Optional caption' },
        },
        required: ['path'],
      },
      handler: async (args: { path: string; caption?: string }) => { await cb.sendVoice(args.path, args.caption); return { success: true }; },
    }),

    defineTool('pin_message', {
      description: 'Pin a message in the chat. Use when a response contains important info the user should keep visible.',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'number', description: 'The message ID to pin' },
        },
        required: ['message_id'],
      },
      handler: async (args: { message_id: number }) => { await cb.pinMessage(args.message_id); return { success: true }; },
    }),

    defineTool('create_topic', {
      description: 'Create a new forum topic (thread) in the Telegram group. Use to spin up isolated workspaces for subtasks.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Topic name' },
          icon_color: { type: 'number', description: 'Icon color (optional)' },
        },
        required: ['name'],
      },
      handler: async (args: { name: string; icon_color?: number }) => {
        const topicId = await cb.createTopic(args.name, args.icon_color);
        return { success: true, topic_id: topicId };
      },
    }),

    defineTool('react', {
      description: 'React to a message with an emoji. Use to acknowledge, express sentiment, or provide feedback on a specific message.',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'number', description: 'The message ID to react to' },
          emoji: { type: 'string', description: 'Emoji to react with (e.g. 👍, ❤️, 🔥)' },
        },
        required: ['message_id', 'emoji'],
      },
      handler: async (args: { message_id: number; emoji: string }) => { await cb.react(args.message_id, args.emoji); return { success: true }; },
    }),

    defineTool('send_contact', {
      description: 'Share a contact card with the user on Telegram.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Phone number with country code' },
          first_name: { type: 'string', description: 'First name' },
          last_name: { type: 'string', description: 'Last name (optional)' },
        },
        required: ['phone', 'first_name'],
      },
      handler: async (args: { phone: string; first_name: string; last_name?: string }) => {
        await cb.sendContact(args.phone, args.first_name, args.last_name);
        return { success: true };
      },
    }),
  ];
}
