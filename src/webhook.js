import { enrollLearner } from "./enroll.js";
import { verifyWebhookSignature } from "./signature.js";

const SUCCESS_EVENTS = new Set(["payment.captured", "order.paid"]);

function notesOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePayload(rawBody) {
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { payload: null, event: null };
    }
    return { payload, event: typeof payload.event === "string" ? payload.event : null };
  } catch {
    return { payload: null, event: null };
  }
}

async function loadPurchase({ event, razorpay, courses }) {
  const payment = event?.payload?.payment?.entity ?? null;
  const orderEntity = event?.payload?.order?.entity ?? null;
  let notes = {
    ...notesOf(payment?.notes),
    ...notesOf(orderEntity?.notes),
  };
  const orderId = text(orderEntity?.id) || text(payment?.order_id);

  const notesIncomplete =
    !text(notes.courseCode) ||
    !text(notes.graphyCourseCode) ||
    !text(notes.buyerEmail) ||
    !text(notes.buyerName);
  if (notesIncomplete && orderId) {
    const fetched = await razorpay.orders.fetch(orderId);
    notes = { ...notes, ...notesOf(fetched?.notes) };
  }

  const courseCode = text(notes.courseCode);
  const fromCatalog = courses.findByCode(courseCode);

  return {
    paymentId: text(payment?.id),
    orderId,
    courseCode,
    // Prefer the product id captured when the order was created.
    graphyCourseCode:
      text(notes.graphyCourseCode) || fromCatalog?.graphyCourseCode || "",
    buyer: {
      email: text(notes.buyerEmail).toLowerCase(),
      name: text(notes.buyerName),
      phone: text(notes.buyerPhone),
    },
  };
}

export function createWebhookHandler({
  config,
  courses,
  razorpay,
  graphy,
  enrollments,
  webhookLog,
}) {
  return async function webhook(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!rawBody) {
      return res.status(400).json({ error: "Expected a raw JSON body" });
    }

    const signature = req.get("x-razorpay-signature") || null;
    const razorpayEventId = req.get("x-razorpay-event-id") || null;
    const signatureValid = verifyWebhookSignature(
      rawBody,
      signature,
      config.razorpayWebhookSecret,
    );
    const parsed = parsePayload(rawBody);

    let webhookId = null;
    try {
      webhookId = await webhookLog.record({
        rawBody: rawBody.toString("utf8"),
        payload: parsed.payload,
        event: parsed.event,
        razorpayEventId,
        signature,
        signatureValid,
      });
    } catch (err) {
      console.error("[webhook] failed to store payload", { message: err.message });
    }

    const finish = async (fields) => {
      try {
        await webhookLog.complete(webhookId, fields);
      } catch (err) {
        console.error("[webhook] failed to update stored payload", {
          message: err.message,
          outcome: fields.outcome,
        });
      }
    };

    if (!signatureValid) {
      console.error("[webhook] rejected: signature mismatch", { razorpayEventId });
      await finish({
        status: "rejected",
        outcome: "invalid_signature",
        error: "Invalid signature",
      });
      return res.status(400).json({ error: "Invalid signature" });
    }

    if (!parsed.payload) {
      console.error("[webhook] rejected: body is not JSON", { razorpayEventId });
      await finish({
        status: "rejected",
        outcome: "invalid_json",
        error: "Invalid JSON",
      });
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const event = parsed.payload;
    if (!SUCCESS_EVENTS.has(event.event)) {
      await finish({ status: "ignored", outcome: "ignored" });
      return res.status(200).json({ ok: true, ignored: true });
    }

    let purchase;
    try {
      purchase = await loadPurchase({ event, razorpay, courses });
    } catch (err) {
      console.error("[webhook] could not read order notes", {
        event: event.event,
        razorpayEventId,
        message: err.message,
      });
      await finish({
        status: "failed",
        outcome: "notes_unavailable",
        error: err.message,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    const ids = {
      paymentId: purchase.paymentId || null,
      orderId: purchase.orderId || null,
    };

    if (
      !purchase.paymentId ||
      !purchase.courseCode ||
      !purchase.graphyCourseCode ||
      !purchase.buyer.email ||
      !purchase.buyer.name
    ) {
      console.error("[webhook] paid event is missing payment id or order notes", {
        event: event.event,
        razorpayEventId,
        ...ids,
        courseCode: purchase.courseCode || null,
        graphyCourseCode: purchase.graphyCourseCode || null,
        email: purchase.buyer.email || null,
      });
      await finish({
        status: "failed",
        outcome: "missing_notes",
        error: "Paid event is missing payment id or buyer notes",
        ...ids,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    const course = {
      courseCode: purchase.courseCode,
      graphyCourseCode: purchase.graphyCourseCode,
    };

    let claim;
    try {
      claim = await enrollments.claim({
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: course.courseCode,
        graphyCourseCode: course.graphyCourseCode,
        email: purchase.buyer.email,
        name: purchase.buyer.name,
        phone: purchase.buyer.phone,
      });
    } catch (err) {
      console.error("[webhook] could not claim enrollment", {
        event: event.event,
        razorpayEventId,
        ...ids,
        message: err.message,
      });
      await finish({
        status: "failed",
        outcome: "claim_failed",
        error: err.message,
        ...ids,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    if (claim.outcome === "duplicate") {
      console.log("[webhook] payment already enrolled; skipping", {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
      });
      await finish({ status: "duplicate", outcome: "duplicate", ...ids });
      return res.status(200).json({ ok: true, duplicate: true });
    }

    if (claim.outcome === "in_progress") {
      console.error("[webhook] enrollment already in progress", {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
      });
      await finish({
        status: "failed",
        outcome: "in_progress",
        error: "Enrollment already in progress",
        ...ids,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    try {
      const result = await enrollLearner({
        graphy,
        course,
        buyer: purchase.buyer,
      });
      await enrollments.markSuccess(purchase.paymentId, result.graphyResponse);
      console.log("[webhook] enrolled learner", {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: course.courseCode,
        graphyCourseCode: course.graphyCourseCode,
        email: purchase.buyer.email,
        attempts: claim.attempts,
      });
      await finish({ status: "enrolled", outcome: "enrolled", ...ids });
      return res.status(200).json({ ok: true, enrolled: true });
    } catch (err) {
      console.error("[webhook] enrollment failed", {
        event: event.event,
        razorpayEventId,
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: course.courseCode,
        graphyCourseCode: course.graphyCourseCode,
        email: purchase.buyer.email,
        attempts: claim.attempts,
        message: err.message,
      });
      try {
        await enrollments.markFailed(
          purchase.paymentId,
          err.message,
          err.graphyResponse ?? null,
        );
      } catch (markErr) {
        console.error("[webhook] could not record enrollment failure", {
          paymentId: purchase.paymentId,
          message: markErr.message,
        });
      }
      await finish({
        status: "failed",
        outcome: "enrollment_failed",
        error: err.message,
        ...ids,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }
  };
}
