# Razorpay checkout → Graphy enrollment

Small Express service that sells courses from a static catalog. The browser asks this service for a Razorpay order. The price always comes from the catalog. When Razorpay reports a successful payment, the service finds or creates the learner on Graphy and assigns the course.

## Setup

Requires Node.js 18 or newer.

```bash
cp .env.example .env
# fill in Razorpay, Graphy, and MongoDB credentials
npm install
npm start
```

MongoDB must be reachable at `MONGODB_URI` before the process starts. The driver uses its default pool. One client is created at startup and reused.

The process listens on `PORT` (default `3000`).

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
| `CORS_ORIGIN` | no | If set, `POST /api/orders` allows that browser origin. |
| `MONGODB_URI` | yes | MongoDB connection string. |
| `MONGODB_DB` | yes | Database name. Collections `webhookEvents` and `enrollments` are created on startup. |
| `COURSES_PATH` | no | Catalog file. Default `data/courses.json`. |

Relative paths are resolved from the project root.

## Course catalog

`data/courses.json` is a JSON array. Each object:

| Field | Meaning |
| --- | --- |
| `courseCode` | Our id. The checkout request sends this. |
| `graphyCourseCode` | Graphy **product id** of the course or package. Sent as `productId` to `POST /public/v1/assign`. |
| `name` | Display name. |
| `price` | Price in **INR rupees** (paise allowed, for example `499` or `499.5`). The client never sends the price. |

The two entries shipped in the file are examples. Replace `graphyCourseCode` with real product ids from Graphy before taking live payments. Razorpay is charged in paise (`price * 100`), currency `INR`.

## Create an order

`POST /api/orders`

```bash
curl -s -X POST http://localhost:3000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "courseCode": "EXAMPLE-INTRO",
    "email": "learner@example.com",
    "name": "Asha Rao",
    "phone": "+919876543210"
  }'
```

`phone` is optional. When present it must include a country code (`+919876543210`), which is the form Graphy expects for `mobile`.

Response `201`:

```json
{
  "orderId": "order_ABC123",
  "amount": 49900,
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
    prefill: { email: "learner@example.com", name: "Asha Rao" },
  });
  checkout.open();
</script>
```

The order is created with notes the webhook reads later: `courseCode`, `graphyCourseCode`, `buyerEmail`, `buyerName`, and `buyerPhone` when the buyer sent one.

## Webhook

`POST /api/webhooks/razorpay`

Razorpay calls this. Verify the signature against the **raw** body before trusting the JSON.

Handled events:

- `payment.captured` — payload has the payment only. Notes on the payment are often empty, so the handler loads the order with the Razorpay API and reads the notes saved at order creation.
- `order.paid` — payload includes the order, so notes are read from the order entity.

Other events are acknowledged with `200` and ignored.

On a paid event the handler:

1. Reads `courseCode`, `buyerEmail`, `buyerName`, and optional `buyerPhone` from the notes.
2. Reads `graphyCourseCode` from those notes (the product id saved at checkout). If that note is missing, it falls back to the current catalog entry for `courseCode`.
3. Skips Graphy if this payment id was already enrolled (Razorpay retries, and both events can arrive for one payment). The guard is a unique index on `paymentId` in `enrollments`.
4. Otherwise finds the learner (`GET /public/v1/learners?query={"email":"..."}`), creates them if missing (`POST /public/v1/learners`), and assigns the course (`POST /public/v1/assign` with `email` and `productId`).

Every delivery is written to `webhookEvents` before it is acted on: raw body, parsed payload (or null), event name, `X-Razorpay-Event-Id`, the signature header, whether the signature matched, received time, and the processing status. Invalid signatures are stored too, with `signatureValid: false` and status `rejected`, and are not enrolled. A retry is another document; the event id is not unique.

`enrollments` holds one document per payment: payment id, order id, course code, Graphy product id, learner email, name, and phone, status `success` or `failed`, the Graphy response or error, attempt count, and timestamps. A successful payment is not enrolled again. A failed attempt stays in the collection and a later retry claims that row, increments `attempts`, and tries Graphy again.

Success and duplicates respond `200`. A Graphy or Razorpay failure is logged with the payment id, order id, course, and email, the enrollment row is marked `failed`, and the response is `500` so Razorpay retries.

### Razorpay dashboard

1. Settings → Webhooks → Add new webhook.
2. URL: `https://<your-host>/api/webhooks/razorpay` (a tunnel such as ngrok works locally).
3. Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`.
4. Active events: `payment.captured` and `order.paid`.
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
| Find learner | `GET /public/v1/learners?mid&key&limit=10&query={"email":"<email>"}` |
| Create learner | `POST /public/v1/learners` form body: `mid`, `key`, `email`, `name`, optional `mobile`, `sendEmail=true` |
| Assign course | `POST /public/v1/assign` form body: `mid`, `key`, `email`, `productId` |

`productId` is `graphyCourseCode` from the catalog. Create does not return a learner id in the documented example (`{ "status": "success" }`); assign uses the email. `sendEmail=true` asks Graphy to email login details. No password is sent, so Graphy generates one.

The published Assign URL in that collection is the broken string `{/public/v1/assign`. This service calls `https://api.ongraphy.com/public/v1/assign`, matching the path segments and `POST /public/v1/unassign`.

## Tests

```bash
npm test
```

Covers webhook signature checks (including a body that no longer matches after re-serialization), order creation with a mocked Razorpay client (catalog price wins over a client `price`), Graphy request shape, and webhook idempotency against MongoDB (via `mongodb-memory-server`).

Indexes created on startup:

| Collection | Index |
| --- | --- |
| `enrollments` | unique `paymentId` |
| `webhookEvents` | `receivedAt` descending, and `razorpayEventId` (not unique) |

## Limitations

- INR only.
- A crash after Graphy accepts the assign and before the enrollment row is marked `success` leaves status `processing`. A retry sooner than two minutes is treated as in progress. After two minutes the row can be claimed again, which calls assign a second time. Whether Graphy treats that as a no-op is not documented.
