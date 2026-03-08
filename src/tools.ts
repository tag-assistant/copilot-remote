// Copilot Remote — Custom tools for Copilot SDK
// These tools are registered with the session so Copilot can interact with Telegram.
import { defineTool } from '@github/copilot-sdk';

export function createTelegramTools(callbacks: { sendNotification: (text: string) => Promise<void> }) {
  const notify = defineTool('send_notification', {
    description:
      'Send a notification message to the user on Telegram. Use this when you want to alert the user about something important, like a long-running task completing.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The notification message to send' },
      },
      required: ['message'],
    },
    handler: async (args: any) => {
      await callbacks.sendNotification(args.message);
      return { success: true };
    },
  });

  return [notify];
}
