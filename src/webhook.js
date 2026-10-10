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
  store,
}) {
  return async function webhook(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!rawBody) {
      return res.status(400).json({ error: "Expected a raw JSON body" });
    }

    const signature = req.get("x-razorpay-signature");
    if (
      !verifyWebhookSignature(rawBody, signature, config.razorpayWebhookSecret)
    ) {
      console.error("[webhook] rejected: signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      console.error("[webhook] rejected: body is not JSON");
      return res.status(400).json({ error: "Invalid JSON" });
    }

    if (!SUCCESS_EVENTS.has(event?.event)) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    let purchase;
    try {
      purchase = await loadPurchase({ event, razorpay, courses });
    } catch (err) {
      console.error("[webhook] could not read order notes", {
        event: event.event,
        message: err.message,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    if (
      !purchase.paymentId ||
      !purchase.courseCode ||
      !purchase.graphyCourseCode ||
      !purchase.buyer.email
    ) {
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

    if (!purchase.buyer.name) {
      console.error("[webhook] order notes are missing buyerName", {
        event: event.event,
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }

    const course = {
      courseCode: purchase.courseCode,
      graphyCourseCode: purchase.graphyCourseCode,
    };

    try {
      const outcome = await store.once(purchase.paymentId, () =>
        enrollLearner({
          graphy,
          course,
          buyer: purchase.buyer,
        }),
      );

      if (outcome.status === "duplicate") {
        console.log("[webhook] payment already enrolled; skipping", {
          paymentId: purchase.paymentId,
          orderId: purchase.orderId,
        });
        return res.status(200).json({ ok: true, duplicate: true });
      }

      console.log("[webhook] enrolled learner", {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: course.courseCode,
        graphyCourseCode: course.graphyCourseCode,
        email: purchase.buyer.email,
      });
      return res.status(200).json({ ok: true, enrolled: true });
    } catch (err) {
      console.error("[webhook] enrollment failed", {
        event: event.event,
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: course.courseCode,
        graphyCourseCode: course.graphyCourseCode,
        email: purchase.buyer.email,
        message: err.message,
      });
      return res.status(500).json({ error: "Enrollment failed" });
    }
  };
}
