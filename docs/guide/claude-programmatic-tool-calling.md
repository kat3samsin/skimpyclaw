# Claude Programmatic Tool Calling

## Overview

Anthropic released a set of improvements to Claude's tool calling capabilities — effectively "tool calling 2.0." These changes address fundamental inefficiencies in the classic JSON tool-call loop that has been unchanged for two years, particularly for long-running, complex agent tasks.

## How It Differs from Traditional Tool Calling

**Classic flow:** The model outputs a single JSON tool call, the server executes it and returns the result, then the model decides the next step. Each tool invocation is a full round trip, and every intermediate result (including irrelevant metadata) stays in the context window.

**Programmatic flow:** Instead of one-tool-at-a-time JSON, the model writes a block of code that can invoke multiple tools, use for-loops, conditionals, and pass results between functions — all in a single execution step. A `code_execution` sandbox tool is added to the model's available tools, and each tool definition gets an `allowed_caller` parameter pointing to it. The model returns code; the agent runtime extracts tool calls from that code, executes them, and feeds results back for synthesis.

This keeps intermediate data (large HTML, metadata, IDs) scoped inside the code's variables rather than polluting the context window.

## Token Efficiency Tactics

### Programmatic Tool Call Batching

- Model writes code with loops and conditionals to batch multiple tool calls into one round trip.
- Reduces model round trips to the minimum number of LLM calls.
- **30-50% token savings** in Anthropic's experiments; context window stays dramatically smaller than traditional tool calling.

### Dynamic Filtering for Web Fetch

- Instead of dumping full raw HTML into context, a code layer filters and extracts only relevant content before returning it to the model.
- **~24% token reduction** on average.
- Activated by pointing to the special versioned web fetch tool (`2026_02_09`).

### Tool Search / Deferred Loading

- Instead of loading all tool schemas upfront (which can be hundreds of tools/MCPs), a single `tool_search` tool (~500 tokens) retrieves relevant tool definitions on demand.
- Tools marked with `deferred_loading: true` are hidden by default; the model discovers them via search.
- **Up to ~80% context window optimization** for agents with 10+ tools.
- Per-MCP granularity: set a default defer policy but override specific actions to remain always-visible.

### Tool Use Examples

- New `input_examples` field on tool definitions provides concrete call examples.
- Helps the model handle complex nested structures, optional parameters, date formats, and cross-field dependencies.
- **Accuracy improvement from 72% to 90%** on complex parameter handling in Anthropic's testing.

## Implementation Notes

- Enabling programmatic calling requires adding the `code_execution` tool and setting `allowed_caller` on each tool — no full agent restructure needed.
- Dynamic filtering and deferred loading are orthogonal; combine them for maximum savings.
- Tool use examples are most valuable for tools with many optional fields or non-obvious formatting requirements.
