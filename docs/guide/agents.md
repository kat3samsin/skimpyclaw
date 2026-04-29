---
title: Agents
outline: deep
---

# Agents

SkimpyClaw agents are core runtime identities. They are not Discord-specific.

An agent is selected by `agentId` and run through `runAgentTurn(agentId, ...)`. Each configured agent can have its own identity, model, thinking level, prompt templates, and memory under `~/.skimpyclaw/agents/<agent-id>/`.

## Core Agents

Agents are configured in `~/.skimpyclaw/config.json`:

```json
{
  "agents": {
    "default": "main",
    "list": {
      "main": {
        "identity": { "name": "SkimpyClaw", "emoji": "👙🦞" },
        "model": "anthropic/claude-haiku-4-5"
      },
      "reviewer": {
        "identity": { "name": "Reviewer", "emoji": "🔎" },
        "model": "anthropic/claude-sonnet-4-6",
        "thinking": "high"
      }
    }
  }
}
```

Prompt files live at:

```text
~/.skimpyclaw/agents/<agent-id>/
├── IDENTITY.md
├── TOOLS.md
└── memory/
```

The default chat, cron, heartbeat, and channel handlers use `agents.default` unless their code path passes a different `agentId`.

## Discord Profiles

Discord profiles are a Discord-only alias and thread-routing layer on top of core agents. A profile maps an alias such as `@reviewer` to one configured `agents.list` entry and can add model, effort, and prompt overrides.

Profiles and thread bindings are stored separately from `config.json`:

```text
~/.skimpyclaw/discord-thread-agents.json
```

A profile stores:

- `alias`: Discord-facing name, used as `@alias`
- `agentId`: target key from `config.agents.list`
- `model`: optional model override
- `thinking`: optional effort override (`none`, `low`, `medium`, `high`, `xhigh`)
- `promptOverlay`: optional instructions injected under `## Discord Thread Agent`

## Discord Commands

| Command | Description |
|---------|-------------|
| `/agent create <alias> [agent-id]` | Create or update a reusable Discord profile. Defaults to `agents.default` when `agent-id` is omitted |
| `/agent use <alias> [message]` | Run the profile in the current thread, or create a new thread from the channel, then optionally run the first message |
| `/agent model [alias] <model>` | Set a profile model override. If `alias` is new, creates it against the default agent |
| `/agent effort [alias] <level>` | Set a profile effort override. `think` is also accepted as the subcommand |
| `/agent prompt [alias] <prompt text>` | Set a profile prompt overlay |
| `/agent delete <alias>` | Delete a profile and its thread bindings |
| `/agent list` | List configured profiles |
| `/agent status` | Show the profile active in the current thread |

## Mentions

Once a profile exists, invoke it with:

```text
@reviewer summarize the proposed release notes
```

Routing behavior:

- In a Discord server channel, `@alias <message>` creates a thread, binds it to the profile, announces the thread URL, and runs the message there.
- In an existing Discord thread, `@alias <message>` binds that thread and runs the message there.
- In a Discord DM, `@alias <message>` runs directly in the DM without creating a thread.
- After a thread is bound, ordinary non-command messages in that thread route to the bound profile automatically.

## Prompt Attachments

`/agent prompt` can read an attached document instead of inline text:

```text
/agent prompt reviewer
```

Attach a text-like file or PDF to the same Discord message. Supported files include `.md`, `.txt`, `.json`, `.yaml`, source-code files, logs, and `.pdf`; attachment downloads are limited to 2 MB, extracted text is capped at 100,000 characters, and stored profile prompts are capped at 20,000 characters.

## Example

```text
/agent create reviewer main
/agent model reviewer anthropic/claude-sonnet-4-6
/agent effort reviewer high
/agent prompt reviewer Focus on correctness issues, missing tests, and risky behavior changes.
/agent use reviewer Review the current plan before implementation.
```

## Relationship To Coding Agents

Core SkimpyClaw agents and Discord profiles run the normal in-process agent loop. They can still call `code_with_agent` if their tool configuration allows it, but they are not themselves external CLI workers.

For external coding workers, see [Coding Agents](./coding-agents.md).
