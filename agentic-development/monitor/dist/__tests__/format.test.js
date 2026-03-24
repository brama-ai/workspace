import { describe, it, expect } from "vitest";
import { formatDuration, formatTokens, formatCost } from "../lib/format.js";
describe("formatDuration", () => {
    it("formats seconds", () => {
        expect(formatDuration(30)).toBe("30s");
    });
    it("formats minutes and seconds", () => {
        expect(formatDuration(90)).toBe("1m 30s");
    });
    it("formats hours, minutes, seconds", () => {
        expect(formatDuration(3700)).toBe("1h 1m 40s");
    });
    it("handles zero", () => {
        expect(formatDuration(0)).toBe("0s");
    });
    it("handles undefined/null gracefully", () => {
        expect(formatDuration(undefined)).toBe("-");
        expect(formatDuration(null)).toBe("-");
    });
});
describe("formatTokens", () => {
    it("formats small numbers as-is", () => {
        expect(formatTokens(500)).toBe("500");
    });
    it("formats thousands with k suffix", () => {
        expect(formatTokens(1500)).toBe("1.5k");
    });
    it("formats millions with M suffix", () => {
        expect(formatTokens(2500000)).toBe("2.5M");
    });
    it("handles zero", () => {
        expect(formatTokens(0)).toBe("0");
    });
    it("handles undefined gracefully", () => {
        expect(formatTokens(undefined)).toBe("-");
    });
});
describe("formatCost", () => {
    it("formats dollar amount", () => {
        expect(formatCost(1.5)).toBe("$1.50");
    });
    it("formats zero", () => {
        expect(formatCost(0)).toBe("$0.00");
    });
    it("formats small amounts", () => {
        expect(formatCost(0.0645)).toBe("$0.06");
    });
    it("handles undefined gracefully", () => {
        expect(formatCost(undefined)).toBe("-");
    });
});
