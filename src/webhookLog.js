/**
 * One document per delivery, including signature failures.
 * razorpayEventId is not unique: Razorpay retries and both payment.captured
 * and order.paid are stored.
 */
export function createWebhookLog(collection) {
  return {
    async record(fields) {
      const result = await collection.insertOne({
        receivedAt: new Date(),
        rawBody: fields.rawBody,
        payload: fields.payload ?? null,
        event: fields.event ?? null,
        razorpayEventId: fields.razorpayEventId ?? null,
        signature: fields.signature ?? null,
        signatureValid: Boolean(fields.signatureValid),
        status: "received",
        outcome: null,
        error: null,
        paymentId: null,
        orderId: null,
        processedAt: null,
      });
      return result.insertedId;
    },

    async complete(id, fields) {
      if (!id) return;
      await collection.updateOne(
        { _id: id },
        {
          $set: {
            status: fields.status,
            outcome: fields.outcome ?? null,
            error: fields.error ?? null,
            paymentId: fields.paymentId ?? null,
            orderId: fields.orderId ?? null,
            processedAt: new Date(),
          },
        },
      );
    },
  };
}
