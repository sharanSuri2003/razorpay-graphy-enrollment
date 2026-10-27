import test from "node:test";
import assert from "node:assert/strict";
import { graphyEmail, proxyEmail, suppliedEmail } from "../src/buyerEmail.js";

test("proxy email keeps the country code and drops formatting", () => {
  assert.equal(proxyEmail("+91 99999 00001"), "919999900001@indianfarmer.com");
  assert.equal(proxyEmail("+919999900001"), "919999900001@indianfarmer.com");
  assert.equal(proxyEmail(""), "");
});

test("a stored buyer email wins over the proxy address", () => {
  const buyer = { email: "Learner@Example.com", phone: "+919999900001" };
  assert.equal(suppliedEmail(buyer), "learner@example.com");
  assert.equal(graphyEmail(buyer), "learner@example.com");
  assert.equal(suppliedEmail({ email: "", phone: "+919999900001" }), "");
  assert.equal(
    suppliedEmail({ email: "919999900001@indianfarmer.com", phone: "+919999900001" }),
    "",
  );
  assert.equal(graphyEmail({ phone: "+919999900001" }), "919999900001@indianfarmer.com");
});
