import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createCatalog } from "../src/courses.js";
import { createEnrollmentRepo } from "../src/enrollments.js";
import { ENROLLMENTS, WEBHOOKS } from "../src/mongo.js";
import { createWebhookLog } from "../src/webhookLog.js";
import { listen, sign, testConfig } from "./helpers.js";
import { closeMongoAfterTests, createTestDb } from "./mongo.js";

closeMongoAfterTests();

const catalog = createCatalog([
  {
    courseCode: "EXAMPLE-INTRO",
    graphyCourseCode: "prod_intro_1",
    name: "Example: Introduction course",
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

function graphyMock() {
  const calls = [];
  let learners = [];
  return {
    calls,
    setLearners(next) {
      learners = next;
    },
    client: {
      async findLearnerByEmail(email) {
        calls.push({ op: "find", email });
        return learners.find((learner) => learner.email === email) ?? null;
      },
      async createLearner(input) {
        calls.push({ op: "create", input });
        learners.push({ id: "learner_1", email: input.email, name: input.name });
        return { status: "success", id: "learner_1" };
      },
      async assignCourse(input) {
        calls.push({ op: "assign", input });
        return { status: "success" };
      },
    },
  };
}

async function withApp(fn) {
  const graphy = graphyMock();
  const fetched = [];
  const razorpay = {
    keyId: "rzp_test_key",
    orders: {
      async create() {
        throw new Error("orders.create should not run from the webhook");
      },
      async fetch(orderId) {
        fetched.push(orderId);
        return { id: orderId, notes };
      },
    },
  };
  const db = await createTestDb();
  const app = createApp({
    config: testConfig(),
    courses: catalog,
    razorpay,
    graphy: graphy.client,
    enrollments: createEnrollmentRepo(db.collection(ENROLLMENTS)),
    webhookLog: createWebhookLog(db.collection(WEBHOOKS)),
  });
  const server = await listen(app);
  try {
    await fn({ server, graphy, fetched, db });
  } finally {
    await server.close();
  }
}

async function postWebhook(url, event, { secret, signature, eventId } = {}) {
  const raw = JSON.stringify(event);
  const header = signature === undefined ? sign(raw, secret) : signature;
  const response = await fetch(`${url}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": header,
      "X-Razorpay-Event-Id": eventId ?? "evt_test",
    },
    body: raw,
  });
  return { response, body: await response.json(), raw };
}

test("enrolls from payment.captured by fetching order notes, once", async () => {
  await withApp(async ({ server, graphy, fetched, db }) => {
    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_123",
            order_id: "order_123",
            status: "captured",
            notes: [],
          },
        },
      },
    };

    const first = await postWebhook(server.url, event, { eventId: "evt_123" });
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body, { ok: true, enrolled: true });
    assert.deepEqual(fetched, ["order_123"]);
    assert.deepEqual(
      graphy.calls.map((call) => call.op),
      ["find", "create", "assign"],
    );
    assert.deepEqual(graphy.calls[2].input, {
      email: "learner@example.com",
      productId: "prod_intro_1",
    });
    assert.equal(graphy.calls[1].input.mobile, "+919876543210");

    const stored = await db.collection(ENROLLMENTS).findOne({ paymentId: "pay_123" });
    assert.equal(stored.status, "success");
    assert.equal(stored.orderId, "order_123");
    assert.equal(stored.courseCode, "EXAMPLE-INTRO");
    assert.equal(stored.graphyCourseCode, "prod_intro_1");
    assert.equal(stored.email, "learner@example.com");
    assert.equal(stored.name, "Asha Rao");
    assert.equal(stored.phone, "+919876543210");
    assert.equal(stored.attempts, 1);
    assert.deepEqual(stored.graphyResponse.assign, { status: "success" });
    assert.deepEqual(stored.graphyResponse.create, { status: "success", id: "learner_1" });

    const second = await postWebhook(server.url, event, { eventId: "evt_123" });
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.body, { ok: true, duplicate: true });
    assert.equal(graphy.calls.length, 3);
    assert.equal(await db.collection(ENROLLMENTS).countDocuments({ paymentId: "pay_123" }), 1);

    const deliveries = await db
      .collection(WEBHOOKS)
      .find({ razorpayEventId: "evt_123" })
      .sort({ receivedAt: 1 })
      .toArray();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].signatureValid, true);
    assert.equal(deliveries[0].status, "enrolled");
    assert.equal(deliveries[0].event, "payment.captured");
    assert.equal(deliveries[0].rawBody, first.raw);
    assert.equal(deliveries[0].payload.event, "payment.captured");
    assert.equal(deliveries[1].status, "duplicate");
  });
});

test("enrolls an existing learner from order.paid without creating them", async () => {
  await withApp(async ({ server, graphy, fetched, db }) => {
    graphy.setLearners([{ id: "learner_9", email: "learner@example.com" }]);
    const event = {
      event: "order.paid",
      payload: {
        payment: { entity: { id: "pay_456", order_id: "order_456", notes: [] } },
        order: { entity: { id: "order_456", status: "paid", notes } },
      },
    };

    const result = await postWebhook(server.url, event);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.enrolled, true);
    assert.deepEqual(fetched, []);
    assert.deepEqual(
      graphy.calls.map((call) => call.op),
      ["find", "assign"],
    );
    const stored = await db.collection(ENROLLMENTS).findOne({ paymentId: "pay_456" });
    assert.equal(stored.graphyResponse.create, null);
    assert.equal(stored.graphyResponse.assign.status, "success");
  });
});

test("stores an invalid signature and ignores unrelated events", async () => {
  await withApp(async ({ server, graphy, db }) => {
    const paid = {
      event: "payment.captured",
      payload: {
        payment: { entity: { id: "pay_789", order_id: "order_789", notes } },
      },
    };
    const rejected = await postWebhook(server.url, paid, {
      signature: "deadbeef",
      eventId: "evt_bad",
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(graphy.calls.length, 0);
    assert.equal(await db.collection(ENROLLMENTS).countDocuments(), 0);

    const bad = await db.collection(WEBHOOKS).findOne({ razorpayEventId: "evt_bad" });
    assert.equal(bad.signatureValid, false);
    assert.equal(bad.signature, "deadbeef");
    assert.equal(bad.status, "rejected");
    assert.equal(bad.outcome, "invalid_signature");
    assert.equal(bad.event, "payment.captured");
    assert.equal(bad.rawBody, rejected.raw);

    const ignored = await postWebhook(server.url, { event: "payment.authorized" }, {
      eventId: "evt_auth",
    });
    assert.equal(ignored.response.status, 200);
    assert.equal(ignored.body.ignored, true);
    assert.equal(graphy.calls.length, 0);
    const ignoredDoc = await db.collection(WEBHOOKS).findOne({ razorpayEventId: "evt_auth" });
    assert.equal(ignoredDoc.signatureValid, true);
    assert.equal(ignoredDoc.status, "ignored");
  });
});

test("returns 500 when Graphy assign fails and retries enrollment later", async () => {
  await withApp(async ({ server, graphy, db }) => {
    let fail = true;
    graphy.client.assignCourse = async (input) => {
      graphy.calls.push({ op: "assign", input });
      if (fail) throw new Error("Graphy assign course failed (503): unavailable");
      return { status: "success" };
    };

    const event = {
      event: "order.paid",
      payload: {
        payment: { entity: { id: "pay_retry", notes: [] } },
        order: { entity: { id: "order_retry", notes } },
      },
    };

    const failed = await postWebhook(server.url, event, { eventId: "evt_fail" });
    assert.equal(failed.response.status, 500);

    const afterFailure = await db.collection(ENROLLMENTS).findOne({ paymentId: "pay_retry" });
    assert.equal(afterFailure.status, "failed");
    assert.equal(afterFailure.attempts, 1);
    assert.match(afterFailure.error, /unavailable/);
    const failedEvent = await db.collection(WEBHOOKS).findOne({ razorpayEventId: "evt_fail" });
    assert.equal(failedEvent.status, "failed");
    assert.equal(failedEvent.outcome, "enrollment_failed");

    fail = false;
    const retried = await postWebhook(server.url, event, { eventId: "evt_retry" });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.enrolled, true);
    assert.equal(graphy.calls.filter((call) => call.op === "assign").length, 2);

    const afterRetry = await db.collection(ENROLLMENTS).findOne({ paymentId: "pay_retry" });
    assert.equal(afterRetry.status, "success");
    assert.equal(afterRetry.attempts, 2);
    assert.equal(afterRetry.error, null);
  });
});
