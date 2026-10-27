export const PHONE_RE = /^\+[1-9]\d{7,14}$/;

function notesOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Course and buyer come from Razorpay order notes. Payment notes are often
 * empty, so the order is fetched when the notes we already have are incomplete.
 */
export async function resolvePurchase({ payment, order, razorpay, courses }) {
  let notes = {
    ...notesOf(payment?.notes),
    ...notesOf(order?.notes),
  };
  const orderId = text(order?.id) || text(payment?.order_id);

  const incomplete =
    !text(notes.courseCode) ||
    !text(notes.graphyCourseCode) ||
    !text(notes.buyerEmail) ||
    !text(notes.buyerName) ||
    !PHONE_RE.test(text(notes.buyerPhone));
  if (incomplete && orderId && razorpay?.orders?.fetch) {
    const fetched = await razorpay.orders.fetch(orderId);
    notes = { ...notes, ...notesOf(fetched?.notes) };
  }

  const courseCode = text(notes.courseCode);
  const fromCatalog = courses.findByCode(courseCode);

  return {
    paymentId: text(payment?.id),
    orderId,
    courseCode,
    graphyCourseCode:
      text(notes.graphyCourseCode) || fromCatalog?.graphyCourseCode || "",
    buyer: {
      email: text(notes.buyerEmail).toLowerCase(),
      name: text(notes.buyerName),
      phone: text(notes.buyerPhone),
    },
  };
}

export function purchaseReady(purchase) {
  return Boolean(
    purchase?.paymentId &&
      purchase.courseCode &&
      purchase.graphyCourseCode &&
      purchase.buyer?.name,
  );
}

/** Null when buyerPhone can be sent to Graphy. A retry cannot fill this in. */
export function buyerPhoneError(purchase) {
  const phone = purchase?.buyer?.phone ?? "";
  if (!phone) return "buyerPhone is missing from the order notes";
  if (!PHONE_RE.test(phone)) {
    return "buyerPhone in the order notes must include a country code, for example +919876543210";
  }
  return null;
}
