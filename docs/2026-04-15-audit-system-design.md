# Security Audit System Design

> Phase 1: Content Persistence + Chat-View Audit Page

## Background

Team uses Claude Code Hub as a unified AI API proxy. Need security audit capabilities to:
- Persist full conversation content for post-hoc review
- Detect misuse of team AI quota (personal use, off-topic queries)
- Provide a chat-style viewer for admins to review conversations

Current state: request metadata is logged to `message_request` table, but conversation content only lives in Redis with 5-min TTL and is subject to redaction (`STORE_SESSION_MESSAGES`). No persistent audit trail for content.

## Constraints

### Incremental Deployment

The system is **in production use**. All changes must be:
- Non-breaking: existing functionality unaffected
- Additive: new tables, new files, new routes — no destructive schema changes
- Feature-gated: `ENABLE_AUDIT=false` by default, zero performance impact when off

### Upstream Sync Friendliness

This is a fork of [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub). Design must minimize merge conflicts when syncing upstream updates.

**Isolation principles:**

| Principle | Implementation |
|-----------|---------------|
| Audit code isolation | All audit logic in `src/lib/audit/`, `src/actions/audit.ts`, `src/app/.../audit/` |
| Schema isolation | `audit_log` defined in `src/drizzle/audit-schema.ts` (separate file), imported in schema index |
| Minimal core file changes | `response-handler.ts` gets only 1 hook call line + 1 import line |
| Feature switch | `ENABLE_AUDIT=false` skips all audit code paths at runtime |
| New files don't conflict | All new files are in directories that don't exist upstream |

**Core file touch points (total: 3 files, ~5 lines each):**

| File | Change | Conflict Risk |
|------|--------|---------------|
| `src/app/v1/_lib/proxy/response-handler.ts` | +1 import, +1 `void auditHook.onRequestComplete(session, responseBody)` | Low — append at end of function |
| `src/app/[locale]/dashboard/_components/dashboard-header.tsx` | +1 nav item in `NAV_ITEMS` array | Low — array append |
| `src/drizzle/schema.ts` or index file | +1 import of `audit-schema.ts` | Low — import append |

**Event hook pattern (response-handler.ts):**

```typescript
// Only addition to response-handler.ts:
import { auditHook } from "@/lib/audit/audit-hook";

// At response completion point:
void auditHook.onRequestComplete(session, responseBody);
```

```typescript
// src/lib/audit/audit-hook.ts — fully isolated
import { getEnvConfig } from "@/lib/config/env.schema";
import { AuditWriter } from "./audit-writer";

export const auditHook = {
  async onRequestComplete(session: ProxySession, responseBody: unknown) {
    if (!getEnvConfig().ENABLE_AUDIT) return;  // zero cost when off
    await AuditWriter.write(session, responseBody);
  },
};
```

**Upstream merge workflow:**

```bash
git fetch upstream
git merge upstream/main
# Conflicts (if any) will only be in the 3 files above
# Each conflict is 1-2 lines, trivially resolvable
```

## Scope

**In scope (Phase 1):**
- `audit_log` PG table for metadata
- JSONL file storage for full conversation content
- Async write pipeline after proxy response completes
- Dashboard audit list page + session chat-view page

**Out of scope (future phases):**
- Automatic content classification (work / personal / suspicious)
- `audit_keywords` rule engine
- Risk label detection (PII, credentials, code leak)
- Anomaly detection and alerting
- Audit report export
- Admin operation audit trail

## Data Model

### `audit_log` Table (PostgreSQL)

```sql
CREATE TABLE audit_log (
  id            SERIAL PRIMARY KEY,
  request_id    INTEGER NOT NULL,          -- references message_request(id)
  user_id       INTEGER NOT NULL,
  user_name     VARCHAR(128),
  key           VARCHAR NOT NULL,          -- API key (hashed)
  session_id    VARCHAR(64),
  request_seq   INTEGER DEFAULT 1,         -- sequence within session

  -- Request summary
  model         VARCHAR(128),
  endpoint      VARCHAR(256),
  input_tokens  BIGINT,
  output_tokens BIGINT,
  cost_usd      NUMERIC(21,15) DEFAULT 0,
  status_code   INTEGER,

  -- Content audit
  content_summary TEXT,                    -- first 500 chars for SQL search
  content_path    VARCHAR(512),            -- relative path to JSONL file
  content_size    INTEGER,                 -- original content size in bytes
  compressed      BOOLEAN DEFAULT FALSE,   -- gzip compressed flag

  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

**Indexes:**
- `(user_id, created_at DESC)` — filter by user
- `(session_id, request_seq)` — chat view session replay
- `(created_at DESC, id DESC)` — keyset pagination
- `(model)` — filter by model

### JSONL File Storage

```
{AUDIT_DATA_DIR}/
  2026/04/
    {sessionId}.jsonl
    {sessionId}.1.jsonl      -- rolled when > 10MB
    {sessionId}.2.jsonl
```

Each line is one request-response pair:

```jsonl
{"seq":1,"ts":"2026-04-15T10:00:00Z","request":{"system":"...","messages":[...]},"response":{"content":[...]},"_meta":{"size":12345,"truncated":false}}
{"seq":2,"ts":"2026-04-15T10:01:30Z","request":{"messages":[...]},"response":{"content":[...]},"_meta":{"size":8900,"truncated":false}}
```

**File rolling:** When a JSONL file exceeds 10MB, subsequent writes go to `{sessionId}.{N}.jsonl`. The `content_path` in `audit_log` always points to the specific shard.

## Content Size Handling

| Scenario | Action |
|----------|--------|
| Single message < 50KB | Store as-is |
| Single message 50KB ~ 500KB | Store as-is; `content_summary` still only first 500 chars |
| Single message > 500KB | Truncate to 500KB |
| Image base64 data | Replace with `[IMAGE: X KB]` placeholder |
| Total content per request > 2MB | gzip compress, set `compressed = true` |

## Write Pipeline

### Trigger Point

After `ProxyResponseHandler` finishes streaming the response back to the user. The write is **async (fire-and-forget)** — does not block the user response.

### Write Condition

```typescript
function shouldAudit(session: ProxySession): boolean {
  return session.providerId > 0       // provider was selected (not blocked)
    && session.blockedBy == null;      // not intercepted by any guard
}
```

This captures:
- All successful requests (status 200)
- Requests that reached upstream but got errors (429, 500, 503, timeouts)

This excludes:
- Warmup / probe requests
- Guard-blocked requests (sensitive word, rate limit, request filter)

### Write Flow

```
ProxyResponseHandler (response complete)
  → shouldAudit() check
  → AuditWriter.write(session, responseBody)
      1. Extract request body from session.request.message
      2. Extract response body from in-memory accumulation
      3. Preprocess: stripImageBase64() → truncateLargeMessages() → maybe gzip
      4. Append JSON line to JSONL file (with file rolling check)
      5. Insert audit_log row to PG
```

### Independence from Existing Storage

The audit pipeline is fully independent:
- Does NOT depend on Redis session storage
- Does NOT respect `STORE_SESSION_MESSAGES` setting (always stores raw content)
- Does NOT interfere with existing `messageRequest` logging
- Reads directly from in-memory session/response objects at write time

## Dashboard UI

### Navigation

Add "Audit" item to `NAV_ITEMS` in `dashboard-header.tsx`:
```typescript
{ href: "/dashboard/audit", label: t("audit"), adminOnly: true }
```

### Page 1: Audit List (`/dashboard/audit`)

**Layout:** Table view with session grouping, similar to existing Usage Logs page.

**Columns:** Timestamp | User | Model | Status | Tokens | Cost | Summary

**Features:**
- Default grouped by `session_id`, each session shows first message summary
- Expandable rows to see all requests in a session
- Filters: user, model, time range
- Search: `ILIKE` on `content_summary`
- Click row → navigate to chat view
- Keyset pagination (reuse existing pattern from usage logs)

### Page 2: Chat View (`/dashboard/audit/{sessionId}`)

**Layout:** Chat-bubble UI, resembling a messaging app.

**Message Display:**
- User messages: left-aligned, distinct background
- AI responses: right-aligned, different background
- System prompt: collapsible section at top
- Code blocks: syntax highlighting (reuse `CodeDisplay` component)
- Per-message metadata: timestamp, token count

**Loading Strategy:**
- Show most recent 20 rounds by default
- "Load more" button / scroll-up to load older messages
- Read from `audit_log` table for metadata, then fetch JSONL content by `content_path` + line offset

**Session Info Panel (collapsible sidebar):**
- Total rounds, total tokens, total cost
- Duration (first to last request timestamp)
- Model(s) used
- User info

**Data Flow:**
```
Chat View Page
  → Server Action: getAuditSession(sessionId, page, pageSize)
    → Query audit_log WHERE session_id = ? ORDER BY request_seq
    → For each record, read JSONL file at content_path, seek to correct line
    → Return structured chat data
  → Client renders as chat bubbles
```

## Configuration

New environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_AUDIT` | `false` | Master switch for audit system |
| `AUDIT_DATA_DIR` | `./data/audit` | Directory for JSONL files (should be a mounted volume in Docker) |
| `AUDIT_MAX_FILE_SIZE` | `10485760` | Max JSONL file size before rolling (10MB) |
| `AUDIT_CONTENT_MAX_SIZE` | `524288` | Max single message size before truncation (500KB) |

## i18n

Add audit-related strings to all 5 locale files under `messages/{locale}/dashboard.json`:

```json
"audit": {
  "title": "Audit Logs",
  "description": "Review team AI usage and conversation content",
  "filters": {
    "user": "User",
    "model": "Model",
    "timeRange": "Time Range",
    "search": "Search summary..."
  },
  "columns": {
    "time": "Time",
    "user": "User",
    "model": "Model",
    "status": "Status",
    "tokens": "Tokens",
    "cost": "Cost",
    "summary": "Summary"
  },
  "chat": {
    "systemPrompt": "System Prompt",
    "loadMore": "Load More",
    "sessionInfo": "Session Info",
    "totalRounds": "Total Rounds",
    "totalTokens": "Total Tokens",
    "totalCost": "Total Cost",
    "duration": "Duration",
    "noData": "No audit data for this session"
  }
}
```

## File Structure (New Files)

```
src/
  drizzle/
    audit-schema.ts                    # audit_log table definition (isolated from schema.ts)
  lib/
    audit/
      audit-hook.ts                    # Entry point hook (called from response-handler.ts)
      audit-writer.ts                  # Core write logic
      audit-file-store.ts              # JSONL file operations (append, read, roll)
      audit-preprocessor.ts            # Image stripping, truncation, compression
  actions/
    audit.ts                           # Server actions (list, getSession, readContent)
  app/[locale]/dashboard/
    audit/
      page.tsx                         # Audit list page
      _components/
        audit-list.tsx                 # List with session grouping
        audit-filters.tsx              # Filter bar
    audit/[sessionId]/
      page.tsx                         # Chat view page
      _components/
        audit-chat-view.tsx            # Chat bubble renderer
        audit-chat-bubble.tsx          # Single message bubble
        audit-session-stats.tsx        # Session info sidebar
```
