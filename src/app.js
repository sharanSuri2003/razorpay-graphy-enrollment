import express from "express";
import { createOrderHandler } from "./orders.js";
import { createWebhookHandler } from "./webhook.js";

export function createApp({ config, courses, razorpay, graphy, store }) {
  const app = express();
  app.disable("x-powered-by");

  if (config.corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  // Razorpay signs the exact bytes. This route must see the raw body,
  // so it is registered before the JSON parser.
  app.post(
    "/api/webhooks/razorpay",
    express.raw({ type: () => true, limit: "1mb" }),
    createWebhookHandler({ config, courses, razorpay, graphy, store }),
  );

  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/orders", createOrderHandler({ courses, razorpay }));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    console.error("[app] unhandled error", { message: err?.message });
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}
