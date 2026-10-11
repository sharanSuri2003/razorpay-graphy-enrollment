import test from "node:test";
import assert from "node:assert/strict";
import { createEnrollmentRepo } from "../src/enrollments.js";
import { ENROLLMENTS } from "../src/mongo.js";
import { closeMongoAfterTests, createTestDb } from "./mongo.js";

closeMongoAfterTests();

const details = {
  paymentId: "pay_unique",
  orderId: "order_unique",
  courseCode: "EXAMPLE-INTRO",
  graphyCourseCode: "prod_intro_1",
  email: "learner@example.com",
  name: "Asha Rao",
  phone: "+919876543210",
};

async function repo() {
  const db = await createTestDb();
  return { db, enrollments: createEnrollmentRepo(db.collection(ENROLLMENTS)) };
}

test("unique payment id admits one claim and records success once", async () => {
  const { db, enrollments } = await repo();
  const [first, second] = await Promise.all([
    enrollments.claim(details),
    enrollments.claim(details),
  ]);
  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ["claimed", "in_progress"]);

  await enrollments.markSuccess("pay_unique", { assign: { status: "success" } });
  const again = await enrollments.claim(details);
  assert.equal(again.outcome, "duplicate");

  const stored = await db.collection(ENROLLMENTS).findOne({ paymentId: "pay_unique" });
  assert.equal(stored.status, "success");
  assert.equal(stored.attempts, 1);
  assert.equal(stored.email, "learner@example.com");
  assert.equal(stored.graphyCourseCode, "prod_intro_1");
  assert.deepEqual(stored.graphyResponse, { assign: { status: "success" } });
  assert.ok(stored.enrolledAt instanceof Date);
});

test("a failed attempt can be claimed again and a stale processing row can be reclaimed", async () => {
  const { db, enrollments } = await repo();
  const collection = db.collection(ENROLLMENTS);

  assert.equal((await enrollments.claim(details)).outcome, "claimed");
  await enrollments.markFailed("pay_unique", "Graphy down", { assign: null });

  const retry = await enrollments.claim(details);
  assert.equal(retry.outcome, "claimed");
  assert.equal(retry.attempts, 2);

  await collection.updateOne(
    { paymentId: "pay_unique" },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } },
  );
  const reclaimed = await enrollments.claim(details);
  assert.equal(reclaimed.outcome, "claimed");
  assert.equal(reclaimed.attempts, 3);

  const stored = await collection.findOne({ paymentId: "pay_unique" });
  assert.equal(stored.status, "processing");
  assert.equal(stored.phone, "+919876543210");
});
