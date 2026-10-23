/**
 * courseInfo=true adds `courses` on the learner. Each entry's `id` is the
 * Graphy product id. An empty array means the learner has no courses.
 *
 * true: `courses` contains this product id.
 * false: no learner, or `courses` is present and does not contain it.
 * null: a learner was returned without a `courses` array.
 */
export function enrollmentFromLearner(learner, productId) {
  if (!learner) return false;
  if (!Array.isArray(learner.courses)) return null;
  return learner.courses.some(
    (course) => course && typeof course === "object" && course.id === productId,
  );
}
