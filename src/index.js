import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadCourses } from "./courses.js";
import { createEnrollmentRepo } from "./enrollments.js";
import { createGraphyClient } from "./graphyClient.js";
import { connectMongo, ENROLLMENTS, WEBHOOKS } from "./mongo.js";
import { createRazorpayClient } from "./razorpayClient.js";
import { createWebhookLog } from "./webhookLog.js";

const config = loadConfig();
const courses = loadCourses(config.coursesPath);
const { client, db } = await connectMongo(config);

const app = createApp({
  config,
  courses,
  razorpay: createRazorpayClient(config),
  graphy: createGraphyClient(config),
  enrollments: createEnrollmentRepo(db.collection(ENROLLMENTS)),
  webhookLog: createWebhookLog(db.collection(WEBHOOKS)),
});

const server = app.listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
});

async function shutdown() {
  server.close();
  await client.close();
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
