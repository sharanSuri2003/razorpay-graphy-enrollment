import { graphyEmail, suppliedEmail } from "./buyerEmail.js";

function graphyCode(err) {
  const code = Number(err?.graphyCode);
  return Number.isInteger(code) ? code : null;
}

function accountEmail(learner) {
  return learner?.email ? String(learner.email).trim() : "";
}

async function assignExistingMobile({ graphy, course, buyer, log, paymentEmail }) {
  const byMobile = await graphy.findLearnerByMobile(buyer.phone);
  const existingEmail = accountEmail(byMobile);
  if (!existingEmail) return null;
  log.warn("[graphy] mobile is already registered; assigning the existing account", {
    paymentEmail: paymentEmail || null,
    existingEmail,
    mobile: buyer.phone,
    courseCode: course.courseCode,
  });
  return existingEmail;
}

async function createOrReuse({ graphy, course, buyer, email, log }) {
  try {
    return {
      email,
      createResponse: await graphy.createLearner({
        email,
        name: buyer.name,
        mobile: buyer.phone,
      }),
    };
  } catch (err) {
    const code = graphyCode(err);
    if (code === 22) {
      log.log("[graphy] account already exists for this email; assigning it", {
        email,
        courseCode: course.courseCode,
      });
      return { email, createResponse: null };
    }
    if (code === 25) {
      const existingEmail = await assignExistingMobile({
        graphy,
        course,
        buyer,
        log,
        paymentEmail: suppliedEmail(buyer) || email,
      });
      if (!existingEmail) {
        const error = new Error(
          `Mobile ${buyer.phone} is already registered in Graphy, but no learner was found for it. Not assigning. Payment email: ${suppliedEmail(buyer) || email}.`,
        );
        error.graphyCode = 25;
        error.cause = err;
        throw error;
      }
      return { email: existingEmail, createResponse: null };
    }
    throw err;
  }
}

/**
 * Assign the course on Graphy.
 *
 * A buyer email is looked up first and assigned as-is. Otherwise the phone is
 * looked up first so an existing account keeps the course, and only then is a
 * `<digits>@indianfarmer.com` learner created. Error 22 assigns that email.
 * Error 25 assigns the account that already owns the mobile.
 */
export async function enrollLearner({ graphy, course, buyer, log = console }) {
  let createResponse = null;
  const provided = suppliedEmail(buyer);
  let assignedEmail = graphyEmail(buyer);

  if (!provided) {
    const existingEmail = await assignExistingMobile({
      graphy,
      course,
      buyer,
      log,
      paymentEmail: null,
    });
    if (existingEmail) {
      assignedEmail = existingEmail;
    } else {
      const created = await createOrReuse({
        graphy,
        course,
        buyer,
        email: assignedEmail,
        log,
      });
      assignedEmail = created.email;
      createResponse = created.createResponse;
    }
  } else {
    const existing = await graphy.findLearnerByEmail(provided);
    if (existing) {
      assignedEmail = provided;
    } else {
      const created = await createOrReuse({
        graphy,
        course,
        buyer,
        email: provided,
        log,
      });
      assignedEmail = created.email;
      createResponse = created.createResponse;
    }
  }

  let assignResponse;
  try {
    assignResponse = await graphy.assignCourse({
      email: assignedEmail,
      productId: course.graphyCourseCode,
    });
  } catch (err) {
    err.graphyResponse = { create: createResponse, assign: null };
    throw err;
  }

  return {
    assignedEmail,
    graphyResponse: {
      create: createResponse,
      assign: assignResponse ?? null,
    },
  };
}
