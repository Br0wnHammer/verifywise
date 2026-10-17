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
  // The quoted forms are tried first; an unquoted value may contain "'".
  String.raw`(${KEY})\b\s*[:=]\s*(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|[^\s&,"{}]+)`,
  "gi",
);
const JSON_DOUBLE = new RegExp(String.raw`(${KEY})"\s*:\s*${DOUBLE_QUOTED}`, "gi");
const JSON_SINGLE = new RegExp(String.raw`(${KEY})'\s*:\s*${SINGLE_QUOTED}`, "gi");

// header.payload.signature, both JSON parts base64url ("eyJ"). The
// signature may be empty (unsigned tokens).
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

// A "/", "?" or "#" before the first ":" after "://" means that ":" is in
// a path or query, not in userinfo. A quote there means the ":" belongs to
// the surrounding JSON (e.g. {"a":"https://ok","b":"me@mail"}), which keeps
// plain URLs inside JSON lines unchanged. "@" is allowed: an ambiguous user
// part such as admin@srv over-redacts rather than leaking.
const NOT_IN_USER = /[/?#"']/;
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
// host:port, then "/" or the end of the token.
const PORT = /\d+(?:\/|$)/y;

/**
 * scheme://<user>:<password>@host inside one whitespace-separated token.
 * One fail-closed rule: once a URL's userinfo ":" is seen, the password
 * runs to the LAST "@" in the token, whatever lies between (quotes,
 * brackets, "://", more URLs). With no "@" after it, the password runs to
 * the end of the token, unless what follows the ":" is a port (digits,
 * then "/" or the end). Over-redaction (host:port@path, a second URL in
 * the same token) is accepted; under-redaction is not. Keeps scheme, user
 * and whatever follows the last "@".
 *
 * Linear: "://" positions are visited in order, and each user part is
 * scanned only up to the next ":" (which is at or before the next "://").
 */
function redactUrlCredentials(token: string): string {
  const lastAt = token.lastIndexOf("@");
  let out = "";
  let copied = 0;
  for (let sep = token.indexOf("://"); sep !== -1; sep = token.indexOf("://", sep + 3)) {
    if (sep < copied) continue; // inside a region already redacted
    if (sep === 0 || !SCHEME_CHAR.test(token[sep - 1])) continue;
    const start = sep + 3;
    const colon = token.indexOf(":", start);
    if (colon === -1) break; // no ":" left, so no userinfo and no later "://"
    if (NOT_IN_USER.test(token.slice(start, colon))) continue;
    if (lastAt > colon) {
      out += `${token.slice(copied, colon + 1)}[REDACTED]`;
      copied = lastAt;
      continue;
    }
    PORT.lastIndex = colon + 1;
    if (PORT.test(token)) continue; // host:port with no "@" after it
    out += `${token.slice(copied, colon + 1)}[REDACTED]`;
    copied = token.length;
    break;
  }
  return copied === 0 ? token : out + token.slice(copied);
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
      // Credentials in URLs (only tokens containing "://" are examined)
      .replace(/\S+/g, (token) => (token.includes("://") ? redactUrlCredentials(token) : token))
      // key=value or key: value style sensitive fields
      .replace(KEY_VALUE, "$1=[REDACTED]")
      // JSON double-quoted sensitive fields
      .replace(JSON_DOUBLE, '$1":"[REDACTED]"')
      // JSON single-quoted sensitive fields
      .replace(JSON_SINGLE, "$1':'[REDACTED]'")
  );
}
