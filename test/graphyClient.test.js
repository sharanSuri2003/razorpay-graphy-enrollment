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
