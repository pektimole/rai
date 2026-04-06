/**
 * Environment variable reader.
 * Reads from process.env (works with .env loaders, systemd, Docker, etc.)
 */

export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    result[key] = value;
  }
  return result;
}
