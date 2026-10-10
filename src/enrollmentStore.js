import fs from "node:fs";
import path from "node:path";

/**
 * Remembers payment ids that have already been enrolled.
 * A second delivery of the same payment (Razorpay retry, or both
 * payment.captured and order.paid) does not call Graphy again.
 */
export function createEnrollmentStore(filePath) {
  const processed = new Map();
  const inflight = new Map();

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Enrollment store ${filePath} must be a JSON object`);
    }
    for (const [id, record] of Object.entries(data)) {
      processed.set(id, record);
    }
  }

  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(processed), null, 2));
    fs.renameSync(tmp, filePath);
  }

  load();

  return {
    has(paymentId) {
      return processed.has(paymentId);
    },

    /**
     * Run fn once per payment id. Concurrent callers share one in-flight attempt.
     * The id is recorded only after fn resolves.
     */
    async once(paymentId, fn) {
      if (processed.has(paymentId)) {
        return { status: "duplicate" };
      }
      const existing = inflight.get(paymentId);
      if (existing) {
        await existing;
        return { status: "duplicate" };
      }

      const run = (async () => {
        const result = await fn();
        processed.set(paymentId, {
          paymentId,
          enrolledAt: new Date().toISOString(),
          ...result,
        });
        persist();
        return result;
      })();

      inflight.set(paymentId, run);
      try {
        await run;
        return { status: "enrolled" };
      } finally {
        inflight.delete(paymentId);
      }
    },
  };
}
