# HEARTBEAT.md - Periodic Tasks

Follow this file literally when asked to run heartbeat checks.

## Core Rules

- If there is nothing urgent/actionable, reply exactly: `HEARTBEAT_OK`
- Do not infer stale tasks from old conversations unless they are in current files/context
- Keep heartbeat replies concise (1-2 lines unless asked for detail)

## Priority Checks

- [ ] Any unread messages in Telegram?
- [ ] Any urgent notifications?

## Proactive Items (if integrations available)

- [ ] Check Linear inbox for new issues
- [ ] Check GitHub for PR reviews needed
- [ ] Check Slack mentions (if connected)
- [ ] Review calendar for upcoming meetings

## Context Building

- [ ] If meeting in <2h, prepare relevant context
- [ ] If PR review pending >24h, consider a nudge

## Guardrails

- Never fabricate browsing/tool results
- If a required file/tool/path is unavailable, state exactly what's missing in one line
- [ ] Track what was checked and when

## Reporting

If nothing needs attention, simply acknowledge:
"HEARTBEAT_OK"

If something needs attention, alert proactively.
