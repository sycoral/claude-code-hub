// System-injected envelope prefixes that should be filtered out of
// "real user input" views in conversation audit.
//
// Two categories:
//   1. TEXT_PREFIXES — literal string prefixes (e.g. "[Tool results]").
//   2. TAG_NAMES — XML-like tag names whose "<tag" opening should be matched
//      with a word boundary (so "<tag>" and `<tag attr="x">` both match,
//      but "<tagging>" does not).
//
// To extend the filter, edit one of the arrays below and rebuild.

const TEXT_PREFIXES = ["[Tool results]", "[Memory context]"] as const;

const TAG_NAMES = [
  "tool_result",
  "tool_use",
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "function_calls",
  "functions",
] as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const SYSTEM_WRAPPER_TEXT_PATTERN = (() => {
  const literal = TEXT_PREFIXES.map(escapeRegex).join("|");
  const tag = TAG_NAMES.map(escapeRegex).join("|");
  return new RegExp(`^(${literal}|<(${tag})\\b)`);
})();
