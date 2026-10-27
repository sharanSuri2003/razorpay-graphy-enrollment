const PROXY_DOMAIN = "indianfarmer.com";

/** Digits only, including the country code. `+91 99999 00001` → `919999900001@indianfarmer.com`. */
export function proxyEmail(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return `${digits}@${PROXY_DOMAIN}`;
}

/**
 * Email the buyer actually gave us. A blank note and our own proxy address
 * both count as "no email", so checkout and enrollment stay on the same path.
 */
export function suppliedEmail(buyer) {
  const email = String(buyer?.email ?? "").trim().toLowerCase();
  if (!email) return "";
  const proxy = proxyEmail(buyer?.phone);
  if (proxy && email === proxy) return "";
  return email;
}

/** Address Graphy should use when the buyer did not give one. */
export function graphyEmail(buyer) {
  return suppliedEmail(buyer) || proxyEmail(buyer?.phone);
}
