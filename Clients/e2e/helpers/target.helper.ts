/**
 * The environment the E2E run points at. Anything other than localhost is a
 * deployed environment (staging, production), where global.setup.ts must not
 * run: it deletes and recreates organizations and seeds data.
 *
 * Read lazily, so playwright.config.ts sees values loaded by dotenv.
 */
export function e2eBaseUrl(): string {
  return process.env.E2E_BASE_URL || "http://localhost:5173";
}

export function isDeployedTarget(baseUrl: string = e2eBaseUrl()): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    // An unparseable URL is treated as deployed, so the destructive setup refuses it
    return true;
  }
  return !["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
