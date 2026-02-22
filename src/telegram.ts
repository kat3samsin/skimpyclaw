// Telegram bot - Re-export from new location for backward compatibility
// @deprecated Import from './channels/telegram/index.js' instead

export {
  // Core functions
  initTelegram,
  startTelegram,
  stopTelegram,
  getBot,
  setSilenceUntil,
  getSilenceUntil,
  isSilenced,
  sendProactiveMessage,
  sendProactiveVoice,
  
  // Utilities
  getHistory,
  addToHistory,
  clearHistory,
  getRunContext,
  getDefaultTelegramToolConfig,
  buildHelpText,
  getTelegramDefaultChatId,
  startTypingIndicator,
  sendLongMessage,
  sendLongMessageHtml,
  escapeHtml,
  markdownToTelegramHtml,
  
  // Constants
  state,
  BOT_COMMANDS,
  LAUNCHD_LABEL,
  
  // Handlers
  commandHandlers,
  subscribeToApprovalEvents,
} from './channels/telegram/index.js';

// Types
export type { MemoryFileInfo, TelegramContext } from './channels/telegram/types.js';
