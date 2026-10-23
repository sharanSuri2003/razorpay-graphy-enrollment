import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { parseCorsOrigins } from "../src/config.js";
import { listen, testConfig } from "./helpers.js";

test("parseCorsOrigins trims a comma-separated list and keeps a single value", () => {
  assert.deepEqual(parseCorsOrigins(""), []);
  assert.deepEqual(parseCorsOrigins("   "), []);
  assert.deepEqual(parseCorsOrigins("https://kropiq.in"), ["https://kropiq.in"]);
  assert.deepEqual(
    parseCorsOrigins(" https://kropiq.in, https://www.kropiq.in "),
    ["https://kropiq.in", "https://www.kropiq.in"],
  );
  assert.deepEqual(
    parseCorsOrigins("https://kropiq.in, ,https://kropiq.in"),
    ["https://kropiq.in"],
  );
});

async function withApp(corsOrigins, fn) {
  const app = createApp({
    config: testConfig({ corsOrigins }),
    courses: { findByCode() { return null; } },
    razorpay: {},
    graphy: {},
  });
  const server = await listen(app);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test("echoes only an Origin that exactly matches the configured list", async () => {
  await withApp(
    ["https://kropiq.in", "https://www.kropiq.in"],
    async (server) => {
      const allowed = await fetch(`${server.url}/health`, {
        headers: { Origin: "https://www.kropiq.in" },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), "https://www.kropiq.in");
      assert.equal(allowed.headers.get("vary"), "Origin");
      assert.match(allowed.headers.get("access-control-allow-methods"), /POST/);

      const preflight = await fetch(`${server.url}/api/orders`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://kropiq.in",
          "Access-Control-Request-Method": "POST",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "https://kropiq.in");
      assert.equal(preflight.headers.get("vary"), "Origin");

      const rejected = await fetch(`${server.url}/health`, {
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.headers.get("access-control-allow-origin"), null);
      assert.equal(rejected.headers.get("access-control-allow-headers"), null);
      assert.equal(rejected.headers.get("access-control-allow-methods"), null);
      assert.equal(rejected.headers.get("vary"), "Origin");

      const missing = await fetch(`${server.url}/health`);
      assert.equal(missing.headers.get("access-control-allow-origin"), null);
    },
  );

  await withApp(["https://kropiq.in"], async (server) => {
    const response = await fetch(`${server.url}/health`, {
      headers: { Origin: "https://kropiq.in" },
    });
    assert.equal(response.headers.get("access-control-allow-origin"), "https://kropiq.in");
    assert.equal(response.headers.get("vary"), "Origin");
  });
});
