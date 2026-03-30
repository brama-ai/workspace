import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectConfiguredModels, readRoutingConfig, resolveAgentRouting } from "../lib/model-routing.js";

describe("model-routing", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createRepo(configText: string): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "model-routing-"));
    tempDirs.push(repoRoot);
    mkdirSync(join(repoRoot, ".opencode"), { recursive: true });
    writeFileSync(join(repoRoot, ".opencode", "oh-my-opencode.jsonc"), configText, "utf8");
    return repoRoot;
  }

  it("parses jsonc agent routing with comments and trailing commas", () => {
    const repoRoot = createRepo(`{
      // comment
      "agents": {
        "u-architect": {
          "model": "anthropic/claude-opus-4-6",
          "fallback_models": [
            "google/gemini-2.5-flash",
            "openai/gpt-5.4",
          ],
        },
      },
    }`);

    const config = readRoutingConfig(repoRoot);
    expect(config.agents?.["u-architect"]?.model).toBe("anthropic/claude-opus-4-6");
    expect(config.agents?.["u-architect"]?.fallback_models).toEqual([
      "google/gemini-2.5-flash",
      "openai/gpt-5.4",
    ]);
  });

  it("resolves primary and fallbacks from oh-my-opencode config", () => {
    const repoRoot = createRepo(`{
      "agents": {
        "u-coder": {
          "model": "anthropic/claude-sonnet-4-6",
          "fallback_models": ["google/gemini-2.5-flash", "openai/gpt-5.4"]
        }
      }
    }`);

    expect(resolveAgentRouting(repoRoot, "u-coder")).toEqual({
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackChain: ["google/gemini-2.5-flash", "openai/gpt-5.4"],
      source: "config",
    });
  });

  it("uses degraded random fallback when agent config is missing", () => {
    const repoRoot = createRepo(`{
      "agents": {
        "u-architect": {
          "model": "anthropic/claude-opus-4-6",
          "fallback_models": ["google/gemini-2.5-flash"]
        }
      },
      "categories": {
        "deep": {
          "model": "openai/gpt-5.4"
        }
      }
    }`);

    vi.spyOn(Math, "random").mockReturnValue(0.9);

    const routing = resolveAgentRouting(repoRoot, "u-tester");
    expect(routing.source).toBe("degraded_random");
    expect(routing.primaryModel).toBe("openai/gpt-5.4");
    expect(routing.fallbackChain).toEqual([]);
    expect(routing.warning).toContain("Missing model routing for u-tester");
  });

  it("collects unique models across agents and categories", () => {
    const repoRoot = createRepo(`{
      "agents": {
        "u-architect": {
          "model": "anthropic/claude-opus-4-6",
          "fallback_models": ["google/gemini-2.5-flash", "openai/gpt-5.4"]
        }
      },
      "categories": {
        "spec-writing": {
          "model": "anthropic/claude-opus-4-6",
          "fallback_models": ["openrouter/free"]
        }
      }
    }`);

    const models = collectConfiguredModels(readRoutingConfig(repoRoot));
    expect(models).toEqual([
      "anthropic/claude-opus-4-6",
      "google/gemini-2.5-flash",
      "openai/gpt-5.4",
      "openrouter/free",
    ]);
  });

  it("resolves u-architect from config (runtime matches TUI source)", () => {
    const repoRoot = createRepo(`{
      "agents": {
        "u-architect": {
          "model": "anthropic/claude-opus-4-6",
          "fallback_models": ["google/gemini-2.5-flash", "openai/gpt-5.4"]
        }
      }
    }`);

    const routing = resolveAgentRouting(repoRoot, "u-architect");
    expect(routing.source).toBe("config");
    expect(routing.primaryModel).toBe("anthropic/claude-opus-4-6");
    expect(routing.fallbackChain).toEqual(["google/gemini-2.5-flash", "openai/gpt-5.4"]);
    expect(routing.warning).toBeUndefined();
  });

  it("emits warning when agent has no routing entry and no models available", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "model-routing-empty-"));
    tempDirs.push(repoRoot);
    mkdirSync(join(repoRoot, ".opencode"), { recursive: true });
    writeFileSync(join(repoRoot, ".opencode", "oh-my-opencode.jsonc"), "{}", "utf8");

    const routing = resolveAgentRouting(repoRoot, "u-coder");
    expect(routing.source).toBe("degraded_random");
    expect(routing.primaryModel).toBe("");
    expect(routing.warning).toContain("Missing model routing for u-coder");
    expect(routing.warning).toContain("no fallback models are available");
  });

  it("degraded fallback warning contains agent name", () => {
    const repoRoot = createRepo(`{
      "agents": {
        "u-architect": { "model": "anthropic/claude-opus-4-6" }
      }
    }`);

    vi.spyOn(Math, "random").mockReturnValue(0);
    const routing = resolveAgentRouting(repoRoot, "u-missing-agent");
    expect(routing.source).toBe("degraded_random");
    expect(routing.warning).toContain("u-missing-agent");
    expect(routing.warning).toContain("degraded random fallback");
  });
});
