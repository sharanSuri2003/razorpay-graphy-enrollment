import test from "node:test";
import assert from "node:assert/strict";
import { verifyWebhookSignature } from "../src/signature.js";
import { sign, webhookSecret } from "./helpers.js";

test("accepts an HMAC of the raw body", () => {
  const raw = Buffer.from('{"event":"payment.captured","amount":49900}');
  const signature = sign(raw, webhookSecret);
  assert.equal(verifyWebhookSignature(raw, signature, webhookSecret), true);
});

test("rejects a body that was re-serialized before verification", () => {
  const original = '{ "event" : "order.paid", "payload" : { "ok" : true } }';
  const signature = sign(original, webhookSecret);
  const reserialized = JSON.stringify(JSON.parse(original));
  assert.notEqual(original, reserialized);
  assert.equal(
    verifyWebhookSignature(Buffer.from(original), signature, webhookSecret),
    true,
  );
  assert.equal(
    verifyWebhookSignature(Buffer.from(reserialized), signature, webhookSecret),
    false,
  );
});

test("rejects a missing or wrong signature", () => {
  const raw = Buffer.from("{}");
  assert.equal(verifyWebhookSignature(raw, "", webhookSecret), false);
  assert.equal(verifyWebhookSignature(raw, sign(raw, "other"), webhookSecret), false);
  assert.equal(verifyWebhookSignature(raw, "ab", webhookSecret), false);
});
