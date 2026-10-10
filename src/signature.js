import crypto from "node:crypto";

/**
 * Razorpay signs the raw request bytes with HMAC-SHA256 and the webhook secret.
 * The digest is hex in the X-Razorpay-Signature header.
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const actual = Buffer.from(String(signature));
  const digest = Buffer.from(expected);
  if (actual.length !== digest.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, digest);
}
