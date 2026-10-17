/**
 * Defense-in-depth redaction for accidentally-logged secrets.
 * Applied to every file log message before it reaches the transport, and by
 * logEvent / getEventsQuery to event descriptions (event_logs and the audit
 * ledger).
 *
 * This runs on every log line, so every pattern must stay linear on long or
 * hostile input: each repetition that can fail after scanning is bounded,
 * and token patterns only start at the beginning of a run (a lookbehind for
 * the run's own characters), so a long run is scanned once, not once per
 * position. redact.test.ts times pathological inputs.
 */

// A sensitive key name. Up to four snake/kebab segments may come before
// (client_secret, db_password, x-api-key, AWS_SECRET_ACCESS_KEY). The core
// names end at a word boundary in the patterns below, which keeps
// "tokens", "max_tokens" and "token_count" out.
const KEY =
  "(?:[A-Za-z0-9]{1,32}[_-]){0,4}" +
  "(?:password|passwd|passphrase|secret[_-]?key|secret|private[_-]?key|access[_-]?key|token|api[_-]?key|apikey|accesstoken|refreshtoken|clientsecret)";

const KEY_VALUE = new RegExp(`\\b(${KEY})\\b\\s{0,16}[:=]\\s{0,16}[^\\s&,"{}]+`, "gi");
const JSON_DOUBLE = new RegExp(`"(${KEY})"\\s{0,16}:\\s{0,16}"[^"]{0,4096}"`, "gi");
const JSON_SINGLE = new RegExp(`'(${KEY})'\\s{0,16}:\\s{0,16}'[^']{0,4096}'`, "gi");

// scheme://[user]:password@host. The password runs to the last "@" in the
// URL token (up to three "@" inside it), so passwords containing "/" or "@"
// are covered. A userinfo of the form host:port@... cannot be told apart
// from user:password@..., so it is redacted as well (safe side). The
// password is matched as "@"-terminated segments that cannot contain "@",
// so there is nothing ambiguous to backtrack through.
const URL_CREDENTIALS =
  /(?<![A-Za-z0-9+.:/-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{0,256}:)(?:[^\s@]{0,256}@){1,4}(?=[^\s@]*(?:\s|$))/gi;

// header.payload.signature, both JSON parts base64url ("eyJ"). The
// signature may be empty (unsigned tokens).
const JWT =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,8192}\.eyJ[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{0,8192}/g;

export function redactSensitiveInfo(input: string): string {
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
      .replace(/(\bAuthorization\s{0,16}:\s{0,16}Bearer\s{1,16})\S+/gi, "$1[REDACTED]")
      // Bare JWTs
      .replace(JWT, "[REDACTED]")
      // Credentials in URLs: keeps scheme, user and host
      .replace(URL_CREDENTIALS, "$1[REDACTED]@")
      // key=value or key: value style sensitive fields
      .replace(KEY_VALUE, "$1=[REDACTED]")
      // JSON double-quoted sensitive fields
      .replace(JSON_DOUBLE, '"$1":"[REDACTED]"')
      // JSON single-quoted sensitive fields
      .replace(JSON_SINGLE, "'$1':'[REDACTED]'")
  );
}
