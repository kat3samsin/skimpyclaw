// Serialize complete turns within one conversation while keeping unrelated
// conversations concurrent.

const conversationTails = new Map<string, Promise<void>>();

export function runConversationTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationTails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.then(() => undefined, () => undefined);
  conversationTails.set(key, tail);

  return run.finally(() => {
    if (conversationTails.get(key) === tail) {
      conversationTails.delete(key);
    }
  });
}

export function _getConversationQueueSizeForTesting(): number {
  return conversationTails.size;
}

export function _resetConversationQueuesForTesting(): void {
  conversationTails.clear();
}
