import Razorpay from "razorpay";

export function createRazorpayClient({ razorpayKeyId, razorpayKeySecret }) {
  const client = new Razorpay({
    key_id: razorpayKeyId,
    key_secret: razorpayKeySecret,
  });

  return {
    keyId: razorpayKeyId,
    orders: {
      create(payload) {
        return client.orders.create(payload);
      },
      fetch(orderId) {
        return client.orders.fetch(orderId);
      },
    },
    payments: {
      all(params) {
        return client.payments.all(params);
      },
    },
  };
}
