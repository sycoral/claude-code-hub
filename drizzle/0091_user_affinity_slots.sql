-- Migration: Add providers.limit_concurrent_users for per-account user affinity slot limit
-- 用途：控制同一账号最多被多少个不同用户绑定（0 = 不限制）
-- 语义与 limit_concurrent_sessions 对称：一个管 session 并发数，一个管活跃用户数
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "limit_concurrent_users" integer DEFAULT 0;
