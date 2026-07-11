import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _getConversationQueueSizeForTesting,
  _resetConversationQueuesForTesting,
  runConversationTurn,
} from '../conversation-queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runConversationTurn', () => {
  beforeEach(() => {
    _resetConversationQueuesForTesting();
  });

  afterEach(() => {
    _resetConversationQueuesForTesting();
  });

  it('serializes complete turns for the same conversation', async () => {
    const firstGate = deferred();
    const firstStarted = deferred();
    const history: string[] = [];
    const observedHistory: string[][] = [];

    const first = runConversationTurn('telegram:1', async () => {
      observedHistory.push([...history]);
      firstStarted.resolve();
      await firstGate.promise;
      history.push('first exchange');
    });
    await firstStarted.promise;

    const second = runConversationTurn('telegram:1', async () => {
      observedHistory.push([...history]);
      history.push('second exchange');
    });
    await Promise.resolve();

    expect(observedHistory).toEqual([[]]);
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(observedHistory).toEqual([[], ['first exchange']]);
    expect(history).toEqual(['first exchange', 'second exchange']);
    expect(_getConversationQueueSizeForTesting()).toBe(0);
  });

  it('allows different conversations to run concurrently', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();

    const first = runConversationTurn('discord:channel:1', async () => {
      firstStarted.resolve();
      await firstGate.promise;
    });
    const second = runConversationTurn('discord:channel:2', async () => {
      secondStarted.resolve();
      await secondGate.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(_getConversationQueueSizeForTesting()).toBe(2);

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([first, second]);
  });

  it('continues the queue after a failed turn', async () => {
    const events: string[] = [];
    const first = runConversationTurn('discord:dm:1', async () => {
      events.push('first');
      throw new Error('failed turn');
    });
    const second = runConversationTurn('discord:dm:1', async () => {
      events.push('second');
      return 'ok';
    });

    await expect(first).rejects.toThrow('failed turn');
    await expect(second).resolves.toBe('ok');
    expect(events).toEqual(['first', 'second']);
    expect(_getConversationQueueSizeForTesting()).toBe(0);
  });
});
