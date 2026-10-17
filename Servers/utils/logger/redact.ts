/**
 * Defense-in-depth redaction for accidentally-logged secrets.
 * Applied to every file log message before it reaches the transport, and by
 * logEvent to every event description before it is stored (event_logs and
 * the audit ledger).
 */

// A sensitive key name, optionally with a snake/kebab prefix
// (client_secret, db_password, x-api-key, csrf_token). The trailing \b in
// the patterns below keeps longer words such as "tokens" or "token_count" out.
const KEY =
  "(?:[A-Za-z0-9]+[_-])*(?:password|passwd|secret|token|api[_-]?key|apikey|accesstoken|refreshtoken|clientsecret)";

const KEY_VALUE = new RegExp(`\\b(${KEY})\\b\\s*[:=]\\s*[^\\s&,"{}]+`, "gi");
const JSON_DOUBLE = new RegExp(`"(${KEY})"\\s*:\\s*"[^"]*"`, "gi");
const JSON_SINGLE = new RegExp(`'(${KEY})'\\s*:\\s*'[^']*'`, "gi");

export function redactSensitiveInfo(input: string): string {
  return (
    input
      // OpenAI-style API keys and similar long key prefixes
      .replace(/\b(sk-[A-Za-z0-9_-]{10,})\b/g, "[REDACTED]")
      // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained)
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]")
      // Vercel AI Gateway keys
      .replace(/\bvck_[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
      // Authorization: Bearer <token>
      .replace(/(\bAuthorization\s*:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
      // Bare JWTs (header.payload.signature, both JSON parts base64url "eyJ")
      .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
      // Credentials in URLs: scheme://user:password@host keeps user and host
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@")
      // key=value or key: value style sensitive fields
      .replace(KEY_VALUE, "$1=[REDACTED]")
      // JSON double-quoted sensitive fields
      .replace(JSON_DOUBLE, '"$1":"[REDACTED]"')
      // JSON single-quoted sensitive fields
      .replace(JSON_SINGLE, "'$1':'[REDACTED]'")
  );
}
