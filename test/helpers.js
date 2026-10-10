import { createServer } from "node:http";
import { once } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnrollmentStore } from "../src/enrollmentStore.js";

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
    enrollmentStorePath: "",
    corsOrigin: "",
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

export function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enroll-"));
  const filePath = path.join(dir, "enrollments.json");
  return {
    filePath,
    store: createEnrollmentStore(filePath),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
