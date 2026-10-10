import fs from "node:fs";

const CURRENCY = "INR";

export function priceToPaise(price) {
  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error("price must be a number of INR rupees");
  }
  const paise = Math.round(price * 100);
  if (Math.abs(price * 100 - paise) > 1e-6) {
    throw new Error("price supports at most 2 decimal places");
  }
  if (!Number.isSafeInteger(paise) || paise < 100) {
    throw new Error("price must be at least 1 INR");
  }
  return paise;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function createCatalog(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Course catalog must be a non-empty JSON array");
  }

  const byCode = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each course must be an object");
    }
    const courseCode = requiredString(entry.courseCode, "courseCode");
    const graphyCourseCode = requiredString(
      entry.graphyCourseCode,
      `graphyCourseCode for ${courseCode}`,
    );
    const name = requiredString(entry.name, `name for ${courseCode}`);
    if (byCode.has(courseCode)) {
      throw new Error(`Duplicate courseCode: ${courseCode}`);
    }
    let amount;
    try {
      amount = priceToPaise(entry.price);
    } catch (err) {
      throw new Error(`Course ${courseCode}: ${err.message}`);
    }
    byCode.set(courseCode, {
      courseCode,
      graphyCourseCode,
      name,
      price: entry.price,
      currency: CURRENCY,
      amount,
    });
  }

  return {
    findByCode(courseCode) {
      return byCode.get(courseCode) ?? null;
    },
  };
}

export function loadCourses(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Could not read courses file ${filePath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Courses file ${filePath} is not valid JSON: ${err.message}`);
  }
  return createCatalog(parsed);
}
