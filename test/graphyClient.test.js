import test from "node:test";
import assert from "node:assert/strict";
import { createGraphyClient } from "../src/graphyClient.js";

function mockFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body == null ? "" : String(options.body);
    requests.push({
      url: String(url),
      method: options.method,
      headers: options.headers,
      body,
    });
    return handler(requests.at(-1));
  };
  return { requests, fetchImpl };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test("finds, creates, and assigns with the documented Graphy contract", async () => {
  const { requests, fetchImpl } = mockFetch(async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/public/v1/learners") {
      assert.equal(url.searchParams.get("mid"), "mid_test");
      assert.equal(url.searchParams.get("key"), "token_test");
      assert.deepEqual(JSON.parse(url.searchParams.get("query")), {
        email: "learner@example.com",
      });
      return jsonResponse(200, { data: [], total: 0, limit: 10, skip: 0 });
    }
    if (request.method === "POST" && url.pathname === "/public/v1/learners") {
      return jsonResponse(200, { status: "success" });
    }
    if (request.method === "POST" && url.pathname === "/public/v1/assign") {
      return jsonResponse(200, { status: "success" });
    }
    throw new Error(`unexpected ${request.method} ${url.pathname}`);
  });

  const graphy = createGraphyClient({
    graphyMerchantId: "mid_test",
    graphyApiToken: "token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    fetchImpl,
  });

  assert.equal(await graphy.findLearnerByEmail("learner@example.com"), null);

  await graphy.createLearner({
    email: "learner@example.com",
    name: "Asha Rao",
    mobile: "+919876543210",
  });
  const created = new URLSearchParams(requests[1].body);
  assert.equal(created.get("mid"), "mid_test");
  assert.equal(created.get("key"), "token_test");
  assert.equal(created.get("email"), "learner@example.com");
  assert.equal(created.get("name"), "Asha Rao");
  assert.equal(created.get("mobile"), "+919876543210");
  assert.equal(created.get("sendEmail"), "true");
  assert.equal(
    requests[1].headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );

  await graphy.assignCourse({
    email: "learner@example.com",
    productId: "58415074e4b0a28c13059e96",
  });
  const assigned = new URLSearchParams(requests[2].body);
  assert.equal(requests[2].url, "https://api.ongraphy.com/public/v1/assign");
  assert.equal(assigned.get("email"), "learner@example.com");
  assert.equal(assigned.get("productId"), "58415074e4b0a28c13059e96");
  assert.equal(assigned.get("mid"), "mid_test");
});

test("treats an HTTP 200 error object as a failure and does not retry it", async () => {
  let calls = 0;
  const { fetchImpl } = mockFetch(async () => {
    calls += 1;
    return jsonResponse(200, {
      error: { code: 22, message: "Account exists for email : learner@example.com" },
    });
  });
  const graphy = createGraphyClient({
    graphyMerchantId: "mid_test",
    graphyApiToken: "token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    retryAttempts: 3,
    retryBaseDelayMs: 10,
    sleep: async () => {
      throw new Error("should not sleep");
    },
    fetchImpl,
  });

  await assert.rejects(
    () =>
      graphy.createLearner({
        email: "learner@example.com",
        name: "Asha Rao",
        mobile: "+919876543210",
      }),
    (err) => {
      assert.equal(err.statusCode, 200);
      assert.equal(err.graphyCode, 22);
      assert.match(err.message, /Account exists for email/);
      assert.match(err.message, /code 22/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("reads error code 25 from an HTTP 200 body", async () => {
  const { fetchImpl } = mockFetch(async () =>
    jsonResponse(200, {
      error: {
        code: 25,
        message: "This mobile number is already registered. Please use a different number.",
      },
    }),
  );
  const graphy = createGraphyClient({
    graphyMerchantId: "mid_test",
    graphyApiToken: "token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    retryAttempts: 1,
    fetchImpl,
  });

  await assert.rejects(
    () =>
      graphy.createLearner({
        email: "learner@example.com",
        name: "Asha Rao",
        mobile: "+919876543210",
      }),
    (err) => {
      assert.equal(err.graphyCode, 25);
      assert.equal(err.statusCode, 200);
      assert.match(err.message, /already registered/);
      return true;
    },
  );
});

test("finds a learner by mobile", async () => {
  const { requests, fetchImpl } = mockFetch(async () =>
    jsonResponse(200, {
      data: [{ id: "learner_9", email: "other@example.com", mobile: "+919876543210" }],
      total: 1,
    }),
  );
  const graphy = createGraphyClient({
    graphyMerchantId: "mid_test",
    graphyApiToken: "token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    fetchImpl,
  });

  const learner = await graphy.findLearnerByMobile("+919876543210");
  assert.equal(learner.email, "other@example.com");
  assert.deepEqual(JSON.parse(new URL(requests[0].url).searchParams.get("query")), {
    mobile: "+919876543210",
  });
});

test("treats a non-success Graphy status as a failure and redacts the token", async () => {
  const { fetchImpl } = mockFetch(async () =>
    jsonResponse(200, { status: "failure", message: "bad key token_test" }),
  );
  const graphy = createGraphyClient({
    graphyMerchantId: "mid_test",
    graphyApiToken: "token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    fetchImpl,
  });

  await assert.rejects(
    () =>
      graphy.assignCourse({
        email: "learner@example.com",
        productId: "prod",
      }),
    (err) => {
      assert.match(err.message, /assign course failed/);
      assert.equal(err.message.includes("token_test"), false);
      assert.match(err.message, /\[redacted\]/);
      return true;
    },
  );
});
