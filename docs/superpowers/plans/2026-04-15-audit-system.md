# Audit System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a security audit system that persists full conversation content to JSONL files and provides a chat-style viewer in the admin dashboard.

**Architecture:** Event-hook pattern — a single `auditHook.onRequestComplete()` call in `response-handler.ts` delegates to an isolated audit module. All audit code lives under `src/lib/audit/` and `src/app/[locale]/dashboard/audit/`. Schema defined in a separate `src/drizzle/audit-schema.ts` file to minimize upstream merge conflicts.

**Tech Stack:** Drizzle ORM (PG), Node.js fs (JSONL), Next.js App Router, React (chat UI), shadcn/ui, next-intl (i18n)

**Spec:** `docs/2026-04-15-audit-system-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/drizzle/audit-schema.ts` | `audit_log` table definition (Drizzle pgTable) |
| `src/lib/audit/audit-hook.ts` | Entry point — feature gate + delegates to writer |
| `src/lib/audit/audit-writer.ts` | Orchestrates: preprocess, write JSONL, insert DB |
| `src/lib/audit/audit-file-store.ts` | JSONL append, file rolling, line reading |
| `src/lib/audit/audit-preprocessor.ts` | Strip image base64, truncate large messages |
| `src/actions/audit.ts` | Server actions: list sessions, read chat content |
| `src/app/[locale]/dashboard/audit/page.tsx` | Audit list page (server component) |
| `src/app/[locale]/dashboard/audit/_components/audit-list.tsx` | Session-grouped table |
| `src/app/[locale]/dashboard/audit/_components/audit-filters.tsx` | Filter bar |
| `src/app/[locale]/dashboard/audit/[sessionId]/page.tsx` | Chat view page (server component) |
| `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-chat-view.tsx` | Chat bubble renderer |
| `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-chat-bubble.tsx` | Single message bubble |
| `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-session-stats.tsx` | Session info sidebar |
| `tests/unit/audit/audit-preprocessor.test.ts` | Preprocessor unit tests |
| `tests/unit/audit/audit-file-store.test.ts` | File store unit tests |
| `tests/unit/audit/audit-writer.test.ts` | Writer unit tests |

### Modified Files (minimal changes)

| File | Change | Lines |
|------|--------|-------|
| `src/drizzle/index.ts` | Add `export * from './audit-schema'` | +1 line |
| `drizzle.config.ts` | Change schema to glob `"./src/drizzle/*.ts"` | ~1 line |
| `src/lib/config/env.schema.ts` | Add 4 env vars | +4 lines |
| `src/app/v1/_lib/proxy/response-handler.ts` | Add import + 2 hook calls | +3 lines |
| `src/app/[locale]/dashboard/_components/dashboard-header.tsx` | Add nav item | +1 line |
| `messages/en/dashboard.json` | Add audit i18n strings | ~30 lines |
| `messages/zh-CN/dashboard.json` | Add audit i18n strings (Chinese) | ~30 lines |
| `messages/zh-TW/dashboard.json` | Add audit i18n strings | ~30 lines |
| `messages/ja/dashboard.json` | Add audit i18n strings | ~30 lines |
| `messages/ru/dashboard.json` | Add audit i18n strings | ~30 lines |

---

## Task 1: Environment Variables & Schema

**Files:**
- Modify: `src/lib/config/env.schema.ts:110` (after `STORE_SESSION_RESPONSE_BODY`)
- Create: `src/drizzle/audit-schema.ts`
- Modify: `src/drizzle/index.ts`
- Modify: `drizzle.config.ts`

- [ ] **Step 1: Add env vars**

In `src/lib/config/env.schema.ts`, add after the `STORE_SESSION_RESPONSE_BODY` line (line 109):

```typescript
  // Audit system
  ENABLE_AUDIT: z.string().default("false").transform(booleanTransform),
  AUDIT_DATA_DIR: z.string().default("./data/audit"),
  AUDIT_MAX_FILE_SIZE: z.coerce.number().default(10 * 1024 * 1024), // 10MB
  AUDIT_CONTENT_MAX_SIZE: z.coerce.number().default(500 * 1024), // 500KB
```

- [ ] **Step 2: Create audit schema**

Create `src/drizzle/audit-schema.ts`:

```typescript
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").notNull(),
    userId: integer("user_id").notNull(),
    userName: varchar("user_name", { length: 128 }),
    key: varchar("key").notNull(),
    sessionId: varchar("session_id", { length: 64 }),
    requestSeq: integer("request_seq").default(1),

    model: varchar("model", { length: 128 }),
    endpoint: varchar("endpoint", { length: 256 }),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    costUsd: numeric("cost_usd", { precision: 21, scale: 15 }).default("0"),
    statusCode: integer("status_code"),

    contentSummary: text("content_summary"),
    contentPath: varchar("content_path", { length: 512 }),
    contentSize: integer("content_size"),
    compressed: boolean("compressed").default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    auditLogUserCreatedAtIdx: index("idx_audit_log_user_created_at").on(
      table.userId,
      table.createdAt
    ),
    auditLogSessionSeqIdx: index("idx_audit_log_session_seq").on(
      table.sessionId,
      table.requestSeq
    ),
    auditLogCreatedAtIdIdx: index("idx_audit_log_created_at_id").on(
      table.createdAt,
      table.id
    ),
    auditLogModelIdx: index("idx_audit_log_model").on(table.model),
  })
);
```

- [ ] **Step 3: Export from drizzle index**

In `src/drizzle/index.ts`, add:

```typescript
export * from './audit-schema';
```

- [ ] **Step 4: Update drizzle config to glob**

In `drizzle.config.ts`, change the `schema` field:

```typescript
  schema: "./src/drizzle/*.ts",
```

This ensures Drizzle picks up both `schema.ts` and `audit-schema.ts`.

- [ ] **Step 5: Generate migration**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run db:generate`

Expected: A new migration SQL file in `drizzle/` containing `CREATE TABLE audit_log`.

- [ ] **Step 6: Review generated SQL**

Read the generated migration file. Verify it creates the table with all columns and indexes. No manual edits should be needed.

- [ ] **Step 7: Commit**

```bash
git add src/drizzle/audit-schema.ts src/drizzle/index.ts drizzle.config.ts src/lib/config/env.schema.ts drizzle/
git commit -m "feat(audit): add audit_log schema and env vars"
```

---

## Task 2: Audit Preprocessor

**Files:**
- Create: `src/lib/audit/audit-preprocessor.ts`
- Create: `tests/unit/audit/audit-preprocessor.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/audit/audit-preprocessor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  preprocessAuditContent,
  extractSummary,
} from "@/lib/audit/audit-preprocessor";

describe("audit-preprocessor", () => {
  describe("extractSummary", () => {
    it("extracts first user message text up to limit", () => {
      const request = {
        messages: [
          { role: "user", content: "Hello world, this is a test message" },
        ],
      };
      const summary = extractSummary(request, 20);
      expect(summary).toBe("Hello world, this is");
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
      const response = { content: [] };
      const result = preprocessAuditContent(request, response, 500 * 1024);

      const imageBlock = (result.request.messages[0].content as any[])[0];
      expect(imageBlock.source.data).toMatch(/^\[IMAGE: \d+(\.\d+)? KB\]$/);
    });

    it("truncates messages exceeding max size", () => {
      const longText = "x".repeat(600 * 1024);
      const request = {
        messages: [{ role: "user", content: longText }],
      };
      const response = { content: [] };
      const result = preprocessAuditContent(request, response, 500 * 1024);

      expect((result.request.messages[0].content as string).length).toBeLessThanOrEqual(
        500 * 1024 + 50 // allow for truncation marker
      );
      expect(result.truncated).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "E:/coding/source/github/claude-code-hub" && bunx vitest run tests/unit/audit/audit-preprocessor.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement preprocessor**

Create `src/lib/audit/audit-preprocessor.ts`:

```typescript
const TRUNCATION_MARKER = "... [TRUNCATED]";

interface AuditContentResult {
  request: Record<string, unknown>;
  response: unknown;
  originalSize: number;
  truncated: boolean;
}

/**
 * Extract a summary from the first user message in a request.
 */
export function extractSummary(
  request: Record<string, unknown>,
  maxLength: number
): string {
  const messages = request.messages;
  if (!Array.isArray(messages)) return "";

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "user") continue;

    if (typeof m.content === "string") {
      return m.content.slice(0, maxLength);
    }

    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === "object" && block !== null && "text" in block) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") {
            return text.slice(0, maxLength);
          }
        }
      }
    }
  }

  return "";
}

/**
 * Preprocess request and response for audit storage.
 * - Strips image base64 data (replaces with size placeholder)
 * - Truncates individual messages exceeding maxMessageSize
 */
export function preprocessAuditContent(
  request: Record<string, unknown>,
  response: unknown,
  maxMessageSize: number
): AuditContentResult {
  const originalJson = JSON.stringify({ request, response });
  const originalSize = Buffer.byteLength(originalJson, "utf-8");

  let truncated = false;
  const processedRequest = deepClone(request);

  // Process messages array
  if (Array.isArray(processedRequest.messages)) {
    processedRequest.messages = (processedRequest.messages as unknown[]).map(
      (msg) => {
        if (typeof msg !== "object" || msg === null) return msg;
        const m = { ...(msg as Record<string, unknown>) };

        if (typeof m.content === "string" && Buffer.byteLength(m.content, "utf-8") > maxMessageSize) {
          m.content = m.content.slice(0, maxMessageSize) + TRUNCATION_MARKER;
          truncated = true;
        }

        if (Array.isArray(m.content)) {
          m.content = (m.content as unknown[]).map((block) => {
            if (typeof block !== "object" || block === null) return block;
            const b = { ...(block as Record<string, unknown>) };

            // Strip image base64
            if (
              b.type === "image" &&
              typeof b.source === "object" &&
              b.source !== null
            ) {
              const src = b.source as Record<string, unknown>;
              if (typeof src.data === "string" && src.data.length > 200) {
                const sizeKB = (Buffer.byteLength(src.data, "utf-8") / 1024).toFixed(1);
                b.source = { ...src, data: `[IMAGE: ${sizeKB} KB]` };
              }
            }

            // Truncate large text blocks
            if (typeof b.text === "string" && Buffer.byteLength(b.text, "utf-8") > maxMessageSize) {
              b.text = b.text.slice(0, maxMessageSize) + TRUNCATION_MARKER;
              truncated = true;
            }

            return b;
          });
        }

        return m;
      }
    );
  }

  return {
    request: processedRequest,
    response,
    originalSize,
    truncated,
  };
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "E:/coding/source/github/claude-code-hub" && bunx vitest run tests/unit/audit/audit-preprocessor.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit/audit-preprocessor.ts tests/unit/audit/audit-preprocessor.test.ts
git commit -m "feat(audit): add content preprocessor with image stripping and truncation"
```

---

## Task 3: JSONL File Store

**Files:**
- Create: `src/lib/audit/audit-file-store.ts`
- Create: `tests/unit/audit/audit-file-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/audit/audit-file-store.test.ts`:

```typescript
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
    const parts = relPath.split(/[/\\]/);
    // Should be YYYY/MM/session-2.jsonl
    expect(parts.length).toBe(3);
    expect(parts[0]).toMatch(/^\d{4}$/);
    expect(parts[1]).toMatch(/^\d{2}$/);
  });

  it("rolls file when exceeding max size", async () => {
    const bigLine = JSON.stringify({ data: "x".repeat(800) });
    await store.appendLine("session-3", bigLine);
    const path2 = await store.appendLine("session-3", bigLine);

    // Second write should go to .1.jsonl
    expect(path2).toMatch(/session-3\.1\.jsonl$/);
  });

  it("reads a specific line by index", async () => {
    await store.appendLine("session-4", '{"seq":1,"msg":"first"}');
    await store.appendLine("session-4", '{"seq":2,"msg":"second"}');

    // File might have rolled; read from the first file
    const lines = await store.readLines(
      store.getRelativePath("session-4"),
      0,
      10
    );
    // At minimum, the first file should have at least one line
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]).seq).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "E:/coding/source/github/claude-code-hub" && bunx vitest run tests/unit/audit/audit-file-store.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement file store**

Create `src/lib/audit/audit-file-store.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { logger } from "@/lib/logger";

export class AuditFileStore {
  constructor(
    private readonly baseDir: string,
    private readonly maxFileSize: number
  ) {}

  /**
   * Append a JSON line to the session's JSONL file.
   * Returns the relative path from baseDir.
   */
  async appendLine(sessionId: string, line: string): Promise<string> {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
    const dir = path.join(this.baseDir, yearMonth);

    await fs.promises.mkdir(dir, { recursive: true });

    let filePath = path.join(dir, `${sessionId}.jsonl`);
    let suffix = 0;

    // Roll if current file exceeds max size
    try {
      while ((await this.getFileSize(filePath)) >= this.maxFileSize) {
        suffix++;
        filePath = path.join(dir, `${sessionId}.${suffix}.jsonl`);
      }
    } catch {
      // File doesn't exist yet, use current path
    }

    await fs.promises.appendFile(filePath, line + "\n", "utf-8");

    return path.relative(this.baseDir, filePath).replace(/\\/g, "/");
  }

  /**
   * Read lines from a JSONL file.
   * @param relativePath - Path relative to baseDir
   * @param offset - Line offset (0-based)
   * @param limit - Max lines to return
   */
  async readLines(
    relativePath: string,
    offset: number,
    limit: number
  ): Promise<string[]> {
    const fullPath = path.join(this.baseDir, relativePath);

    try {
      const content = await fs.promises.readFile(fullPath, "utf-8");
      const allLines = content.split("\n").filter((line) => line.trim() !== "");
      return allLines.slice(offset, offset + limit);
    } catch (error) {
      logger.warn("[AuditFileStore] Failed to read file", {
        path: relativePath,
        error,
      });
      return [];
    }
  }

  /**
   * Compress a file with gzip.
   * Returns the .gz path relative to baseDir.
   */
  async compressFile(relativePath: string): Promise<string> {
    const fullPath = path.join(this.baseDir, relativePath);
    const gzPath = `${fullPath}.gz`;

    await pipeline(createReadStream(fullPath), createGzip(), createWriteStream(gzPath));

    await fs.promises.unlink(fullPath);

    return path.relative(this.baseDir, gzPath).replace(/\\/g, "/");
  }

  /**
   * Get the relative path for a session (without checking if it exists).
   */
  getRelativePath(sessionId: string): string {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
    return `${yearMonth}/${sessionId}.jsonl`;
  }

  private async getFileSize(filePath: string): Promise<number> {
    const stats = await fs.promises.stat(filePath);
    return stats.size;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "E:/coding/source/github/claude-code-hub" && bunx vitest run tests/unit/audit/audit-file-store.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit/audit-file-store.ts tests/unit/audit/audit-file-store.test.ts
git commit -m "feat(audit): add JSONL file store with rolling and line reading"
```

---

## Task 4: Audit Writer & Hook

**Files:**
- Create: `src/lib/audit/audit-writer.ts`
- Create: `src/lib/audit/audit-hook.ts`
- Create: `tests/unit/audit/audit-writer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/audit/audit-writer.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: vi.fn(() => ({
    ENABLE_AUDIT: true,
    AUDIT_DATA_DIR: "/tmp/audit-test",
    AUDIT_MAX_FILE_SIZE: 10 * 1024 * 1024,
    AUDIT_CONTENT_MAX_SIZE: 500 * 1024,
  })),
}));

vi.mock("@/drizzle/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { shouldAudit } from "@/lib/audit/audit-writer";

describe("audit-writer", () => {
  describe("shouldAudit", () => {
    it("returns true when provider is selected and not blocked", () => {
      const session = {
        provider: { id: 1 },
        messageContext: { id: 100 },
        authState: { user: { id: 1 }, apiKey: "sk-xxx" },
      };
      expect(shouldAudit(session as any)).toBe(true);
    });

    it("returns false when no provider", () => {
      const session = {
        provider: null,
        messageContext: { id: 100 },
      };
      expect(shouldAudit(session as any)).toBe(false);
    });

    it("returns false when provider id is 0 (blocked)", () => {
      const session = {
        provider: { id: 0 },
        messageContext: { id: 100 },
      };
      expect(shouldAudit(session as any)).toBe(false);
    });

    it("returns false when no messageContext", () => {
      const session = {
        provider: { id: 1 },
        messageContext: null,
      };
      expect(shouldAudit(session as any)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "E:/coding/source/github/claude-code-hub" && bunx vitest run tests/unit/audit/audit-writer.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement audit writer**

Create `src/lib/audit/audit-writer.ts`:

```typescript
import { db } from "@/drizzle/db";
import { auditLog } from "@/drizzle/audit-schema";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { AuditFileStore } from "./audit-file-store";
import {
  extractSummary,
  preprocessAuditContent,
} from "./audit-preprocessor";

let fileStore: AuditFileStore | null = null;

function getFileStore(): AuditFileStore {
  if (!fileStore) {
    const config = getEnvConfig();
    fileStore = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);
  }
  return fileStore;
}

/**
 * Determine if a request should be audited.
 * Only audit requests that reached a provider (not blocked by guards).
 */
export function shouldAudit(session: ProxySession): boolean {
  return (
    session.provider != null &&
    session.provider.id > 0 &&
    session.messageContext != null
  );
}

/**
 * Write an audit record: JSONL file + database row.
 */
export async function writeAuditRecord(
  session: ProxySession,
  responseText: string
): Promise<void> {
  try {
    const config = getEnvConfig();
    const store = getFileStore();
    const messageContext = session.messageContext!;
    const auth = session.authState;

    // Parse response body
    let responseBody: unknown = null;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Non-JSON response (e.g., SSE text), store as-is
      responseBody = { _raw: responseText.slice(0, config.AUDIT_CONTENT_MAX_SIZE) };
    }

    // Preprocess content
    const processed = preprocessAuditContent(
      session.request.message,
      responseBody,
      config.AUDIT_CONTENT_MAX_SIZE
    );

    // Build JSONL line
    const line = JSON.stringify({
      seq: session.requestSequence,
      ts: new Date().toISOString(),
      request: processed.request,
      response: processed.response,
      _meta: {
        size: processed.originalSize,
        truncated: processed.truncated,
      },
    });

    // Determine if compression is needed
    const lineSize = Buffer.byteLength(line, "utf-8");
    let compressed = false;
    let contentPath: string;

    if (lineSize > 2 * 1024 * 1024) {
      // Write to temp, compress, then record the .gz path
      contentPath = await store.appendLine(
        session.sessionId ?? `nosession-${messageContext.id}`,
        line
      );
      contentPath = await store.compressFile(contentPath);
      compressed = true;
    } else {
      contentPath = await store.appendLine(
        session.sessionId ?? `nosession-${messageContext.id}`,
        line
      );
    }

    // Extract summary for SQL search
    const summary = extractSummary(session.request.message, 500);

    // Insert audit_log row
    await db.insert(auditLog).values({
      requestId: messageContext.id,
      userId: auth?.user?.id ?? 0,
      userName: auth?.user?.name ?? session.userName,
      key: auth?.apiKey ?? "",
      sessionId: session.sessionId ?? null,
      requestSeq: session.requestSequence,
      model: session.request.model,
      endpoint: session.getEndpoint() ?? null,
      inputTokens: undefined, // filled by finalizeRequestStats later, or read from response
      outputTokens: undefined,
      costUsd: "0",
      statusCode: undefined,
      contentSummary: summary,
      contentPath,
      contentSize: processed.originalSize,
      compressed,
    });

    logger.debug("[AuditWriter] Audit record written", {
      sessionId: session.sessionId,
      requestSeq: session.requestSequence,
      contentPath,
      contentSize: processed.originalSize,
    });
  } catch (error) {
    // Audit failure must never break the proxy
    logger.error("[AuditWriter] Failed to write audit record", { error });
  }
}
```

- [ ] **Step 4: Implement audit hook**

Create `src/lib/audit/audit-hook.ts`:

```typescript
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { shouldAudit, writeAuditRecord } from "./audit-writer";

export const auditHook = {
  /**
   * Called after proxy response completes.
   * Fire-and-forget: errors are caught internally.
   */
  async onRequestComplete(
    session: ProxySession,
    responseText: string
  ): Promise<void> {
    try {
      if (!getEnvConfig().ENABLE_AUDIT) return;
      if (!shouldAudit(session)) return;

      await writeAuditRecord(session, responseText);
    } catch (error) {
      logger.error("[AuditHook] Unexpected error", { error });
    }
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "E:/coding/source/github/claude-code-hub" && bunx vitest run tests/unit/audit/audit-writer.test.ts`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/audit/audit-writer.ts src/lib/audit/audit-hook.ts tests/unit/audit/audit-writer.test.ts
git commit -m "feat(audit): add audit writer and hook entry point"
```

---

## Task 5: Hook into Response Handler

**Files:**
- Modify: `src/app/v1/_lib/proxy/response-handler.ts`

This is the **only modification to a core file**. Two hook points: one in `finalizeRequestStats` (covers non-stream + Gemini passthrough), one in `finalizeStream` (covers main stream path).

- [ ] **Step 1: Add import**

At the top of `src/app/v1/_lib/proxy/response-handler.ts` (after line 39):

```typescript
import { auditHook } from "@/lib/audit/audit-hook";
```

- [ ] **Step 2: Hook in finalizeRequestStats**

In `finalizeRequestStats` function, just before `return normalizedUsage;` (line 3419):

```typescript
  void auditHook.onRequestComplete(session, responseText);

  return normalizedUsage;
```

- [ ] **Step 3: Hook in finalizeStream**

In the `finalizeStream` inner function, just before the closing `};` (around line 2234, after `emitLangfuseTrace`):

```typescript
        void auditHook.onRequestComplete(session, allContent);
```

- [ ] **Step 4: Verify build**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run typecheck`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/v1/_lib/proxy/response-handler.ts
git commit -m "feat(audit): hook audit writer into response handler (2 lines)"
```

---

## Task 6: Server Actions for Audit Data

**Files:**
- Create: `src/actions/audit.ts`

- [ ] **Step 1: Implement server actions**

Create `src/actions/audit.ts`:

```typescript
"use server";

import { and, count, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { auditLog } from "@/drizzle/audit-schema";
import { getEnvConfig } from "@/lib/config/env.schema";
import { AuditFileStore } from "@/lib/audit/audit-file-store";
import { getSession } from "@/lib/auth";
import type { ActionResult } from "@/actions/types";

export interface AuditSessionItem {
  sessionId: string | null;
  userName: string | null;
  model: string | null;
  firstSummary: string | null;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: string;
  firstAt: string;
  lastAt: string;
}

export interface AuditListResult {
  sessions: AuditSessionItem[];
  total: number;
  hasMore: boolean;
}

export async function getAuditSessions(params: {
  page: number;
  pageSize: number;
  userId?: number;
  model?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
}): Promise<ActionResult<AuditListResult>> {
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return { success: false, error: "Unauthorized" };
  }

  const { page, pageSize, userId, model, search, startDate, endDate } = params;
  const conditions = [];

  if (userId) conditions.push(eq(auditLog.userId, userId));
  if (model) conditions.push(eq(auditLog.model, model));
  if (search) conditions.push(ilike(auditLog.contentSummary, `%${search}%`));
  if (startDate) conditions.push(gte(auditLog.createdAt, new Date(startDate)));
  if (endDate) conditions.push(lte(auditLog.createdAt, new Date(endDate)));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Query grouped by session_id
  const sessionsQuery = db
    .select({
      sessionId: auditLog.sessionId,
      userName: sql<string>`MIN(${auditLog.userName})`.as("user_name"),
      model: sql<string>`MODE() WITHIN GROUP (ORDER BY ${auditLog.model})`.as("model"),
      firstSummary: sql<string>`(ARRAY_AGG(${auditLog.contentSummary} ORDER BY ${auditLog.requestSeq}))[1]`.as("first_summary"),
      requestCount: count().as("request_count"),
      totalInputTokens: sql<number>`COALESCE(SUM(${auditLog.inputTokens}), 0)`.as("total_input"),
      totalOutputTokens: sql<number>`COALESCE(SUM(${auditLog.outputTokens}), 0)`.as("total_output"),
      totalCost: sql<string>`COALESCE(SUM(${auditLog.costUsd}), 0)`.as("total_cost"),
      firstAt: sql<string>`MIN(${auditLog.createdAt})`.as("first_at"),
      lastAt: sql<string>`MAX(${auditLog.createdAt})`.as("last_at"),
    })
    .from(auditLog)
    .where(whereClause)
    .groupBy(auditLog.sessionId)
    .orderBy(desc(sql`MAX(${auditLog.createdAt})`))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);

  const results = await sessionsQuery;
  const hasMore = results.length > pageSize;
  const sessions = results.slice(0, pageSize);

  return {
    success: true,
    data: {
      sessions,
      total: sessions.length,
      hasMore,
    },
  };
}

export interface AuditChatMessage {
  seq: number;
  ts: string;
  request: Record<string, unknown>;
  response: unknown;
  _meta: { size: number; truncated: boolean };
}

export interface AuditChatResult {
  messages: AuditChatMessage[];
  hasMore: boolean;
  totalRecords: number;
}

export async function getAuditChat(params: {
  sessionId: string;
  page: number;
  pageSize: number;
}): Promise<ActionResult<AuditChatResult>> {
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return { success: false, error: "Unauthorized" };
  }

  const { sessionId, page, pageSize } = params;

  // Get audit records for this session
  const records = await db
    .select({
      requestSeq: auditLog.requestSeq,
      contentPath: auditLog.contentPath,
      compressed: auditLog.compressed,
    })
    .from(auditLog)
    .where(eq(auditLog.sessionId, sessionId))
    .orderBy(auditLog.requestSeq)
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);

  const totalQuery = await db
    .select({ count: count() })
    .from(auditLog)
    .where(eq(auditLog.sessionId, sessionId));

  const totalRecords = totalQuery[0]?.count ?? 0;
  const hasMore = records.length > pageSize;
  const recordSlice = records.slice(0, pageSize);

  // Read content from JSONL files
  const config = getEnvConfig();
  const store = new AuditFileStore(config.AUDIT_DATA_DIR, config.AUDIT_MAX_FILE_SIZE);
  const messages: AuditChatMessage[] = [];

  for (const record of recordSlice) {
    if (!record.contentPath) continue;

    try {
      const lines = await store.readLines(record.contentPath, 0, 10000);
      // Find the line matching this request sequence
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as AuditChatMessage;
          if (parsed.seq === record.requestSeq) {
            messages.push(parsed);
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (error) {
      // File read failed, skip this record
    }
  }

  return {
    success: true,
    data: { messages, hasMore, totalRecords },
  };
}

/**
 * Get distinct models used in audit logs (for filter dropdown).
 */
export async function getAuditModels(): Promise<ActionResult<string[]>> {
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return { success: false, error: "Unauthorized" };
  }

  const results = await db
    .selectDistinct({ model: auditLog.model })
    .from(auditLog)
    .where(sql`${auditLog.model} IS NOT NULL`)
    .orderBy(auditLog.model);

  return {
    success: true,
    data: results.map((r) => r.model!).filter(Boolean),
  };
}
```

- [ ] **Step 2: Verify build**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run typecheck`

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/actions/audit.ts
git commit -m "feat(audit): add server actions for audit list and chat view"
```

---

## Task 7: i18n Strings

**Files:**
- Modify: `messages/en/dashboard.json`
- Modify: `messages/zh-CN/dashboard.json`
- Modify: `messages/zh-TW/dashboard.json`
- Modify: `messages/ja/dashboard.json`
- Modify: `messages/ru/dashboard.json`

- [ ] **Step 1: Add English strings**

In `messages/en/dashboard.json`, add inside the top-level `"nav"` object a new key:

```json
"audit": "Audit"
```

Then add a new top-level `"audit"` section (as a sibling to `"sessions"`, `"logs"`, etc.):

```json
"audit": {
  "title": "Audit Logs",
  "description": "Review team AI usage and conversation content",
  "filters": {
    "user": "User",
    "model": "Model",
    "timeRange": "Time Range",
    "search": "Search summary...",
    "startDate": "Start Date",
    "endDate": "End Date",
    "apply": "Apply",
    "reset": "Reset"
  },
  "columns": {
    "time": "Time",
    "user": "User",
    "model": "Model",
    "requests": "Requests",
    "tokens": "Tokens",
    "cost": "Cost",
    "summary": "Summary"
  },
  "chat": {
    "title": "Session Audit",
    "back": "Back to Audit List",
    "systemPrompt": "System Prompt",
    "loadMore": "Load More",
    "sessionInfo": "Session Info",
    "totalRounds": "Total Rounds",
    "totalTokens": "Total Tokens",
    "totalCost": "Total Cost",
    "duration": "Duration",
    "noData": "No audit data for this session",
    "userMessage": "User",
    "assistantMessage": "Assistant",
    "tokens": "tokens"
  }
}
```

- [ ] **Step 2: Add zh-CN strings**

In `messages/zh-CN/dashboard.json`, add to `"nav"`:

```json
"audit": "审计"
```

Add top-level `"audit"` section:

```json
"audit": {
  "title": "审计日志",
  "description": "查看团队 AI 使用记录和对话内容",
  "filters": {
    "user": "用户",
    "model": "模型",
    "timeRange": "时间范围",
    "search": "搜索摘要...",
    "startDate": "开始日期",
    "endDate": "结束日期",
    "apply": "应用",
    "reset": "重置"
  },
  "columns": {
    "time": "时间",
    "user": "用户",
    "model": "模型",
    "requests": "请求数",
    "tokens": "Tokens",
    "cost": "费用",
    "summary": "摘要"
  },
  "chat": {
    "title": "会话审计",
    "back": "返回审计列表",
    "systemPrompt": "系统提示词",
    "loadMore": "加载更多",
    "sessionInfo": "会话信息",
    "totalRounds": "总轮次",
    "totalTokens": "总 Tokens",
    "totalCost": "总费用",
    "duration": "时长",
    "noData": "该会话无审计数据",
    "userMessage": "用户",
    "assistantMessage": "助手",
    "tokens": "tokens"
  }
}
```

- [ ] **Step 3: Add zh-TW, ja, ru strings**

Repeat the same structure for:
- `messages/zh-TW/dashboard.json` — Traditional Chinese
- `messages/ja/dashboard.json` — Japanese
- `messages/ru/dashboard.json` — Russian

Translate each key appropriately. Follow the same pattern as existing translations in each file.

- [ ] **Step 4: Verify i18n audit**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run i18n:audit-placeholders`

Expected: No missing placeholders for audit keys.

- [ ] **Step 5: Commit**

```bash
git add messages/
git commit -m "feat(audit): add i18n strings for audit pages (5 locales)"
```

---

## Task 8: Dashboard Navigation

**Files:**
- Modify: `src/app/[locale]/dashboard/_components/dashboard-header.tsx:31`

- [ ] **Step 1: Add audit nav item**

In `dashboard-header.tsx`, add a new item to the `NAV_ITEMS` array, before the `documentation` entry (line 30):

```typescript
    { href: "/dashboard/audit", label: t("audit"), adminOnly: true },
```

- [ ] **Step 2: Verify build**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run typecheck`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/[locale]/dashboard/_components/dashboard-header.tsx
git commit -m "feat(audit): add audit nav item to dashboard header"
```

---

## Task 9: Audit List Page

**Files:**
- Create: `src/app/[locale]/dashboard/audit/page.tsx`
- Create: `src/app/[locale]/dashboard/audit/_components/audit-list.tsx`
- Create: `src/app/[locale]/dashboard/audit/_components/audit-filters.tsx`

- [ ] **Step 1: Create page server component**

Create `src/app/[locale]/dashboard/audit/page.tsx`:

```tsx
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { getTranslations } from "next-intl/server";
import { AuditListClient } from "./_components/audit-list";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session || session.user.role !== "admin") {
    return redirect({ href: session ? "/dashboard" : "/login", locale });
  }

  const t = await getTranslations("dashboard.audit");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("description")}</p>
      </div>
      <AuditListClient />
    </div>
  );
}
```

- [ ] **Step 2: Create filter bar component**

Create `src/app/[locale]/dashboard/audit/_components/audit-filters.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { getAuditModels } from "@/actions/audit";

interface AuditFiltersProps {
  onFilterChange: (filters: {
    search?: string;
    model?: string;
    startDate?: string;
    endDate?: string;
  }) => void;
}

export function AuditFilters({ onFilterChange }: AuditFiltersProps) {
  const t = useTranslations("dashboard.audit.filters");
  const [search, setSearch] = useState("");
  const [model, setModel] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    getAuditModels().then((result) => {
      if (result.success && result.data) {
        setModels(result.data);
      }
    });
  }, []);

  const handleApply = () => {
    onFilterChange({
      search: search || undefined,
      model: model || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });
  };

  const handleReset = () => {
    setSearch("");
    setModel("");
    setStartDate("");
    setEndDate("");
    onFilterChange({});
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        placeholder={t("search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-64"
        onKeyDown={(e) => e.key === "Enter" && handleApply()}
      />
      <Select value={model} onValueChange={setModel}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder={t("model")} />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="date"
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
        className="w-40"
        placeholder={t("startDate")}
      />
      <Input
        type="date"
        value={endDate}
        onChange={(e) => setEndDate(e.target.value)}
        className="w-40"
        placeholder={t("endDate")}
      />
      <Button onClick={handleApply} size="sm">
        {t("apply")}
      </Button>
      <Button onClick={handleReset} size="sm" variant="outline">
        {t("reset")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Create audit list component**

Create `src/app/[locale]/dashboard/audit/_components/audit-list.tsx`:

```tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import {
  type AuditSessionItem,
  getAuditSessions,
} from "@/actions/audit";
import { AuditFilters } from "./audit-filters";

export function AuditListClient() {
  const t = useTranslations("dashboard.audit");
  const [sessions, setSessions] = useState<AuditSessionItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState<{
    search?: string;
    model?: string;
    startDate?: string;
    endDate?: string;
  }>({});

  const fetchData = useCallback(
    async (pageNum: number) => {
      setIsLoading(true);
      const result = await getAuditSessions({
        page: pageNum,
        pageSize: 20,
        ...filters,
      });
      if (result.success && result.data) {
        setSessions(result.data.sessions);
        setHasMore(result.data.hasMore);
      }
      setIsLoading(false);
    },
    [filters]
  );

  useEffect(() => {
    setPage(1);
    fetchData(1);
  }, [fetchData]);

  const handleFilterChange = (newFilters: typeof filters) => {
    setFilters(newFilters);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="space-y-4">
      <AuditFilters onFilterChange={handleFilterChange} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.time")}</TableHead>
              <TableHead>{t("columns.user")}</TableHead>
              <TableHead>{t("columns.model")}</TableHead>
              <TableHead className="text-center">{t("columns.requests")}</TableHead>
              <TableHead className="text-right">{t("columns.tokens")}</TableHead>
              <TableHead className="text-right">{t("columns.cost")}</TableHead>
              <TableHead>{t("columns.summary")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {t("chat.noData")}
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => (
                <TableRow key={s.sessionId ?? "null"} className="cursor-pointer hover:bg-muted/50">
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatDate(s.firstAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{s.userName ?? "Unknown"}</Badge>
                  </TableCell>
                  <TableCell className="text-sm font-mono">{s.model ?? "-"}</TableCell>
                  <TableCell className="text-center">{s.requestCount}</TableCell>
                  <TableCell className="text-right text-sm">
                    {(s.totalInputTokens + s.totalOutputTokens).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono">
                    ${Number(s.totalCost).toFixed(4)}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                    {s.sessionId ? (
                      <Link
                        href={`/dashboard/audit/${s.sessionId}`}
                        className="hover:underline"
                      >
                        {s.firstSummary || "-"}
                      </Link>
                    ) : (
                      s.firstSummary || "-"
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const p = page - 1;
            setPage(p);
            fetchData(p);
          }}
          disabled={page <= 1 || isLoading}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">Page {page}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const p = page + 1;
            setPage(p);
            fetchData(p);
          }}
          disabled={!hasMore || isLoading}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run typecheck`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/[locale]/dashboard/audit/
git commit -m "feat(audit): add audit list page with filters and session grouping"
```

---

## Task 10: Chat View Page

**Files:**
- Create: `src/app/[locale]/dashboard/audit/[sessionId]/page.tsx`
- Create: `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-chat-view.tsx`
- Create: `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-chat-bubble.tsx`
- Create: `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-session-stats.tsx`

- [ ] **Step 1: Create chat view page**

Create `src/app/[locale]/dashboard/audit/[sessionId]/page.tsx`:

```tsx
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { AuditChatViewClient } from "./_components/audit-chat-view";

export const dynamic = "force-dynamic";

export default async function AuditChatPage({
  params,
}: {
  params: Promise<{ locale: string; sessionId: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session || session.user.role !== "admin") {
    return redirect({ href: session ? "/dashboard" : "/login", locale });
  }

  return <AuditChatViewClient />;
}
```

- [ ] **Step 2: Create chat bubble component**

Create `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-chat-bubble.tsx`:

```tsx
"use client";

import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

interface ChatBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  tokens?: number;
}

export function AuditChatBubble({ role, content, timestamp, tokens }: ChatBubbleProps) {
  const t = useTranslations("dashboard.audit.chat");
  const isUser = role === "user";
  const isSystem = role === "system";

  if (isSystem) {
    return (
      <div className="mx-auto my-4 max-w-2xl rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30 p-4">
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {t("systemPrompt")}
        </div>
        <pre className="whitespace-pre-wrap break-words text-sm">{content}</pre>
      </div>
    );
  }

  return (
    <div
      className={cn("my-3 flex", isUser ? "justify-start" : "justify-end")}
    >
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-3",
          isUser
            ? "rounded-bl-md bg-blue-50 dark:bg-blue-950/40"
            : "rounded-br-md bg-muted"
        )}
      >
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {isUser ? t("userMessage") : t("assistantMessage")}
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {content}
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          {timestamp && <span>{new Date(timestamp).toLocaleTimeString()}</span>}
          {tokens != null && tokens > 0 && (
            <span>
              {tokens.toLocaleString()} {t("tokens")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create session stats component**

Create `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-session-stats.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "next-intl";

interface AuditSessionStatsProps {
  totalRounds: number;
  totalTokens: number;
  totalCost: string;
  duration: string;
  model: string;
  userName: string;
}

export function AuditSessionStats({
  totalRounds,
  totalTokens,
  totalCost,
  duration,
  model,
  userName,
}: AuditSessionStatsProps) {
  const t = useTranslations("dashboard.audit.chat");

  const stats = [
    { label: t("totalRounds"), value: totalRounds.toString() },
    { label: t("totalTokens"), value: totalTokens.toLocaleString() },
    { label: t("totalCost"), value: `$${Number(totalCost).toFixed(4)}` },
    { label: t("duration"), value: duration },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("sessionInfo")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm">
          <span className="text-muted-foreground">User: </span>
          <span className="font-medium">{userName}</span>
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">Model: </span>
          <span className="font-mono text-xs">{model}</span>
        </div>
        {stats.map((stat) => (
          <div key={stat.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{stat.label}</span>
            <span className="font-medium">{stat.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Create main chat view component**

Create `src/app/[locale]/dashboard/audit/[sessionId]/_components/audit-chat-view.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  type AuditChatMessage,
  getAuditChat,
  getAuditSessions,
} from "@/actions/audit";
import { AuditChatBubble } from "./audit-chat-bubble";
import { AuditSessionStats } from "./audit-session-stats";

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
          if (typeof b.thinking === "string") return `[thinking] ${b.thinking}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return JSON.stringify(content, null, 2);
}

function extractResponseText(response: unknown): string {
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>;

    // Claude format: content[]
    if (Array.isArray(r.content)) {
      return extractTextContent(r.content);
    }

    // OpenAI format: choices[].message.content
    if (Array.isArray(r.choices)) {
      return (r.choices as any[])
        .map((c) => c?.message?.content || c?.delta?.content || "")
        .filter(Boolean)
        .join("\n");
    }

    // Raw text
    if (typeof r._raw === "string") return r._raw;
  }

  return typeof response === "string" ? response : JSON.stringify(response, null, 2);
}

export function AuditChatViewClient() {
  const t = useTranslations("dashboard.audit.chat");
  const params = useParams();
  const sessionId = params.sessionId as string;

  const [messages, setMessages] = useState<AuditChatMessage[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalRecords, setTotalRecords] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionInfo, setSessionInfo] = useState<{
    userName: string;
    model: string;
    totalCost: string;
    firstAt: string;
    lastAt: string;
  } | null>(null);

  const fetchMessages = useCallback(
    async (pageNum: number, prepend = false) => {
      setIsLoading(true);
      const result = await getAuditChat({
        sessionId,
        page: pageNum,
        pageSize: 20,
      });

      if (result.success && result.data) {
        if (prepend) {
          setMessages((prev) => [...result.data!.messages, ...prev]);
        } else {
          setMessages(result.data.messages);
        }
        setHasMore(result.data.hasMore);
        setTotalRecords(result.data.totalRecords);
      }
      setIsLoading(false);
    },
    [sessionId]
  );

  useEffect(() => {
    fetchMessages(1);

    // Fetch session summary info
    getAuditSessions({ page: 1, pageSize: 1, search: sessionId }).then(
      (result) => {
        if (result.success && result.data && result.data.sessions.length > 0) {
          const s = result.data.sessions[0];
          setSessionInfo({
            userName: s.userName ?? "Unknown",
            model: s.model ?? "Unknown",
            totalCost: s.totalCost,
            firstAt: s.firstAt,
            lastAt: s.lastAt,
          });
        }
      }
    );
  }, [fetchMessages, sessionId]);

  const handleLoadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchMessages(nextPage, true);
  };

  const totalTokens = messages.reduce((sum, m) => {
    const meta = m._meta;
    return sum + (meta?.size ?? 0);
  }, 0);

  const duration =
    sessionInfo && sessionInfo.firstAt && sessionInfo.lastAt
      ? formatDuration(
          new Date(sessionInfo.lastAt).getTime() -
            new Date(sessionInfo.firstAt).getTime()
        )
      : "-";

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Main chat area */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-4 border-b pb-4">
          <Link href="/dashboard/audit">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("back")}
            </Button>
          </Link>
          <div>
            <h2 className="text-lg font-semibold">{t("title")}</h2>
            <p className="font-mono text-xs text-muted-foreground">
              {sessionId}
            </p>
          </div>
        </div>

        {/* Chat messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {hasMore && (
            <div className="mb-4 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={handleLoadMore}
                disabled={isLoading}
              >
                {t("loadMore")}
              </Button>
            </div>
          )}

          {messages.length === 0 && !isLoading && (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {t("noData")}
            </div>
          )}

          {messages.map((msg) => {
            const items: React.ReactNode[] = [];

            // System prompt (only for first message)
            if (msg.seq === 1 && msg.request.system) {
              const systemText =
                typeof msg.request.system === "string"
                  ? msg.request.system
                  : extractTextContent(msg.request.system);
              items.push(
                <AuditChatBubble
                  key={`${msg.seq}-system`}
                  role="system"
                  content={systemText}
                />
              );
            }

            // User messages
            const userMessages = Array.isArray(msg.request.messages)
              ? (msg.request.messages as any[]).filter(
                  (m) => m.role === "user"
                )
              : [];

            for (const um of userMessages) {
              items.push(
                <AuditChatBubble
                  key={`${msg.seq}-user-${items.length}`}
                  role="user"
                  content={extractTextContent(um.content)}
                  timestamp={msg.ts}
                />
              );
            }

            // Assistant response
            const responseText = extractResponseText(msg.response);
            if (responseText) {
              items.push(
                <AuditChatBubble
                  key={`${msg.seq}-assistant`}
                  role="assistant"
                  content={responseText}
                  timestamp={msg.ts}
                />
              );
            }

            return items;
          })}
        </div>
      </div>

      {/* Stats sidebar */}
      <div className="hidden w-72 shrink-0 lg:block">
        <AuditSessionStats
          totalRounds={totalRecords}
          totalTokens={totalTokens}
          totalCost={sessionInfo?.totalCost ?? "0"}
          duration={duration}
          model={sessionInfo?.model ?? "-"}
          userName={sessionInfo?.userName ?? "-"}
        />
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}
```

- [ ] **Step 5: Verify build**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run typecheck`

Expected: No type errors.

- [ ] **Step 6: Visual test**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run dev`

Navigate to `http://localhost:13500/dashboard/audit` in a browser. Verify:
- Page loads without errors
- Navigation item appears for admin users
- Empty state displays correctly
- Chat view page at `/dashboard/audit/{any-session-id}` renders the layout

- [ ] **Step 7: Commit**

```bash
git add src/app/[locale]/dashboard/audit/
git commit -m "feat(audit): add chat view page with bubble UI and session stats"
```

---

## Task 11: Full Integration Test

- [ ] **Step 1: Run full typecheck**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run typecheck`

Expected: PASS, no errors.

- [ ] **Step 2: Run full test suite**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run test`

Expected: All existing tests PASS. New audit tests PASS.

- [ ] **Step 3: Run lint**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run lint:fix`

Expected: No errors after auto-fix.

- [ ] **Step 4: Run build**

Run: `cd "E:/coding/source/github/claude-code-hub" && bun run build`

Expected: Production build succeeds.

- [ ] **Step 5: Commit any lint fixes**

```bash
git add -A
git commit -m "chore(audit): lint fixes"
```

---

## Summary of Core File Changes

Only 3 existing files are modified, each with minimal diff:

| File | Diff |
|------|------|
| `response-handler.ts` | +1 import, +2 `void auditHook.onRequestComplete(...)` calls |
| `dashboard-header.tsx` | +1 nav item in array |
| `env.schema.ts` | +4 env var definitions |
| `drizzle/index.ts` | +1 export line |
| `drizzle.config.ts` | schema path change to glob |
