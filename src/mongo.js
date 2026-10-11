import { MongoClient } from "mongodb";

export const WEBHOOKS = "webhookEvents";
export const ENROLLMENTS = "enrollments";

/**
 * One client for the life of the process. Pool size and timeouts stay at the
 * driver defaults: this is a single long-running server doing short reads and
 * writes, and there is no measured concurrency to size a pool against.
 */
export async function connectMongo({ mongoUri, mongoDb }) {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);
  await ensureIndexes(db);
  return { client, db };
}

export async function ensureIndexes(db) {
  const webhooks = db.collection(WEBHOOKS);
  const enrollments = db.collection(ENROLLMENTS);
  await webhooks.createIndex({ receivedAt: -1 });
  await webhooks.createIndex({ razorpayEventId: 1 });
  await enrollments.createIndex({ paymentId: 1 }, { unique: true });
}
