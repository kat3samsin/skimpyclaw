---
layout: home

hero:
  name: "👙🦞"
  text: Lobster in a Bikini
  tagline: Lightweight (~22k LOC). Runs locally. Telegram, Discord, scheduled tasks, and a web dashboard — all in one tiny service.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/kat3samsin/skimpyclaw

features:
  - icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
    title: Multi-Channel Chat
    details: Telegram or Discord bot with persistent conversation history and voice message support.
  - icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    title: Skills-Enabled Agent
    details: Extensible skills system with trigger-based activation. File I/O, bash, browser automation, and MCP tools built in.
  - icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    title: Cron Scheduler
    details: Run agent prompts or shell scripts on a schedule. Daily digests and automated workflows.
  - icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    title: Subagents
    details: Model autonomously spawns coding/research subagents with retry and concurrency control.
  - icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    title: Web Dashboard
    details: Preact/Vite SPA for status, cron management, audit logs, memory browser, and live config editing.
  - icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    title: Coding Agent Teams
    details: Spawn parallel coding agents (Claude, Codex, Kimi) that decompose tasks, write code, and run validation gates.
---

<style>
/* Custom homepage styling to match dashboard */

.VPHero .tagline {
  font-size: 1.2rem;
  color: var(--vp-c-text-2);
}

.VPFeatures {
  padding-top: 64px;
}

.VPFeatures .VPFeature {
  margin-top: 32px;
}

.VPFeatures .icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  background: var(--vp-c-brand-soft);
  border-radius: 12px;
  color: var(--vp-c-brand);
}

.VPFeatures .icon svg {
  width: 24px;
  height: 24px;
}
</style>
