import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSystemSettings = vi.hoisted(() => vi.fn());
const mockGetActiveUserVersions = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: mockGetSystemSettings,
}));

vi.mock("@/repository/client-versions", () => ({
  getActiveUserVersions: mockGetActiveUserVersions,
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: mockGetRedisClient,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function buildSettings(pinned: Record<string, string>) {
  return {
    id: 1,
    enableClientVersionCheck: true,
    clientVersionPinned: pinned,
  };
}

describe("ClientVersionChecker.shouldUpgrade with pinned versions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("uses pinned version as the threshold when set, regardless of auto-detected GA", async () => {
    mockGetSystemSettings.mockResolvedValue(buildSettings({ "claude-cli": "2.0.30" }));

    const { ClientVersionChecker } = await import("@/lib/client-version-checker");

    // user is below the pinned threshold → must upgrade
    const result = await ClientVersionChecker.shouldUpgrade("claude-cli", "2.0.20");

    expect(result.needsUpgrade).toBe(true);
    expect(result.gaVersion).toBe("2.0.30");
    // No need to query active users when pinned is set
    expect(mockGetActiveUserVersions).not.toHaveBeenCalled();
  });

  it("does not flag upgrade when user version is at or above the pinned threshold", async () => {
    mockGetSystemSettings.mockResolvedValue(buildSettings({ "claude-cli": "2.0.30" }));

    const { ClientVersionChecker } = await import("@/lib/client-version-checker");

    const equal = await ClientVersionChecker.shouldUpgrade("claude-cli", "2.0.30");
    expect(equal.needsUpgrade).toBe(false);
    expect(equal.gaVersion).toBe("2.0.30");

    const newer = await ClientVersionChecker.shouldUpgrade("claude-cli", "2.0.40");
    expect(newer.needsUpgrade).toBe(false);
    expect(newer.gaVersion).toBe("2.0.30");
  });

  it("treats blank/whitespace pinned values as unset and falls back to auto detection", async () => {
    mockGetSystemSettings.mockResolvedValue(buildSettings({ "claude-cli": "   " }));
    // Auto detection has nothing → no upgrade required
    mockGetActiveUserVersions.mockResolvedValue([]);

    const { ClientVersionChecker } = await import("@/lib/client-version-checker");

    const result = await ClientVersionChecker.shouldUpgrade("claude-cli", "2.0.10");

    expect(result.needsUpgrade).toBe(false);
    expect(result.gaVersion).toBeNull();
    expect(mockGetActiveUserVersions).toHaveBeenCalled();
  });

  it("only applies pinned to the matching client type", async () => {
    mockGetSystemSettings.mockResolvedValue(buildSettings({ "claude-cli": "2.0.30" }));
    mockGetActiveUserVersions.mockResolvedValue([]);

    const { ClientVersionChecker } = await import("@/lib/client-version-checker");

    const cliResult = await ClientVersionChecker.shouldUpgrade("claude-cli", "2.0.10");
    expect(cliResult.needsUpgrade).toBe(true);
    expect(cliResult.gaVersion).toBe("2.0.30");

    // VSCode has no pin → falls back to auto (which is empty here), so no upgrade required
    const vscodeResult = await ClientVersionChecker.shouldUpgrade("claude-vscode", "1.0.0");
    expect(vscodeResult.needsUpgrade).toBe(false);
    expect(vscodeResult.gaVersion).toBeNull();
  });

  it("falls back to auto detection when clientVersionPinned is empty/missing", async () => {
    mockGetSystemSettings.mockResolvedValue(buildSettings({}));
    mockGetActiveUserVersions.mockResolvedValue([]);

    const { ClientVersionChecker } = await import("@/lib/client-version-checker");

    const result = await ClientVersionChecker.shouldUpgrade("claude-cli", "2.0.10");
    expect(result.needsUpgrade).toBe(false);
    expect(result.gaVersion).toBeNull();
    expect(mockGetActiveUserVersions).toHaveBeenCalled();
  });

  it("fails open (no upgrade) when getSystemSettings throws", async () => {
    mockGetSystemSettings.mockRejectedValue(new Error("DB down"));

    const { ClientVersionChecker } = await import("@/lib/client-version-checker");

    const result = await ClientVersionChecker.shouldUpgrade("claude-cli", "2.0.10");
    expect(result.needsUpgrade).toBe(false);
    expect(result.gaVersion).toBeNull();
  });
});
