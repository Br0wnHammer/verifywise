import { describe, it, expect } from "@jest/globals";
import { redactSensitiveInfo, UNSCANNABLE_PLACEHOLDER } from "../logger/redact";

describe("redactSensitiveInfo", () => {
  it.each([
    // Existing coverage, unchanged.
    ["OpenAI-style key", "key sk-abcdefghijklmnop1234 rejected", "key [REDACTED] rejected"],
    [
      "Authorization Bearer",
      "Authorization: Bearer abc.def.ghi failed",
      "Authorization: Bearer [REDACTED] failed",
    ],
    ["password=", "login password=hunter2 refused", "login password=[REDACTED] refused"],
    ["quoted password=", "login password='hunter2' refused", "login password=[REDACTED] refused"],
    ["camelCase accessToken", "accessToken: abc123 expired", "accessToken=[REDACTED] expired"],
    [
      'JSON "password"',
      '{"password":"hunter2","user":"a"}',
      '{"password":"[REDACTED]","user":"a"}',
    ],
    // snake_case and prefixed keys
    ["client_secret", "client_secret=abc123 is wrong", "client_secret=[REDACTED] is wrong"],
    ["access_token", "access_token: xyz789 expired", "access_token=[REDACTED] expired"],
    ["refresh_token", "refresh_token=r-1 revoked", "refresh_token=[REDACTED] revoked"],
    ["db_password", "db_password=pa55 bad", "db_password=[REDACTED] bad"],
    [
      'JSON "refresh_token"',
      '{"refresh_token":"r-1","ok":false}',
      '{"refresh_token":"[REDACTED]","ok":false}',
    ],
    ['JSON "client_secret"', "{'client_secret': 'abc'}", "{'client_secret':'[REDACTED]'}"],
    // headers
    ["x-api-key header", "x-api-key: abcdef123456 denied", "x-api-key=[REDACTED] denied"],
    // URL credentials keep scheme, user and host
    [
      "URL credentials",
      "connect postgres://admin:s3cr3t@db.internal:5432/vw failed",
      "connect postgres://admin:[REDACTED]@db.internal:5432/vw failed",
    ],
    // bare tokens
    [
      "bare JWT",
      "token eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJlLXZhbHVl was invalid",
      "token [REDACTED] was invalid",
    ],
    [
      "GitHub classic token",
      "push with ghp_abcdefghijklmnopqrstuvwxyz0123 failed",
      "push with [REDACTED] failed",
    ],
    [
      "GitHub fine-grained token",
      "use github_pat_11ABCDEFG0123456789_abcdefghijklmnop now",
      "use [REDACTED] now",
    ],
    [
      "Vercel gateway key",
      "gateway key vck_abcdefghij1234567890 rejected",
      "gateway key [REDACTED] rejected",
    ],
    // suffixed key names
    [
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SECRET_ACCESS_KEY=abc set",
      "AWS_SECRET_ACCESS_KEY=[REDACTED] set",
    ],
    ["secret_key", "secret_key=abc set", "secret_key=[REDACTED] set"],
    ["private_key", "private_key=abc set", "private_key=[REDACTED] set"],
    ["passphrase", "passphrase=hunter2 set", "passphrase=[REDACTED] set"],
    // URL credentials, harder shapes
    [
      "password-only URL",
      "redis://:s3cr3tpw@localhost:6379 refused",
      "redis://:[REDACTED]@localhost:6379 refused",
    ],
    [
      "password with /",
      "postgres://user:ab/cd+ef@db:5432/x refused",
      "postgres://user:[REDACTED]@db:5432/x refused",
    ],
    [
      "password with @",
      "postgres://user:p@ss@db/x refused",
      "postgres://user:[REDACTED]@db/x refused",
    ],
    // host:port@ is indistinguishable from user:password@, so it is redacted.
    ["host:port@ (safe side)", "http://host:8080@foo", "http://host:[REDACTED]@foo"],
    // unsigned JWT
    ["JWT with empty signature", "got eyJhbGc.eyJzdWI. back", "got [REDACTED] back"],
    // scheme chains: the scheme may follow ":" or "/"
    [
      "jdbc:postgresql URL",
      "connect jdbc:postgresql://u:p@h:5432/db failed",
      "connect jdbc:postgresql://u:[REDACTED]@h:5432/db failed",
    ],
    ["URL: prefix", "URL:postgres://u:p@h", "URL:postgres://u:[REDACTED]@h"],
    [
      "env-style URL",
      "DATABASE_URL=postgres://u:p@h/db",
      "DATABASE_URL=postgres://u:[REDACTED]@h/db",
    ],
    // several URLs in one token
    [
      "credentialed URL after a plain one in one JSON token",
      '{"a":"https://ok.example","b":"postgres://u:pw@db/x"}',
      '{"a":"https://ok.example","b":"postgres://u:[REDACTED]@db/x"}',
    ],
    [
      "two credentialed URLs in one token",
      "postgres://u:p1@a,redis://:p2@b",
      // One rule: the password runs to the last "@" (over-redaction accepted).
      "postgres://u:[REDACTED]@b",
    ],
    // host:port then "@" in the path is indistinguishable too (safe side).
    ["port then @ in the path (safe side)", "http://host:8080/a@b", "http://host:[REDACTED]@b"],
    // passwords containing characters that used to end the URL early
    ["password with {", "postgres://u:ab{cd@h/db", "postgres://u:[REDACTED]@h/db"],
    ['password with "', 'postgres://u:ab"cd@h/db', "postgres://u:[REDACTED]@h/db"],
    ["password with ]", "postgres://u:ab]cd@h/db", "postgres://u:[REDACTED]@h/db"],
    ["password with ://", "postgres://u:pa://ss@h/db", "postgres://u:[REDACTED]@h/db"],
    // no "@" after the userinfo ":" (fail closed)
    ["password with no @", "postgres://u:secretpw", "postgres://u:[REDACTED]"],
    [
      "password with no @ in JSON",
      '{"db":"postgres://u:secretpw"}',
      '{"db":"postgres://u:[REDACTED]',
    ],
    // apostrophe inside an unquoted value
    ["unquoted value with an apostrophe", "password=abc'def set", "password=[REDACTED] set"],
    // key names are found whatever precedes them
    [
      "six prefix segments",
      "a_b_c_d_e_f_password=hunter2 set",
      "a_b_c_d_e_f_password=[REDACTED] set",
    ],
    ["camelCase prefix", "dbPassword=hunter2 set", "dbPassword=[REDACTED] set"],
    // quoted, spaced and unterminated values
    ["quoted value with spaces", 'password="two words" set', "password=[REDACTED] set"],
    ["wide whitespace", `password=${" ".repeat(20)}hunter2 set`, "password=[REDACTED] set"],
    ["unterminated JSON value", '{"password":"hunter2', '{"password":"[REDACTED]"'],
    [
      "JSON value with escaped quote",
      '{"password":"a\\"b","ok":1}',
      '{"password":"[REDACTED]","ok":1}',
    ],
  ])("redacts %s", (_label, input, expected) => {
    expect(redactSensitiveInfo(input)).toBe(expected);
  });

  it.each([
    "Created vendor Acme",
    "token budget exceeded for this month",
    "max_tokens=4096 was applied",
    "token_count=12 recorded",
    "Risk 42 updated by user 7",
    "Failed to update risk: risk not found (id=42)",
    "Visit https://verifywise.ai/docs for help",
    "Secret santa planning task created",
    "Fetched http://host:8080/path ok",
    "Listening on http://localhost:3000",
    '{"url":"http://host:8080/x"}',
    "Profile https://example.com/@user linked",
    '{"u":"https://example.com/users/@me","n":1}',
    '{"a":"https://ok.example","b":"me@mail.example"}',
    "Request 3f2b9c1e-1234-4abc-8def-0123456789ab completed",
  ])("leaves %j unchanged", (input) => {
    expect(redactSensitiveInfo(input)).toBe(input);
  });

  // Never fail open on length: over-long secrets are redacted in full.
  it.each([
    [
      "a 10KB JWT",
      `eyJ${"a".repeat(3400)}.eyJ${"b".repeat(3400)}.${"c".repeat(3400)}`,
      "[REDACTED]",
    ],
    [
      "a JWT whose segments exceed 8KB",
      `eyJ${"a".repeat(9000)}.eyJ${"b".repeat(9000)}.${"c".repeat(9000)}`,
      "[REDACTED]",
    ],
    [
      "a 10KB JSON secret value",
      `{"password":"${"s".repeat(10_000)}"}`,
      '{"password":"[REDACTED]"}',
    ],
    ["a 1KB URL password", `postgres://u:${"p".repeat(1024)}@db/x`, "postgres://u:[REDACTED]@db/x"],
    ["a 10KB key=value secret", `token=${"t".repeat(10_000)} end`, "token=[REDACTED] end"],
  ])("redacts %s in full", (_label, input, expected) => {
    expect(redactSensitiveInfo(input)).toBe(expected);
  });

  it("fails closed when the input cannot be scanned", () => {
    const unscannable = {
      replace() {
        throw new RangeError("Maximum call stack size exceeded");
      },
    } as unknown as string;
    expect(redactSensitiveInfo(unscannable)).toBe(UNSCANNABLE_PLACEHOLDER);
  });
});

// Redaction runs on every log line and event, so it must stay linear.
// Each input is 50-120KB; a quadratic pattern takes seconds on them (the
// UUID chain took ~1.8s and "a-" x32000 ~8.7s with the earlier unbounded
// key prefix). Measured locally (Node 22, best of 3): 0.2-3.3ms each, worst
// the 100KB random text. The bound is the best of three runs, so a busy CI
// machine does not flake it.
describe("redactSensitiveInfo performance", () => {
  const prng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const random = prng(42);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=:/@.\" '{}&,";
  const randomText = Array.from(
    { length: 100_000 },
    () => alphabet[Math.floor(random() * alphabet.length)],
  ).join("");
  const uuids = Array.from(
    { length: 2000 },
    (_, i) =>
      `${((i * 2654435761) >>> 0).toString(16).padStart(8, "0")}-1234-4abc-8def-0123456789ab`,
  ).join("-");

  const bestOfThree = (input: string) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      redactSensitiveInfo(input);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it.each([
    ["2000 UUIDs joined by -", uuids],
    ['"a-" x32000', "a-".repeat(32000)],
    ["100KB random text", randomText],
    ['"eyJ-" x25000', "eyJ-".repeat(25000)],
    ['"sk-" x30000', "sk-".repeat(30000)],
    ['"x://a:" x15000', "x://a:".repeat(15000)],
    ['"x://a:@@" x15000', "x://a:@@".repeat(15000)],
    ['"x://a:;" x15000', "x://a:;".repeat(15000)],
    ['"\\"password\\":\\"" x8000', '"password":"'.repeat(8000)],
    ['"Authorization: " x8000', "Authorization: ".repeat(8000)],
    ["'password=\"x ' x8000 (unterminated quotes)", 'password="x '.repeat(8000)],
    ["'password\"' x10000", 'password"'.repeat(10000)],
    ['"eyJa.eyJ-" x20000', "eyJa.eyJ-".repeat(20000)],
    ['"a://b:c@" x15000 in one token', "a://b:c@".repeat(15000)],
    ["a 100KB token with :// and @", `x://${"y".repeat(100_000)}@`],
    ['\'"https://x.y","\' x8000 then @', `${'"https://x.y","'.repeat(8000)}@`],
    ['"x://@" x20000', "x://@".repeat(20000)],
    ['"x://u:p@" x15000', "x://u:p@".repeat(15000)],
  ])("redacts %s in under 50ms", (_label, input) => {
    expect(bestOfThree(input)).toBeLessThan(50);
  });
});
