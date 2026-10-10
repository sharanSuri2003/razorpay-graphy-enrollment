import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadCourses } from "./courses.js";
import { createEnrollmentStore } from "./enrollmentStore.js";
import { createGraphyClient } from "./graphyClient.js";
import { createRazorpayClient } from "./razorpayClient.js";

const config = loadConfig();
const courses = loadCourses(config.coursesPath);
const app = createApp({
  config,
  courses,
  razorpay: createRazorpayClient(config),
  graphy: createGraphyClient(config),
  store: createEnrollmentStore(config.enrollmentStorePath),
});

app.listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
});
