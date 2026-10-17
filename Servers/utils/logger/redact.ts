/**
 * Defense-in-depth redaction for accidentally-logged secrets.
 * Applied to every file log message before it reaches the transport, and by
 * logEvent / getEventsQuery to event descriptions (event_logs and the audit
 * ledger).
 *
 * Two rules hold for every pattern here:
 * - Linear time. This runs on every log line, so nothing may backtrack
 *   across a long run: token patterns only start at the beginning of a run
 *   (a lookbehind for the run's own characters), and URL credentials are
 *   found per whitespace-separated token with string scans, not a regex.
 * - Never fail open on length. No repetition that guards a secret is
 *   capped, so an over-long secret is still redacted in full.
 * redact.test.ts times pathological inputs and covers over-long secrets.
 */

// A sensitive key word. Matched on the word itself, whatever comes before
// it (client_secret, AWS_SECRET_ACCESS_KEY, a_b_c_d_e_f_password,
// dbPassword), so a long or unusual prefix cannot hide it; the prefix stays
// in the output. The word must end at a word boundary, which keeps
// "tokens", "max_tokens" and "token_count" out.
const KEY =
  "(?:password|passwd|passphrase|secret[_-]?key|private[_-]?key|access[_-]?key|api[_-]?key|apikey|secret|token)";

// A double- or single-quoted value, escape-aware, to the closing quote or
// the end of the input (an unterminated value is still redacted). Written
// as an unrolled loop (plain runs between escapes) rather than (a|b)*,
// which overflows V8's regex stack on multi-megabyte values.
const DOUBLE_QUOTED = String.raw`"[^"\\]*(?:\\.[^"\\]*)*"?`;
const SINGLE_QUOTED = String.raw`'[^'\\]*(?:\\.[^'\\]*)*'?`;

const KEY_VALUE = new RegExp(
  String.raw`(${KEY})\b\s*[:=]\s*(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|[^\s&,"'{}]+)`,
  "gi",
);
const JSON_DOUBLE = new RegExp(String.raw`(${KEY})"\s*:\s*${DOUBLE_QUOTED}`, "gi");
const JSON_SINGLE = new RegExp(String.raw`(${KEY})'\s*:\s*${SINGLE_QUOTED}`, "gi");

// header.payload.signature, both JSON parts base64url ("eyJ"). The
// signature may be empty (unsigned tokens).
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/**
 * scheme://[user]:password@host in one whitespace-separated token. The
 * password runs from the userinfo ":" to the last "@" in the token, so
 * passwords containing "/" or "@" are covered, and any scheme chain works
 * (jdbc:postgresql://, URL:postgres://). Keeps scheme, user and host.
 * host:port@... cannot be told apart from user:password@..., so it is
 * redacted too (safe side); a "@" later in the path also counts as the end
 * of the password (safe side).
 */
function redactUrlCredentials(token: string): string {
  const sep = token.indexOf("://");
  if (sep <= 0 || !/[A-Za-z0-9+.-]/.test(token[sep - 1])) return token;
  const at = token.lastIndexOf("@");
  if (at < sep + 3) return token;
  const userinfo = token.slice(sep + 3, at);
  const colon = userinfo.indexOf(":");
  // No ":" means user@host with no password. A "/", "?" or "#" before the
  // ":" means the ":" is in a path or query, not in userinfo.
  if (colon < 0 || /[/?#]/.test(userinfo.slice(0, colon))) return token;
  return `${token.slice(0, sep + 3 + colon + 1)}[REDACTED]${token.slice(at)}`;
}

/** Returned when the input could not be scanned: fail closed, never raw. */
export const UNSCANNABLE_PLACEHOLDER = "[REDACTED: message could not be scanned for secrets]";

export function redactSensitiveInfo(input: string): string {
  try {
    return redactPatterns(input);
  } catch {
    // A regex engine limit (e.g. stack size on a pathological multi-MB
    // input) must neither crash the logger nor let the raw text through.
    return UNSCANNABLE_PLACEHOLDER;
  }
}

function redactPatterns(input: string): string {
  return (
    input
      // OpenAI-style API keys and similar long key prefixes
      .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
      // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained)
      .replace(
        /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
        "[REDACTED]",
      )
      // Vercel AI Gateway keys
      .replace(/(?<![A-Za-z0-9_-])vck_[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
      // Authorization: Bearer <token>
      .replace(/(\bAuthorization\s*:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
      // Bare JWTs
      .replace(JWT, "[REDACTED]")
      // Credentials in URLs (only tokens with both "://" and "@" are examined)
      .replace(/\S+/g, (token) =>
        token.includes("://") && token.includes("@") ? redactUrlCredentials(token) : token,
      )
      // key=value or key: value style sensitive fields
      .replace(KEY_VALUE, "$1=[REDACTED]")
      // JSON double-quoted sensitive fields
      .replace(JSON_DOUBLE, '$1":"[REDACTED]"')
      // JSON single-quoted sensitive fields
      .replace(JSON_SINGLE, "$1':'[REDACTED]'")
  );
}
