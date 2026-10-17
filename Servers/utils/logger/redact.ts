/**
 * Defense-in-depth redaction for accidentally-logged secrets.
 * Applied to every file log message before it reaches the transport, and by
 * logEvent / getEventsQuery to event descriptions (event_logs and the audit
 * ledger).
 *
 * Two rules hold for every pattern here:
 * - Linear time. This runs on every log line, so nothing may backtrack
 *   across a long run: token patterns only start at the beginning of a run
 *   (a lookbehind for the run's own characters), and JWTs and URL
 *   credentials are found per run or token with string scans, not a regex.
 * - Never fail open on length. No repetition that guards a secret is
 *   capped, so an over-long secret is still redacted in full.
 * redact.test.ts times pathological inputs and covers over-long secrets.
 */

// A sensitive key word. Matched on the word itself, whatever comes before
// it (client_secret, AWS_SECRET_ACCESS_KEY, a_b_c_d_e_f_password,
// dbPassword), so a long or unusual prefix cannot hide it; the prefix stays
// in the output. The word must end at a word boundary, which keeps
// "tokens", "max_tokens" and "token_count" out. Password keys also take a
// short list of suffixes (password_confirmation, password2, passwordHash);
// a list rather than any \w*, which would make every failed attempt rescan
// the word.
const KEY =
  "(?:(?:password|passwd|passphrase)(?:[_-]?(?:confirmation|confirm|repeat|current|old|new|hash|digest|\\d+))?|secret[_-]?key|private[_-]?key|access[_-]?key|api[_-]?key|apikey|secret|token)";

// A double- or single-quoted value, escape-aware, to the closing quote or
// the end of the input (an unterminated value is still redacted). Written
// as an unrolled loop (plain runs between escapes) rather than (a|b)*,
// which overflows V8's regex stack on multi-megabyte values. An escape is a
// backslash and any next character, newlines included.
const DOUBLE_QUOTED = String.raw`"[^"\\]*(?:\\[\s\S][^"\\]*)*"?`;
const SINGLE_QUOTED = String.raw`'[^'\\]*(?:\\[\s\S][^'\\]*)*'?`;
// An array or object value, to its first "]" or "}" (the innermost close,
// so every nested value before it is covered) or the end of the input.
const NESTED = String.raw`\[[^\]]*\]?|\{[^}]*\}?`;
// key: value, key=value and Perl/Ruby-style key => value.
const SEP = String.raw`\s*(?:=>|[:=])\s*`;

const KEY_VALUE = new RegExp(
  // The quoted forms are tried first; an unquoted value may contain "'".
  String.raw`(${KEY})\b${SEP}(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${NESTED}|[^\s&,"{}]+)`,
  "gi",
);
// A quoted key's value may also be nested, a number, true/false or null.
const JSON_DOUBLE = new RegExp(
  String.raw`(${KEY})"${SEP}(?:${DOUBLE_QUOTED}|${NESTED}|[^\s,}\]]+)`,
  "gi",
);
const JSON_SINGLE = new RegExp(
  String.raw`(${KEY})'${SEP}(?:${SINGLE_QUOTED}|${NESTED}|[^\s,}\]]+)`,
  "gi",
);
// JSON nested as an escaped string: {"msg":"{\"password\":\"x\"}"}, at
// any escape depth. The value runs to the end of the enclosing string (an
// unescaped quote), so a value with deeper escaped quotes is still covered.
const JSON_ESCAPED = new RegExp(
  String.raw`(${KEY})(\\+)"\s*:\s*\\+"[^"\\]*(?:\\[\s\S][^"\\]*)*`,
  "gi",
);

// Authorization header values in header, JSON, util.inspect and escaped
// JSON forms: everything after the key, a leading quote and a Bearer/Basic
// scheme word is redacted to the end of the line. One rule, fail closed: a
// value can hold quotes, escapes and spaces (Token token="x", Digest
// a=\"b\", Basic YWJj\/ZGVm), so no stop character inside the line is safe.
// Whitespace is allowed after the quote only (one \s* before it), so the
// pattern cannot backtrack between two whitespace runs.
const AUTHORIZATION =
  /(\bAuthorization(?:\\*["'])?\s*[:=]\s*(?:\\*["']\s*)?(?:(?:Bearer|Basic)\s+)?)[^\r\n]+/gi;

// A Bearer or Basic credential under any other key or none ({ auth:
// 'Bearer x1' }). It ends where the RFC 6750/7617 token alphabet ends, so
// stopping there cannot leak part of it (a backslash is included for
// JSON-escaped "\/"); it must contain a digit, which
// keeps prose such as "Basic authentication failed" readable.
const BEARER_TOKEN = /\b((?:Bearer|Basic)\s+)(?=[A-Za-z._~+/=\\-]*\d)[A-Za-z0-9._~+/=\\-]+/gi;

/**
 * Bare JWTs: header.payload.signature, both JSON parts base64url ("eyJ"),
 * the signature possibly empty (unsigned tokens). `run` is a maximal run of
 * [A-Za-z0-9_.-]. A JWT starts at the start of a "."-separated segment or
 * right after a "-" (x-token-eyJ...), never after a letter, digit or "_".
 *
 * Linear: each segment is scanned once for a start, and a match resumes
 * after the signature segment.
 */
function redactJwts(run: string): string {
  const segments = run.split(".");
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const start = jwtStart(seg);
    const payload = segments[i + 1];
    if (
      start !== -1 &&
      i + 2 < segments.length &&
      payload.length > 3 &&
      payload.startsWith("eyJ")
    ) {
      out += `${seg.slice(0, start)}[REDACTED]`;
      i += 2; // header, payload and signature consumed
    } else {
      out += seg;
    }
    if (i < segments.length - 1) out += ".";
  }
  return out;
}

/** Index of the first JWT header start in `seg`, or -1. */
function jwtStart(seg: string): number {
  for (let p = seg.indexOf("eyJ"); p !== -1; p = seg.indexOf("eyJ", p + 1)) {
    if (p + 3 >= seg.length) return -1; // the header needs a character after "eyJ"
    if (p === 0 || seg[p - 1] === "-") return p;
  }
  return -1;
}

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

/**
 * Redacts secrets from anything a log sink was given. Coercion to text
 * happens here, once, so every sink (file printf, logStructured, logEvent)
 * treats a non-string the same way; a value that cannot be coerced (a
 * null-prototype object) fails closed like an engine limit.
 */
export function redactSensitiveInfo(input: unknown): string {
  try {
    return redactPatterns(typeof input === "string" ? input : String(input));
  } catch {
    // A regex engine limit (e.g. stack size on a pathological multi-MB
    // input) must neither crash the logger nor let the raw text through.
    return UNSCANNABLE_PLACEHOLDER;
  }
}

function redactPatterns(input: string): string {
  let text = input
    // OpenAI-style API keys and similar long key prefixes. A "-" may come
    // before them (x-sk-...): a failed attempt is bounded by the {10,}.
    .replace(/(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained)
    .replace(
      /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
      "[REDACTED]",
    )
    // Vercel AI Gateway keys
    .replace(/(?<![A-Za-z0-9_])vck_[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // Authorization header values
    .replace(AUTHORIZATION, "$1[REDACTED]")
    // Bearer/Basic credentials outside an Authorization header
    .replace(BEARER_TOKEN, "$1[REDACTED]");
  // Bare JWTs and URL credentials are scanned per run or token, and only on
  // lines that can contain them.
  if (text.includes("eyJ")) {
    text = text.replace(/[A-Za-z0-9_.-]+/g, (run) => (run.includes("eyJ") ? redactJwts(run) : run));
  }
  if (text.includes("://")) {
    text = text.replace(/\S+/g, (token) =>
      token.includes("://") ? redactUrlCredentials(token) : token,
    );
  }
  return (
    text
      // key=value or key: value style sensitive fields
      .replace(KEY_VALUE, "$1=[REDACTED]")
      // JSON double-quoted sensitive fields
      .replace(JSON_DOUBLE, '$1":"[REDACTED]"')
      // JSON single-quoted sensitive fields
      .replace(JSON_SINGLE, "$1':'[REDACTED]'")
      // JSON nested as an escaped string, keeping its escape depth
      .replace(JSON_ESCAPED, (_m, key: string, bs: string) => `${key}${bs}":${bs}"[REDACTED]${bs}"`)
  );
}

/** Row columns that can carry logged text (error messages, field values). */
const ROW_TEXT_FIELDS = ["description", "old_value", "new_value"] as const;

/**
 * Redacts the text columns of an event_logs or audit_ledger row on read.
 * Rows written before write-time redaction may hold raw secrets, and the
 * ledger is hash-chained, so they cannot be rewritten. Non-string and
 * missing columns are left as they are. The ledger's verifyChain and its
 * CSV export read the stored text, so their hashes still verify.
 */
export function redactRowText<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const field of ROW_TEXT_FIELDS) {
    if (typeof out[field] === "string") out[field] = redactSensitiveInfo(out[field]);
  }
  return out as T;
}
