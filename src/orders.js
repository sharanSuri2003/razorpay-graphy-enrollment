import { PHONE_RE } from "./purchase.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function createOrderHandler({ courses, razorpay }) {
  return async function createOrder(req, res) {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};

    const courseCode = text(body.courseCode);
    const email = text(body.email).toLowerCase();
    const name = text(body.name);
    const phone = text(body.phone);

    if (!courseCode) {
      return res.status(400).json({ error: "courseCode is required" });
    }
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (!name || name.length > 120) {
      return res.status(400).json({ error: "name is required (max 120 characters)" });
    }
    if (!phone || !PHONE_RE.test(phone)) {
      return res.status(400).json({
        error: "phone is required and must include a country code, for example +919876543210",
      });
    }

    const course = courses.findByCode(courseCode);
    if (!course) {
      return res.status(404).json({ error: `Unknown course: ${courseCode}` });
    }

    const notes = {
      courseCode: course.courseCode,
      graphyCourseCode: course.graphyCourseCode,
      buyerEmail: email,
      buyerName: name,
      buyerPhone: phone,
    };

    try {
      const order = await razorpay.orders.create({
        amount: course.amount,
        currency: course.currency,
        receipt: receiptFor(course.courseCode),
        notes,
      });

      return res.status(201).json({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: razorpay.keyId,
      });
    } catch (err) {
      console.error("[orders] Razorpay order creation failed", {
        courseCode,
        email,
        message: err.message,
      });
      return res.status(502).json({ error: "Could not create payment order" });
    }
  };
}

function receiptFor(courseCode) {
  const stamp = Date.now().toString(36);
  return `${courseCode}-${stamp}`.slice(0, 40);
}
