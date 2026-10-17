import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { auditLogs } from "../../../db/schema/audit_logs.schema.js";
import { nightAudits } from "../../../db/schema/night_audits.schema.js";
import { jakartaDate } from "../../night-audit/services/night-audit.service.js";
import {
  buildManagerDailySnapshot,
  type ManagerDailySnapshot,
} from "../services/manager-daily-report.service.js";

type Query = { date: string };
type FinancialSummary = { roomRevenue: number; paymentsReceived: number; refundsPaid: number };

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const managerDailyReportRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Query }>(
    "/manager-daily",
    {
      preHandler: app.requirePermission("reports.view_revenue"),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["date"],
          properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
        },
      },
    },
    async (request, reply) => {
      const { date } = request.query;
      if (!validDate(date) || date > jakartaDate()) {
        return reply.code(400).send({
          error: { code: "INVALID_DATE", message: "Choose a valid date up to today." },
        });
      }

      const [audit] = await app.db
        .select({
          id: nightAudits.id,
          snapshot: nightAudits.snapshot,
          closedAt: nightAudits.closedAt,
        })
        .from(nightAudits)
        .where(eq(nightAudits.businessDate, date))
        .limit(1);

      if (audit) {
        const snapshot = audit.snapshot as { managerReport?: ManagerDailySnapshot };
        if (!snapshot.managerReport) {
          return {
            businessDate: date,
            status: "legacy_unavailable" as const,
            closedAt: audit.closedAt,
            capturedAt: null,
            metrics: null,
            breakdown: null,
            correction: null,
          };
        }
        const [[correctionCount], [latest]] = await Promise.all([
          app.db
            .select({ total: count() })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.entityType, "night_audit"),
                eq(auditLogs.entityId, audit.id),
                eq(auditLogs.action, "financial_correction"),
              ),
            ),
          app.db
            .select({ afterData: auditLogs.afterData })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.entityType, "night_audit"),
                eq(auditLogs.entityId, audit.id),
                eq(auditLogs.action, "financial_correction"),
              ),
            )
            .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
            .limit(1),
        ]);
        const accepted = latest?.afterData as FinancialSummary | undefined;
        return {
          businessDate: date,
          status: "final" as const,
          closedAt: audit.closedAt,
          capturedAt: snapshot.managerReport.capturedAt,
          metrics: snapshot.managerReport.metrics,
          breakdown: snapshot.managerReport.breakdown ?? null,
          correction: accepted
            ? {
                count: correctionCount.total,
                roomRevenueDelta: accepted.roomRevenue - snapshot.managerReport.metrics.roomRevenue,
                paymentsReceivedDelta:
                  accepted.paymentsReceived - snapshot.managerReport.metrics.paymentsReceived,
                refundsPaidDelta: accepted.refundsPaid - snapshot.managerReport.metrics.refundsPaid,
              }
            : null,
        };
      }

      const live = await app.db.transaction((tx) => buildManagerDailySnapshot(tx, date), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
      return {
        businessDate: date,
        status: "provisional" as const,
        closedAt: null,
        capturedAt: live.capturedAt,
        metrics: live.metrics,
        breakdown: live.breakdown,
        correction: null,
      };
    },
  );
};
