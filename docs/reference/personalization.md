# Personalization: Implicit Feedback Learning

SkimpyClaw adapts its response style per-user by detecting implicit feedback signals from conversation turns and maintaining a lightweight preference profile. No model fine-tuning is involved — this is a prompt-layer adaptation system.

## Architecture

```
User message → detectSignals() → FeedbackSignal[]
                                       ↓
                              updateProfile() → UserProfile (persisted)
                                       ↓
                         buildPersonalizationPrompt() → injected into system prompt
```

### Signal Detection (`detectSignals`)

Runs on every user turn. Detects three signal types:

| Signal | Reward | Examples |
|--------|--------|---------|
| **correction** | -0.6 | "That's wrong", "Not what I asked", "You misunderstood" |
| **reask** | -0.3 to -0.4 | "I already asked", "Let me rephrase", high word overlap with prior message |
| **acceptance** | +0.1 to +0.3 | "Thanks", "Perfect", "That's right", or smooth follow-up without complaint |

Also detects **dimension-specific** signals (verbosity, formatting, technical depth) from phrases like "too verbose", "give me a list", "explain in simpler terms".

### Preference Dimensions

| Dimension | -1 | +1 |
|-----------|-----|-----|
| `verbosity` | Brief, concise | Detailed, thorough |
| `directness` | Diplomatic, gentle | Direct, blunt |
| `formatting` | Flowing prose | Structured (lists, headers) |
| `initiative` | Reactive | Proactive |
| `technicalDepth` | High-level | Deep technical detail |

### Profile Storage

Per-user JSON files at `~/.skimpyclaw/profiles/{userId}.json`. File permissions are 0600.

Each profile tracks:
- Current preference values per dimension (float, bounded ±0.85)
- Confidence per dimension (0–1, grows with consistent signals)
- Interaction count
- Opt-out flag

### Prompt Injection

When a profile has ≥3 interactions and dimensions with sufficient confidence (≥0.3) and magnitude (≥0.15), a `## User Preferences` section is appended to the system prompt describing the learned preferences in natural language.

The prompt explicitly marks these as "soft preferences" that the model should override when situationally appropriate.

## Configuration

Add to `~/.skimpyclaw/config.json`:

```json
{
  "personalization": {
    "enabled": true,
    "learningRate": 0.15,
    "confidenceThreshold": 0.3,
    "decayFactor": 0.98,
    "maxDimensionValue": 0.85
  }
}
```

All fields are optional. Defaults shown above.

### Tuning Thresholds

| Parameter | Default | Effect |
|-----------|---------|--------|
| `learningRate` | 0.15 | How fast preferences shift per signal. Higher = faster adaptation, more volatile. Range: 0.05–0.3 |
| `confidenceThreshold` | 0.3 | Minimum signal confidence to apply an update or display in prompt. Lower = more responsive but noisier |
| `decayFactor` | 0.98 | Per-turn multiplier pulling preferences toward 0. Lower = faster forgetting. 0.95 forgets in ~20 turns; 0.99 persists for ~100 |
| `maxDimensionValue` | 0.85 | Absolute bound on preference values. Prevents runaway accumulation |

### Opt-Out

Users can disable personalization. The `setUserOptOut(userId, true)` function resets all preferences and stops signal processing. Can be wired to a `/personalize off` command.

## Integration Points

- **`src/personalization.ts`** — Core module: signal detection, profile CRUD, prompt generation
- **`src/agent.ts`** — Calls `processUserTurn()` before building the message array, appends preferences to system prompt
- **`src/types.ts`** — Types: `FeedbackSignal`, `UserProfile`, `PreferenceDimensions`, `PersonalizationConfig`

## Limitations and Future Work

**Current limitations:**
- Pattern-based signal detection (no semantic understanding of intent)
- Dimension updates from corrections are heuristic, not grounded in what specifically was wrong
- No cross-session intent linking (reask detection is within-conversation only)
- Smooth follow-up is a weak signal — it rewards the status quo even if the user is just being polite

**Potential improvements:**
- **Contextual bandits**: Use the model itself to classify signals and propose dimension updates, replacing regex patterns
- **DPO-style offline logs**: Log (prompt, chosen response, rejected response) triples for future preference optimization
- **Semantic reask**: Use embeddings to detect intent repetition across sessions
- **A/B exploration**: Occasionally vary response style to discover better preference points
- **Per-topic profiles**: Track preferences per domain (coding vs. writing vs. planning) rather than globally
- **Explicit preference elicitation**: Periodically ask users about their preferences directly to calibrate the system
