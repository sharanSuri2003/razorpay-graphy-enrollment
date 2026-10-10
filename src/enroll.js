/**
 * Find the learner by email, create them if Graphy has no match, then assign
 * the course. Assign is POST /public/v1/assign with the Graphy product id.
 * Create-learner does not return an id in the documented response, and assign
 * identifies the learner by email, so the id is not required.
 */
export async function enrollLearner({ graphy, course, buyer }) {
  const existing = await graphy.findLearnerByEmail(buyer.email);
  if (!existing) {
    try {
      await graphy.createLearner({
        email: buyer.email,
        name: buyer.name,
        mobile: buyer.phone || undefined,
      });
    } catch (err) {
      // A concurrent create, or a lookup miss, can mean the learner already
      // exists. Assign still works by email if a second lookup finds them.
      const again = await graphy.findLearnerByEmail(buyer.email).catch(() => null);
      if (!again) throw err;
    }
  }

  await graphy.assignCourse({
    email: buyer.email,
    productId: course.graphyCourseCode,
  });

  return {
    courseCode: course.courseCode,
    graphyCourseCode: course.graphyCourseCode,
    email: buyer.email,
  };
}
