/**
 * Graphy public API, from the published collection
 * https://documenter.getpostman.com/view/10740263/Szt8eA1V
 *
 * Auth is the merchant id (`mid`) and API token (`key`) on each call.
 * Create learner: POST /public/v1/learners (form body).
 * Find learner:  GET  /public/v1/learners?query={"email":"..."}
 * Enroll:        POST /public/v1/assign (form body: email + productId).
 *
 * The collection's Assign request URL is malformed (`{/public/v1/assign`).
 * The path and the sibling Unassign call (POST /public/v1/unassign) put it at
 * {base}/public/v1/assign.
 */

function redact(message, secret) {
  if (!secret) return String(message);
  return String(message).split(secret).join("[redacted]");
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return { json: null, text: "" };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

export function createGraphyClient({
  graphyMerchantId,
  graphyApiToken,
  graphyApiBaseUrl,
  fetchImpl = fetch,
}) {
  const baseUrl = graphyApiBaseUrl.replace(/\/$/, "");

  function fail(action, response, parsed) {
    const detail =
      parsed.json?.message ||
      parsed.json?.error ||
      parsed.json?.response ||
      parsed.text ||
      response.statusText;
    const error = new Error(
      redact(
        `Graphy ${action} failed (${response.status}): ${String(detail).slice(0, 500)}`,
        graphyApiToken,
      ),
    );
    error.statusCode = response.status;
    throw error;
  }

  function assertSuccess(action, response, parsed) {
    if (!response.ok) {
      fail(action, response, parsed);
    }
    const status = parsed.json?.status;
    if (typeof status === "string" && status.toLowerCase() !== "success") {
      fail(action, response, parsed);
    }
  }

  async function findLearnerByEmail(email) {
    const url = new URL(`${baseUrl}/public/v1/learners`);
    url.searchParams.set("mid", graphyMerchantId);
    url.searchParams.set("key", graphyApiToken);
    url.searchParams.set("limit", "10");
    url.searchParams.set("query", JSON.stringify({ email }));

    const response = await fetchImpl(url, { method: "GET" });
    const parsed = await readBody(response);
    if (!response.ok) {
      fail("find learner", response, parsed);
    }
    const list = Array.isArray(parsed.json?.data) ? parsed.json.data : [];
    return (
      list.find(
        (learner) =>
          String(learner?.email ?? "").toLowerCase() === email.toLowerCase(),
      ) ?? null
    );
  }

  async function createLearner({ email, name, mobile }) {
    const body = new URLSearchParams();
    body.set("mid", graphyMerchantId);
    body.set("key", graphyApiToken);
    body.set("email", email);
    body.set("name", name);
    if (mobile) body.set("mobile", mobile);
    // Documented default is true: email the learner their login details.
    body.set("sendEmail", "true");

    const response = await fetchImpl(`${baseUrl}/public/v1/learners`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const parsed = await readBody(response);
    assertSuccess("create learner", response, parsed);
    return parsed.json;
  }

  async function assignCourse({ email, productId }) {
    const body = new URLSearchParams();
    body.set("mid", graphyMerchantId);
    body.set("key", graphyApiToken);
    body.set("email", email);
    body.set("productId", productId);

    const response = await fetchImpl(`${baseUrl}/public/v1/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const parsed = await readBody(response);
    assertSuccess("assign course", response, parsed);
    return parsed.json;
  }

  return { findLearnerByEmail, createLearner, assignCourse };
}
