import test from "node:test";
import assert from "node:assert/strict";
import { createGraphyClient } from "../src/graphyClient.js";
import { isRetryableGraphyError, retryDelayMs, withRetry } from "../src/retry.js";

test("backoff doubles after each failure", () => {
  assert.equal(retryDelayMs(1, 500), 500);
  assert.equal(retryDelayMs(2, 500), 1000);
  assert.equal(retryDelayMs(3, 500), 2000);
});

test("retries transport errors and 5xx, not a Graphy application failure", () => {
  assert.equal(isRetryableGraphyError({ statusCode: 503 }), true);
  assert.equal(isRetryableGraphyError({ statusCode: 429 }), true);
  assert.equal(isRetryableGraphyError({ name: "TimeoutError" }), true);
  assert.equal(isRetryableGraphyError(new TypeError("network down")), true);
  assert.equal(isRetryableGraphyError({ statusCode: 400 }), false);
  assert.equal(isRetryableGraphyError({ statusCode: 200 }), false);
});

test("withRetry waits between attempts and then throws", async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          const error = new Error("unavailable");
          error.statusCode = 503;
          throw error;
        },
        {
          attempts: 3,
          baseDelayMs: 100,
          sleep: async (ms) => delays.push(ms),
          label: "assign course",
        },
      ),
    /unavailable/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("Graphy client retries a 503 and then accepts success", async () => {
  const delays = [];
  let assignCalls = 0;
  const graphy = createGraphyClient({
    graphyMerchantId: "mid_test",
    graphyApiToken: "token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    retryAttempts: 3,
    retryBaseDelayMs: 50,
    requestTimeoutMs: 1000,
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/public/v1/assign") {
        assignCalls += 1;
        if (assignCalls < 3) {
          return {
            ok: false,
            status: 503,
            statusText: "unavailable",
            async text() {
              return "busy";
            },
          };
        }
      }
      assert.equal(options.signal.aborted, false);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify(
            path.endsWith("/learners") && options.method === "GET"
              ? { data: [], total: 0 }
              : { status: "success" },
          );
        },
      };
    },
  });

  await graphy.assignCourse({
    email: "learner@example.com",
    productId: "prod_1",
  });
  assert.equal(assignCalls, 3);
  assert.deepEqual(delays, [50, 100]);
});

test("Graphy client does not retry a 400", async () => {
  let calls = 0;
  const graphy = createGraphyClient({
    graphyMerchantId: "mid_test",
    graphyApiToken: "token_test",
    graphyApiBaseUrl: "https://api.ongraphy.com",
    retryAttempts: 3,
    retryBaseDelayMs: 10,
    sleep: async () => {
      throw new Error("should not sleep");
    },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        statusText: "bad",
        async text() {
          return JSON.stringify({ status: "failure", message: "bad product token_test" });
        },
      };
    },
  });

  await assert.rejects(
    () => graphy.assignCourse({ email: "learner@example.com", productId: "nope" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message.includes("token_test"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});
