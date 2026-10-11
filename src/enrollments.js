/** Reclaim a processing row left behind by a crashed attempt. */
const STALE_PROCESSING_MS = 2 * 60 * 1000;

function learnerFields(details) {
  return {
    orderId: details.orderId || null,
    courseCode: details.courseCode,
    graphyCourseCode: details.graphyCourseCode,
    email: details.email,
    name: details.name,
    phone: details.phone || null,
  };
}

/**
 * Idempotency is the unique index on paymentId.
 * The first delivery inserts status "processing". A later delivery sees
 * "success" and does not call Graphy. A "failed" row can be claimed again.
 */
export function createEnrollmentRepo(collection) {
  return {
    async claim(details) {
      const now = new Date();
      const fields = learnerFields(details);
      try {
        await collection.insertOne({
          paymentId: details.paymentId,
          ...fields,
          status: "processing",
          graphyResponse: null,
          error: null,
          attempts: 1,
          createdAt: now,
          updatedAt: now,
          enrolledAt: null,
        });
        return { outcome: "claimed", attempts: 1 };
      } catch (err) {
        if (err.code !== 11000) throw err;
      }

      const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
      const taken = await collection.findOneAndUpdate(
        {
          paymentId: details.paymentId,
          $or: [
            { status: "failed" },
            { status: "processing", updatedAt: { $lt: staleBefore } },
          ],
        },
        {
          $set: {
            ...fields,
            status: "processing",
            error: null,
            updatedAt: now,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: "after" },
      );
      if (taken) {
        return { outcome: "claimed", attempts: taken.attempts };
      }

      const current = await collection.findOne(
        { paymentId: details.paymentId },
        { projection: { status: 1 } },
      );
      if (current?.status === "success") {
        return { outcome: "duplicate" };
      }
      return { outcome: "in_progress" };
    },

    async markSuccess(paymentId, graphyResponse) {
      const now = new Date();
      const result = await collection.updateOne(
        { paymentId, status: "processing" },
        {
          $set: {
            status: "success",
            graphyResponse: graphyResponse ?? null,
            error: null,
            enrolledAt: now,
            updatedAt: now,
          },
        },
      );
      if (result.matchedCount !== 1) {
        throw new Error(`Could not record success for payment ${paymentId}`);
      }
    },

    async markFailed(paymentId, error, graphyResponse) {
      await collection.updateOne(
        { paymentId, status: "processing" },
        {
          $set: {
            status: "failed",
            error: String(error).slice(0, 2000),
            graphyResponse: graphyResponse ?? null,
            updatedAt: new Date(),
          },
        },
      );
    },
  };
}
