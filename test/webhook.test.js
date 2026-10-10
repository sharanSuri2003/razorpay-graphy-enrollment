import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createCatalog } from "../src/courses.js";
import { listen, sign, tempStore, testConfig } from "./helpers.js";

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
        return { status: "success" };
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
  const storeFile = tempStore();
  const app = createApp({
    config: testConfig(),
    courses: catalog,
    razorpay,
    graphy: graphy.client,
    store: storeFile.store,
  });
  const server = await listen(app);
  try {
    await fn({ server, graphy, fetched, store: storeFile.store });
  } finally {
    await server.close();
    storeFile.cleanup();
  }
}

async function postWebhook(url, event, { secret, signature } = {}) {
  const raw = JSON.stringify(event);
  const header =
    signature === undefined ? sign(raw, secret) : signature;
  const response = await fetch(`${url}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": header,
    },
    body: raw,
  });
  return { response, body: await response.json() };
}

test("enrolls from payment.captured by fetching order notes, once", async () => {
  await withApp(async ({ server, graphy, fetched }) => {
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

    const first = await postWebhook(server.url, event);
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

    const second = await postWebhook(server.url, event);
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.body, { ok: true, duplicate: true });
    assert.equal(graphy.calls.length, 3);
  });
});

test("enrolls an existing learner from order.paid without creating them", async () => {
  await withApp(async ({ server, graphy, fetched }) => {
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
  });
});

test("rejects a bad signature and ignores unrelated events", async () => {
  await withApp(async ({ server, graphy }) => {
    const paid = {
      event: "payment.captured",
      payload: {
        payment: { entity: { id: "pay_789", order_id: "order_789", notes } },
      },
    };
    const rejected = await postWebhook(server.url, paid, { signature: "deadbeef" });
    assert.equal(rejected.response.status, 400);
    assert.equal(graphy.calls.length, 0);

    const ignored = await postWebhook(server.url, { event: "payment.authorized" });
    assert.equal(ignored.response.status, 200);
    assert.equal(ignored.body.ignored, true);
    assert.equal(graphy.calls.length, 0);
  });
});

test("returns 500 when Graphy assign fails and retries enrollment later", async () => {
  await withApp(async ({ server, graphy }) => {
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

    const failed = await postWebhook(server.url, event);
    assert.equal(failed.response.status, 500);

    fail = false;
    const retried = await postWebhook(server.url, event);
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.enrolled, true);
    assert.equal(graphy.calls.filter((call) => call.op === "assign").length, 2);
  });
});
