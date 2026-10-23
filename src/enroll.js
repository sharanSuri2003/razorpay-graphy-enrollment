/**
 * Find the learner by email, create them if Graphy has no match, then assign
 * the course. Assign is POST /public/v1/assign with the Graphy product id.
 * Create-learner does not return an id in the documented response, and assign
 * identifies the learner by email, so the id is not required.
 */
export async function enrollLearner({ graphy, course, buyer }) {
  let createResponse = null;
  const existing = await graphy.findLearnerByEmail(buyer.email);
  if (!existing) {
    try {
      createResponse = await graphy.createLearner({
        email: buyer.email,
        name: buyer.name,
        mobile: buyer.phone,
      });
    } catch (err) {
      // A concurrent create, or a lookup miss, can mean the learner already
      // exists. Assign still works by email if a second lookup finds them.
      const again = await graphy.findLearnerByEmail(buyer.email).catch(() => null);
      if (!again) {
        err.graphyResponse = { create: null, assign: null };
        throw err;
      }
    }
  }

  let assignResponse;
  try {
    assignResponse = await graphy.assignCourse({
      email: buyer.email,
      productId: course.graphyCourseCode,
    });
  } catch (err) {
    err.graphyResponse = { create: createResponse, assign: null };
    throw err;
  }

  return {
    graphyResponse: {
      create: createResponse,
      assign: assignResponse ?? null,
    },
  };
}
