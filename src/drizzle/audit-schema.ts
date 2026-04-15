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
