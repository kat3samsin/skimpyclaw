# Tools

## Tool layers

| Layer | Tools | When included |
|-------|-------|---------------|
| Built-in | Read, Write, Glob, Bash | Always (when tools enabled) |
| Browser | Browser (Playwright) | When `tools.browser.enabled` is true |
| MCP | Auto-discovered from mcporter | All servers in `~/.mcporter/mcporter.json` |
| Agent | code_with_agent, code_with_team, check_code_agent | When chatId + config present |

For coding worker details, see `docs/coding-agents.md`.

## Agent coding tools

`code_with_agent` and `code_with_team` run external coding CLIs (not in-process Read/Write/Bash tool calls).

Exact command builders live in `src/code-agents/utils.ts` (`buildCodeAgentArgs`):

- **Claude worker**: `claude -p --verbose --output-format stream-json --dangerously-skip-permissions ... <task>`
- **Codex worker**: `codex exec --full-auto --json --color never ... <task>`
- **Kimi worker**: `kimi --yolo -p <task> ...`

Related files:

- Tool schemas: `src/tools/definitions.ts` (`code_with_agent`, `code_with_team`)
- Orchestration/runtime: `src/code-agents/index.ts`
- Command construction: `src/code-agents/utils.ts`

## Built-in tools

- **Read** — read a file (restricted to `allowedPaths`)
- **Write** — write a file (restricted to `allowedPaths`, uses file locking for concurrent writes)
- **Glob** — find files by pattern (restricted to `allowedPaths`)
- **Bash** — run shell commands (blocked list via `isBashCommandSafe()`)

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

## Browser tool (Playwright)

Optional, disabled by default. Add to your tool config:

```json
"browser": {
  "enabled": true,
  "type": "chromium",
  "headless": true,
  "allowFile": false,
  "slowMoMs": 50,
  "userAgent": "",
  "viewport": { "width": 1280, "height": 720 },
  "profileDir": "${HOME}/.skimpyclaw/browser-profile",
  "executablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
}
```

**Actions:** `open(url)`, `click(selector)`, `type(selector,text)`, `select(selector,value)`, `hover(selector)`, `scroll(selector?|direction?|amount?)`, `waitFor(selector|text)`, `evaluate(script)`, `getText(selector?)`, `screenshot(file_path?)`, `wait(timeMs)`, `close()`

**Profile:** Uses a persistent profile directory so logins and cookies are remembered between runs. Default: `~/.skimpyclaw/browser-profile`.

**Security:** `file://` URLs are blocked unless `allowFile: true` and the path is inside `allowedPaths`. Screenshots must be saved inside `allowedPaths`. `evaluate` runs arbitrary JS — same trust model as Bash.

**CLI wrapper:**
```bash
skimpyclaw browser open https://example.com
skimpyclaw browser open https://example.com --browser firefox
skimpyclaw browser waitFor "h1"
skimpyclaw browser getText                   # full page text
skimpyclaw browser getText "h1"              # specific element
skimpyclaw browser evaluate --script "document.title"
skimpyclaw browser scroll
skimpyclaw browser scroll --direction up
skimpyclaw browser scroll --amount 500
skimpyclaw browser scroll ".target"          # scroll element into view
skimpyclaw browser select "#dropdown" "value"
skimpyclaw browser hover ".menu-item"
skimpyclaw browser screenshot
skimpyclaw browser wait --ms 30000           # manual login window
skimpyclaw browser close
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
