import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadCourses } from "./courses.js";
import { createGraphyClient } from "./graphyClient.js";
import { createRazorpayClient } from "./razorpayClient.js";
import { runRecovery } from "./recovery.js";

const config = loadConfig();
const courses = loadCourses(config.coursesPath);
const razorpay = createRazorpayClient(config);
const graphy = createGraphyClient({
  ...config,
  retryAttempts: config.graphyRetryAttempts,
  retryBaseDelayMs: config.graphyRetryBaseDelayMs,
  requestTimeoutMs: config.graphyRequestTimeoutMs,
});

const app = createApp({ config, courses, razorpay, graphy });

const server = app.listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
});

if (config.recoveryEnabled) {
  const run = () => {
    runRecovery({ config, razorpay, graphy, courses }).catch((err) => {
      console.error("[recovery] run failed", { message: err.message });
    });
  };
  run();
  const timer = setInterval(run, config.recoveryIntervalMs);
  timer.unref();
} else {
  console.log("[recovery] in-process job disabled");
}

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
