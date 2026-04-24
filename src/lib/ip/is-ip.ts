// Edge-compatible replacement for `node:net`'s `isIP`.
// Next.js 16's middleware and middleware-bundled instrumentation run in Edge
// Runtime, which disallows `node:*` imports. The upstream v0.7.1 code pulls
// `node:net` here through the middleware chain, so we swap it for a
// regex-based equivalent.
//
// Return values mirror `net.isIP`: 0 = not an IP, 4 = IPv4, 6 = IPv6.

const IPV4_RE =
  /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;

export function isIP(value: unknown): 0 | 4 | 6 {
  if (typeof value !== "string" || value.length === 0) return 0;

  if (IPV4_RE.test(value)) return 4;

  // IPv6: must contain at least one colon and only hex + colons.
  if (!value.includes(":")) return 0;
  if (!/^[0-9a-fA-F:]+$/.test(value)) return 0;

  // Reject ":::" or more (invalid compressed form).
  if (value.includes(":::")) return 0;

  const doubleColonCount = (value.match(/::/g) || []).length;
  // At most one "::" compression.
  if (doubleColonCount > 1) return 0;

  const hasCompression = doubleColonCount === 1;
  const groups = value.split(":");
  // Split edge cases: "::1" → ["", "", "1"], "1::" → ["1", "", ""]
  // Filter out empty groups from the compression marker for length check.
  const significantGroups = groups.filter((g) => g !== "");

  // IPv6 has 8 groups. Without compression: exactly 8. With compression: <8.
  if (!hasCompression && significantGroups.length !== 8) return 0;
  if (hasCompression && significantGroups.length >= 8) return 0;

  // Each significant group must be 1-4 hex digits.
  if (!significantGroups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return 0;

  return 6;
}
