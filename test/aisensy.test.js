import test from "node:test";
import assert from "node:assert/strict";
import {
  buyerFirstName,
  courseAccessUrl,
  createAiSensyClient,
  notifyPurchase,
  purchaseConfirmationBody,
} from "../src/aisensy.js";
import { createCatalog } from "../src/courses.js";
import { runRecovery } from "../src/recovery.js";
import { testConfig } from "./helpers.js";

const course = {
  courseCode: "CFBC",
  graphyCourseCode: "69982bc4537633302dc0288e",
  name: "Capsicum Farming Business Course",
  accessUrl: "",
  guideVideoUrl: "",
};

const config = testConfig({
  aisensyApiKey: "aisensy-secret-key",
  aisensyGuideVideoUrl: "https://cdn.example.com/guide.mp4",
});

function jsonResponse(status, payload = { ok: true }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test("confirmation params follow the kropiq_purchase template", () => {
  assert.equal(buyerFirstName("  "), "user");
  assert.equal(buyerFirstName("Asha Rao"), "Asha");

  const built = purchaseConfirmationBody({
    config,
    course,
    buyer: { name: "Asha Rao", phone: "+91 70308 07419" },
    paymentId: "pay_123",
  });
  assert.equal(built.destination, "917030807419");
  assert.equal(
    built.accessUrl,
    "https://login.indianfarmer.com/s/courses/69982bc4537633302dc0288e/info",
  );
  assert.deepEqual(built.body.templateParams, [
    "Asha",
    "+91 70308 07419",
    "pay_123",
    "https://login.indianfarmer.com/s/courses/69982bc4537633302dc0288e/info",
    "https://cdn.example.com/guide.mp4",
  ]);
  assert.equal(built.body.userName, "Asha Rao");
  assert.equal(built.body.campaignName, "kropiq_purchase");
  assert.equal(built.body.source, "new-landing-page form");
  assert.deepEqual(built.body.paramsFallbackValue, { FirstName: "user" });
  assert.deepEqual(built.body.media, {});
  assert.deepEqual(built.body.buttons, []);

  const unnamed = purchaseConfirmationBody({
    config,
    course: {
      ...course,
      accessUrl: "https://courses.example/capsicum",
      guideVideoUrl: "https://courses.example/video",
    },
    buyer: { name: "", phone: "+917030807419" },
    paymentId: "pay_456",
  });
  assert.equal(unnamed.body.userName, "user");
  assert.deepEqual(unnamed.body.templateParams, [
    "user",
    "+917030807419",
    "pay_456",
    "https://courses.example/capsicum",
    "https://courses.example/video",
  ]);
  assert.equal(courseAccessUrl({ graphyCourseCode: "abc" }), "https://login.indianfarmer.com/s/courses/abc/info");
});

test("skips the WhatsApp call when the API key or video URL is unset", async () => {
  let calls = 0;
  const noKey = createAiSensyClient({
    ...testConfig({ aisensyApiKey: "" }),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200);
    },
    log: { warn() {}, log() {}, error() {} },
  });
  const skipped = await noKey.sendPurchaseConfirmation({
    course,
    buyer: { name: "Asha", phone: "+917030807419" },
    paymentId: "pay_1",
  });
  assert.equal(skipped.skipped, true);
  assert.equal(calls, 0);

  const noVideo = createAiSensyClient({
    ...config,
    aisensyGuideVideoUrl: "",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200);
    },
    log: { warn() {}, log() {}, error() {} },
  });
  const skippedVideo = await noVideo.sendPurchaseConfirmation({
    course,
    buyer: { name: "Asha", phone: "+917030807419" },
    paymentId: "pay_1",
  });
  assert.equal(skippedVideo.reason, "guidance video URL is unset");
  assert.equal(calls, 0);
});

test("retries AiSensy 5xx, does not retry 400, and redacts the API key", async () => {
  const delays = [];
  let calls = 0;
  const client = createAiSensyClient({
    ...config,
    graphyRetryAttempts: 3,
    graphyRetryBaseDelayMs: 10,
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.apiKey, "aisensy-secret-key");
      assert.equal(options.headers["Content-Type"], "application/json");
      if (calls < 3) return jsonResponse(503, { message: "busy aisensy-secret-key" });
      return jsonResponse(200);
    },
    log: { warn() {}, log() {}, error() {} },
  });

  const result = await client.sendPurchaseConfirmation({
    course,
    buyer: { name: "Asha Rao", phone: "+917030807419" },
    paymentId: "pay_123",
  });
  assert.equal(result.skipped, false);
  assert.equal(result.destination, "917030807419");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);

  let rejectedCalls = 0;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const bad = createAiSensyClient({
      ...config,
      graphyRetryAttempts: 3,
      graphyRetryBaseDelayMs: 10,
      sleep: async () => {
        throw new Error("should not sleep");
      },
      fetchImpl: async () => {
        rejectedCalls += 1;
        return jsonResponse(400, { message: "bad key aisensy-secret-key" });
      },
      log: { warn() {}, log() {}, error() {} },
    });
    await assert.rejects(
      () =>
        bad.sendPurchaseConfirmation({
          course,
          buyer: { name: "Asha", phone: "+917030807419" },
          paymentId: "pay_123",
        }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message.includes("aisensy-secret-key"), false);
        assert.match(err.message, /\[redacted\]/);
        return true;
      },
    );
  } finally {
    console.error = original;
  }
  assert.equal(rejectedCalls, 1);
  assert.equal(JSON.stringify(errors).includes("aisensy-secret-key"), false);
});

test("a WhatsApp failure does not fail recovery, and an already enrolled buyer is not messaged", async () => {
  const sent = [];
  const catalog = createCatalog([
    {
      courseCode: "EXAMPLE-INTRO",
      graphyCourseCode: "prod_intro_1",
      name: "Example",
      price: 499,
    },
  ]);
  const notes = {
    courseCode: "EXAMPLE-INTRO",
    graphyCourseCode: "prod_intro_1",
    buyerEmail: "learner@example.com",
    buyerName: "Asha Rao",
    buyerPhone: "+919876543210",
  };
  const razorpay = {
    payments: {
      async all() {
        return {
          items: [
            { id: "pay_known", status: "captured", order_id: "order_known", notes },
            { id: "pay_new", status: "captured", order_id: "order_new", notes: { ...notes, buyerEmail: "new@example.com" } },
          ],
        };
      },
    },
    orders: { async fetch() { throw new Error("notes are on the payment"); } },
  };
  const graphy = {
    async isEnrolled({ email }) {
      return email === "learner@example.com";
    },
    async findLearnerByEmail() {
      return null;
    },
    async createLearner() {
      return { status: "success" };
    },
    async assignCourse() {
      return { status: "success" };
    },
  };
  const aisensy = {
    async sendPurchaseConfirmation(input) {
      sent.push(input.paymentId);
      throw new Error("AiSensy failed (503): down");
    },
  };

  const summary = await runRecovery({
    config: testConfig(),
    razorpay,
    graphy,
    courses: catalog,
    aisensy,
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    log: { log() {}, error() {}, warn() {} },
  });

  assert.equal(summary.enrolled, 1);
  assert.equal(summary.alreadyEnrolled, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(sent, ["pay_new"]);

  const notified = await notifyPurchase({
    aisensy,
    course: catalog.findByCode("EXAMPLE-INTRO"),
    buyer: { name: "Asha", phone: "+919876543210" },
    paymentId: "pay_new",
    log: { log() {}, error() {}, warn() {} },
  });
  assert.equal(notified.failed, true);
});
