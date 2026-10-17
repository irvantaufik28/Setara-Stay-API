import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { auditLogs } from "../../../db/schema/audit_logs.schema.js";
import { nightAudits } from "../../../db/schema/night_audits.schema.js";
import { nightAuditSettings } from "../../../db/schema/night_audit_settings.schema.js";
import { users } from "../../../db/schema/users.schema.js";
import { buildManagerDailySnapshot } from "../../reports/services/manager-daily-report.service.js";
import {
  buildAuditPreview,
  closeWindowOpen,
  getAuditState,
  jakartaDate,
  type AuditPreview,
} from "../services/night-audit.service.js";

type SetupBody = { startDate: string; confirm: boolean };
type HistoryQuery = { page?: number; limit?: number };
type CloseBody = {
  businessDate: string;
  previewToken: string;
  confirm: boolean;
  warningReason?: string;
};
type CorrectionBody = { reason: string; previewToken: string };
type FinancialSummary = Pick<
  AuditPreview["summary"],
  "roomRevenue" | "paymentsReceived" | "refundsPaid"
>;

function financialSummary(summary: AuditPreview["summary"]): FinancialSummary {
  return {
    roomRevenue: summary.roomRevenue,
    paymentsReceived: summary.paymentsReceived,
    refundsPaid: summary.refundsPaid,
  };
}

function financialDelta(before: FinancialSummary, after: FinancialSummary): FinancialSummary {
  return {
    roomRevenue: after.roomRevenue - before.roomRevenue,
    paymentsReceived: after.paymentsReceived - before.paymentsReceived,
    refundsPaid: after.refundsPaid - before.refundsPaid,
  };
}

function hasFinancialDelta(delta: FinancialSummary): boolean {
  return Object.values(delta).some((value) => value !== 0);
}

const dateProperty = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const managerRole = (roleName: string) => roleName === "Owner" || roleName === "Manager";

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

class AuditError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export const nightAuditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/date-context", { preHandler: app.authenticate }, async () => {
    const state = await getAuditState(app.db);
    return {
      calendarDate: jakartaDate(),
      businessDate: state.businessDate,
      lastClosedDate: state.lastClosedDate,
      recoveryRequired: state.recoveryRequired,
    };
  });

  app.get("/state", { preHandler: app.requirePermission("night_audit.view") }, async () =>
    getAuditState(app.db),
  );

  app.post<{ Body: SetupBody }>(
    "/setup",
    {
      preHandler: app.requirePermission("night_audit.close"),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["startDate", "confirm"],
          properties: {
            startDate: dateProperty,
            confirm: { type: "boolean", const: true },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = request.authUser!;
      if (!managerRole(actor.roleName)) {
        return reply.code(403).send({
          error: { code: "MANAGER_REQUIRED", message: "Owner or Manager confirmation required" },
        });
      }
      const { startDate } = request.body;
      if (!validDate(startDate) || startDate > jakartaDate()) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_DATE", message: "Start date is invalid" } });
      }
      try {
        return await app.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(734219, 1)`);
          const state = await getAuditState(tx);
          if (
            state.recoveryReason === "date_gap" ||
            state.recoveryReason === "start_date_mismatch"
          ) {
            throw new AuditError(
              "AUDIT_RECOVERY_REQUIRED",
              "Audit history has skipped dates or a mismatched start date.",
            );
          }
          if (state.initialized) {
            throw new AuditError(
              "AUDIT_ALREADY_INITIALIZED",
              "Night audit start date is already set.",
            );
          }
          if (state.closedCount > 0 && startDate !== state.firstClosedDate) {
            throw new AuditError(
              "START_DATE_MUST_MATCH_FIRST_CLOSED",
              "Start date must match the first existing audit snapshot. Review earlier dates manually if they also require audit.",
            );
          }
          await tx.insert(nightAuditSettings).values({ startDate, initializedByUserId: actor.id });
          return getAuditState(tx);
        });
      } catch (error) {
        if (error instanceof AuditError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );

  app.get(
    "/preview",
    {
      preHandler: app.requirePermission("night_audit.view"),
    },
    async (_request, reply) => {
      const state = await getAuditState(app.db);
      if (state.recoveryRequired) {
        return reply.code(409).send({
          error: {
            code: "AUDIT_RECOVERY_REQUIRED",
            message: "Existing audit snapshots require manual recovery.",
          },
        });
      }
      if (!state.initialized || !state.businessDate) {
        return reply.code(409).send({
          error: {
            code: "AUDIT_SETUP_REQUIRED",
            message: "Set the first audit date before previewing.",
          },
        });
      }
      return buildAuditPreview(app.db, state.businessDate, state.lastClosedDate);
    },
  );

  app.get<{ Querystring: HistoryQuery }>(
    "/history",
    {
      preHandler: app.requirePermission("night_audit.view"),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request) => {
      const { page = 1, limit = 20 } = request.query;
      const [items, [total]] = await Promise.all([
        app.db
          .select({
            id: nightAudits.id,
            businessDate: nightAudits.businessDate,
            closedAt: nightAudits.closedAt,
            closedBy: sql<string>`coalesce(${nightAudits.snapshot}->>'closedByName', ${users.name})`,
          })
          .from(nightAudits)
          .innerJoin(users, eq(nightAudits.closedByUserId, users.id))
          .orderBy(desc(nightAudits.businessDate))
          .limit(limit)
          .offset((page - 1) * limit),
        app.db.select({ total: count() }).from(nightAudits),
      ]);
      return { items, total: total.total, page, limit };
    },
  );

  app.get<{ Params: { businessDate: string } }>(
    "/history/:businessDate",
    {
      preHandler: app.requirePermission("night_audit.view"),
      schema: {
        params: {
          type: "object",
          required: ["businessDate"],
          properties: { businessDate: dateProperty },
        },
      },
    },
    async (request, reply) => {
      if (!validDate(request.params.businessDate)) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_DATE", message: "Business date is invalid" } });
      }
      const [audit] = await app.db
        .select({
          id: nightAudits.id,
          businessDate: nightAudits.businessDate,
          closedAt: nightAudits.closedAt,
          closedBy: sql<string>`coalesce(${nightAudits.snapshot}->>'closedByName', ${users.name})`,
          snapshot: nightAudits.snapshot,
        })
        .from(nightAudits)
        .innerJoin(users, eq(nightAudits.closedByUserId, users.id))
        .where(eq(nightAudits.businessDate, request.params.businessDate))
        .limit(1);
      if (!audit) {
        return reply
          .code(404)
          .send({ error: { code: "AUDIT_NOT_FOUND", message: "Audit snapshot not found" } });
      }
      const [corrections, current] = await Promise.all([
        app.db
          .select({
            id: auditLogs.id,
            actorName: users.name,
            reason: auditLogs.reason,
            beforeData: auditLogs.beforeData,
            afterData: auditLogs.afterData,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .innerJoin(users, eq(auditLogs.actorUserId, users.id))
          .where(
            and(
              eq(auditLogs.entityType, "night_audit"),
              eq(auditLogs.entityId, audit.id),
              eq(auditLogs.action, "financial_correction"),
            ),
          )
          .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id)),
        buildAuditPreview(app.db, audit.businessDate, null),
      ]);
      const original = financialSummary((audit.snapshot as AuditPreview).summary);
      const accepted = corrections.length
        ? (corrections[corrections.length - 1].afterData as FinancialSummary)
        : original;
      const actual = financialSummary(current.summary);
      return {
        ...audit,
        corrections: corrections.map((item) => ({
          ...item,
          delta: financialDelta(
            item.beforeData as FinancialSummary,
            item.afterData as FinancialSummary,
          ),
        })),
        financialReconciliation: {
          original,
          accepted,
          actual,
          pendingDelta: financialDelta(accepted, actual),
          previewToken: current.previewToken,
        },
      };
    },
  );

  app.post<{ Params: { businessDate: string }; Body: CorrectionBody }>(
    "/history/:businessDate/corrections",
    {
      preHandler: app.requirePermission("night_audit.close"),
      schema: {
        params: {
          type: "object",
          required: ["businessDate"],
          properties: { businessDate: dateProperty },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason", "previewToken"],
          properties: {
            reason: { type: "string", minLength: 3, maxLength: 1000 },
            previewToken: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = request.authUser!;
      if (!managerRole(actor.roleName)) {
        return reply.code(403).send({
          error: { code: "MANAGER_REQUIRED", message: "Owner or Manager confirmation required" },
        });
      }
      if (!validDate(request.params.businessDate) || !request.body.reason.trim()) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_CORRECTION", message: "Date and reason are required" } });
      }
      try {
        return await app.db.transaction(
          async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(734219, 2)`);
            const [audit] = await tx
              .select()
              .from(nightAudits)
              .where(eq(nightAudits.businessDate, request.params.businessDate))
              .limit(1);
            if (!audit) throw new AuditError("AUDIT_NOT_FOUND", "Audit snapshot not found", 404);
            const [latest] = await tx
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
              .limit(1);
            const before = latest
              ? (latest.afterData as FinancialSummary)
              : financialSummary((audit.snapshot as AuditPreview).summary);
            const current = await buildAuditPreview(tx, audit.businessDate, null);
            if (current.previewToken !== request.body.previewToken)
              throw new AuditError(
                "PREVIEW_CHANGED",
                "Audit data has changed. Refresh the correction preview.",
              );
            const after = financialSummary(current.summary);
            const delta = financialDelta(before, after);
            if (!hasFinancialDelta(delta))
              throw new AuditError(
                "NO_FINANCIAL_CHANGE",
                "No financial difference needs confirmation.",
              );
            const [entry] = await tx
              .insert(auditLogs)
              .values({
                actorUserId: actor.id,
                entityType: "night_audit",
                entityId: audit.id,
                action: "financial_correction",
                beforeData: before,
                afterData: after,
                reason: request.body.reason.trim(),
              })
              .returning({ id: auditLogs.id, createdAt: auditLogs.createdAt });
            return { id: entry.id, createdAt: entry.createdAt, before, after, delta };
          },
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (error instanceof AuditError)
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        throw error;
      }
    },
  );

  app.post<{ Body: CloseBody }>(
    "/close",
    {
      preHandler: app.requirePermission("night_audit.close"),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["businessDate", "previewToken", "confirm"],
          properties: {
            businessDate: dateProperty,
            previewToken: { type: "string", pattern: "^[a-f0-9]{64}$" },
            confirm: { type: "boolean", const: true },
            warningReason: { type: "string", minLength: 3, maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = request.authUser!;
      if (!managerRole(actor.roleName)) {
        return reply.code(403).send({
          error: { code: "MANAGER_REQUIRED", message: "Owner or Manager confirmation required" },
        });
      }
      const { businessDate, previewToken, warningReason } = request.body;
      if (!validDate(businessDate)) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_DATE", message: "Business date is invalid" } });
      }
      try {
        return await app.db.transaction(
          async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(734219, 1)`);
            const state = await getAuditState(tx);
            if (state.recoveryRequired) {
              throw new AuditError(
                "AUDIT_RECOVERY_REQUIRED",
                "Existing audit snapshots require manual recovery.",
              );
            }
            if (!state.initialized) {
              throw new AuditError(
                "AUDIT_SETUP_REQUIRED",
                "Set the first audit date before closing.",
              );
            }
            if (state.businessDate !== businessDate) {
              throw new AuditError(
                "BUSINESS_DATE_CHANGED",
                "Business date has changed. Refresh preview.",
              );
            }
            if (!closeWindowOpen(businessDate)) {
              throw new AuditError(
                "AUDIT_TOO_EARLY",
                "This date can be closed after 06:00 WIB on the next day.",
              );
            }
            const preview = await buildAuditPreview(tx, businessDate, state.lastClosedDate);
            if (preview.previewToken !== previewToken) {
              throw new AuditError("PREVIEW_CHANGED", "Audit data has changed. Refresh preview.");
            }
            if (preview.blockers.length > 0) {
              throw new AuditError("AUDIT_BLOCKED", "Resolve all blockers before closing the day.");
            }
            if (preview.warnings.length > 0 && (warningReason?.trim().length ?? 0) < 3) {
              throw new AuditError(
                "WARNING_REASON_REQUIRED",
                "Manager must provide a reason for warnings.",
              );
            }
            const managerReport = await buildManagerDailySnapshot(
              tx,
              businessDate,
              preview.summary,
            );
            const [closed] = await tx
              .insert(nightAudits)
              .values({
                businessDate,
                closedByUserId: actor.id,
                snapshot: {
                  ...preview,
                  closedByName: actor.name,
                  warningReason: warningReason?.trim() || null,
                  managerReport,
                },
              })
              .returning({ id: nightAudits.id, closedAt: nightAudits.closedAt });
            return {
              id: closed.id,
              businessDate,
              nextBusinessDate: preview.nextBusinessDate,
              closedAt: closed.closedAt,
              snapshot: {
                ...preview,
                closedByName: actor.name,
                warningReason: warningReason?.trim() || null,
                managerReport,
              },
            };
          },
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (error instanceof AuditError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "23505" || error.code === "40001")
        ) {
          return reply.code(409).send({
            error: {
              code: "PREVIEW_CHANGED",
              message: "Audit data has changed. Refresh preview.",
            },
          });
        }
        throw error;
      }
    },
  );
};
