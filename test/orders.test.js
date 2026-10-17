import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createCatalog } from "../src/courses.js";
import { listen, testConfig } from "./helpers.js";

const catalog = createCatalog([
  {
    courseCode: "EXAMPLE-INTRO",
    graphyCourseCode: "EXAMPLE_GRAPHY_PRODUCT_ID_1",
    name: "Example: Introduction course",
    price: 499,
  },
]);

function mockRazorpay() {
  const created = [];
  return {
    created,
    client: {
      keyId: "rzp_test_key",
      orders: {
        async create(payload) {
          created.push(payload);
          return {
            id: "order_test_1",
            amount: payload.amount,
            currency: payload.currency,
            notes: payload.notes,
          };
        },
        async fetch() {
          throw new Error("fetch should not be called while creating an order");
        },
      },
    },
  };
}

async function withApp(fn) {
  const razorpay = mockRazorpay();
  const app = createApp({
    config: testConfig(),
    courses: catalog,
    razorpay: razorpay.client,
    graphy: {
      async findLearnerByEmail() {
        throw new Error("graphy should not be called");
      },
      async createLearner() {
        throw new Error("graphy should not be called");
      },
      async assignCourse() {
        throw new Error("graphy should not be called");
      },
    },
  });
  const server = await listen(app);
  try {
    await fn({ server, razorpay });
  } finally {
    await server.close();
  }
}

test("creates an order from the catalog price and stores buyer notes", async () => {
  await withApp(async ({ server, razorpay }) => {
    const response = await fetch(`${server.url}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseCode: "EXAMPLE-INTRO",
        email: "Learner@Example.com",
        name: "Asha Rao",
        phone: "+919876543210",
        price: 1,
      }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      orderId: "order_test_1",
      amount: 49900,
      currency: "INR",
      keyId: "rzp_test_key",
    });
    assert.equal(razorpay.created.length, 1);
    assert.equal(razorpay.created[0].amount, 49900);
    assert.equal(razorpay.created[0].currency, "INR");
    assert.deepEqual(razorpay.created[0].notes, {
      courseCode: "EXAMPLE-INTRO",
      graphyCourseCode: "EXAMPLE_GRAPHY_PRODUCT_ID_1",
      buyerEmail: "learner@example.com",
      buyerName: "Asha Rao",
      buyerPhone: "+919876543210",
    });
  });
});

test("rejects an unknown course and a missing email", async () => {
  await withApp(async ({ server, razorpay }) => {
    const unknown = await fetch(`${server.url}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseCode: "NOPE",
        email: "learner@example.com",
        name: "Asha Rao",
        price: 99999,
      }),
    });
    assert.equal(unknown.status, 404);
    assert.equal(razorpay.created.length, 0);

    const missing = await fetch(`${server.url}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseCode: "EXAMPLE-INTRO", name: "Asha Rao" }),
    });
    assert.equal(missing.status, 400);
    assert.equal(razorpay.created.length, 0);
  });
});
