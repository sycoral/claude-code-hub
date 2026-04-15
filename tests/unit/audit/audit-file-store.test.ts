import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditFileStore } from "@/lib/audit/audit-file-store";

describe("audit-file-store", () => {
  let tmpDir: string;
  let store: AuditFileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
    store = new AuditFileStore(tmpDir, 1024); // 1KB max for testing
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a line and returns relative path", async () => {
    const relPath = await store.appendLine("session-1", '{"seq":1}');
    expect(relPath).toMatch(/session-1\.jsonl$/);
    const fullPath = path.join(tmpDir, relPath);
    const content = fs.readFileSync(fullPath, "utf-8");
    expect(content.trim()).toBe('{"seq":1}');
  });

  it("creates year/month subdirectory", async () => {
    const relPath = await store.appendLine("session-2", '{"seq":1}');
    const parts = relPath.split("/");
    expect(parts.length).toBe(3); // YYYY/MM/session-2.jsonl
    expect(parts[0]).toMatch(/^\d{4}$/);
    expect(parts[1]).toMatch(/^\d{2}$/);
  });

  it("rolls file when exceeding max size", async () => {
    const bigLine = JSON.stringify({ data: "x".repeat(800) });
    await store.appendLine("session-3", bigLine);
    const path2 = await store.appendLine("session-3", bigLine);
    expect(path2).toMatch(/session-3\.1\.jsonl$/);
  });

  it("reads lines from file", async () => {
    await store.appendLine("session-4", '{"seq":1,"msg":"first"}');
    // Note: might roll due to 1KB limit, so read from the path returned
    const relPath = store.getRelativePath("session-4");
    const lines = await store.readLines(relPath, 0, 10);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]).seq).toBe(1);
  });
});
