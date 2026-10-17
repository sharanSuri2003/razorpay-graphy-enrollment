import "dotenv/config";
import { loadConfig } from "./config.js";
import { loadCourses } from "./courses.js";
import { createGraphyClient } from "./graphyClient.js";
import { createRazorpayClient } from "./razorpayClient.js";
import { runRecovery } from "./recovery.js";

const config = loadConfig();
const courses = loadCourses(config.coursesPath);
const summary = await runRecovery({
  config,
  courses,
  razorpay: createRazorpayClient(config),
  graphy: createGraphyClient({
    ...config,
    retryAttempts: config.graphyRetryAttempts,
    retryBaseDelayMs: config.graphyRetryBaseDelayMs,
    requestTimeoutMs: config.graphyRequestTimeoutMs,
  }),
});

process.exit(summary.failed > 0 ? 1 : 0);
