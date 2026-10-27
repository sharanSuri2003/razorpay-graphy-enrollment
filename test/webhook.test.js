import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createCatalog } from "../src/courses.js";
import { listen, sign, testConfig } from "./helpers.js";

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
  let mobileLearner = null;
  return {
    calls,
    setLearners(next) {
      learners = next;
    },
    setMobileLearner(next) {
      mobileLearner = next;
    },
    client: {
      async findLearnerByEmail(email) {
        calls.push({ op: "find", email });
        return learners.find((learner) => learner.email === email) ?? null;
      },
      async findLearnerByMobile(mobile) {
        calls.push({ op: "findMobile", mobile });
        return mobileLearner;
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
  let orderNotes = notes;
  const razorpay = {
    keyId: "rzp_test_key",
    orders: {
      async create() {
        throw new Error("orders.create should not run from the webhook");
      },
      async fetch(orderId) {
        fetched.push(orderId);
        return { id: orderId, notes: orderNotes };
      },
    },
  };
  const app = createApp({
    config: testConfig(),
    courses: catalog,
    razorpay,
    graphy: graphy.client,
  });
  const server = await listen(app);
  try {
    await fn({
      server,
      graphy,
      fetched,
      setOrderNotes(next) {
        orderNotes = next;
      },
    });
  } finally {
    await server.close();
  }
}

async function postWebhook(url, event, { secret, signature } = {}) {
  const raw = JSON.stringify(event);
  const header = signature === undefined ? sign(raw, secret) : signature;
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

test("enrolls from payment.captured by fetching order notes", async () => {
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
    assert.deepEqual(graphy.calls[1].input, {
      email: "learner@example.com",
      name: "Asha Rao",
      mobile: "+919876543210",
    });
    assert.deepEqual(graphy.calls[2].input, {
      email: "learner@example.com",
      productId: "prod_intro_1",
    });

    const second = await postWebhook(server.url, event);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.enrolled, true);
    assert.deepEqual(
      graphy.calls.map((call) => call.op),
      ["find", "create", "assign", "find", "assign"],
    );
  });
});

test("enrolls an existing learner from payment.captured notes without creating them", async () => {
  await withApp(async ({ server, graphy, fetched }) => {
    graphy.setLearners([{ id: "learner_9", email: "learner@example.com" }]);
    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_456", order_id: "order_456", status: "captured", notes },
        },
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

test("does not call Graphy when buyerPhone is missing or invalid", async () => {
  await withApp(async ({ server, graphy, fetched, setOrderNotes }) => {
    setOrderNotes({ ...notes, buyerPhone: "" });
    const missing = await postWebhook(server.url, {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_nophone",
            order_id: "order_nophone",
            status: "captured",
            notes: [],
          },
        },
      },
    });
    assert.equal(missing.response.status, 200);
    assert.equal(missing.body.ok, true);
    assert.equal(missing.body.skipped, true);
    assert.match(missing.body.reason, /buyerPhone is missing/);
    assert.deepEqual(fetched, ["order_nophone"]);
    assert.equal(graphy.calls.length, 0);

    setOrderNotes({ ...notes, buyerPhone: "9876543210" });
    const invalid = await postWebhook(server.url, {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_badphone",
            order_id: "order_badphone",
            status: "captured",
            notes: { ...notes, buyerPhone: "9876543210" },
          },
        },
      },
    });
    assert.equal(invalid.response.status, 200);
    assert.equal(invalid.body.skipped, true);
    assert.match(invalid.body.reason, /country code/);
    assert.deepEqual(fetched, ["order_nophone", "order_badphone"]);
    assert.equal(graphy.calls.length, 0);
  });
});

test("enrolls a phone-only buyer on the account that already has that mobile", async () => {
  await withApp(async ({ server, graphy, setOrderNotes }) => {
    const phoneOnly = {
      courseCode: "EXAMPLE-INTRO",
      graphyCourseCode: "prod_intro_1",
      buyerName: "Asha Rao",
      buyerPhone: "+919999900001",
    };
    setOrderNotes(phoneOnly);
    graphy.setMobileLearner({ email: "real@example.com", mobile: "+919999900001" });

    const existing = await postWebhook(server.url, {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_phone",
            order_id: "order_phone",
            status: "captured",
            notes: [],
          },
        },
      },
    });
    assert.equal(existing.response.status, 200);
    assert.equal(existing.body.enrolled, true);
    assert.deepEqual(
      graphy.calls.map((call) => call.op),
      ["findMobile", "assign"],
    );
    assert.equal(graphy.calls[1].input.email, "real@example.com");

    graphy.setMobileLearner(null);
    graphy.calls.length = 0;
    const created = await postWebhook(server.url, {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_proxy",
            order_id: "order_proxy",
            status: "captured",
            notes: phoneOnly,
          },
        },
      },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.enrolled, true);
    assert.equal(graphy.calls[1].input.email, "919999900001@indianfarmer.com");
    assert.equal(graphy.calls[1].input.mobile, "+919999900001");
    assert.equal(graphy.calls[2].input.email, "919999900001@indianfarmer.com");
  });
});

test("rejects a bad signature and ignores unrelated events", async () => {
  await withApp(async ({ server, graphy, fetched }) => {
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

    const orderPaid = await postWebhook(server.url, {
      event: "order.paid",
      payload: {
        payment: { entity: { id: "pay_order", order_id: "order_paid", notes } },
        order: { entity: { id: "order_paid", status: "paid", notes } },
      },
    });
    assert.equal(orderPaid.response.status, 200);
    assert.equal(orderPaid.body.ignored, true);
    assert.equal(graphy.calls.length, 0);
    assert.equal(fetched.length, 0);
  });
});

test("returns 500 when Graphy assign fails and a later delivery tries again", async () => {
  await withApp(async ({ server, graphy }) => {
    let fail = true;
    graphy.client.assignCourse = async (input) => {
      graphy.calls.push({ op: "assign", input });
      if (fail) throw new Error("Graphy assign course failed (503): unavailable");
      return { status: "success" };
    };

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_retry", order_id: "order_retry", status: "captured", notes },
        },
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
