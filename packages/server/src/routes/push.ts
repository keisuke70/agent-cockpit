import type { FastifyInstance } from "fastify";
import {
  getPublicKey,
  addSubscription,
  removeSubscription,
} from "../push.js";

interface SubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface UnsubscribeBody {
  endpoint: string;
}

export async function pushRoutes(app: FastifyInstance) {
  app.get("/api/push/vapid-public-key", () => ({ publicKey: getPublicKey() }));

  app.post<{ Body: SubscribeBody }>("/api/push/subscribe", (req, reply) => {
    const body = req.body;
    if (
      !body ||
      typeof body.endpoint !== "string" ||
      !body.keys ||
      typeof body.keys.p256dh !== "string" ||
      typeof body.keys.auth !== "string"
    ) {
      return reply.status(400).send({ error: "Invalid subscription" });
    }
    const id = addSubscription(body);
    return reply.status(201).send({ id });
  });

  app.delete<{ Body: UnsubscribeBody }>(
    "/api/push/subscribe",
    (req, reply) => {
      const body = req.body;
      if (!body || typeof body.endpoint !== "string") {
        return reply.status(400).send({ error: "Invalid endpoint" });
      }
      removeSubscription(body.endpoint);
      return reply.status(204).send();
    },
  );
}
