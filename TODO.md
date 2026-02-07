# TODO

- [ ] Secrets at rest: stop storing credentials/tokens in plaintext `~/.skimpyclaw/config.json`.
  - Implement secure secret storage (macOS Keychain or encrypted secrets file).
  - Store only secret references/IDs in config.
  - Add migration for existing plaintext secrets and remove/rotate old values.
- [x] Dashboard tracking of completed tasks.
- [ ] Langfuse integration.
- [x] Expand Telegram command coverage and polish command UX.
- [ ] Support additional channels (e.g. Discord) by decoupling channel adapters from core agent runtime.
- [x] Add stronger test coverage: unit tests + end-to-end tests.
- [ ] Add browser control capability.
- [] OpenRouter, Minimax, and Kimi
