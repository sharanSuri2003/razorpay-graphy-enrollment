import { notifyPurchase } from "./aisensy.js";
import { enrollLearner } from "./enroll.js";
import { buyerPhoneError, purchaseReady, resolvePurchase } from "./purchase.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function pageItems(page) {
  if (Array.isArray(page)) return page;
  if (Array.isArray(page?.items)) return page.items;
  return [];
}

export async function listCapturedPayments(razorpay, fromDate, toDate) {
  const from = Math.floor(fromDate.getTime() / 1000);
  const to = Math.floor(toDate.getTime() / 1000);
  const captured = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const skip = page * PAGE_SIZE;
    const result = await razorpay.payments.all({ from, to, count: PAGE_SIZE, skip });
    const items = pageItems(result);
    for (const payment of items) {
      if (payment?.status === "captured") captured.push(payment);
    }
    if (items.length < PAGE_SIZE) break;
  }

  return captured;
}

/**
 * Look at captured Razorpay payments in the recent window and enroll anyone
 * Graphy does not already show on the course. Nothing is written locally.
 */
export async function runRecovery({
  config,
  razorpay,
  graphy,
  courses,
  aisensy,
  now = () => new Date(),
  log = console,
}) {
  const end = now();
  const start = new Date(
    end.getTime() - config.recoveryWindowMs - config.recoveryOverlapMs,
  );
  const payments = await listCapturedPayments(razorpay, start, end);
  const summary = {
    scanned: 0,
    enrolled: 0,
    alreadyEnrolled: 0,
    skipped: 0,
    failed: 0,
    from: start.toISOString(),
    to: end.toISOString(),
  };

  for (const payment of payments) {
    summary.scanned += 1;
    let purchase;
    try {
      purchase = await resolvePurchase({ payment, razorpay, courses });
    } catch (err) {
      summary.failed += 1;
      log.error("[recovery] could not read order notes", {
        paymentId: payment?.id ?? null,
        message: err.message,
      });
      continue;
    }

    if (!purchaseReady(purchase)) {
      summary.skipped += 1;
      log.error("[recovery] captured payment is missing course or buyer notes", {
        paymentId: purchase.paymentId || payment?.id || null,
        orderId: purchase.orderId || null,
        courseCode: purchase.courseCode || null,
        email: purchase.buyer?.email || null,
      });
      continue;
    }

    const phoneError = buyerPhoneError(purchase);
    if (phoneError) {
      summary.failed += 1;
      log.error(`[recovery] not enrolling: ${phoneError}`, {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: purchase.courseCode,
        graphyCourseCode: purchase.graphyCourseCode,
        email: purchase.buyer.email,
      });
      continue;
    }

    try {
      const enrolled = await graphy.isEnrolled({
        email: purchase.buyer.email,
        mobile: purchase.buyer.phone,
        productId: purchase.graphyCourseCode,
      });
      if (enrolled === true) {
        summary.alreadyEnrolled += 1;
        log.log("[recovery] learner already has the course", {
          paymentId: purchase.paymentId,
          email: purchase.buyer.email,
          mobile: purchase.buyer.phone,
          graphyCourseCode: purchase.graphyCourseCode,
        });
        continue;
      }
      if (enrolled === null) {
        log.error(
          "[recovery] Graphy learner has no courses field; assigning anyway",
          {
            paymentId: purchase.paymentId,
            email: purchase.buyer.email,
            graphyCourseCode: purchase.graphyCourseCode,
          },
        );
      }

      const enrollment = await enrollLearner({
        graphy,
        course: {
          courseCode: purchase.courseCode,
          graphyCourseCode: purchase.graphyCourseCode,
        },
        buyer: purchase.buyer,
        log,
      });
      summary.enrolled += 1;
      log.log("[recovery] enrolled learner", {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: purchase.courseCode,
        graphyCourseCode: purchase.graphyCourseCode,
        email: enrollment.assignedEmail,
        paymentEmail: purchase.buyer.email,
      });
      await notifyPurchase({
        aisensy,
        course: courses.findByCode(purchase.courseCode) ?? {
          courseCode: purchase.courseCode,
          graphyCourseCode: purchase.graphyCourseCode,
        },
        buyer: purchase.buyer,
        paymentId: purchase.paymentId,
        log,
      });
    } catch (err) {
      summary.failed += 1;
      log.error("[recovery] enrollment failed", {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        courseCode: purchase.courseCode,
        graphyCourseCode: purchase.graphyCourseCode,
        email: purchase.buyer.email,
        message: err.message,
      });
    }
  }

  log.log("[recovery] finished", summary);
  return summary;
}
