/**
 * Defense-in-depth redaction for accidentally-logged secrets.
 * Applied to every file log message before it reaches the transport, and to
 * event descriptions before they are written to event_logs.
 */
export function redactSensitiveInfo(input: string): string {
  return (
    input
      // OpenAI-style API keys and similar long key prefixes
      .replace(/\b(sk-[A-Za-z0-9_-]{10,})\b/g, "[REDACTED]")
      // Authorization: Bearer <token>
      .replace(/(\bAuthorization\s*:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
      // key=value or key: value style sensitive fields
      .replace(
        /\b(password|secret|token|apiKey|api_key|refreshToken|accessToken)\b\s*[:=]\s*[^\s&,"{}]+/gi,
        "$1=[REDACTED]",
      )
      // JSON double-quoted sensitive fields
      .replace(
        /"(password|secret|token|apiKey|api_key|refreshToken|accessToken)"\s*:\s*"[^"]*"/gi,
        '"$1":"[REDACTED]"',
      )
      // JSON single-quoted sensitive fields
      .replace(
        /'(password|secret|token|apiKey|api_key|refreshToken|accessToken)'\s*:\s*'[^']*'/gi,
        "'$1':'[REDACTED]'",
      )
  );
}
