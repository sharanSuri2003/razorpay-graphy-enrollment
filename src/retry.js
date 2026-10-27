const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Delay before the next try after `failedAttempt` (1 for the first failure). */
export function retryDelayMs(failedAttempt, baseDelayMs) {
  return baseDelayMs * 2 ** (failedAttempt - 1);
}

/**
 * Retry network failures, timeouts, HTTP 429, and HTTP 5xx.
 * A Graphy HTTP 200 with an error object, or status other than "success", is not retried.
 */
export function isRetryableGraphyError(err) {
  const status = err?.statusCode;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  if (typeof status === "number") return false;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return true;
  const code = err?.code || err?.cause?.code;
  if (TRANSIENT_CODES.has(code)) return true;
  if (err instanceof TypeError) return true;
  return true;
}

export async function withRetry(fn, { attempts, baseDelayMs, sleep, label, prefix = "graphy" }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retryable = isRetryableGraphyError(err);
      console.error(`[${prefix}] ${label} failed`, {
        attempt,
        attempts,
        retryable,
        statusCode: err.statusCode ?? null,
        message: err.message,
      });
      if (!retryable || attempt === attempts) throw err;
      await sleep(retryDelayMs(attempt, baseDelayMs));
    }
  }
  throw lastError;
}
