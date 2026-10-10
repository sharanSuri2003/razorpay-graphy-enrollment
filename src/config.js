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
    enrollmentStorePath: resolveFromRoot(
      env.ENROLLMENT_STORE_PATH,
      "data/enrollments.json",
    ),
    corsOrigin: String(env.CORS_ORIGIN ?? "").trim(),
  };
}
