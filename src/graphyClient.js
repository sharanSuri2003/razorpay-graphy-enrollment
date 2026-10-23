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

import { enrollmentFromLearner } from "./enrollmentCheck.js";
import { withRetry } from "./retry.js";

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
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryAttempts = 3,
  retryBaseDelayMs = 500,
  requestTimeoutMs = 10_000,
}) {
  const baseUrl = graphyApiBaseUrl.replace(/\/$/, "");

  function fail(action, response, parsed) {
    const bodyError = parsed.json?.error;
    const graphyCode =
      bodyError && typeof bodyError === "object" ? bodyError.code : undefined;
    const detail =
      (bodyError && typeof bodyError === "object" ? bodyError.message : null) ||
      parsed.json?.message ||
      (typeof bodyError === "string" ? bodyError : null) ||
      parsed.json?.response ||
      parsed.text ||
      response.statusText;
    const codeLabel = graphyCode == null ? "" : `, code ${graphyCode}`;
    const error = new Error(
      redact(
        `Graphy ${action} failed (${response.status}${codeLabel}): ${String(detail).slice(0, 500)}`,
        graphyApiToken,
      ),
    );
    error.statusCode = response.status;
    if (graphyCode != null) error.graphyCode = graphyCode;
    throw error;
  }

  function assertSuccess(action, response, parsed) {
    if (!response.ok) fail(action, response, parsed);
    if (parsed.json?.error && typeof parsed.json.error === "object") {
      fail(action, response, parsed);
    }
    const status = parsed.json?.status;
    if (typeof status !== "string" || status.toLowerCase() !== "success") {
      fail(action, response, parsed);
    }
  }

  async function send(action, url, options) {
    return withRetry(
      async () => {
        let response;
        try {
          response = await fetchImpl(url, {
            ...options,
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
        } catch (err) {
          const wrapped = new Error(redact(err.message, graphyApiToken));
          wrapped.name = err.name;
          wrapped.code = err.code || err.cause?.code;
          wrapped.cause = err;
          throw wrapped;
        }
        const parsed = await readBody(response);
        if (response.status === 429 || response.status >= 500) {
          fail(action, response, parsed);
        }
        // Business errors are HTTP 200 with an `error` object. Do not retry them.
        if (
          response.ok &&
          parsed.json?.error &&
          typeof parsed.json.error === "object"
        ) {
          fail(action, response, parsed);
        }
        return { response, parsed };
      },
      {
        attempts: retryAttempts,
        baseDelayMs: retryBaseDelayMs,
        sleep,
        label: action,
      },
    );
  }

  async function findLearners(query, { courseInfo = false } = {}) {
    const url = new URL(`${baseUrl}/public/v1/learners`);
    url.searchParams.set("mid", graphyMerchantId);
    url.searchParams.set("key", graphyApiToken);
    url.searchParams.set("limit", "10");
    url.searchParams.set("query", JSON.stringify(query));
    if (courseInfo) url.searchParams.set("courseInfo", "true");

    const { response, parsed } = await send("find learner", url, { method: "GET" });
    if (!response.ok) fail("find learner", response, parsed);
    return Array.isArray(parsed.json?.data) ? parsed.json.data : [];
  }

  async function findLearnerByEmail(email, options) {
    const list = await findLearners({ email }, options);
    return (
      list.find(
        (learner) =>
          String(learner?.email ?? "").toLowerCase() === String(email).toLowerCase(),
      ) ?? null
    );
  }

  async function findLearnerByMobile(mobile, options) {
    const list = await findLearners({ mobile }, options);
    const exact = list.find((learner) => String(learner?.mobile ?? "") === mobile);
    if (exact) return exact;
    if (list.length === 1 && (list[0].mobile == null || list[0].mobile === "")) {
      return list[0];
    }
    return null;
  }

  async function createLearner({ email, name, mobile }) {
    if (typeof mobile !== "string" || mobile.trim() === "") {
      throw new Error("mobile is required");
    }
    const body = new URLSearchParams();
    body.set("mid", graphyMerchantId);
    body.set("key", graphyApiToken);
    body.set("email", email);
    body.set("name", name);
    body.set("mobile", mobile.trim());
    body.set("sendEmail", "true");

    const { response, parsed } = await send("create learner", `${baseUrl}/public/v1/learners`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    assertSuccess("create learner", response, parsed);
    return parsed.json;
  }

  async function assignCourse({ email, productId }) {
    const body = new URLSearchParams();
    body.set("mid", graphyMerchantId);
    body.set("key", graphyApiToken);
    body.set("email", email);
    body.set("productId", productId);

    const { response, parsed } = await send("assign course", `${baseUrl}/public/v1/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    assertSuccess("assign course", response, parsed);
    return parsed.json;
  }

  /**
   * true when the resolved learner's `courses` includes this product id.
   * false when nobody matches, or `courses` is present and does not include it.
   * null when the learner exists but `courses` itself is absent.
   * Email is checked first. Mobile is the account create would hit on error 25.
   */
  async function isEnrolled({ email, mobile, productId }) {
    const byEmail = await findLearnerByEmail(email, { courseInfo: true });
    if (byEmail) return enrollmentFromLearner(byEmail, productId);
    if (mobile) {
      const byMobile = await findLearnerByMobile(mobile, { courseInfo: true });
      if (byMobile) return enrollmentFromLearner(byMobile, productId);
    }
    return false;
  }

  return {
    findLearnerByEmail,
    findLearnerByMobile,
    createLearner,
    assignCourse,
    isEnrolled,
  };
}
