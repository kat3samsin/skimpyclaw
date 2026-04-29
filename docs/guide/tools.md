# Tools

## Tool layers

| Layer | Tools | When included |
|-------|-------|---------------|
| Built-in | Read, Write, Glob, Bash, Fetch | Always (when tools enabled) |
| MCP | Auto-discovered from mcporter | Full tool profile on Anthropic and Codex provider paths |
| Agent | code_with_agent, check_code_agent | When chatId + config present |

For coding worker details, see [Coding Agents](./coding-agents.md). For configured agents and reusable Discord `@alias` profiles, see [Agents](./agents.md).

## Agent coding tools

`code_with_agent` runs an external coding CLI (not an in-process Read/Write/Bash tool call).

Exact command builders live in `src/code-agents/utils.ts` (`buildCodeAgentArgs`):

- **Claude worker**: `claude -p --verbose --output-format stream-json --dangerously-skip-permissions ... <task>`
- **Codex worker**: `codex exec --full-auto --json --color never ... <task>`

Discord interactive coding sessions currently use Claude only.

Related files:

- Tool schema: `src/tools/definitions.ts` (`code_with_agent`)
- Runtime: `src/code-agents/index.ts`
- Command construction: `src/code-agents/utils.ts`

## Built-in tools

- **Read** — read a file (restricted to `allowedPaths`)
- **Write** — write a file (restricted to `allowedPaths`, uses file locking for concurrent writes)
- **Glob** — find files by pattern (restricted to `allowedPaths`)
- **Bash** — run shell commands (blocked list via `isBashCommandSafe()`)
- **Fetch** — make HTTP requests and return the response. HTML is auto-converted to plain text. Use for APIs, web search (e.g. `https://duckduckgo.com/html/?q=your+query`), or fetching page content

## Tool config

Tools are configured per-channel or per-cron-job:

```json
"tools": {
  "enabled": true,
  "allowedPaths": ["${HOME}/.skimpyclaw"],
  "maxIterations": 20,
  "bashTimeout": 30000
}
```

## MCP tools (mcporter)

SkimpyClaw auto-discovers MCP tools at runtime via [mcporter](https://github.com/nicobrinkkemper/mcporter).

**How it works:**
1. On first tool request, SkimpyClaw reads `~/.mcporter/mcporter.json`
2. Calls `listServers()` to find all configured MCP servers
3. For each server, discovers available tools with their schemas
4. Maps each tool to `mcp__{server}__{tool}` format (e.g. `mcp__my-server__search`)
5. Results are cached for the lifetime of the process

**mcporter config** (`~/.mcporter/mcporter.json`):
```json
{
  "mcpServers": {
    "my-tools": {
      "command": "npx",
      "args": ["@example/mcp-server"]
    },
    "my-server": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

Two transport types:
- **Stdio**: `command` + `args` — mcporter spawns the process
- **SSE**: `url` — mcporter connects to an HTTP SSE endpoint

**CLI commands:**
```bash
skimpyclaw tools list                                         # list all tools (built-in + MCP)
skimpyclaw tools install my-server --command npx --args '["@some/mcp-server"]'
skimpyclaw tools install my-server --url http://localhost:3001/sse
skimpyclaw tools remove my-server
```

`tools install` and `tools remove` modify `~/.mcporter/mcporter.json`. Restart SkimpyClaw after changes.

## Exec Approval

The `Bash` tool has a built-in safety gate that pauses and asks for human approval before running dangerous commands (risk tiers 2-3). See the dedicated [Exec Approval](./exec-approval.md) page for full details on risk tiers, configuration, and channel behavior.
