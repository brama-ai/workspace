# Model TTFB Benchmark

**Date**: 2026-03-26
**Environment**: devcontainer, opencode 1.2.27
**Test**: `opencode run --agent u-validator "Reply: OK"` — time to first meaningful output (> 3 lines)

## Results

| Model | Provider | TTFO | Status | Notes |
|-------|----------|------|--------|-------|
| anthropic/claude-sonnet-4-6 | anthropic (direct) | **6s** | OK | Fastest paid model |
| google/gemini-2.5-flash | google (direct) | **6s** | OK | Fastest overall, good for quick tasks |
| anthropic/claude-opus-4-6 | anthropic (direct) | **7s** | OK | Strongest reasoning |
| opencode-go/kimi-k2.5 | opencode-go | **8s** | OK | Reliable workhorse |
| opencode-go/glm-5 | opencode-go | **8s** | OK | Strong for long-horizon tasks |
| opencode/big-pickle | opencode zen | **12s** | OK | Free tier, slower cold start |
| opencode/minimax-m2.5-free | opencode zen | **17s** | OK | Free tier, verbose responses |
| opencode/gpt-5-nano | opencode zen | **19s** | OK | Free tier, slowest working model |
| minimax/MiniMax-M2.7 | minimax (direct) | **>25s** | DEAD | Subscription routing issue |
| openai/gpt-5.4 | openai (direct) | **>25s** | DEAD | Rate limits exhausted (resets 2026-03-29) |
| openai/gpt-5.2 | openai (direct) | **>25s** | DEAD | Same rate limit pool |

## Provider Tiers (by TTFO)

| Tier | TTFO | Providers | Use case |
|------|------|-----------|----------|
| **Fast** | 6-8s | anthropic, google, opencode-go | Primary models, first fallbacks |
| **Medium** | 12-19s | opencode zen (free) | Free fallback, acceptable for non-critical |
| **Unreliable** | >25s or hang | openai (rate limited), minimax (broken) | In fallback chain but may stall |

## Safe Connect Timeout Values

Based on measured TTFO:

| Timeout | Safe for | Kills |
|---------|----------|-------|
| 8s | anthropic, google, opencode-go | — |
| 12s | + opencode/big-pickle | gpt-5-nano (19s), minimax-free (17s) |
| 20s | all working models | only dead providers |
| 25s+ | — | nothing (too slow) |

**Current setting**: 20s stall detection (for < 5 lines output)
**Recommended**: keep 20s — safe for all working models, catches dead providers quickly enough

## Fallback Chain Strategy

```
Primary model (from agent .md)
    ↓ stall 20s
Fast fallback (anthropic/google/opencode-go) — 6-8s
    ↓ stall 20s
GPT fallback (openai/*) — works when limits available, stalls otherwise
    ↓ stall 20s
Free fallback (opencode/big-pickle) — 12s, always available
    ↓ stall 20s
Last resort (openrouter/free) — varies
```

**Worst case** (primary + GPT both dead): 20s + 6s = **26s** to reach working model
**Best case** (primary works): **6-8s** direct response

## How to Re-test

```bash
# Full benchmark
./agentic-development/lib/test-connect-time.sh

# Single model stall + fallback test
./agentic-development/lib/test-stall-fallback.sh u-validator
```
