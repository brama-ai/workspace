/**
 * slash-commands.test.ts — Unit tests for slash command filtering and suggestion UX.
 *
 * Test tier: Tier 2 (Unit) — pure functions, no I/O.
 */
import { describe, it, expect } from "vitest";
import {
  getSlashSuggestions,
  matchSlashCommand,
  isSlashInput,
  SLASH_COMMANDS,
} from "../lib/slash-commands.js";

describe("getSlashSuggestions", () => {
  it("returns all 3 commands for '/'", () => {
    const suggestions = getSlashSuggestions("/");
    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((s) => s.name)).toContain("/model");
    expect(suggestions.map((s) => s.name)).toContain("/compact");
    expect(suggestions.map((s) => s.name)).toContain("/new");
  });

  it("filters to /model for '/mo'", () => {
    const suggestions = getSlashSuggestions("/mo");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe("/model");
  });

  it("filters to /compact for '/co'", () => {
    const suggestions = getSlashSuggestions("/co");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe("/compact");
  });

  it("filters to /new for '/n'", () => {
    const suggestions = getSlashSuggestions("/n");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe("/new");
  });

  it("returns no matches for '/x'", () => {
    const suggestions = getSlashSuggestions("/x");
    expect(suggestions).toHaveLength(0);
  });

  it("returns no suggestions for empty input", () => {
    const suggestions = getSlashSuggestions("");
    expect(suggestions).toHaveLength(0);
  });

  it("returns no suggestions for non-slash input", () => {
    const suggestions = getSlashSuggestions("hello");
    expect(suggestions).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    const suggestions = getSlashSuggestions("/MO");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe("/model");
  });

  it("returns exact match for '/model'", () => {
    const suggestions = getSlashSuggestions("/model");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe("/model");
  });
});

describe("matchSlashCommand", () => {
  it("matches /model exactly", () => {
    const cmd = matchSlashCommand("/model");
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("/model");
  });

  it("matches /compact exactly", () => {
    const cmd = matchSlashCommand("/compact");
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("/compact");
  });

  it("matches /new exactly", () => {
    const cmd = matchSlashCommand("/new");
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("/new");
  });

  it("returns null for partial match", () => {
    const cmd = matchSlashCommand("/mo");
    expect(cmd).toBeNull();
  });

  it("returns null for non-command input", () => {
    const cmd = matchSlashCommand("hello");
    expect(cmd).toBeNull();
  });

  it("is case-insensitive", () => {
    const cmd = matchSlashCommand("/MODEL");
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("/model");
  });

  it("trims whitespace before matching", () => {
    const cmd = matchSlashCommand("  /model  ");
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("/model");
  });
});

describe("isSlashInput", () => {
  it("returns true for slash-prefixed input", () => {
    expect(isSlashInput("/model")).toBe(true);
    expect(isSlashInput("/")).toBe(true);
    expect(isSlashInput("/anything")).toBe(true);
  });

  it("returns false for non-slash input", () => {
    expect(isSlashInput("hello")).toBe(false);
    expect(isSlashInput("")).toBe(false);
    expect(isSlashInput("model")).toBe(false);
  });
});

describe("SLASH_COMMANDS registry", () => {
  it("has exactly 3 commands", () => {
    expect(SLASH_COMMANDS).toHaveLength(3);
  });

  it("all commands have name, description, and category", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.category).toBeTruthy();
    }
  });

  it("all command names start with /", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.name.startsWith("/")).toBe(true);
    }
  });
});
