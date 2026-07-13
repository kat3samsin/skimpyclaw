import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import {
  sendToThread,
  sendToThreadWithAttachments,
  sendToThreadWithVoice,
} from '../channels/discord/threads.js';

const CHANNEL_ID = '123456789012345678';

describe('Discord channel fetch errors', () => {
  let fetchChannel: ReturnType<typeof vi.fn>;
  let client: Client;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchChannel = vi.fn();
    client = { channels: { fetch: fetchChannel } } as unknown as Client;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports Discord Unknown Channel as not found', async () => {
    fetchChannel.mockRejectedValue(Object.assign(new Error('Unknown Channel'), { code: 10003 }));

    await expect(sendToThread(client, CHANNEL_ID, 'hello')).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(`[discord] Channel/thread ${CHANNEL_ID} not found`);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['text', (target: Client) => sendToThread(target, CHANNEL_ID, 'hello')],
    ['attachments', (target: Client) => sendToThreadWithAttachments(target, CHANNEL_ID, 'hello')],
    ['voice', (target: Client) => sendToThreadWithVoice(target, CHANNEL_ID, 'hello')],
  ])('preserves a %s transport failure instead of calling it not found', async (_name, send) => {
    const networkError = new Error('getaddrinfo ENOTFOUND discord.com');
    fetchChannel.mockRejectedValue(networkError);

    await expect(send(client)).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith(
      `[discord] Failed to fetch channel/thread ${CHANNEL_ID}:`,
      networkError,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
