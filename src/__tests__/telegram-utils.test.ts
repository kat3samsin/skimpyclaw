import { describe, expect, it } from 'vitest';
import { getTelegramDefaultChatId } from '../channels/telegram/utils.js';

function cfg(allowFrom: Array<string | number>): any {
  return {
    channels: {
      telegram: {
        allowFrom,
      },
    },
  };
}

describe('getTelegramDefaultChatId', () => {
  it('returns first numeric id even when first allowlist item is username', () => {
    expect(getTelegramDefaultChatId(cfg(['@its_katriiina', 7978706110]))).toBe(7978706110);
  });

  it('accepts numeric strings', () => {
    expect(getTelegramDefaultChatId(cfg(['not-id', '123456789']))).toBe(123456789);
  });

  it('returns null when no numeric ids are present', () => {
    expect(getTelegramDefaultChatId(cfg(['@user', 'abc']))).toBeNull();
  });
});
