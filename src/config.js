import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "GRAPHY_MERCHANT_ID",
  "GRAPHY_API_TOKEN",
];

export function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function flag(value, fallback, name) {
  if (value === undefined || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function integerInRange(value, fallback, name, { min, max }) {
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function resolveFromRoot(value, fallback) {
  const chosen = value && String(value).trim() ? String(value).trim() : fallback;
  return path.isAbsolute(chosen) ? chosen : path.join(projectRoot(), chosen);
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    port,
    razorpayKeyId: String(env.RAZORPAY_KEY_ID).trim(),
    razorpayKeySecret: String(env.RAZORPAY_KEY_SECRET).trim(),
    razorpayWebhookSecret: String(env.RAZORPAY_WEBHOOK_SECRET).trim(),
    graphyMerchantId: String(env.GRAPHY_MERCHANT_ID).trim(),
    graphyApiToken: String(env.GRAPHY_API_TOKEN).trim(),
    graphyApiBaseUrl: String(
      env.GRAPHY_API_BASE_URL || "https://api.ongraphy.com",
    ).replace(/\/$/, ""),
    coursesPath: resolveFromRoot(env.COURSES_PATH, "data/courses.json"),
    corsOrigin: String(env.CORS_ORIGIN ?? "").trim(),
    graphyRetryAttempts: integerInRange(
      env.GRAPHY_RETRY_ATTEMPTS,
      3,
      "GRAPHY_RETRY_ATTEMPTS",
      { min: 1, max: 8 },
    ),
    graphyRetryBaseDelayMs: integerInRange(
      env.GRAPHY_RETRY_BASE_DELAY_MS,
      500,
      "GRAPHY_RETRY_BASE_DELAY_MS",
      { min: 1, max: 60_000 },
    ),
    graphyRequestTimeoutMs: integerInRange(
      env.GRAPHY_REQUEST_TIMEOUT_MS,
      10_000,
      "GRAPHY_REQUEST_TIMEOUT_MS",
      { min: 100, max: 120_000 },
    ),
    recoveryEnabled: flag(env.RECOVERY_ENABLED, true, "RECOVERY_ENABLED"),
    recoveryIntervalMs: integerInRange(
      env.RECOVERY_INTERVAL_MS,
      10 * 60 * 1000,
      "RECOVERY_INTERVAL_MS",
      { min: 1000, max: 24 * 60 * 60 * 1000 },
    ),
    recoveryWindowMs: integerInRange(
      env.RECOVERY_WINDOW_MS,
      10 * 60 * 1000,
      "RECOVERY_WINDOW_MS",
      { min: 1000, max: 24 * 60 * 60 * 1000 },
    ),
    recoveryOverlapMs: integerInRange(
      env.RECOVERY_OVERLAP_MS,
      2 * 60 * 1000,
      "RECOVERY_OVERLAP_MS",
      { min: 0, max: 60 * 60 * 1000 },
    ),
  };
}
