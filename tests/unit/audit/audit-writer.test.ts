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

import { shouldAudit } from "@/lib/audit/audit-writer";

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
});
