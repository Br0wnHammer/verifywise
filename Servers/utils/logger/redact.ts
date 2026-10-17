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

// Characters RFC 3986 never allows unencoded anywhere in a URL. They end a
// URL inside a longer token (JSON, HTML, a quoted value), so a password
// containing one of them raw is not recognised; in a valid URL they are
// percent-encoded.
const URL_TERMINATORS = new Set(['"', "<", ">", "{", "}", "[", "]", "`"]);
// A "/", "?" or "#" before the ":" means the ":" is in a path or query, not
// in userinfo; "'", "(", ")", "," and ";" there mean the ":" belongs to the
// surrounding text (e.g. single-quoted JSON), not to this URL.
const NOT_IN_USER = /[/?#'(),;]/;
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;

/**
 * scheme://[user]:password@host, for every "://" in one whitespace-separated
 * token (a JSON line can hold several URLs). Each URL runs from its "://"
 * to the next "://" or URL terminator; its password runs from the first ":"
 * to the last "@" in that span, so passwords containing "/" or "@" are
 * covered and any scheme chain works (jdbc:postgresql://, URL:postgres://).
 * Keeps scheme, user and host. host:port@... cannot be told apart from
 * user:password@..., and a later "@" in the path also ends the password,
 * so both are redacted (safe side). One pass over the token: the spans are
 * disjoint and each is scanned once.
 */
function redactUrlCredentials(token: string): string {
  const seps: number[] = [];
  for (let i = token.indexOf("://"); i !== -1; i = token.indexOf("://", i + 3)) seps.push(i);

  let out = "";
  let copied = 0;
  for (let j = 0; j < seps.length; j++) {
    const sep = seps[j];
    const start = sep + 3;
    const limit = j + 1 < seps.length ? seps[j + 1] : token.length;
    let colon = -1;
    let at = -1;
    for (let k = start; k < limit && !URL_TERMINATORS.has(token[k]); k++) {
      if (token[k] === ":" && colon === -1) colon = k;
      else if (token[k] === "@") at = k;
    }
    if (sep === 0 || !SCHEME_CHAR.test(token[sep - 1])) continue;
    // No ":" before the last "@" means user@host with no password.
    if (colon === -1 || at < colon || NOT_IN_USER.test(token.slice(start, colon))) continue;
    out += `${token.slice(copied, colon + 1)}[REDACTED]`;
    copied = at;
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
