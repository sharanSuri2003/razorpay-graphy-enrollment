import test from "node:test";
import assert from "node:assert/strict";
import { enrollLearner } from "../src/enroll.js";

const course = {
  courseCode: "CFBC",
  graphyCourseCode: "69982bc4537633302dc0288e",
};

const buyer = {
  email: "learner@example.com",
  name: "Asha Rao",
  phone: "+919876543210",
};

function graphyError(code, message) {
  const error = new Error(message);
  error.statusCode = 200;
  error.graphyCode = code;
  return error;
}

test("assigns an existing email without creating the learner", async () => {
  const calls = [];
  const graphy = {
    async findLearnerByEmail(email) {
      calls.push({ op: "findEmail", email });
      return { email, courses: [] };
    },
    async createLearner() {
      throw new Error("create should not run");
    },
    async assignCourse(input) {
      calls.push({ op: "assign", input });
      return { status: "success" };
    },
  };

  const result = await enrollLearner({ graphy, course, buyer, log: { log() {}, warn() {} } });
  assert.equal(result.assignedEmail, buyer.email);
  assert.deepEqual(
    calls.map((call) => call.op),
    ["findEmail", "assign"],
  );
  assert.equal(calls[1].input.email, buyer.email);
});

test("assigns by email when create returns error 22", async () => {
  const calls = [];
  const graphy = {
    async findLearnerByEmail() {
      calls.push("findEmail");
      return null;
    },
    async createLearner() {
      calls.push("create");
      throw graphyError(22, "Account exists for email : learner@example.com");
    },
    async findLearnerByMobile() {
      throw new Error("mobile lookup should not run for error 22");
    },
    async assignCourse(input) {
      calls.push(`assign:${input.email}`);
      return { status: "success" };
    },
  };

  const result = await enrollLearner({ graphy, course, buyer, log: { log() {}, warn() {} } });
  assert.equal(result.assignedEmail, buyer.email);
  assert.deepEqual(calls, ["findEmail", "create", `assign:${buyer.email}`]);
});

test("assigns the existing mobile account when create returns error 25", async () => {
  const warnings = [];
  const graphy = {
    async findLearnerByEmail() {
      return null;
    },
    async createLearner() {
      throw graphyError(
        25,
        "This mobile number is already registered. Please use a different number.",
      );
    },
    async findLearnerByMobile(mobile) {
      assert.equal(mobile, buyer.phone);
      return { email: "existing@example.com", mobile };
    },
    async assignCourse(input) {
      return { status: "success", email: input.email };
    },
  };

  const result = await enrollLearner({
    graphy,
    course,
    buyer,
    log: {
      log() {},
      warn(message, details) {
        warnings.push({ message, details });
      },
    },
  });

  assert.equal(result.assignedEmail, "existing@example.com");
  assert.equal(result.graphyResponse.assign.email, "existing@example.com");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /already registered/);
  assert.equal(warnings[0].details.paymentEmail, buyer.email);
  assert.equal(warnings[0].details.existingEmail, "existing@example.com");
});

test("assigns the phone's existing account when the buyer gave no email", async () => {
  const warnings = [];
  const calls = [];
  const graphy = {
    async findLearnerByEmail() {
      throw new Error("email lookup should not run before the mobile account is found");
    },
    async findLearnerByMobile(mobile) {
      calls.push({ op: "findMobile", mobile });
      return { email: "real@example.com", mobile };
    },
    async createLearner() {
      throw new Error("create should not run");
    },
    async assignCourse(input) {
      calls.push({ op: "assign", email: input.email });
      return { status: "success" };
    },
  };

  const result = await enrollLearner({
    graphy,
    course,
    buyer: { name: "Asha Rao", phone: "+91 99999 00001" },
    log: {
      log() {},
      warn(message, details) {
        warnings.push({ message, details });
      },
    },
  });

  assert.equal(result.assignedEmail, "real@example.com");
  assert.deepEqual(calls, [
    { op: "findMobile", mobile: "+91 99999 00001" },
    { op: "assign", email: "real@example.com" },
  ]);
  assert.equal(warnings[0].details.paymentEmail, null);
  assert.equal(warnings[0].details.existingEmail, "real@example.com");
});

test("creates a proxy email when the buyer gave no email and the phone is new", async () => {
  const calls = [];
  const graphy = {
    async findLearnerByMobile() {
      calls.push("findMobile");
      return null;
    },
    async findLearnerByEmail() {
      throw new Error("email lookup should not run when creating the proxy");
    },
    async createLearner(input) {
      calls.push(`create:${input.email}`);
      return { status: "success" };
    },
    async assignCourse(input) {
      calls.push(`assign:${input.email}`);
      return { status: "success" };
    },
  };

  const result = await enrollLearner({
    graphy,
    course,
    buyer: { name: "Asha Rao", phone: "+91 99999 00001" },
    log: { log() {}, warn() {} },
  });

  assert.equal(result.assignedEmail, "919999900001@indianfarmer.com");
  assert.deepEqual(calls, [
    "findMobile",
    "create:919999900001@indianfarmer.com",
    "assign:919999900001@indianfarmer.com",
  ]);
});

test("fails when error 25 has no learner for that mobile", async () => {
  const graphy = {
    async findLearnerByEmail() {
      return null;
    },
    async createLearner() {
      throw graphyError(25, "This mobile number is already registered. Please use a different number.");
    },
    async findLearnerByMobile() {
      return null;
    },
    async assignCourse() {
      throw new Error("assign should not run");
    },
  };

  await assert.rejects(
    () => enrollLearner({ graphy, course, buyer, log: { log() {}, warn() {} } }),
    (err) => {
      assert.equal(err.graphyCode, 25);
      assert.match(err.message, /no learner was found/);
      assert.match(err.message, new RegExp(buyer.email));
      return true;
    },
  );
});
