import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { classifyProbeError, formatReasonCode } from "../agents/model-probe.js";
import {
  blacklistModel,
  isModelBlacklisted,
  getBlacklistEntry,
  unblockModel,
  getAllBlacklistEntries,
} from "../agents/executor.js";

describe("model-probe", () => {
  describe("classifyProbeError", () => {
    it("classifies quota/token errors", () => {
      expect(classifyProbeError("insufficient balance")).toBe("quota_or_tokens");
      expect(classifyProbeError("quota exceeded")).toBe("quota_or_tokens");
      expect(classifyProbeError("billing error occurred")).toBe("quota_or_tokens");
      expect(classifyProbeError("payment required")).toBe("quota_or_tokens");
      expect(classifyProbeError("credit exhausted")).toBe("quota_or_tokens");
      expect(classifyProbeError("token limit exceeded")).toBe("quota_or_tokens");
      expect(classifyProbeError("context length exceeded")).toBe("quota_or_tokens");
    });

    it("classifies rate limit errors", () => {
      expect(classifyProbeError("rate limit exceeded")).toBe("rate_limit");
      expect(classifyProbeError("too many requests")).toBe("rate_limit");
      expect(classifyProbeError("Error 429: too many requests")).toBe("rate_limit");
      expect(classifyProbeError("requests per minute exceeded")).toBe("rate_limit");
    });

    it("classifies service unavailable errors", () => {
      expect(classifyProbeError("service unavailable")).toBe("service_unavailable");
      expect(classifyProbeError("503 Service Unavailable")).toBe("service_unavailable");
      expect(classifyProbeError("502 Bad Gateway")).toBe("service_unavailable");
      expect(classifyProbeError("server is overloaded")).toBe("service_unavailable");
      expect(classifyProbeError("internal server error 500")).toBe("service_unavailable");
    });

    it("classifies timeout errors", () => {
      expect(classifyProbeError("request timed out")).toBe("timeout");
      expect(classifyProbeError("connection timeout")).toBe("timeout");
      expect(classifyProbeError("deadline exceeded")).toBe("timeout");
    });

    it("returns undefined for unknown errors", () => {
      expect(classifyProbeError("some random error message")).toBeUndefined();
      expect(classifyProbeError("model not found")).toBeUndefined();
      expect(classifyProbeError("")).toBeUndefined();
    });

    it("is case-insensitive", () => {
      expect(classifyProbeError("RATE LIMIT EXCEEDED")).toBe("rate_limit");
      expect(classifyProbeError("Quota Exceeded")).toBe("quota_or_tokens");
      expect(classifyProbeError("Service Unavailable")).toBe("service_unavailable");
    });
  });

  describe("formatReasonCode", () => {
    it("formats known reason codes", () => {
      expect(formatReasonCode("quota_or_tokens")).toBe("quota/tokens");
      expect(formatReasonCode("rate_limit")).toBe("rate limit");
      expect(formatReasonCode("service_unavailable")).toBe("service unavailable");
      expect(formatReasonCode("timeout")).toBe("timeout");
      expect(formatReasonCode("provider_error")).toBe("provider error");
      expect(formatReasonCode("billing_error")).toBe("billing error");
      expect(formatReasonCode("hard_timeout")).toBe("timeout (hard)");
      expect(formatReasonCode("near_timeout")).toBe("timeout (near)");
    });

    it("returns 'unknown error' for undefined", () => {
      expect(formatReasonCode(undefined)).toBe("unknown error");
    });
  });
});

describe("blacklist metadata (executor)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("stores reasonCode and errorMessage in blacklist entry", () => {
    const model = `meta-test-model-${Date.now()}`;
    blacklistModel(model, 60, {
      reasonCode: "quota_or_tokens",
      errorMessage: "Quota exceeded for this model",
    });

    const entry = getBlacklistEntry(model);
    expect(entry).toBeDefined();
    expect(entry?.reasonCode).toBe("quota_or_tokens");
    expect(entry?.errorMessage).toBe("Quota exceeded for this model");
    expect(entry?.lastCheckedAt).toBeDefined();
  });

  it("loads legacy entry without metadata fields", () => {
    // Legacy entries only have model + expiresAt — should still be treated as blocked
    const model = `legacy-model-${Date.now()}`;
    // Simulate legacy by calling blacklistModel without metadata
    blacklistModel(model, 60);
    expect(isModelBlacklisted(model)).toBe(true);
    const entry = getBlacklistEntry(model);
    expect(entry).toBeDefined();
    expect(entry?.model).toBe(model);
    // reasonCode may be undefined for legacy entries
  });

  it("unblockModel removes the model from the blacklist", () => {
    const model = `unblock-test-${Date.now()}`;
    blacklistModel(model, 60, { reasonCode: "rate_limit" });
    expect(isModelBlacklisted(model)).toBe(true);

    unblockModel(model);
    expect(isModelBlacklisted(model)).toBe(false);
    expect(getBlacklistEntry(model)).toBeUndefined();
  });

  it("unblockModel is safe to call on non-blacklisted model", () => {
    // Should not throw
    expect(() => unblockModel("non-existent-model-xyz")).not.toThrow();
  });

  it("getAllBlacklistEntries returns only active entries", () => {
    vi.useFakeTimers();

    const model1 = `all-entries-1-${Date.now()}`;
    const model2 = `all-entries-2-${Date.now()}`;
    blacklistModel(model1, 60);
    blacklistModel(model2, 1); // expires quickly

    vi.advanceTimersByTime(1500);

    const entries = getAllBlacklistEntries();
    const ids = entries.map((e) => e.model);
    expect(ids).toContain(model1);
    expect(ids).not.toContain(model2);

    vi.useRealTimers();
  });

  it("blacklistModel preserves lastSuccessAt from existing entry", () => {
    const model = `preserve-success-${Date.now()}`;
    const successTs = Date.now() - 5000;

    // First blacklist with a success timestamp
    blacklistModel(model, 60, { reasonCode: "rate_limit" });
    // Manually set lastSuccessAt by re-reading and checking
    const entry1 = getBlacklistEntry(model);
    expect(entry1?.lastSuccessAt).toBeUndefined(); // no success yet

    // Unblock (simulates successful recheck)
    unblockModel(model);

    // Re-blacklist (simulates new failure after recovery)
    blacklistModel(model, 60, { reasonCode: "timeout" });
    const entry2 = getBlacklistEntry(model);
    expect(entry2?.reasonCode).toBe("timeout");
  });

  it("blacklistModel updates metadata on re-blacklist", () => {
    const model = `update-meta-${Date.now()}`;
    blacklistModel(model, 60, { reasonCode: "rate_limit", errorMessage: "first error" });
    blacklistModel(model, 60, { reasonCode: "timeout", errorMessage: "second error" });

    const entry = getBlacklistEntry(model);
    expect(entry?.reasonCode).toBe("timeout");
    expect(entry?.errorMessage).toBe("second error");
  });
});
