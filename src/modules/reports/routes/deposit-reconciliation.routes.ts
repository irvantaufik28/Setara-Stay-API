import type { FastifyPluginAsync } from "fastify";
import {
  buildDepositReconciliation,
  listDepositMovements,
  type DepositQuery,
} from "../services/deposit-reconciliation.service.js";

const querystring = {
  type: "object",
  additionalProperties: false,
  properties: {
    search: { type: "string", maxLength: 255 },
    view: { type: "string", enum: ["open", "all"] },
    reservationStatus: { type: "string", enum: ["all", "checked_out"] },
    ledgerStatus: { type: "string", enum: ["all", "matched", "review"] },
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
} as const;

export const depositReconciliationRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: DepositQuery }>(
    "/deposit-reconciliation",
    { preHandler: app.requirePermission("reports.view_revenue"), schema: { querystring } },
    async (request) => {
      const capturedAt = new Date().toISOString();
      return app.db.transaction((tx) => buildDepositReconciliation(tx, capturedAt, request.query), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
    },
  );
  app.get<{ Querystring: DepositQuery }>(
    "/deposit-reconciliation/movements",
    { preHandler: app.requirePermission("reports.view_revenue"), schema: { querystring } },
    async (request) => {
      const capturedAt = new Date().toISOString();
      return app.db.transaction((tx) => listDepositMovements(tx, capturedAt, request.query), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
    },
  );
};
