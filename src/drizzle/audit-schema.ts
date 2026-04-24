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
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const conversationAuditLog = pgTable(
  "conversation_audit_log",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    userName: varchar("user_name", { length: 128 }),
    key: varchar("key").notNull(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),

    model: varchar("model", { length: 128 }),
    endpoint: varchar("endpoint", { length: 256 }),
    inputTokens: bigint("input_tokens", { mode: "number" }).default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).default(0),
    costUsd: numeric("cost_usd", { precision: 21, scale: 15 }).default("0"),

    requestCount: integer("request_count").default(1),     // total API requests in this session
    totalMessages: integer("total_messages"),               // latest messages count in context

    contentSummary: text("content_summary"),                // latest user message (for search)
    contentPath: varchar("content_path", { length: 512 }),  // JSONL file path
    contentSize: integer("content_size").default(0),        // accumulated content size in bytes
    compressed: boolean("compressed").default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    conversationAuditLogSessionIdUniq: uniqueIndex("idx_conversation_audit_log_session_id_uniq").on(
      table.sessionId
    ),
    conversationAuditLogUserCreatedAtIdx: index("idx_conversation_audit_log_user_created_at").on(
      table.userId,
      table.createdAt
    ),
    conversationAuditLogCreatedAtIdIdx: index("idx_conversation_audit_log_created_at_id").on(
      table.createdAt,
      table.id
    ),
    conversationAuditLogModelIdx: index("idx_conversation_audit_log_model").on(table.model),
  })
);
