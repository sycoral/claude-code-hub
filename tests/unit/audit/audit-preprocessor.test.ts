import { describe, expect, it } from "vitest";
import { preprocessAuditContent, extractSummary } from "@/lib/audit/audit-preprocessor";

describe("audit-preprocessor", () => {
  describe("extractSummary", () => {
    it("extracts first user message text up to limit", () => {
      const request = {
        messages: [{ role: "user", content: "Hello world, this is a test message" }],
      };
      expect(extractSummary(request, 20)).toBe("Hello world, this is");
    });

    it("returns empty string when no user messages", () => {
      const request = { messages: [{ role: "assistant", content: "Hi" }] };
      expect(extractSummary(request, 500)).toBe("");
    });

    it("handles system-only request", () => {
      const request = { system: "You are helpful", messages: [] };
      expect(extractSummary(request, 500)).toBe("");
    });

    it("extracts from content block array", () => {
      const request = {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Block message" }],
          },
        ],
      };
      expect(extractSummary(request, 500)).toBe("Block message");
    });
  });

  describe("preprocessAuditContent", () => {
    it("passes through small content unchanged", () => {
      const request = {
        system: "Be helpful",
        messages: [{ role: "user", content: "Hi" }],
      };
      const response = { content: [{ type: "text", text: "Hello" }] };
      const result = preprocessAuditContent(request, response, 500 * 1024);
      expect(result.request.messages[0].content).toBe("Hi");
      expect(result.truncated).toBe(false);
    });

    it("strips image base64 data", () => {
      const request = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", data: "a".repeat(10000) },
              },
            ],
          },
        ],
      };
      const result = preprocessAuditContent(request, { content: [] }, 500 * 1024);
      const imageBlock = (result.request.messages[0].content as any[])[0];
      expect(imageBlock.source.data).toMatch(/^\[IMAGE: \d+(\.\d+)? KB\]$/);
    });

    it("truncates messages exceeding max size", () => {
      const longText = "x".repeat(600 * 1024);
      const request = { messages: [{ role: "user", content: longText }] };
      const result = preprocessAuditContent(request, { content: [] }, 500 * 1024);
      expect((result.request.messages[0].content as string).length).toBeLessThanOrEqual(
        500 * 1024 + 50
      );
      expect(result.truncated).toBe(true);
    });
  });
});
