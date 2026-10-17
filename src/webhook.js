import { enrollLearner } from "./enroll.js";
import { purchaseReady, resolvePurchase } from "./purchase.js";
import { verifyWebhookSignature } from "./signature.js";

const CAPTURED = "payment.captured";

function parsePayload(rawBody) {
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function createWebhookHandler({ config, courses, razorpay, graphy }) {
  return async function webhook(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!rawBody) {
      return res.status(400).json({ error: "Expected a raw JSON body" });
    }

    const signature = req.get("x-razorpay-signature") || null;
    if (
      !verifyWebhookSignature(rawBody, signature, config.razorpayWebhookSecret)
    ) {
      console.error("[webhook] rejected: signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = parsePayload(rawBody);
    if (!event) {
      console.error("[webhook] rejected: body is not JSON");
      return res.status(400).json({ error: "Invalid JSON" });
    }

    if (event.event !== CAPTURED) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    let purchase;
    try {
      purchase = await resolvePurchase({
        payment: event.payload?.payment?.entity,
        order: event.payload?.order?.entity,
        razorpay,
        courses,
      });
    } catch (err) {
      console.error("[webhook] could not read order notes", {
        event: event.event,
        message: err.message,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    if (!purchaseReady(purchase)) {
      console.error("[webhook] paid event is missing payment id or order notes", {
        event: event.event,
        paymentId: purchase.paymentId || null,
        orderId: purchase.orderId || null,
        courseCode: purchase.courseCode || null,
        graphyCourseCode: purchase.graphyCourseCode || null,
        email: purchase.buyer.email || null,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    try {
      await enrollLearner({
        graphy,
        course: {
          courseCode: purchase.courseCode,
          graphyCourseCode: purchase.graphyCourseCode,
        },
        buyer: purchase.buyer,
      });
      console.log("[webhook] enrolled learner", {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: purchase.courseCode,
        graphyCourseCode: purchase.graphyCourseCode,
        email: purchase.buyer.email,
      });
      return res.status(200).json({ ok: true, enrolled: true });
    } catch (err) {
      console.error("[webhook] enrollment failed", {
        event: event.event,
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: purchase.courseCode,
        graphyCourseCode: purchase.graphyCourseCode,
        email: purchase.buyer.email,
        message: err.message,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }
  };
}
