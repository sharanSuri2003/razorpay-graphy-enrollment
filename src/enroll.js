function graphyCode(err) {
  const code = Number(err?.graphyCode);
  return Number.isInteger(code) ? code : null;
}

/**
 * Assign the course to the Graphy account that already owns this email, or
 * this mobile when the mobile is registered to someone else.
 *
 * 1. An email match is assigned directly.
 * 2. Otherwise create the learner. Error 22 means the email exists; assign it.
 * 3. Error 25 means the mobile is already registered. Assign the account
 *    returned by a mobile lookup, or fail if that lookup finds nobody.
 */
export async function enrollLearner({ graphy, course, buyer, log = console }) {
  let createResponse = null;
  let assignedEmail = buyer.email;

  const existing = await graphy.findLearnerByEmail(buyer.email);
  if (!existing) {
    try {
      createResponse = await graphy.createLearner({
        email: buyer.email,
        name: buyer.name,
        mobile: buyer.phone,
      });
    } catch (err) {
      const code = graphyCode(err);
      if (code === 22) {
        log.log("[graphy] account already exists for this email; assigning it", {
          email: buyer.email,
          courseCode: course.courseCode,
        });
      } else if (code === 25) {
        const byMobile = await graphy.findLearnerByMobile(buyer.phone);
        const existingEmail = byMobile?.email ? String(byMobile.email).trim() : "";
        if (!existingEmail) {
          const error = new Error(
            `Mobile ${buyer.phone} is already registered in Graphy, but no learner was found for it. Not assigning. Payment email: ${buyer.email}.`,
          );
          error.graphyCode = 25;
          error.cause = err;
          throw error;
        }
        assignedEmail = existingEmail;
        log.warn(
          "[graphy] mobile is already registered; assigning the existing account",
          {
            paymentEmail: buyer.email,
            existingEmail,
            mobile: buyer.phone,
            courseCode: course.courseCode,
          },
        );
      } else {
        throw err;
      }
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
