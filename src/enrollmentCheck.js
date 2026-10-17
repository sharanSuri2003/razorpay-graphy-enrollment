/**
 * Keys that might hold the course list when courseInfo=true.
 * The published Graphy examples never include this list, so these names are
 * only used when the payload actually has an array under one of them.
 */
const LIST_KEYS = [
  "courses",
  "course",
  "enrollments",
  "products",
  "courseInfo",
  "course info",
  "enrolledCourses",
];

const ID_KEYS = ["id", "productId", "product_id", "courseId", "courseCode", "product id"];

export function courseListOf(learner) {
  if (!learner || typeof learner !== "object") return undefined;
  for (const key of LIST_KEYS) {
    if (Array.isArray(learner[key])) return learner[key];
  }
  return undefined;
}

export function courseListHasProduct(list, productId) {
  return list.some((item) => {
    if (typeof item === "string") return item === productId;
    if (!item || typeof item !== "object") return false;
    return ID_KEYS.some((key) => item[key] === productId);
  });
}

/**
 * true: the payload lists this product.
 * false: no learner, or a course list is present and does not include it.
 * null: a learner was returned with no course list, so enrollment is unknown.
 */
export function enrollmentFromLearner(learner, productId) {
  if (!learner) return false;
  const list = courseListOf(learner);
  if (list === undefined) return null;
  return courseListHasProduct(list, productId);
}
