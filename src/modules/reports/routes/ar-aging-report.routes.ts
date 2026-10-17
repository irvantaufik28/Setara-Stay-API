import type { FastifyPluginAsync } from "fastify";
import { buildArAgingReport, type ArAgingQuery } from "../services/ar-aging-report.service.js";

export const arAgingReportRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ArAgingQuery }>(
    "/ar-aging",
    {
      preHandler: app.requirePermission("reports.view_revenue"),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            search: { type: "string", maxLength: 255 },
            source: { type: "string", enum: ["website", "walk_in", "phone", "ota"] },
            bucket: { type: "string", enum: ["0_30", "31_60", "61_90", "over_90"] },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request) => {
      const capturedAt = new Date().toISOString();
      const asOfDate = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(capturedAt));
      return app.db.transaction(
        (tx) => buildArAgingReport(tx, asOfDate, capturedAt, request.query),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  );
};
