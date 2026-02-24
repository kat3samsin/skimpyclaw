#!/bin/bash
# Setup script for SkimpyClaw documentation site
# This script initializes the docs site and copies existing documentation

set -e

echo "🦞 Setting up SkimpyClaw Docs..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ] || ! grep -q "skimpyclaw" "package.json" 2>/dev/null; then
    echo -e "${RED}Error: Please run this script from the skimpyclaw project root${NC}"
    exit 1
fi

DOCS_DIR="web/docs"

# Check if docs already exist
if [ -d "$DOCS_DIR/.vitepress/dist" ]; then
    echo -e "${YELLOW}Docs build directory already exists. Removing...${NC}"
    rm -rf "$DOCS_DIR/.vitepress/dist"
fi

# Install dependencies
echo -e "${BLUE}Installing dependencies...${NC}"
cd "$DOCS_DIR"
pnpm install

# Copy existing documentation files
echo -e "${BLUE}Copying existing documentation...${NC}"
cd ../..

# Create guide directory
mkdir -p "$DOCS_DIR/guide"

# Copy docs with frontmatter
copy_doc() {
    local src="$1"
    local dest="$2"
    local title="$3"
    
    if [ -f "$src" ]; then
        echo -e "${GREEN}✓${NC} Copying $title"
        
        # Add frontmatter if not present
        if ! head -1 "$src" | grep -q "^---"; then
            cat > "$dest" << EOF
---
title: $title
outline: deep
---

EOF
            cat "$src" >> "$dest"
        else
            cp "$src" "$dest"
        fi
    else
        echo -e "${YELLOW}⚠${NC} Skipping $title (not found)"
    fi
}

# Copy all documentation files
copy_doc "docs/architecture.md" "$DOCS_DIR/guide/architecture.md" "Architecture"
copy_doc "docs/configuration.md" "$DOCS_DIR/guide/configuration.md" "Configuration"
copy_doc "docs/tools.md" "$DOCS_DIR/guide/tools.md" "Tools"
copy_doc "docs/subagents.md" "$DOCS_DIR/guide/subagents.md" "Subagents"
copy_doc "docs/dashboard.md" "$DOCS_DIR/guide/dashboard.md" "Dashboard"
copy_doc "docs/coding-agents.md" "$DOCS_DIR/guide/coding-agents.md" "Coding Agents"
copy_doc "docs/cli.md" "$DOCS_DIR/guide/cli.md" "CLI Reference"
copy_doc "docs/chat-commands.md" "$DOCS_DIR/guide/chat-commands.md" "Chat Commands"
copy_doc "docs/skills.md" "$DOCS_DIR/guide/skills.md" "Skills"
copy_doc "docs/data-storage.md" "$DOCS_DIR/guide/data-storage.md" "Data Storage"
copy_doc "docs/setup-guide.md" "$DOCS_DIR/guide/setup-guide.md" "Setup Guide"
copy_doc "docs/troubleshooting.md" "$DOCS_DIR/guide/troubleshooting.md" "Troubleshooting"
copy_doc "docs/claude-programmatic-tool-calling.md" "$DOCS_DIR/guide/claude-programmatic-tool-calling.md" "Programmatic Tool Calling"

# Create guide index if it doesn't exist
if [ ! -f "$DOCS_DIR/guide/index.md" ]; then
    echo -e "${BLUE}Creating guide index...${NC}"
    cat > "$DOCS_DIR/guide/index.md" << 'EOF'
---
title: Getting Started
outline: deep
---

# Getting Started

Welcome to SkimpyClaw! This guide will help you get up and running with your personal AI assistant.

## What is SkimpyClaw?

SkimpyClaw is a lightweight (~20k LOC) personal AI assistant that runs locally on your machine. It provides:

- **Multi-channel chat** — Telegram and Discord bots with persistent conversation history
- **Tool-enabled agent** — File read/write, bash, browser (Playwright), MCP tools
- **Cron scheduler** — Run prompts or scripts on a schedule
- **Web dashboard** — Manage everything through a beautiful web interface
- **Subagents** — Autonomous task delegation with retry and concurrency control

## Quick Start

```bash
# Install dependencies
pnpm install

# Run setup wizard
pnpm run onboard

# Start the service
pnpm dev
```

## Next Steps

- Read the [Architecture](/guide/architecture) overview
- Learn about [Configuration](/guide/configuration)
- Explore available [Tools](/guide/tools)
- Set up [Subagents](/guide/subagents) for complex tasks

## Getting Help

- Check the [Troubleshooting](/guide/troubleshooting) guide
- Browse the [API Reference](/api/)
- Open an issue on [GitHub](https://github.com/kat3samsin/skimpyclaw)
EOF
fi

# Create API docs
echo -e "${BLUE}Creating API documentation...${NC}"
mkdir -p "$DOCS_DIR/api"

if [ ! -f "$DOCS_DIR/api/index.md" ]; then
    cat > "$DOCS_DIR/api/index.md" << 'EOF'
---
title: API Reference
outline: deep
---

# API Reference

SkimpyClaw exposes a REST API for integration with external services and the web dashboard.

## Base URL

```
http://localhost:18790
```

## Authentication

Dashboard API routes require Bearer token authentication:

```bash
Authorization: Bearer <token>
```

The token is stored in `config.dashboard.token` and shown on startup.

## Endpoints

### Gateway Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| GET | `/status` | Runtime status |
| POST | `/message` | Send a message |
| POST | `/model` | Switch model |
| POST | `/cron/:id/run` | Trigger a cron job |

### Dashboard API

See [Dashboard API](/api/dashboard-api) for detailed endpoint documentation.
EOF
fi

# Create reference docs
echo -e "${BLUE}Creating reference documentation...${NC}"
mkdir -p "$DOCS_DIR/reference"

if [ ! -f "$DOCS_DIR/reference/index.md" ]; then
    cat > "$DOCS_DIR/reference/index.md" << 'EOF'
---
title: Reference
outline: deep
---

# Reference

Quick reference guides for SkimpyClaw configuration and usage.

## Available References

- [Config Options](/reference/config-options) — All configuration options
- [Environment Variables](/reference/environment-variables) — Required and optional env vars
- [Model Aliases](/reference/model-aliases) — Predefined model shortcuts
EOF
fi

# Create placeholder reference files
touch "$DOCS_DIR/reference/config-options.md"
touch "$DOCS_DIR/reference/environment-variables.md"
touch "$DOCS_DIR/reference/model-aliases.md"

# Copy logo if it exists
if [ -f "logo.png" ]; then
    echo -e "${GREEN}✓${NC} Copying logo"
    cp "logo.png" "$DOCS_DIR/public/" 2>/dev/null || mkdir -p "$DOCS_DIR/public" && cp "logo.png" "$DOCS_DIR/public/"
fi

echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. cd $DOCS_DIR"
echo "  2. pnpm dev          # Start dev server"
echo "  3. pnpm build        # Build for production"
echo ""
echo "Docs site will be available at: http://localhost:5173"
