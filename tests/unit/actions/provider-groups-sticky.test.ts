import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockListActiveUsers = vi.hoisted(() => vi.fn());
const mockClearSticky = vi.hoisted(() => vi.fn());
const mockCountActiveUsers = vi.hoisted(() => vi.fn());
const mockGetUserLoadWeights = vi.hoisted(() => vi.fn());
const mockGetGroupWeightThresholds = vi.hoisted(() => vi.fn());
const mockFindWeeklyGroupScopedUsage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/lib/sticky/user-group-sticky", () => ({
  listActiveUsers: mockListActiveUsers,
  clearSticky: mockClearSticky,
  countActiveUsers: mockCountActiveUsers,
}));

vi.mock("@/repository/leaderboard", () => ({
  findWeeklyGroupScopedUsage: mockFindWeeklyGroupScopedUsage,
}));

vi.mock("@/lib/sticky/load-weight", () => ({
  getUserLoadWeights: mockGetUserLoadWeights,
  getGroupWeightThresholds: mockGetGroupWeightThresholds,
  classifyLoadTier: (weight: number, t: { heavyWeight: number; mediumWeight: number }) => {
    if (weight >= t.heavyWeight && t.heavyWeight > 1) return "heavy";
    if (weight >= t.mediumWeight && t.mediumWeight > 1) return "medium";
    return "normal";
  },
  NORMAL_WEIGHT: 1,
}));

vi.mock("@/lib/audit/emit", () => ({
  emitActionAudit: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const mockSelectChain = vi.hoisted(() => {
  const where = vi.fn();
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, from, where };
});

vi.mock("@/drizzle/db", () => ({
  db: {
    select: mockSelectChain.select,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: 1, role: "admin" } });
  mockGetUserLoadWeights.mockResolvedValue(new Map<number, number>());
  mockGetGroupWeightThresholds.mockResolvedValue({
    heavyWeight: 5,
    mediumWeight: 3,
    providerCount: 5,
  });
  mockFindWeeklyGroupScopedUsage.mockResolvedValue([]);
});

describe("listStickyActiveUsers", () => {
  it("rejects non-admin", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 1, role: "user" } });
    const { listStickyActiveUsers } = await import("@/actions/provider-groups");
    const res = await listStickyActiveUsers("team-a", 42);
    expect(res.ok).toBe(false);
  });

  it("rejects invalid providerId", async () => {
    const { listStickyActiveUsers } = await import("@/actions/provider-groups");
    const res = await listStickyActiveUsers("team-a", 0);
    expect(res.ok).toBe(false);
  });

  it("returns empty list immediately when no entries", async () => {
    mockListActiveUsers.mockResolvedValueOnce([]);
    const { listStickyActiveUsers } = await import("@/actions/provider-groups");
    const res = await listStickyActiveUsers("team-a", 42);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toEqual([]);
  });

  it("joins user names from db and looks up load weights", async () => {
    mockListActiveUsers.mockResolvedValueOnce([
      { uid: 7, expireAtMs: 1700000005000 },
      { uid: 8, expireAtMs: 1700000010000 },
      { uid: 9, expireAtMs: 1700000020000 },
    ]);
    mockSelectChain.where.mockResolvedValueOnce([
      { id: 7, name: "alice" },
      { id: 8, name: "bob" },
    ]);
    // N=5 group: heavy=5, medium=3, normal=1
    mockGetUserLoadWeights.mockResolvedValueOnce(
      new Map<number, number>([
        [7, 5], // heavy
        [8, 3], // medium
        // 9 missing → defaults to NORMAL_WEIGHT (1)
      ])
    );
    // 用量数据：组内本周 3 个有效用户（uid 7/8/10），uid 9 无用量
    // 排名 desc by tokens: uid 7 (=#1, 9M), uid 10 (=#2, 5M), uid 8 (=#3, 1M)
    mockFindWeeklyGroupScopedUsage.mockResolvedValueOnce([
      { userId: 7, totalTokens: 9_000_000 },
      { userId: 8, totalTokens: 1_000_000 },
      { userId: 10, totalTokens: 5_000_000 },
    ]);
    const { listStickyActiveUsers } = await import("@/actions/provider-groups");
    const res = await listStickyActiveUsers("team-a", 42);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toEqual([
      {
        uid: 7,
        name: "alice",
        expireAtMs: 1700000005000,
        loadWeight: 5,
        loadTier: "heavy",
        weeklyTokens: 9_000_000,
        rank: 1,
        rankTotal: 3,
      },
      {
        uid: 8,
        name: "bob",
        expireAtMs: 1700000010000,
        loadWeight: 3,
        loadTier: "medium",
        weeklyTokens: 1_000_000,
        rank: 3,
        rankTotal: 3,
      },
      {
        uid: 9,
        name: null,
        expireAtMs: 1700000020000,
        loadWeight: 1,
        loadTier: "normal",
        weeklyTokens: 0,
        rank: null,
        rankTotal: 3,
      },
    ]);
  });
});

describe("evictStickyUser", () => {
  it("rejects non-admin", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 1, role: "user" } });
    const { evictStickyUser } = await import("@/actions/provider-groups");
    const res = await evictStickyUser("team-a", 42, 7);
    expect(res.ok).toBe(false);
    expect(mockClearSticky).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const { evictStickyUser } = await import("@/actions/provider-groups");
    expect((await evictStickyUser("", 42, 7)).ok).toBe(false);
    expect((await evictStickyUser("team-a", 0, 7)).ok).toBe(false);
    expect((await evictStickyUser("team-a", 42, 0)).ok).toBe(false);
    expect(mockClearSticky).not.toHaveBeenCalled();
  });

  it("calls clearSticky with all three args", async () => {
    mockClearSticky.mockResolvedValueOnce(undefined);
    const { evictStickyUser } = await import("@/actions/provider-groups");
    const res = await evictStickyUser("team-a", 42, 7);
    expect(res.ok).toBe(true);
    expect(mockClearSticky).toHaveBeenCalledWith(7, "team-a", 42);
  });
});

describe("countStickyActiveUsersByProvider", () => {
  it("rejects non-admin", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 1, role: "user" } });
    const { countStickyActiveUsersByProvider } = await import("@/actions/provider-groups");
    const res = await countStickyActiveUsersByProvider("team-a", [1, 2]);
    expect(res.ok).toBe(false);
  });

  it("returns empty object when no valid ids", async () => {
    const { countStickyActiveUsersByProvider } = await import("@/actions/provider-groups");
    const res = await countStickyActiveUsersByProvider("team-a", [0, -1]);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toEqual({});
    expect(mockCountActiveUsers).not.toHaveBeenCalled();
  });

  it("returns counts keyed by providerId, dedupes input", async () => {
    mockCountActiveUsers.mockImplementation(async (id: number) => id * 10);
    const { countStickyActiveUsersByProvider } = await import("@/actions/provider-groups");
    const res = await countStickyActiveUsersByProvider("team-a", [1, 2, 1, 3]);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toEqual({ 1: 10, 2: 20, 3: 30 });
    expect(mockCountActiveUsers).toHaveBeenCalledTimes(3);
  });
});
