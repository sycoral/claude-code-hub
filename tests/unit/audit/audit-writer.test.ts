import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: vi.fn(() => ({
    ENABLE_AUDIT: true,
    AUDIT_DATA_DIR: "/tmp/audit-test",
    AUDIT_MAX_FILE_SIZE: 10 * 1024 * 1024,
    AUDIT_CONTENT_MAX_SIZE: 500 * 1024,
  })),
}));

vi.mock("@/drizzle/db", () => ({
  db: { insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })) },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { shouldAudit, extractNewMessages } from "@/lib/audit/audit-writer";

describe("audit-writer", () => {
  describe("shouldAudit", () => {
    it("returns true when provider selected and messageContext exists", () => {
      expect(shouldAudit({ provider: { id: 1 }, messageContext: { id: 100 } } as any)).toBe(true);
    });

    it("returns false when no provider", () => {
      expect(shouldAudit({ provider: null, messageContext: { id: 100 } } as any)).toBe(false);
    });

    it("returns false when provider id is 0 (blocked)", () => {
      expect(shouldAudit({ provider: { id: 0 }, messageContext: { id: 100 } } as any)).toBe(false);
    });

    it("returns false when no messageContext", () => {
      expect(shouldAudit({ provider: { id: 1 }, messageContext: null } as any)).toBe(false);
    });
  });

  describe("extractNewMessages", () => {
    it("returns last user message from simple conversation", () => {
      const messages = [
        { role: "user", content: "question 1" },
        { role: "assistant", content: "answer 1" },
        { role: "user", content: "question 2" },
      ] as any[];
      const result = extractNewMessages(messages);
      expect(result).toEqual([{ role: "user", content: "question 2" }]);
    });

    it("returns empty array for empty messages", () => {
      expect(extractNewMessages([])).toEqual([]);
    });

    it("returns single user message", () => {
      const messages = [{ role: "user", content: "hello" }] as any[];
      expect(extractNewMessages(messages)).toEqual([{ role: "user", content: "hello" }]);
    });

    it("includes one tool call pair (assistant tool_use + user tool_result)", () => {
      const messages = [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "search for X" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "results" }] },
      ] as any[];
      const result = extractNewMessages(messages);
      // Should include only the LAST pair: assistant(tool_use) + user(tool_result)
      expect(result.length).toBe(2);
      expect(result[0].role).toBe("assistant");
      expect(result[1].role).toBe("user");
    });

    it("does NOT scan back through entire tool chain", () => {
      const messages = [
        { role: "user", content: "do something" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "file content" }],
        },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "write", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
      ] as any[];
      const result = extractNewMessages(messages);
      // Should capture only the LAST pair, not the entire chain
      expect(result.length).toBe(2);
      expect(result[0].content[0].id).toBe("t2");
      expect(result[1].content[0].tool_use_id).toBe("t2");
    });

    it("handles context compression (fewer messages than before)", () => {
      // Simulates client sending compressed/truncated history
      const messages = [
        { role: "user", content: "summarized history" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "new question" },
      ] as any[];
      const result = extractNewMessages(messages);
      expect(result).toEqual([{ role: "user", content: "new question" }]);
    });

    it("handles last message being assistant (edge case)", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ] as any[];
      const result = extractNewMessages(messages);
      // Last message is assistant, return it as-is
      expect(result).toEqual([{ role: "assistant", content: "hi" }]);
    });
  });
});
