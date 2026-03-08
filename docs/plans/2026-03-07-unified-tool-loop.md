# Unified Tool Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Status (2026-03-08):** Migration is complete. Provider routing is adapter-based (`src/providers/index.ts`) and the unified loop (`runToolLoop`) is the only tool-loop runtime path.
>
> **Historical note:** References below to feature flags (`config.experimental.unifiedToolLoop`) and side-by-side legacy loop phases are implementation history from the migration period, not current runtime behavior.

**Goal:** Eliminate per-provider tool loop duplication by creating a single agentic loop that works with a normalized provider interface.

**Architecture:** Extract the shared agentic loop logic (iteration, guard, compaction, observability, audit, tool execution) into a generic orchestrator. Each provider implements a thin adapter that handles only API-specific concerns (request building, response parsing, message format conversion). The orchestrator calls adapters through a normalized interface.

**Tech Stack:** TypeScript, Vitest, existing provider SDK clients (Anthropic, OpenAI, raw fetch for Codex)

---

## Executive Summary

The three `chatWithTools*` functions (`chatWithToolsAnthropic`, `chatWithToolsCodex`, `chatWithToolsOpenAI`) each contain ~200-250 lines implementing the same agentic loop pattern. Approximately 60-70% of each function is identical logic: iteration control, abort signal checking, context compaction, tool call guard, tool execution, audit event recording, observability tracing, usage tracking, and result assembly. The remaining 30-40% is genuinely provider-specific: API request building, response parsing, message format differences, and stop-reason detection.

This plan extracts the shared logic into a single `ToolLoopOrchestrator` that delegates provider-specific concerns to a `ProviderAdapter` interface. The migration is phased to minimize risk, with each phase independently shippable and testable.

---

## Current-State Findings

### Duplication Map

| Concern | anthropic.ts | codex.ts | openai.ts | Identical? |
|---------|-------------|----------|-----------|------------|
| Tool definition resolution | L155-156 | L325-331 | L157-163 | ~90% (MCP flag differs) |
| Iteration loop + max check | L180-366 | L340-557 | L183-396 | ~95% |
| Abort signal check | L182-187 | L346-351 | L185-190 | 100% |
| Context compaction call | L190-199 | L349-359 | L193-202 | ~80% (different compact fn) |
| ToolCallGuard instantiation | L175 | L338 | L181 | 100% |
| Guard spin detection | L303-314 | L494-504 | L332-342 | ~95% (msg format differs) |
| Guard progress detection | L343-347 | L537-541 | L375-379 | ~95% (msg format differs) |
| Tool execution (executeTool) | L318 | L513 | L351 | 100% |
| splitToolResult call | L319 | L514 | L352 | 100% |
| Audit event recording | L328-334 | L522-528 | L360-366 | 100% |
| Langfuse tool observation | L296-300 | L506-509 | L344-347 | 100% |
| Usage recording | L237-243 | L385-390 | L226-232 | ~85% (different fn) |
| Generation observation | L221-226 | L374-379 | L206-214 | ~90% |
| Token guard recording | L252-255 | L399-403 | L240-244 | 100% |
| Max iteration warning | L368 | L559 | L398 | 100% |
| Compaction log entry | L199 | L358 | L201 | 100% |
| Tool log assembly | L292-293 | L490-491 | L328-329 | ~95% |

### Provider-Specific Logic (NOT duplicated)

| Concern | Provider |
|---------|----------|
| `anthropic.messages.create()` call with thinking/caching params | Anthropic |
| `codexFetch()` + `parseCodexSSE()` raw HTTP + SSE parsing | Codex |
| `client.chat.completions.create()` with Kimi extras | OpenAI |
| Anthropic `tool_use`/`tool_result` message format | Anthropic |
| Codex `function_call`/`function_call_output` format | Codex |
| OpenAI `tool_calls`/`tool` role message format | OpenAI |
| Codex finalization pass (empty outputText workaround) | Codex |
| Kimi `reasoning_content` replay requirement | OpenAI |
| `<think>` tag stripping for MiniMax | OpenAI |
| Stop reason detection (`stop_reason`, `finish_reason`, empty `functionCalls`) | All (different) |
| System prompt handling (system param vs instructions field) | All (different) |
| Cache control breakpoints | Anthropic only |

### Context Manager Duplication

`context-manager.ts` has 3 near-identical function sets:
- `compactAnthropicMessages` / `compactOpenAIMessages` / `compactCodexMessages` — same algorithm, different message format helpers
- `splitAnthropicHeadTail` / `splitOpenAIHeadTail` / `splitCodexHeadTail` — same logic, different "is this a tool result?" predicate
- `truncateAnthropicHead` / `truncateOpenAIHead` / `truncateCodexHead` — same logic, different field names
- `serializeAnthropicMessages` / `serializeOpenAIMessages` / `serializeCodexMessages` — same pattern, different structure walking

### Existing Interfaces (Already in types.ts)

```typescript
// types.ts:225-228 — Already defined but UNUSED
export interface ModelProvider {
  name: string;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<string>;
}

// providers/types.ts:39-44 — Already defined but UNUSED
export interface Provider {
  readonly name: string;
  isAvailable(): boolean;
  chat(params: ProviderChatParams): Promise<string>;
  chatWithTools(params: ProviderToolChatParams): Promise<ToolChatResult>;
}
```

These interfaces exist but nothing implements them. The routing in `providers/index.ts` uses procedural if/else dispatch instead.

---

## Target Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/providers/adapter.ts` | `ProviderAdapter` interface + `NormalizedResponse` type |
| `src/providers/tool-loop.ts` | `runToolLoop()` — the unified agentic loop |
| `src/providers/adapters/anthropic-adapter.ts` | Anthropic adapter implementation |
| `src/providers/adapters/codex-adapter.ts` | Codex adapter implementation |
| `src/providers/adapters/openai-adapter.ts` | OpenAI adapter implementation |
| `src/__tests__/tool-loop.test.ts` | Unit tests for the unified loop |
| `src/__tests__/adapters.test.ts` | Unit tests for each adapter |

### ProviderAdapter Interface

```typescript
// src/providers/adapter.ts

/** Normalized representation of a model response within the tool loop. */
export interface NormalizedResponse {
  /** Whether the model wants to call tools (vs. returning a final answer) */
  hasToolCalls: boolean;
  /** Tool calls extracted from the response */
  toolCalls: NormalizedToolCall[];
  /** Text content from the response (final answer when hasToolCalls=false) */
  textContent: string;
  /** Raw usage data from the provider */
  usage?: { inputTokens: number; outputTokens: number };
  /** Raw response object (provider-specific, for appending to message history) */
  rawResponse: unknown;
}

export interface NormalizedToolCall {
  /** Unique ID for this tool call (tool_use_id, call_id, toolCall.id) */
  id: string;
  /** Tool name */
  name: string;
  /** Parsed arguments */
  args: Record<string, any>;
  /** Raw arguments string (for logging) */
  rawArgs: string;
}

export interface ProviderAdapter {
  readonly name: string;

  /** Build the initial API messages from ChatMessage[] (strip system, format content) */
  buildMessages(messages: ChatMessage[], options: ChatOptions, config: Config): ProviderMessages;

  /** Build tool definitions in provider-native format */
  buildToolDefs(toolDefs: any[]): any[];

  /** Make one API call with tools. Returns normalized response. */
  call(
    messages: ProviderMessages,
    toolDefs: any[],
    options: ChatOptions,
    config: Config,
  ): Promise<NormalizedResponse>;

  /** Append the assistant's raw response to the message history */
  appendAssistantResponse(messages: ProviderMessages, rawResponse: unknown): void;

  /** Append a tool result to the message history */
  appendToolResult(messages: ProviderMessages, toolCallId: string, result: string, isError?: boolean): void;

  /** Compact messages when context grows too large */
  compactMessages(
    messages: ProviderMessages,
    config: ContextManagementConfig | undefined,
    iteration: number,
    fullConfig?: Config,
  ): Promise<CompactionResult<any>>;

  /** Record usage/cost to the usage tracking system */
  recordUsage(model: string, usage: unknown, trigger?: string, agentId?: string): void;
}

/** Opaque wrapper — each adapter defines its own internal message format */
export interface ProviderMessages {
  /** The mutable message array (format depends on provider) */
  messages: any[];
  /** System prompt / instructions (extracted once, reused per call) */
  systemParam?: any;
}
```

### Unified Tool Loop

```typescript
// src/providers/tool-loop.ts

export async function runToolLoop(
  adapter: ProviderAdapter,
  messages: ChatMessage[],
  options: ChatOptions,
  config: Config,
  toolConfig: ToolConfig,
  toolContext?: ExecuteToolContext,
): Promise<ToolChatResult> {
  const maxIterations = toolConfig.maxIterations || 20;
  const guard = new ToolCallGuard(toolConfig.maxTurnTokens);
  const toolLog: string[] = [];

  // 1. Resolve tool defs once
  const includeSpawn = !!(toolContext?.fullConfig && (toolContext?.chatId || toolContext?.isCronJob));
  const rawToolDefs = await getToolDefinitions(toolConfig, { ... });
  const providerToolDefs = adapter.buildToolDefs(rawToolDefs);

  // 2. Build initial messages
  const providerMessages = adapter.buildMessages(messages, options, config);

  // 3. Agentic loop
  for (let i = 0; i < maxIterations; i++) {
    if (toolContext?.abortSignal?.aborted) { return cancelled result; }

    // Compact
    const compaction = await adapter.compactMessages(...);
    // ... log compaction ...

    // API call
    const genObs = await startGenerationObservation(...);
    const response = await adapter.call(providerMessages, providerToolDefs, options, config);
    adapter.recordUsage(modelId, response.usage, ...);
    guard.recordTokens(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);
    genObs?.end();

    // No tool calls → done
    if (!response.hasToolCalls) {
      return { response: response.textContent || fallback, toolCalls: toolLog, ... };
    }

    // Append assistant response
    adapter.appendAssistantResponse(providerMessages, response.rawResponse);

    // Execute each tool call
    for (const tc of response.toolCalls) {
      // Guard spin check
      // executeTool()
      // splitToolResult()
      // Guard progress check
      // Audit event
      // Langfuse observation
      // adapter.appendToolResult()
    }
  }

  return max iterations result;
}
```

### How Routing Changes

**Before** (`providers/index.ts`):
```typescript
export async function chatWithTools(...) {
  if (codex) return chatWithToolsCodex({ ... });
  if (anthropic) return chatWithToolsAnthropic({ ... });
  if (openai) return chatWithToolsOpenAI({ ... });
}
```

**After** (`providers/index.ts`):
```typescript
export async function chatWithTools(...) {
  const adapter = getAdapter(provider); // returns ProviderAdapter
  return runToolLoop(adapter, messages, options, config, toolConfig, toolContext);
}

function getAdapter(provider: string): ProviderAdapter {
  if (codex) return new CodexAdapter();
  if (provider === 'anthropic') return new AnthropicAdapter();
  return new OpenAIAdapter(provider);
}
```

---

## Phased Migration Plan

### Phase 0: Preparation (1 PR)

**Goal:** Extract shared helpers, add the interface, zero behavior change.

1. Create `src/providers/adapter.ts` with the `ProviderAdapter` interface and `NormalizedResponse` types
2. Extract duplicated helper functions into shared utilities:
   - `buildToolLogEntry(name, inputStr, resultPreview)` → shared tool log formatting
   - `buildIterationLog(provider, iteration, maxIterations, modelId)` → shared console.log
3. Add tests for the new interface types (compile-time only)
4. No changes to existing tool loop functions

### Phase 1: Unified Tool Loop + Anthropic Adapter (1 PR)

**Goal:** Implement the loop and first adapter behind a feature flag.

1. Create `src/providers/tool-loop.ts` with `runToolLoop()`
2. Create `src/providers/adapters/anthropic-adapter.ts` implementing `ProviderAdapter`
3. Add feature flag: `config.experimental?.unifiedToolLoop: boolean` (default false)
4. In `chatWithToolsAnthropic()`: if flag is on, delegate to `runToolLoop(new AnthropicAdapter(), ...)`; otherwise run existing code
5. Write comprehensive tests for `runToolLoop()` with a mock adapter
6. Write tests for `AnthropicAdapter` in isolation
7. Run full test suite to verify no regression

### Phase 2: OpenAI Adapter (1 PR)

**Goal:** Second adapter, still behind feature flag.

1. Create `src/providers/adapters/openai-adapter.ts`
2. Wire into `chatWithToolsOpenAI()` behind the same feature flag
3. Handle Kimi-specific logic (reasoning_content, interleaved) as adapter configuration
4. Handle MiniMax `<think>` stripping in the adapter
5. Tests for `OpenAIAdapter`

### Phase 3: Codex Adapter (1 PR)

**Goal:** Third adapter. This is the trickiest due to SSE parsing and finalization pass.

1. Create `src/providers/adapters/codex-adapter.ts`
2. The finalization pass (lines 418-456 in codex.ts) becomes a post-loop hook or part of the adapter's "no tool calls" handling
3. Wire into `chatWithToolsCodex()` behind feature flag
4. Tests for `CodexAdapter`

### Phase 4: Unify Context Manager (1 PR)

**Goal:** Collapse 3 compaction functions into 1 generic function.

1. Add a `MessageFormatHelper` interface to `adapter.ts`:
   - `isToolResult(item): boolean`
   - `truncateToolResult(item): item`
   - `serialize(items): string`
   - `buildSummaryMessage(summary: string): any`
2. Create `compactMessages<T>(items: T[], helper: MessageFormatHelper<T>, config, iteration, fullConfig)` — single generic function
3. Each adapter implements `MessageFormatHelper` for its format
4. Delete `compactAnthropicMessages`, `compactOpenAIMessages`, `compactCodexMessages`
5. Delete `splitAnthropicHeadTail`, `splitOpenAIHeadTail`, `splitCodexHeadTail`
6. Delete `truncateAnthropicHead`, `truncateOpenAIHead`, `truncateCodexHead`
7. Update context-manager tests

### Phase 5: Remove Old Code + Feature Flag (1 PR)

**Goal:** Delete the legacy tool loop implementations, remove feature flag.

1. Delete `chatWithToolsAnthropic()` body (replace with direct `runToolLoop` call)
2. Delete `chatWithToolsCodex()` body
3. Delete `chatWithToolsOpenAI()` body
4. Remove the feature flag check — unified loop is the only path
5. Optionally keep the old function signatures as thin wrappers for backward compat
6. Clean up unused imports and dead code
7. Update `providers/index.ts` routing to use `getAdapter()` pattern

### Phase 6: Cleanup + Provider Interface (1 PR)

**Goal:** Implement the existing `Provider` interface from `providers/types.ts`.

1. Make each adapter also implement `Provider.chat()` (non-tool simple chat)
2. Replace `chatAnthropic`, `chatCodex`, `chatOpenAI` free functions with adapter methods
3. Replace `isAnthropicAvailable()`, `isCodexAvailable()`, `isOpenAIAvailable()` with `adapter.isAvailable()`
4. Simplify `providers/index.ts` to a provider registry pattern
5. Delete unused `ModelProvider` interface from `types.ts`

---

## Testing and Validation Plan

### Unit Tests

| Test | File | What it validates |
|------|------|-------------------|
| Mock adapter + runToolLoop | `tool-loop.test.ts` | Loop iteration, abort, max iterations, guard blocking, tool execution, compaction, audit events |
| AnthropicAdapter.buildMessages | `adapters.test.ts` | System extraction, cache control, thinking config |
| AnthropicAdapter.call mock | `adapters.test.ts` | Request params, response normalization, stop_reason detection |
| CodexAdapter.call mock | `adapters.test.ts` | SSE parsing, function_call extraction, finalization |
| OpenAIAdapter.call mock | `adapters.test.ts` | finish_reason detection, Kimi extras, think stripping |
| Adapter.appendToolResult | `adapters.test.ts` | Correct message format per provider |
| Generic compactMessages | `context-manager.test.ts` | Same coverage as existing 3 tests, single implementation |

### Integration Tests

- **Behavioral equivalence**: For each provider, run the same tool-calling scenario through both old and new code paths (feature flag on/off) and assert identical `ToolChatResult` output.
- **Edge cases**: Empty tool calls, max iterations hit, abort signal, spin detection block, no-progress nudge, context compaction trigger.

### Regression Strategy

1. Feature flag defaults to OFF — existing behavior untouched in production
2. Each phase is a separate PR with its own test coverage
3. Run `pnpm build && pnpm test` (500 tests) on every PR
4. Manual Telegram testing with flag ON before each merge
5. After Phase 3, run with flag ON for ≥1 week before Phase 5 (deletion)

### What to Measure

| Metric | How | Success criteria |
|--------|-----|------------------|
| Tool loop iterations per turn | Log `[tool-loop] completed in N iterations` | Same distribution as before |
| Total tokens per turn | Usage records in JSONL | No increase >5% |
| Compaction frequency | Log `[context-manager] compacted` count | Same frequency |
| Error rate | Audit traces with status=error | No increase |
| Spin detection blocks | Log `[guard] BLOCKED` count | Same or fewer |
| Latency per iteration | `Date.now()` diff logged per iteration | No increase >10% |
| Feature flag adoption | Config reads | 100% ON before Phase 5 |

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Codex finalization pass doesn't fit adapter model cleanly | M | High | Add optional `onNoToolCalls(response, messages)` hook to adapter interface for post-processing |
| Kimi reasoning_content replay breaks with normalized messages | H | Medium | Keep raw message objects in ProviderMessages; adapter controls serialization |
| Context compaction generics add complexity without reducing code | L | Medium | If generic version is more complex, keep provider-specific compaction in adapters |
| Feature flag adds testing surface area | L | Low | Flag is simple boolean; test both paths in CI |
| Circular dependency between tool-loop.ts and adapters | M | Medium | Adapter interface in separate file; adapters import from tool-loop only for types |
| Anthropic cache_control breakpoints need tool def mutation | L | Low | Adapter's `buildToolDefs()` handles this; tool-loop passes raw defs |
| MCP tool discovery is Anthropic-only, affects tool def resolution | M | Medium | `getToolDefinitions()` already handles `includeMcp` flag; pass through to loop unchanged |
| Breaking change in ToolChatResult shape | H | Low | Interface is already defined; no changes needed |
| Performance regression from adapter indirection | L | Low | Single virtual dispatch per iteration; negligible vs. network round-trip |

---

## Task Checklist

### Phase 0: Preparation
- [ ] Create `src/providers/adapter.ts` with interfaces (S)
- [ ] Extract shared log formatting helpers into `src/providers/loop-utils.ts` (S)
- [ ] Add compile-time tests for new types (S)
- [ ] `pnpm build && pnpm test` passes (S)

### Phase 1: Unified Loop + Anthropic Adapter
- [ ] Create `src/providers/tool-loop.ts` with `runToolLoop()` (L)
- [ ] Create `src/providers/adapters/anthropic-adapter.ts` (M)
- [ ] Add `experimental.unifiedToolLoop` to Config type (S)
- [ ] Wire feature flag in `chatWithToolsAnthropic` (S)
- [ ] Write mock-adapter tests for `runToolLoop` — iteration, abort, guard, compaction (L)
- [ ] Write AnthropicAdapter unit tests (M)
- [ ] Behavioral equivalence test: flag on vs off (M)
- [ ] `pnpm build && pnpm test` passes (S)

### Phase 2: OpenAI Adapter
- [ ] Create `src/providers/adapters/openai-adapter.ts` (M)
- [ ] Handle Kimi reasoning_content in adapter (S)
- [ ] Handle MiniMax think-stripping in adapter (S)
- [ ] Handle provider-native tool rejection (`$` prefix) in adapter (S)
- [ ] Wire feature flag in `chatWithToolsOpenAI` (S)
- [ ] Write OpenAIAdapter unit tests (M)
- [ ] Behavioral equivalence test (M)
- [ ] `pnpm build && pnpm test` passes (S)

### Phase 3: Codex Adapter
- [ ] Create `src/providers/adapters/codex-adapter.ts` (M)
- [ ] Handle finalization pass as adapter hook (M)
- [ ] Wire feature flag in `chatWithToolsCodex` (S)
- [ ] Write CodexAdapter unit tests (M)
- [ ] Behavioral equivalence test (M)
- [ ] `pnpm build && pnpm test` passes (S)

### Phase 4: Unify Context Manager
- [ ] Add `MessageFormatHelper` interface to adapter.ts (S)
- [ ] Implement generic `compactMessages()` (M)
- [ ] Implement MessageFormatHelper in each adapter (M)
- [ ] Update context-manager tests to use generic function (M)
- [ ] Delete old per-provider compaction functions (S)
- [ ] `pnpm build && pnpm test` passes (S)

### Phase 5: Remove Old Code
- [ ] Replace `chatWithToolsAnthropic` body with `runToolLoop` call (S)
- [ ] Replace `chatWithToolsCodex` body with `runToolLoop` call (S)
- [ ] Replace `chatWithToolsOpenAI` body with `runToolLoop` call (S)
- [ ] Remove feature flag (S)
- [ ] Delete dead code and unused imports (S)
- [ ] `pnpm build && pnpm test` passes (S)

### Phase 6: Provider Registry
- [ ] Add `chat()` to adapters (non-tool path) (M)
- [ ] Create provider registry in `providers/index.ts` (M)
- [ ] Replace free function routing with registry lookup (S)
- [ ] Delete unused `ModelProvider` from types.ts (S)
- [ ] `pnpm build && pnpm test` passes (S)

**Estimated total:** ~15 S tasks, ~12 M tasks, ~3 L tasks across 7 PRs.

---

## Recommendation: First 1-2 PRs

**PR 1: Phase 0 — Interface + shared helpers** (all S tasks, low risk, fast review)

This PR ships the `ProviderAdapter` interface and extracts trivial shared helpers. Zero behavior change. Establishes the contract that all subsequent work implements against. Gets the team (you) aligned on the abstraction before writing adapter code.

**PR 2: Phase 1 — Unified loop + Anthropic adapter** (the meat)

This is the highest-value PR. It proves the abstraction works end-to-end with the most-used provider. The feature flag means it can merge without risk. Once this works, Phases 2-3 are mechanical — same pattern, different API client.

Start with these two. If Phase 1 reveals that the adapter interface needs changes, you can adjust before building the other two adapters.
