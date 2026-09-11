import express from "express";
import pino from "pino";
import { authenticate } from "./middleware/auth.js";
import { paymentsRouter } from "./routes/payments.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const app = express();

app.use(express.json({ limit: "256kb" }));
app.use(authenticate);
app.use("/v1/payments", paymentsRouter);

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// Decline reasons from the validation service are passed through untouched so
// that compliance can trace a rule code end to end.
app.use((err, _req, res, _next) => {
  if (err.status === 422) {
    return res.status(422).json({ error: "declined", reasons: err.reasons });
  }
  log.error({ err }, "unhandled error");
  return res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => log.info({ port }, "api-gateway listening"));
