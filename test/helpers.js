import { createServer } from "node:http";
import { once } from "node:events";
import crypto from "node:crypto";

export const webhookSecret = "whsec_test_secret";

export function testConfig(overrides = {}) {
  return {
    port: 0,
    razorpayKeyId: "rzp_test_key",
    razorpayKeySecret: "rzp_test_secret",
    razorpayWebhookSecret: webhookSecret,
    graphyMerchantId: "mid_test",
    graphyApiToken: "graphy_token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    coursesPath: "",
    corsOrigins: [],
    graphyRetryAttempts: 3,
    graphyRetryBaseDelayMs: 500,
    graphyRequestTimeoutMs: 10_000,
    recoveryEnabled: false,
    recoveryIntervalMs: 600_000,
    recoveryWindowMs: 600_000,
    recoveryOverlapMs: 120_000,
    ...overrides,
  };
}

export function sign(rawBody, secret = webhookSecret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export async function listen(app) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
