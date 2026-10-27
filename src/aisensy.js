import { withRetry } from "./retry.js";

const ACCESS_BASE = "https://login.indianfarmer.com/s/courses";

export function whatsAppDestination(phone) {
  return String(phone ?? "").replace(/\D/g, "");
}

export function buyerFirstName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "user";
  return trimmed.split(/\s+/)[0];
}

export function buyerContactName(name) {
  const trimmed = String(name ?? "").trim();
  return trimmed || "user";
}

export function courseAccessUrl(course) {
  const custom = typeof course?.accessUrl === "string" ? course.accessUrl.trim() : "";
  if (custom) return custom;
  const id = typeof course?.graphyCourseCode === "string" ? course.graphyCourseCode.trim() : "";
  return id ? `${ACCESS_BASE}/${id}/info` : "";
}

export function courseGuideVideoUrl(course, fallback) {
  const custom = typeof course?.guideVideoUrl === "string" ? course.guideVideoUrl.trim() : "";
  if (custom) return custom;
  return String(fallback ?? "").trim();
}

/**
 * Body for the approved `kropiq_purchase` template.
 * Params: first name, phone, payment id, course link, guidance video.
 */
export function purchaseConfirmationBody({ config, course, buyer, paymentId }) {
  const destination = whatsAppDestination(buyer?.phone);
  const accessUrl = courseAccessUrl(course);
  const guideVideoUrl = courseGuideVideoUrl(course, config.aisensyGuideVideoUrl);
  const phone = String(buyer?.phone ?? "").trim();
  return {
    destination,
    accessUrl,
    guideVideoUrl,
    body: {
      apiKey: config.aisensyApiKey,
      campaignName: config.aisensyCampaignName,
      destination,
      userName: buyerContactName(buyer?.name),
      templateParams: [
        buyerFirstName(buyer?.name),
        phone,
        String(paymentId ?? ""),
        accessUrl,
        guideVideoUrl,
      ],
      source: config.aisensySource,
      media: {},
      buttons: [],
      carouselCards: [],
      location: {},
      attributes: {},
      paramsFallbackValue: { FirstName: "user" },
    },
  };
}

function redact(message, secret) {
  const text = String(message ?? "");
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

export function createAiSensyClient({
  aisensyApiKey,
  aisensyCampaignName,
  aisensySource,
  aisensyApiUrl,
  aisensyGuideVideoUrl,
  graphyRetryAttempts = 3,
  graphyRetryBaseDelayMs = 500,
  graphyRequestTimeoutMs = 10_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console,
} = {}) {
  const config = {
    aisensyApiKey,
    aisensyCampaignName,
    aisensySource,
    aisensyApiUrl,
    aisensyGuideVideoUrl,
  };

  function skip(reason, details) {
    log.warn(`[aisensy] skipping purchase confirmation: ${reason}`, details);
    return { skipped: true, reason };
  }

  async function sendPurchaseConfirmation({ course, buyer, paymentId }) {
    if (!aisensyApiKey) {
      return skip("AISENSY_API_KEY is unset", { paymentId: paymentId || null });
    }

    const built = purchaseConfirmationBody({ config, course, buyer, paymentId });
    if (!built.destination) {
      return skip("buyer phone has no digits", { paymentId: paymentId || null });
    }
    if (!built.accessUrl) {
      return skip("course access link is missing", { paymentId: paymentId || null });
    }
    if (!built.guideVideoUrl) {
      return skip("guidance video URL is unset", {
        paymentId: paymentId || null,
        courseCode: course?.courseCode || null,
      });
    }

    await withRetry(
      async () => {
        let response;
        try {
          response = await fetchImpl(aisensyApiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(built.body),
            signal: AbortSignal.timeout(graphyRequestTimeoutMs),
          });
        } catch (err) {
          const wrapped = new Error(redact(err.message, aisensyApiKey));
          wrapped.name = err.name;
          wrapped.code = err.code || err.cause?.code;
          wrapped.cause = err;
          throw wrapped;
        }
        const text = await response.text();
        if (!response.ok) {
          const error = new Error(
            redact(`AiSensy failed (${response.status}): ${text.slice(0, 500)}`, aisensyApiKey),
          );
          error.statusCode = response.status;
          throw error;
        }
        return text;
      },
      {
        attempts: graphyRetryAttempts,
        baseDelayMs: graphyRetryBaseDelayMs,
        sleep,
        label: "purchase confirmation",
        prefix: "aisensy",
      },
    );

    return { skipped: false, destination: built.destination };
  }

  return { sendPurchaseConfirmation };
}

/** Send after this run enrolled the learner. A WhatsApp failure does not throw. */
export async function notifyPurchase({ aisensy, course, buyer, paymentId, log = console }) {
  if (!aisensy) return { skipped: true, reason: "no client" };
  try {
    const result = await aisensy.sendPurchaseConfirmation({ course, buyer, paymentId });
    if (!result?.skipped) {
      log.log("[aisensy] purchase confirmation sent", {
        paymentId,
        destination: result.destination,
      });
    }
    return result;
  } catch (err) {
    log.error("[aisensy] purchase confirmation failed", {
      paymentId,
      message: err.message,
    });
    return { skipped: false, failed: true };
  }
}
