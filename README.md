# Razorpay checkout → Graphy enrollment

Small Express service that sells courses from a static catalog. The browser asks this service for a Razorpay order. The price always comes from the catalog. When Razorpay reports a successful payment, the service finds or creates the learner on Graphy and assigns the course.

## Setup

Requires Node.js 18 or newer.

```bash
cp .env.example .env
# fill in Razorpay and Graphy credentials
npm install
npm start
```

The process listens on `PORT` (default `3000`). It does not store payments or enrollments. Graphy is called when a valid paid webhook arrives, and again by the recovery job for recent captured payments.

`GET /health` returns `{ "ok": true }`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAZORPAY_KEY_ID` | yes | Razorpay API key id. Also returned to Checkout. |
| `RAZORPAY_KEY_SECRET` | yes | Razorpay API key secret. Used only on the server to create orders. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret you set on the Razorpay webhook. Not the API key secret. |
| `GRAPHY_MERCHANT_ID` | yes | Graphy merchant id (`mid`). Dashboard → Integration API. |
| `GRAPHY_API_TOKEN` | yes | Graphy API token (`key`). Same screen. Advanced plan only. |
| `PORT` | no | HTTP port. Default `3000`. |
| `GRAPHY_API_BASE_URL` | no | Default `https://api.ongraphy.com`. |
| `GRAPHY_RETRY_ATTEMPTS` | no | Tries per Graphy call, including the first. Default `3`. |
| `GRAPHY_RETRY_BASE_DELAY_MS` | no | First backoff delay. Each later wait is double. Default `500`. |
| `GRAPHY_REQUEST_TIMEOUT_MS` | no | Per-attempt timeout. Default `10000`. |
| `RECOVERY_ENABLED` | no | In-process recovery job. Default `true`. Set `false` when cron runs `npm run recover`. |
| `RECOVERY_INTERVAL_MS` | no | In-process interval. Default `600000` (10 minutes). |
| `RECOVERY_WINDOW_MS` | no | How far back a run looks. Default `600000`. |
| `RECOVERY_OVERLAP_MS` | no | Extra lookback so a payment on the window edge is seen again. Default `120000`. |
| `CORS_ORIGIN` | no | If set, `POST /api/orders` allows that browser origin. |
| `COURSES_PATH` | no | Catalog file. Default `data/courses.json`. |

Relative paths are resolved from the project root.

## Course catalog

`data/courses.json` is a JSON array. Each object:

| Field | Meaning |
| --- | --- |
| `courseCode` | Our id. The checkout request sends this. |
| `graphyCourseCode` | Graphy **product id** of the course or package. Sent as `productId` to `POST /public/v1/assign`. |
| `name` | Display name. |
| `price` | Price in **INR rupees** (up to 2 decimal places, for example `1999` or `1999.50`). The client never sends the price. |

The file is the live catalog. Only these courses can be bought. Razorpay is charged in paise (`price * 100`), currency `INR`.

| `courseCode` | Course | `price` (INR) | Charged amount (paise) |
| --- | --- | ---: | ---: |
| `CFBC` | Capsicum Farming Business Course | 1999 | 199900 |
| `HSFBC` | How to Start Farming Business Course | 2499 | 249900 |
| `TFBC` | Tomato Farming Business Course | 1999 | 199900 |

## Create an order

`POST /api/orders`

```bash
curl -s -X POST http://localhost:3000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "courseCode": "CFBC",
    "email": "learner@example.com",
    "name": "Asha Rao",
    "phone": "+919876543210"
  }'
```

`phone` is required. It must include a country code (`+919876543210`), which is the form Graphy expects for `mobile`. A missing or invalid phone is `400` with an error message, and no Razorpay order is created.

Response `201`:

```json
{
  "orderId": "order_ABC123",
  "amount": 199900,
  "currency": "INR",
  "keyId": "rzp_test_..."
}
```

`amount` is paise. A `price` field in the request is ignored. Unknown `courseCode` is `404`. Missing or invalid buyer fields are `400`.

Checkout (browser) uses that payload:

```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  const checkout = new Razorpay({
    key: payload.keyId,
    order_id: payload.orderId,
    amount: payload.amount,
    currency: payload.currency,
    name: "Courses",
    prefill: { email: "learner@example.com", name: "Asha Rao", contact: "+919876543210" },
  });
  checkout.open();
</script>
```

The order is created with notes the webhook reads later: `courseCode`, `graphyCourseCode`, `buyerEmail`, `buyerName`, and `buyerPhone`.

## Webhook

`POST /api/webhooks/razorpay`

Razorpay calls this. Verify the signature against the **raw** body before trusting the JSON.

The only event that enrolls is `payment.captured`. Its payload has the payment only. Notes on the payment are often empty, so the handler loads the order with the Razorpay API and reads the notes saved at order creation. Every other event, including `order.paid`, is acknowledged with `200` and does not call Graphy.

On `payment.captured` the handler reads `courseCode`, `graphyCourseCode`, `buyerEmail`, `buyerName`, and `buyerPhone` from the notes. If `graphyCourseCode` is missing it uses the catalog entry for `courseCode`. It then enrolls the learner as described under Graphy calls. There is no local record and no check that this payment was already handled, so a second `payment.captured` for the same payment enrolls again.

If `buyerPhone` is missing or not a country-code number, the handler does not call Graphy. It logs the payment id, order id, course, and email, and responds `200` with `{ "ok": true, "skipped": true, "reason": "..." }`. A Razorpay retry cannot add a phone that was never stored on the order.

A bad signature is `400`. Graphy or Razorpay failures are logged with the payment id, order id, course, and email, and the response is `500` so Razorpay can deliver the webhook again. Nothing is saved when that happens.

Each Graphy HTTP call is retried on a network error, timeout, HTTP 429, or HTTP 5xx. The wait is `GRAPHY_RETRY_BASE_DELAY_MS`, then double that, and so on. An HTTP 200 body with an `error` object, or any body whose `status` is not `"success"`, is a business failure and is not retried. Every failed attempt is logged with the attempt number and status.

### Razorpay dashboard

1. Settings → Webhooks → Add new webhook.
2. URL: `https://<your-host>/api/webhooks/razorpay` (a tunnel such as ngrok works locally).
3. Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`.
4. Active events: subscribe only to `payment.captured`. Do not enable `order.paid` or other payment events. Any other event this endpoint receives is acknowledged and ignored.
5. Save, then use the dashboard "send test webhook" only as a connectivity check. A test ping will not contain our order notes, so it will not enroll anyone. Place a test-mode payment against an order created by `POST /api/orders` to exercise enrollment.

Signature check locally (export `RAZORPAY_WEBHOOK_SECRET` first):

```bash
BODY='{"event":"payment.authorized"}'
SIG=$(node -e "const c=require('crypto');process.stdout.write(c.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")
curl -s -X POST http://localhost:3000/api/webhooks/razorpay \
  -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: $SIG" \
  -d "$BODY"
```

That authorized event returns `{ "ok": true, "ignored": true }`.

## Graphy calls

Documented in [Graphy REST API (24 Aug 2021)](https://documenter.getpostman.com/view/10740263/Szt8eA1V). Every call sends `mid` and `key`.

| Step | Request |
| --- | --- |
| Find by email | `GET /public/v1/learners?mid&key&limit=10&query={"email":"<email>"}` |
| Find by mobile | `GET /public/v1/learners?mid&key&limit=10&query={"mobile":"+91..."}` |
| Create learner | `POST /public/v1/learners` form body: `mid`, `key`, `email`, `name`, `mobile` (the buyer phone), `sendEmail=true` |
| Assign course | `POST /public/v1/assign` form body: `mid`, `key`, `email`, `productId` |

`productId` is `graphyCourseCode` from the catalog. Success is `{ "status": "success" }`. Graphy reports a business failure as HTTP 200 with `{ "error": { "code": 22, "message": "..." } }`, not `status: "failure"`. Create checks the mobile before the email.

Enrollment:

1. Look up the learner by email. If found, assign the course to that email and do not create anyone.
2. If not found, create the learner with email, name, and mobile. Error code 22 (`Account exists for email : ...`) means the email is already registered; assign that email.
3. Error code 25 (`This mobile number is already registered. Please use a different number.`) means the phone belongs to an existing account. Look that account up by mobile and assign the course to its email. The log warns with the payment email and the existing account email. If the mobile lookup finds nobody, enrollment fails and Graphy is not assigned.
4. Any other create error fails the enrollment.

`sendEmail=true` asks Graphy to email login details. No password is sent, so Graphy generates one. The phone is sent only when creating a learner; an existing account is not updated.

The published Assign URL in that collection is the broken string `{/public/v1/assign`. This service calls `https://api.ongraphy.com/public/v1/assign`, matching the path segments and `POST /public/v1/unassign`.

### Is this learner already enrolled?

`GET /public/v1/learners?courseInfo=true` includes `courses` on the learner. Each entry looks like `{ "id": "<graphy product id>", "Title": "...", "Assigned Date": "...", "last access date": "..." }`. `id` is the product id. A learner with no courses has `courses: []`.

Recovery resolves the learner the same way as enrollment: email first, then mobile when the email is absent. It skips the payment when that learner's `courses` contains the product id. An empty `courses` array means not enrolled. If the learner object has no `courses` field at all, recovery logs that and assigns anyway.

`GET /t/api/public/v3/products/activelearners` was not used. It lists learners active between two dates, not everyone enrolled in the product.

## Recovery

Each run asks Razorpay for payments created in the last `RECOVERY_WINDOW_MS` plus `RECOVERY_OVERLAP_MS` (defaults: 10 minutes and 2 minutes). Captured payments are kept. For each one the order notes supply the course and buyer, same as the webhook. A captured payment with a missing or invalid `buyerPhone` is not sent to Graphy. It is logged with the payment id, order id, course, and email, and counted as a failure. If the resolved learner already has this product id in `courses`, the payment is skipped. Otherwise the learner is enrolled with the same rules as the webhook, including error 22 and error 25. One learner's failure is logged and the run continues. Nothing is written on this server.

The overlap means a payment that lands on the boundary is visible to two on-time runs. It does not cover a long outage: a payment older than the window is not revisited.

Two ways to run it. Use one of them, not both, or the same payment can be assigned twice while both runs still think the learner is missing.

**In process.** `RECOVERY_ENABLED` defaults to true. `npm start` runs recovery once at startup and then every `RECOVERY_INTERVAL_MS` on `setInterval`. The timer does not keep the process alive by itself.

**External cron.** Set `RECOVERY_ENABLED=false` on the web process and schedule:

```cron
*/10 * * * * cd /path/to/app && npm run recover
```

`npm run recover` runs one pass and exits. Exit code is `1` when any payment in that pass failed (notes could not be read, `buyerPhone` was missing or invalid, or Graphy still failed after retries). Individual failures are logged with payment id, course, and email.

## Tests

```bash
npm test
```

Covers webhook signature checks (including a body that no longer matches after re-serialization), order creation with a mocked Razorpay client (catalog price wins over a client `price`), Graphy request shape, Graphy retries, and the recovery job against mocked Razorpay and Graphy clients.

## Limitations

- INR only.
- No stored idempotency. A second `payment.captured` for the same payment enrolls again. Recovery will skip it only when `courses` already contains the product id.
- If a learner object is missing `courses` entirely, recovery assigns anyway. With the default window and interval, a payment is only considered for about twelve minutes.
- Create sends `sendEmail=true` and no password, so Graphy generates one and emails login details. An existing account is not updated with a new phone.
- `buyerPhone` is required. A captured payment whose notes have no valid phone is not enrolled, and the webhook does not ask Razorpay to retry it.
- Error 25 assigns the course to the Graphy account that already owns the phone, which can be a different email from the one on the payment.
