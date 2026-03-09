# Changelog

All notable documentation and behavior updates should be recorded here.

## Unreleased

- Discord: added a required documentation process for Discord posting/update workflow changes, including update targets in `README.md`, guide pages, and changelog maintenance expectations.
- Discord: cron jobs now support `payload.discordThreadId` to target a specific thread for start/digest/completion notifications, with validation and fallback to active-channel delivery.
