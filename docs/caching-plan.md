# SkimpyClaw Caching Implementation Plan

**Version:** 1.0  
**Date:** 2026-02-16  
**Status:** PLAN-ONLY (No production code modifications)  
**Author:** AI Agent Analysis  

---

## Executive Summary

This document outlines a comprehensive caching strategy for SkimpyClaw, a lightweight personal AI assistant. The goal is to reduce latency, minimize redundant LLM API calls, and improve overall system responsiveness while maintaining data consistency and observability.

**Key Findings:**
- Current system has NO caching mechanisms
- Multiple redundant file reads (templates, skills, configs)
- LLM API calls are uncached and expensive
- Dashboard API endpoints recalculate on every poll
- Tool executions repeatedly read the same files

---

## 1. Goals and Non-Goals

### 1.1 Goals

| Priority | Goal | Target Metric |
|----------|------|---------------|
| P0 | Reduce repeated LLM API calls for similar prompts | 30-50% reduction in API costs |
| P0 | Cache immutable/semi-immutable file reads | <10ms for cached file reads |
| P1 | Implement stale-while-revalidate for dashboard APIs | Sub-50ms dashboard response times |
| P1 | Add request coalescing to prevent cache stampedes | Zero thundering herd incidents |
| P2 | Cache tool execution results where appropriate | 20-40% faster tool loops |
| P2 | Provide cache observability and metrics | Full visibility into hit/miss rates |

### 1.2 Non-Goals

| Item | Rationale |
|------|-----------|
| **Distributed caching (Redis) in MVP** | Single-node personal assistant; in-memory sufficient for v1 |
| **Caching of Write operations** | Write-through caching adds complexity; not needed for personal use |
| **LLM response streaming cache** | Streaming responses are per-session; caching adds complexity |
| **Browser tool state caching** | Browser state is inherently ephemeral |
| **Cross-process cache sharing** | SkimpyClaw runs as single process |
| **Persistent cache across restarts** | Warmup time acceptable for personal assistant |

---

## 2. Current State Findings

### 2.1 Hot Path Analysis

```
┌─────────────────────────────────────────────────────────────────────┐
│                         REQUEST FLOW                                │
├─────────────────────────────────────────────────────────────────────┤
│  Telegram/Discord → gateway.ts → agent.ts → [Anthropic|Codex|OpenAI]│
│                           ↓                                         │
│                     tools.ts (Read/Write/Glob/Bash/Browser)         │
│                           ↓                                         │
│                     subagent.ts (background tasks)                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Identified Redundancies

| Component | Current Behavior | Frequency | Cacheable |
|-----------|------------------|-----------|-----------|
| `loadAgentTemplates()` | Reads 7 template files from disk | Every agent turn | Yes - TTL 60s |
| `loadSkills()` | Scans skills directory, parses frontmatter | Every agent turn | Yes - TTL 60s |
| `discoverMcpTools()` | Lists MCP tools from mcporter | Every tool resolution | Yes - TTL 300s |
| `buildSystemPrompt()` | Reconstructs prompt from templates | Every agent turn | Yes - Content-hash |
| `chat()` / `chatWithTools()` | Calls LLM APIs | Every request | Yes - Semantic |
| `/api/dashboard/status` | Aggregates status data | Every 5s (polling) | Yes - SWR 5s |
| `/api/dashboard/sessions` | Lists session files | Every poll | Yes - SWR 10s |
| `executeReadFile()` | Reads file from disk | Every tool use | Yes - mtime-based |
| `executeListDirectory()` | Lists directory contents | Every tool use | Yes - mtime-based |
| `loadConfig()` | Reads config.json | Every request | Yes - TTL 30s |

### 2.3 Current Performance Bottlenecks

1. **Template Reloading**: 7 file reads per agent turn (unnecessary)
2. **Skill Scanning**: Directory traversal + gray-matter parsing every turn
3. **Config Reloading**: JSON parse on every operation
4. **Dashboard Polling**: Full recalculation every 5 seconds
5. **Repeated File Reads**: Same files read multiple times in tool loops

---

## 3. Cache Layers Architecture

### 3.1 Layer Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CACHE HIERARCHY                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  L1: In-Memory Object Cache (Node.js Map/WeakMap)              │   │
│  │  ├── Config cache (TTL: 30s)                                   │   │
│  │  ├── Template cache (TTL: 60s, file-watch invalidation)        │   │
│  │  ├── Skills cache (TTL: 60s, file-watch invalidation)          │   │
│  │  └── MCP tools cache (TTL: 300s, explicit clear API)           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              ↓                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  L2: File System Cache (mtime-based)                           │   │
│  │  ├── Read tool cache (key: path+mtime)                         │   │
│  │  ├── Glob tool cache (key: path+mtime)                         │   │
│  │  └── Directory listing cache (key: path+mtime)                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              ↓                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  L3: LLM Response Cache (Semantic + Exact Match)               │   │
│  │  ├── Exact match cache (key: hash(system+messages))            │   │
│  │  ├── Semantic cache (embeddings-based similarity)              │   │
│  │  └── Tool call deduplication (key: tool+args)                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              ↓                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  L4: HTTP/API Cache (SWR Pattern)                              │   │
│  │  ├── Dashboard status (SWR: 5s stale, 30s max-age)             │   │
│  │  ├── Sessions list (SWR: 10s stale, 60s max-age)               │   │
│  │  └── Static assets (immutable, 1h max-age)                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Cache Storage Implementation

```typescript
// Proposed cache interface (src/cache/types.ts)

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number | null;  // null = never expires
  etag?: string;             // for conditional requests
  staleAt?: number;          // for SWR pattern
  hits: number;
  lastAccessedAt: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
  size: number;
  memoryBytes: number;
}

interface CacheProvider<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, options?: CacheOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
  stats(): CacheStats;
  keys(): Promise<string[]>;
}

interface CacheOptions {
  ttl?: number;           // Time to live in milliseconds
  staleTtl?: number;      // Stale-while-revalidate window
  tags?: string[];        // For tag-based invalidation
  priority?: number;      // For LRU eviction (higher = keep longer)
}
```

---

## 4. Key Selection Strategy

### 4.1 Key Construction Rules

| Data Type | Key Format | Example |
|-----------|------------|---------|
| **Config** | `config:{path}` | `config:/Users/x/.skimpyclaw/config.json` |
| **Template** | `template:{agentId}:{filename}:{mtime}` | `template:default:IDENTITY.md:1708104000000` |
| **Skills** | `skills:{dirHash}:{mtime}` | `skills:a3f2b1:1708104000000` |
| **MCP Tools** | `mcp:{server}:{tool}` | `mcp:github:search_repositories` |
| **File Read** | `file:{path}:{mtime}` | `file:/Users/x/.skimpyclaw/config.json:1708104000000` |
| **Directory** | `dir:{path}:{mtime}` | `dir:/Users/x/.skimpyclaw/agents:1708104000000` |
| **LLM Exact** | `llm:exact:{hash}` | `llm:exact:a3f2b1c4d5e6` |
| **LLM Semantic** | `llm:semantic:{embedding}` | `llm:semantic:[0.12,-0.34,...]` |
| **Tool Result** | `tool:{name}:{argsHash}` | `tool:Read:a3f2b1` |
| **API Response** | `api:{path}:{queryHash}` | `api:/dashboard/status:a3f2b1` |

### 4.2 Hash Algorithm Selection

| Use Case | Algorithm | Rationale |
|----------|-----------|-----------|
| Content hashing (small) | `fnv1a-32` | Fast, good distribution |
| Content hashing (large) | `xxhash64` | Very fast, low collision |
| Cryptographic | `sha256` | For cache keys needing uniqueness |
| Simple path hashing | `djb2` | Minimal implementation |

```typescript
// Recommended implementation
import { createHash } from 'crypto';

function hashKey(input: string, algorithm: 'fast' | 'secure' = 'fast'): string {
  if (algorithm === 'secure') {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }
  // Simple FNV-1a for speed
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}
```

---

## 5. TTL and Invalidation Policy

### 5.1 Default TTL Matrix

| Cache Type | Default TTL | Stale Window | Max Entries |
|------------|-------------|--------------|-------------|
| Config | 30s | 60s | 1 |
| Templates | 60s | 120s | 100 |
| Skills | 60s | 120s | 50 |
| MCP Tools | 300s | 600s | 200 |
| File Read | ∞ (mtime-based) | N/A | 1000 |
| Directory | ∞ (mtime-based) | N/A | 500 |
| LLM Exact | 3600s | 7200s | 500 |
| LLM Semantic | 1800s | 3600s | 200 |
| Tool Results | 60s | 120s | 1000 |
| API SWR | 5s | 30s | 100 |

### 5.2 Invalidation Strategies

```typescript
// Invalidation triggers

enum InvalidationTrigger {
  // Time-based
  TTL_EXPIRED = 'ttl_expired',
  STALE_WINDOW_EXPIRED = 'stale_expired',
  
  // File-based
  FILE_MODIFIED = 'file_modified',
  FILE_DELETED = 'file_deleted',
  
  // Manual
  EXPLICIT_CLEAR = 'explicit_clear',
  TAG_INVALIDATION = 'tag_invalidation',
  
  // Memory pressure
  LRU_EVICTION = 'lru_eviction',
  MEMORY_PRESSURE = 'memory_pressure',
}

// Tag-based invalidation groups
const CACHE_TAGS = {
  CONFIG: 'config',
  TEMPLATES: 'templates',
  SKILLS: 'skills',
  MCP: 'mcp',
  FILES: 'files',
  LLM: 'llm',
  TOOLS: 'tools',
  API: 'api',
  ALL: 'all',
} as const;
```

### 5.3 File Watch Invalidation

```typescript
// src/cache/file-watcher.ts

import { watch, FSWatcher } from 'fs';
import { EventEmitter } from 'events';

class CacheFileWatcher extends EventEmitter {
  private watchers: Map<string, FSWatcher> = new Map();
  private debounceMs = 100;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  watch(path: string, tags: string[]): void {
    if (this.watchers.has(path)) return;
    
    const watcher = watch(path, { recursive: true }, (eventType, filename) => {
      const key = `${path}:${filename}`;
      
      // Debounce rapid changes
      const existing = this.debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      
      this.debounceTimers.set(key, setTimeout(() => {
        this.debounceTimers.delete(key);
        this.emit('change', { path, filename, eventType, tags });
      }, this.debounceMs));
    });
    
    this.watchers.set(path, watcher);
  }

  unwatch(path: string): void {
    const watcher = this.watchers.get(path);
    if (watcher) {
      watcher.close();
      this.watchers.delete(path);
    }
  }

  closeAll(): void {
    for (const [path, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
```

---

## 6. Stale-While-Revalidate (SWR) Pattern

### 6.1 SWR Implementation

```typescript
// src/cache/swr.ts

interface SWROptions<T> {
  key: string;
  fetcher: () => Promise<T>;
  ttl: number;           // Fresh data duration
  staleTtl: number;      // How long to serve stale while revalidating
  onRevalidate?: (data: T) => void;
  onError?: (error: Error) => void;
}

interface SWRResult<T> {
  data: T;
  stale: boolean;
  revalidating: boolean;
  age: number;
}

async function swrFetch<T>(
  cache: CacheProvider<T>,
  options: SWROptions<T>
): Promise<SWRResult<T>> {
  const { key, fetcher, ttl, staleTtl, onRevalidate, onError } = options;
  const now = Date.now();
  
  const cached = await cache.get(key);
  
  if (cached) {
    const age = now - cached.createdAt;
    const isStale = age > ttl;
    const isExpired = age > (ttl + staleTtl);
    
    if (!isStale) {
      // Fresh data - return immediately
      return { data: cached.value, stale: false, revalidating: false, age };
    }
    
    if (!isExpired) {
      // Stale but acceptable - return stale, revalidate in background
      revalidateInBackground(key, fetcher, cache, onRevalidate, onError);
      return { data: cached.value, stale: true, revalidating: true, age };
    }
    // Expired - must refetch
  }
  
  // No cache or expired - fetch synchronously
  try {
    const data = await fetcher();
    await cache.set(key, data, { ttl, staleTtl });
    return { data, stale: false, revalidating: false, age: 0 };
  } catch (error) {
    // On error, return stale if available
    if (cached) {
      return { 
        data: cached.value, 
        stale: true, 
        revalidating: false, 
        age: now - cached.createdAt 
      };
    }
    throw error;
  }
}

function revalidateInBackground<T>(
  key: string,
  fetcher: () => Promise<T>,
  cache: CacheProvider<T>,
  onRevalidate?: (data: T) => void,
  onError?: (error: Error) => void
): void {
  fetcher()
    .then(data => {
      cache.set(key, data).catch(() => {});
      onRevalidate?.(data);
    })
    .catch(error => {
      onError?.(error);
    });
}
```

### 6.2 SWR for Dashboard APIs

```typescript
// Example: Dashboard status endpoint with SWR

fastify.get('/api/dashboard/status', async (request, reply) => {
  const result = await swrFetch(dashboardCache, {
    key: 'dashboard:status',
    fetcher: () => computeDashboardStatus(config),
    ttl: 5000,      // 5s fresh
    staleTtl: 25000, // Serve stale for 25s more (30s total)
  });
  
  // Set cache headers for HTTP-level caching
  reply.header('X-Cache-Status', result.stale ? 'STALE' : 'HIT');
  reply.header('X-Cache-Age', `${Math.round(result.age / 1000)}s`);
  
  if (result.stale) {
    reply.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=25');
  }
  
  return result.data;
});
```

---

## 7. Concurrency Controls

### 7.1 Request Coalescing

```typescript
// src/cache/coalescing.ts

class RequestCoalescer<T> {
  private inFlight: Map<string, Promise<T>> = new Map();
  
  async coalesce(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      // Request already in flight - join it
      return existing;
    }
    
    const promise = fetcher().finally(() => {
      this.inFlight.delete(key);
    });
    
    this.inFlight.set(key, promise);
    return promise;
  }
  
  cancel(key: string): boolean {
    // Note: Can't truly cancel promises, but can prevent new joins
    return this.inFlight.delete(key);
  }
}

// Usage in agent.ts
const llmCoalescer = new RequestCoalescer<string>();

async function cachedChat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
  const cacheKey = computeCacheKey(messages, options);
  
  return llmCoalescer.coalesce(cacheKey, async () => {
    // Check cache first
    const cached = await llmCache.get(cacheKey);
    if (cached) return cached.value;
    
    // Execute LLM call
    const result = await actualChatCall(messages, options);
    
    // Store in cache
    await llmCache.set(cacheKey, result, { ttl: 3600_000 });
    
    return result;
  });
}
```

### 7.2 Cache Stampede Prevention

```typescript
// Probabilistic early expiration to prevent thundering herd

interface ProbabilisticExpiryOptions {
  beta?: number;  // Jitter factor (default: 1.0)
}

function shouldEarlyExpire(
  entry: CacheEntry<unknown>,
  options: ProbabilisticExpiryOptions = {}
): boolean {
  const { beta = 1.0 } = options;
  const now = Date.now();
  const ttl = entry.expiresAt! - entry.createdAt;
  const elapsed = now - entry.createdAt;
  const remaining = entry.expiresAt! - now;
  
  // Don't expire early if less than 10% of TTL has passed
  if (elapsed < ttl * 0.1) return false;
  
  // Probability increases as expiration approaches
  const probability = Math.exp(-beta * remaining / (ttl * 0.1));
  return Math.random() < probability;
}
```

---

## 8. Error Handling and Fallback Behavior

### 8.1 Cache Error Strategy

```typescript
// src/cache/resilient.ts

class ResilientCache<T> implements CacheProvider<T> {
  constructor(
    private primary: CacheProvider<T>,
    private fallback: CacheProvider<T>,
    private logger: Console
  ) {}
  
  async get(key: string): Promise<T | undefined> {
    try {
      return await this.primary.get(key);
    } catch (error) {
      this.logger.warn(`Primary cache get failed: ${error}`);
      try {
        return await this.fallback.get(key);
      } catch (fallbackError) {
        this.logger.error(`Fallback cache get failed: ${fallbackError}`);
        return undefined;
      }
    }
  }
  
  async set(key: string, value: T, options?: CacheOptions): Promise<void> {
    // Fire and forget to both caches
    const promises = [
      this.primary.set(key, value, options).catch(e => {
        this.logger.warn(`Primary cache set failed: ${e}`);
      }),
      this.fallback.set(key, value, options).catch(e => {
        this.logger.warn(`Fallback cache set failed: ${e}`);
      }),
    ];
    await Promise.all(promises);
  }
  
  // ... other methods
}

// Fallback to null cache (always miss)
class NullCache<T> implements CacheProvider<T> {
  async get(): Promise<undefined> { return undefined; }
  async set(): Promise<void> { }
  async delete(): Promise<boolean> { return false; }
  async clear(): Promise<void> { }
  async has(): Promise<boolean> { return false; }
  stats(): CacheStats { 
    return { hits: 0, misses: 0, evictions: 0, hitRate: 0, size: 0, memoryBytes: 0 }; 
  }
  async keys(): Promise<string[]> { return []; }
}
```

### 8.2 Circuit Breaker for Cache Operations

```typescript
// Prevent cache failures from cascading to main application

enum CircuitState {
  CLOSED = 'closed',      // Normal operation
  OPEN = 'open',          // Failing fast
  HALF_OPEN = 'half_open' // Testing recovery
}

class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failures = 0;
  private lastFailureTime?: number;
  
  constructor(
    private threshold = 5,
    private resetTimeoutMs = 30000
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - (this.lastFailureTime || 0) > this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    this.state = CircuitState.CLOSED;
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = CircuitState.OPEN;
    }
  }
}
```

---

## 9. Observability and Metrics

### 9.1 Metrics Collection

```typescript
// src/cache/metrics.ts

interface CacheMetrics {
  // Hit/miss rates
  hits: Counter;
  misses: Counter;
  hitRate: Gauge;
  
  // Latency
  getLatency: Histogram;
  setLatency: Histogram;
  
  // Size
  entryCount: Gauge;
  memoryBytes: Gauge;
  
  // Events
  evictions: Counter;
  expirations: Counter;
  invalidations: Counter;
}

class MetricsCollector {
  private metrics: Map<string, CacheMetrics> = new Map();
  
  registerCache(name: string): CacheMetrics {
    const metrics: CacheMetrics = {
      hits: new Counter(),
      misses: new Counter(),
      hitRate: new Gauge(),
      getLatency: new Histogram([1, 5, 10, 50, 100]), // milliseconds
      setLatency: new Histogram([1, 5, 10, 50, 100]),
      entryCount: new Gauge(),
      memoryBytes: new Gauge(),
      evictions: new Counter(),
      expirations: new Counter(),
      invalidations: new Counter(),
    };
    this.metrics.set(name, metrics);
    return metrics;
  }
  
  getAllMetrics(): Record<string, CacheMetrics> {
    return Object.fromEntries(this.metrics);
  }
  
  // Export for dashboard
  toPrometheusFormat(): string {
    const lines: string[] = [];
    for (const [name, m] of this.metrics) {
      lines.push(`skimpyclaw_cache_hits{cache="${name}"} ${m.hits.value}`);
      lines.push(`skimpyclaw_cache_misses{cache="${name}"} ${m.misses.value}`);
      lines.push(`skimpyclaw_cache_hit_rate{cache="${name}"} ${m.hitRate.value}`);
      lines.push(`skimpyclaw_cache_entries{cache="${name}"} ${m.entryCount.value}`);
      lines.push(`skimpyclaw_cache_memory_bytes{cache="${name}"} ${m.memoryBytes.value}`);
    }
    return lines.join('\n');
  }
}
```

### 9.2 Cache Debug Endpoint

```typescript
// Add to api.ts

fastify.get('/api/dashboard/cache', async () => {
  const caches = ['config', 'templates', 'skills', 'files', 'llm', 'api'];
  const stats: Record<string, any> = {};
  
  for (const name of caches) {
    const cache = getCache(name);
    stats[name] = {
      ...cache.stats(),
      keys: (await cache.keys()).slice(0, 100), // Limit key exposure
    };
  }
  
  return { caches: stats };
});

fastify.post('/api/dashboard/cache/:name/clear', async (request, reply) => {
  const { name } = request.params as { name: string };
  const cache = getCache(name);
  await cache.clear();
  return { cleared: true, cache: name };
});
```

---

## 10. Rollout Phases

### 10.1 Phase 1: Foundation (Week 1)

**Goal:** Establish caching infrastructure with low-risk implementations

| Task | Effort | Owner | Deliverable |
|------|--------|-------|-------------|
| 1.1 Create cache module structure | 2h | - | `src/cache/` directory |
| 1.2 Implement in-memory cache provider | 4h | - | `MemoryCache` class |
| 1.3 Add cache metrics collection | 3h | - | `MetricsCollector` class |
| 1.4 Cache config loading | 2h | - | `loadConfig()` cached |
| 1.5 Cache agent templates | 2h | - | `loadAgentTemplates()` cached |
| 1.6 Add cache debug endpoints | 2h | - | `/api/dashboard/cache/*` |
| 1.7 Unit tests for cache module | 4h | - | `src/__tests__/cache.test.ts` |

**Success Criteria:**
- Cache infrastructure functional
- Config/template caching working
- No regressions in existing tests

### 10.2 Phase 2: File System Caching (Week 2)

**Goal:** Implement mtime-based caching for file operations

| Task | Effort | Owner | Deliverable |
|------|--------|-------|-------------|
| 2.1 Implement file stat cache | 3h | - | `FileStatCache` class |
| 2.2 Cache Read tool | 2h | - | `executeReadFile()` cached |
| 2.3 Cache Glob tool | 2h | - | `executeListDirectory()` cached |
| 2.4 Cache skills loading | 2h | - | `loadSkills()` cached |
| 2.5 Implement file watcher | 4h | - | `CacheFileWatcher` class |
| 2.6 Integration tests | 3h | - | File cache tests |

**Success Criteria:**
- File reads <10ms when cached
- File modifications properly invalidate cache
- Skills load 10x faster on subsequent calls

### 10.3 Phase 3: API Layer Caching (Week 3)

**Goal:** Add SWR caching to dashboard endpoints

| Task | Effort | Owner | Deliverable |
|------|--------|-------|-------------|
| 3.1 Implement SWR provider | 4h | - | `SWRCache` class |
| 3.2 Cache dashboard status | 2h | - | `/api/dashboard/status` SWR |
| 3.3 Cache sessions list | 2h | - | `/api/dashboard/sessions` SWR |
| 3.4 Cache memory files list | 1h | - | `/api/dashboard/memory/*` SWR |
| 3.5 Add cache headers | 2h | - | HTTP cache-control headers |
| 3.6 Dashboard cache visualization | 4h | - | Cache stats UI panel |

**Success Criteria:**
- Dashboard response times <50ms (cached)
- Proper cache headers for browser caching
- Visual cache metrics in dashboard

### 10.4 Phase 4: LLM Response Caching (Week 4)

**Goal:** Implement semantic caching for LLM calls

| Task | Effort | Owner | Deliverable |
|------|--------|-------|-------------|
| 4.1 Implement exact-match cache | 3h | - | Hash-based LLM cache |
| 4.2 Add request coalescing | 3h | - | `RequestCoalescer` for LLM |
| 4.3 Implement semantic similarity | 6h | - | Embedding-based cache |
| 4.4 Cache `chat()` function | 2h | - | `chat()` with caching |
| 4.5 Cache `chatWithTools()` | 4h | - | Tool loop caching |
| 4.6 Opt-out headers | 2h | - | `X-Skip-Cache` support |

**Success Criteria:**
- 30-50% reduction in API calls for repeated prompts
- Semantic similarity working (configurable threshold)
- Easy cache bypass for testing

### 10.5 Phase 5: Advanced Features (Week 5-6)

**Goal:** Production hardening and optimization

| Task | Effort | Owner | Deliverable |
|------|--------|-------|-------------|
| 5.1 Memory pressure handling | 4h | - | LRU eviction |
| 5.2 Cache persistence option | 4h | - | Disk-backed cache |
| 5.3 Distributed cache prep | 4h | - | Redis adapter (optional) |
| 5.4 Cache warming | 3h | - | Preload common data |
| 5.5 Performance benchmarking | 4h | - | Benchmark suite |
| 5.6 Documentation | 4h | - | Caching guide |

**Success Criteria:**
- Graceful degradation under memory pressure
- Optional Redis support for future scaling
- Complete caching documentation

---

## 11. Testing Strategy

### 11.1 Unit Tests

```typescript
// src/__tests__/cache/memory-cache.test.ts

describe('MemoryCache', () => {
  let cache: MemoryCache<string>;
  
  beforeEach(() => {
    cache = new MemoryCache({ maxSize: 100 });
  });
  
  it('should store and retrieve values', async () => {
    await cache.set('key', 'value');
    expect(await cache.get('key')).toBe('value');
  });
  
  it('should respect TTL', async () => {
    await cache.set('key', 'value', { ttl: 100 });
    expect(await cache.get('key')).toBe('value');
    await sleep(150);
    expect(await cache.get('key')).toBeUndefined();
  });
  
  it('should evict LRU entries when full', async () => {
    cache = new MemoryCache({ maxSize: 2 });
    await cache.set('a', '1');
    await cache.set('b', '2');
    await cache.set('c', '3'); // Evicts 'a'
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe('2');
    expect(await cache.get('c')).toBe('3');
  });
  
  it('should track hit rate', async () => {
    await cache.set('key', 'value');
    await cache.get('key'); // hit
    await cache.get('missing'); // miss
    expect(cache.stats().hitRate).toBe(0.5);
  });
});
```

### 11.2 Integration Tests

```typescript
// src/__tests__/cache/integration.test.ts

describe('File cache integration', () => {
  it('should cache file reads and invalidate on change', async () => {
    const filePath = '/tmp/test-cache-file.txt';
    writeFileSync(filePath, 'initial');
    
    // First read - miss
    const result1 = await cachedReadFile(filePath);
    expect(result1).toBe('initial');
    
    // Second read - hit
    const result2 = await cachedReadFile(filePath);
    expect(result2).toBe('initial');
    expect(getReadCount(filePath)).toBe(1);
    
    // Modify file
    writeFileSync(filePath, 'modified');
    
    // Read after modification - miss (cache invalidated)
    const result3 = await cachedReadFile(filePath);
    expect(result3).toBe('modified');
    expect(getReadCount(filePath)).toBe(2);
  });
});
```

### 11.3 Load Tests

```typescript
// benchmarks/cache-load.test.ts

describe('Cache load tests', () => {
  it('should handle 1000 concurrent cache operations', async () => {
    const cache = new MemoryCache<number>();
    const promises = Array.from({ length: 1000 }, (_, i) =>
      cache.set(`key-${i}`, i).then(() => cache.get(`key-${i}`))
    );
    const results = await Promise.all(promises);
    expect(results).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });
  
  it('should prevent cache stampedede', async () => {
    let callCount = 0;
    const coalescer = new RequestCoalescer<string>();
    const fetcher = async () => {
      callCount++;
      await sleep(100);
      return 'result';
    };
    
    // 100 concurrent requests for same key
    const promises = Array.from({ length: 100 }, () =>
      coalescer.coalesce('key', fetcher)
    );
    
    await Promise.all(promises);
    expect(callCount).toBe(1); // Only one actual fetch
  });
});
```

---

## 12. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Stale data served to user** | Medium | High | Short TTLs for user-facing data; explicit invalidation on writes |
| **Memory exhaustion** | Low | High | LRU eviction; max entry limits; memory monitoring |
| **Cache stampede on restart** | Medium | Medium | Request coalescing; gradual warmup; circuit breaker |
| **Complexity increase** | High | Medium | Phase-by-phase rollout; feature flags; clear documentation |
| **Cache poisoning** | Low | High | Input sanitization; hash verification; audit logging |
| **Performance regression** | Low | High | Benchmarks before/after; opt-out mechanisms; monitoring |
| **Data inconsistency** | Medium | High | File watchers; mtime checks; strong consistency for critical paths |

---

## 13. MVP Recommendation

### 13.1 MVP Scope (Phase 1 + 2)

For immediate implementation, focus on:

1. **In-memory cache infrastructure** (`src/cache/`)
   - MemoryCache provider
   - FileStatCache provider
   - Metrics collection

2. **File system caching**
   - Template caching (60s TTL)
   - Config caching (30s TTL)
   - Read tool caching (mtime-based)

3. **Dashboard SWR**
   - Status endpoint (5s stale)
   - Sessions endpoint (10s stale)

4. **Observability**
   - Cache metrics endpoint
   - Dashboard cache panel

### 13.2 MVP Task Breakdown

```
Week 1: Infrastructure
├── Day 1-2: Cache module setup
│   ├── src/cache/types.ts
│   ├── src/cache/memory.ts
│   └── src/cache/metrics.ts
├── Day 3: Config & template caching
│   ├── Cache loadConfig()
│   └── Cache loadAgentTemplates()
└── Day 4-5: Testing & polish
    ├── Unit tests
    └── Integration tests

Week 2: File & API Caching
├── Day 1-2: File system cache
│   ├── Cache Read tool
│   ├── Cache Glob tool
│   └── File watcher
├── Day 3-4: Dashboard SWR
│   ├── SWR implementation
│   ├── Status endpoint
│   └── Sessions endpoint
└── Day 5: Documentation
    └── Update AGENTS.md
```

### 13.3 MVP Success Metrics

| Metric | Before | Target | Measurement |
|--------|--------|--------|-------------|
| Template load time | 20-50ms | <5ms | Average over 100 calls |
| Config load time | 5-10ms | <2ms | Average over 100 calls |
| Dashboard response | 100-200ms | <50ms | 95th percentile |
| File read (cached) | 5-10ms | <1ms | Average over 100 calls |
| Cache hit rate | 0% | >70% | After 1 hour of use |

---

## 14. Implementation Guidelines

### 14.1 Code Organization

```
src/
├── cache/
│   ├── index.ts           # Public API exports
│   ├── types.ts           # Cache interfaces
│   ├── memory.ts          # In-memory cache
│   ├── file.ts            # File-based cache
│   ├── swr.ts             # Stale-while-revalidate
│   ├── coalescing.ts      # Request coalescing
│   ├── metrics.ts         # Metrics collection
│   └── watcher.ts         # File system watcher
├── decorators/
│   └── cache.ts           # @Cached decorator
└── __tests__/
    └── cache/
        ├── memory.test.ts
        ├── file.test.ts
        └── integration.test.ts
```

### 14.2 Usage Patterns

```typescript
// Pattern 1: Decorator (for functions)
class AgentService {
  @Cached({ ttl: 60_000, tags: ['templates'] })
  async loadTemplates(agentId: string): Promise<Record<string, string>> {
    return loadAgentTemplates(agentId);
  }
}

// Pattern 2: Direct cache access (for tools)
async function executeReadFile(path: string, config: ToolConfig): Promise<string> {
  const stat = await statCache.get(path);
  const cacheKey = `file:${path}:${stat?.mtime.getTime() || 0}`;
  
  const cached = await fileCache.get(cacheKey);
  if (cached) return cached.value;
  
  const content = readFileSync(path, 'utf-8');
  await fileCache.set(cacheKey, content);
  return content;
}

// Pattern 3: SWR for APIs
fastify.get('/api/dashboard/status', async () => {
  return swrFetch(dashboardCache, {
    key: 'status',
    fetcher: computeStatus,
    ttl: 5000,
    staleTtl: 25000,
  });
});
```

### 14.3 Configuration

```typescript
// Add to Config type
interface CacheConfig {
  enabled: boolean;
  maxMemoryMB: number;
  defaultTTL: number;
  swr: {
    enabled: boolean;
    defaultStaleTtl: number;
  };
  llm: {
    enabled: boolean;
    semanticCache: boolean;
    similarityThreshold: number;
  };
}

// Default config
const defaultCacheConfig: CacheConfig = {
  enabled: true,
  maxMemoryMB: 100,
  defaultTTL: 60_000,
  swr: {
    enabled: true,
    defaultStaleTtl: 30_000,
  },
  llm: {
    enabled: true,
    semanticCache: false, // Enable in Phase 4
    similarityThreshold: 0.95,
  },
};
```

---

## 15. Assumptions

| # | Assumption | Validation |
|---|------------|------------|
| A1 | Single-node deployment | Confirmed by code review - no distributed components |
| A2 | Personal use (single user) | Confirmed by config paths (~/.skimpyclaw) |
| A3 | Node.js 20+ runtime | Confirmed by package.json engines |
| A4 | Filesystem supports mtime | Standard Unix/Windows assumption |
| A5 | Memory available for cache | 100MB cache < 1% of typical 16GB system |
| A6 | Fastify server is long-running | Confirmed by service.ts implementation |
| A7 | LLM API costs are significant | Anthropic/OpenAI pricing confirms this |
| A8 | Dashboard polling is frequent | Current 5s polling confirmed in dashboard.ts |

---

## 16. References

- [AGENTS.md](/Users/katre/Sites/skimpyclaw/AGENTS.md) - Project conventions
- [CLAUDE.md](/Users/katre/Sites/skimpyclaw/CLAUDE.md) - Architecture overview
- [src/types.ts](/Users/katre/Sites/skimpyclaw/src/types.ts) - Type definitions
- [src/agent.ts](/Users/katre/Sites/skimpyclaw/src/agent.ts) - Agent implementation
- [src/tools.ts](/Users/katre/Sites/skimpyclaw/src/tools.ts) - Tool implementations
- [src/api.ts](/Users/katre/Sites/skimpyclaw/src/api.ts) - API endpoints
- [src/gateway.ts](/Users/katre/Sites/skimpyclaw/src/gateway.ts) - HTTP server

---

## 17. Appendix: Glossary

| Term | Definition |
|------|------------|
| **TTL** | Time To Live - duration before cache entry expires |
| **SWR** | Stale-While-Revalidate - serve stale data while refreshing in background |
| **LRU** | Least Recently Used - eviction policy |
| **Coalescing** | Combining multiple concurrent requests for same resource |
| **Stampede** | Thundering herd - many requests hitting expired cache simultaneously |
| **mtime** | File modification time - used for cache invalidation |
| **Semantic cache** | Cache based on meaning similarity, not exact match |
| **Circuit breaker** | Pattern to fail fast when dependencies are unhealthy |

---

**End of Document**

*This is a plan-only document. No production code has been modified.*
