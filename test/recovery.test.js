import test from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "../src/courses.js";
import { enrollmentFromLearner } from "../src/enrollmentCheck.js";
import { createGraphyClient } from "../src/graphyClient.js";
import { runRecovery } from "../src/recovery.js";
import { testConfig } from "./helpers.js";

const catalog = createCatalog([
  {
    courseCode: "EXAMPLE-INTRO",
    graphyCourseCode: "prod_intro_1",
    name: "Example: Introduction course",
    price: 499,
  },
]);

function captured(id, notes = []) {
  return { id, status: "captured", order_id: `order_${id}`, notes };
}

const buyer = {
  courseCode: "EXAMPLE-INTRO",
  graphyCourseCode: "prod_intro_1",
  buyerName: "Asha Rao",
  buyerPhone: "+919876543210",
};

test("enrollment check uses a course list when Graphy sends one", () => {
  assert.equal(enrollmentFromLearner(null, "prod_intro_1"), false);
  assert.equal(
    enrollmentFromLearner(
      { email: "a@b.c", courses: [{ productId: "prod_intro_1" }] },
      "prod_intro_1",
    ),
    true,
  );
  assert.equal(
    enrollmentFromLearner({ email: "a@b.c", courses: [] }, "prod_intro_1"),
    false,
  );
  assert.equal(enrollmentFromLearner({ email: "a@b.c", id: "learner_1" }, "prod_intro_1"), null);
});

test("isEnrolled asks for courseInfo and falls back to learner by id", async () => {
  const seen = [];
  const graphy = createGraphyClient({
    graphyMerchantId: "mid",
    graphyApiToken: "token",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    retryAttempts: 1,
    sleep: async () => {},
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      seen.push(`${parsed.pathname}?courseInfo=${parsed.searchParams.get("courseInfo")}`);
      const body = parsed.pathname.endsWith("/learner_1")
        ? { id: "learner_1", email: "learner@example.com", courses: ["prod_intro_1"] }
        : {
            data: [{ id: "learner_1", email: "learner@example.com" }],
            total: 1,
          };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify(body);
        },
      };
    },
  });

  assert.equal(await graphy.isEnrolled("learner@example.com", "prod_intro_1"), true);
  assert.deepEqual(seen, [
    "/public/v1/learners?courseInfo=true",
    "/public/v1/learners/learner_1?courseInfo=true",
  ]);
});

test("recovery enrolls captured payments that are not already on the course", async () => {
  const calls = [];
  const pages = [];
  const now = new Date("2026-06-01T12:00:00.000Z");
  const page1 = [
    captured("pay_known", { ...buyer, buyerEmail: "known@example.com" }),
    ...Array.from({ length: 99 }, (_, index) => ({
      id: `auth_${index}`,
      status: "authorized",
      order_id: `order_auth_${index}`,
      notes: [],
    })),
  ];

  const razorpay = {
    payments: {
      async all(params) {
        pages.push(params);
        if (params.skip === 0) return { items: page1 };
        return {
          items: [
            captured("pay_new"),
            captured("pay_mystery"),
            captured("pay_blank"),
            captured("pay_nophone"),
            captured("pay_badphone"),
            { id: "pay_auth", status: "authorized", order_id: "order_auth", notes: [] },
          ],
        };
      },
    },
    orders: {
      async fetch(orderId) {
        calls.push({ op: "fetch", orderId });
        const emails = {
          order_pay_new: "new@example.com",
          order_pay_mystery: "mystery@example.com",
          order_pay_nophone: "nophone@example.com",
          order_pay_badphone: "badphone@example.com",
        };
        if (!emails[orderId]) return { id: orderId, notes: {} };
        const notes = { ...buyer, buyerEmail: emails[orderId] };
        if (orderId === "order_pay_nophone") delete notes.buyerPhone;
        if (orderId === "order_pay_badphone") notes.buyerPhone = "9876543210";
        return { id: orderId, notes };
      },
    },
  };

  const graphy = {
    async isEnrolled(email, productId) {
      calls.push({ op: "isEnrolled", email, productId });
      if (email === "known@example.com") return true;
      if (email === "mystery@example.com") return null;
      return false;
    },
    async findLearnerByEmail(email) {
      calls.push({ op: "find", email });
      return null;
    },
    async createLearner(input) {
      calls.push({ op: "create", email: input.email, mobile: input.mobile });
      return { status: "success" };
    },
    async assignCourse(input) {
      calls.push({ op: "assign", email: input.email, productId: input.productId });
      return { status: "success" };
    },
  };

  const summary = await runRecovery({
    config: testConfig(),
    razorpay,
    graphy,
    courses: catalog,
    now: () => now,
    log: { log() {}, error() {} },
  });

  assert.equal(pages.length, 2);
  assert.equal(pages[0].from, Math.floor(Date.parse("2026-06-01T11:48:00.000Z") / 1000));
  assert.equal(pages[0].to, Math.floor(now.getTime() / 1000));
  assert.equal(pages[0].count, 100);
  assert.equal(pages[0].skip, 0);
  assert.equal(pages[1].skip, 100);

  assert.deepEqual(summary, {
    scanned: 6,
    enrolled: 2,
    alreadyEnrolled: 1,
    skipped: 1,
    failed: 2,
    from: "2026-06-01T11:48:00.000Z",
    to: "2026-06-01T12:00:00.000Z",
  });

  assert.deepEqual(
    calls.filter((call) => call.op === "assign").map((call) => call.email).sort(),
    ["mystery@example.com", "new@example.com"],
  );
  assert.deepEqual(
    calls.filter((call) => call.op === "create").map((call) => call.mobile),
    ["+919876543210", "+919876543210"],
  );
  assert.equal(calls.some((call) => call.op === "assign" && call.email === "known@example.com"), false);
  assert.equal(
    calls.some((call) => String(call.email).endsWith("phone@example.com")),
    false,
  );
});
