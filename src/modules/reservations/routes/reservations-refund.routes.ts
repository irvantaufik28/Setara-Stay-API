import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { masterItems } from "../../../db/schema/master_items.schema.js";
import { paymentRefunds } from "../../../db/schema/payment_refunds.schema.js";
import { payments } from "../../../db/schema/payments.schema.js";
import { reservationDeposits } from "../../../db/schema/reservation_deposits.schema.js";
import {
  DepositSettlementError,
  settleCheckoutDeposits,
  validateCheckoutDeposits,
} from "../reservation-deposit-settlement.service.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import { uuidSchema } from "../../master/master.shared.js";
import { recordReservationEvent } from "../services/reservation-events.service.js";
import { readReservationFinancials } from "../services/reservation-financials.service.js";
import { getNoRefundDecision } from "../services/reservation-no-refund.service.js";
import {
  calculateRefundSettlement,
  refundAllowed,
} from "../services/reservation-refund-settlement.service.js";
import { paymentStatusAfterCancellationRefund } from "../services/reservation-refund-status.service.js";

type RefundParams = { id: string };
type RefundBody = {
  paymentId: string;
  amount: number;
  reason: string;
  reference: string;
  ignoreCancellationPolicy?: boolean;
  settlementOverrideReason?: string;
};
type PostCheckoutDepositBody = {
  action: "refund" | "damage";
  expectedBalance: number;
  damageAmount?: number;
  reason: string;
  refundReference?: string;
  refundCompleted?: boolean;
};

const paramsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: uuidSchema },
} as const;

const depositRefundParamsSchema = {
  type: "object",
  required: ["id", "depositId"],
  properties: { id: uuidSchema, depositId: uuidSchema },
} as const;

const bodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["paymentId", "amount", "reason", "reference"],
  properties: {
    paymentId: uuidSchema,
    amount: { type: "integer", minimum: 1, maximum: 9007199254740991 },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
    reference: { type: "string", minLength: 1, maxLength: 160 },
    ignoreCancellationPolicy: { type: "boolean", default: false },
    settlementOverrideReason: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

class RefundInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export const reservationRefundRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: RefundParams & { depositId: string };
    Body: PostCheckoutDepositBody;
  }>(
    "/:id/deposits/:depositId/settle",
    {
      preHandler: app.requirePermission("payments.refund"),
      schema: {
        params: depositRefundParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action", "expectedBalance", "reason"],
          properties: {
            action: { type: "string", enum: ["refund", "damage"] },
            expectedBalance: { type: "integer", minimum: 1, maximum: 9007199254740991 },
            damageAmount: { type: "integer", minimum: 1, maximum: 9007199254740991 },
            reason: { type: "string", minLength: 1, maxLength: 2000 },
            refundReference: { type: "string", maxLength: 160 },
            refundCompleted: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { action, damageAmount } = request.body;
      const reason = request.body.reason.trim();
      const refundReference = request.body.refundReference?.trim() ?? "";
      if (
        !reason ||
        (action === "refund" && damageAmount !== undefined) ||
        (action === "damage" && !damageAmount)
      ) {
        return reply.code(400).send({
          error: {
            code: "INVALID_DEPOSIT_SETTLEMENT",
            message: "Choose a valid action and provide a reason",
          },
        });
      }
      if (action === "damage" && !["Owner", "Manager"].includes(request.authUser!.roleName)) {
        return reply.code(403).send({
          error: {
            code: "MANAGER_REQUIRED",
            message: "Owner or Manager approval is required for post-checkout damage",
          },
        });
      }
      try {
        const result = await app.db.transaction(async (tx) => {
          const [reservation] = await tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, request.params.id))
            .for("update")
            .limit(1);
          if (!reservation)
            throw new RefundInputError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
          if (reservation.reservationStatus !== "checked_out") {
            throw new RefundInputError(
              "DEPOSIT_SETTLEMENT_NOT_ALLOWED",
              "Only checked-out reservations can use this settlement",
              409,
            );
          }
          const [deposit] = await tx
            .select()
            .from(reservationDeposits)
            .where(
              and(
                eq(reservationDeposits.id, request.params.depositId),
                eq(reservationDeposits.reservationId, reservation.id),
              ),
            )
            .for("update")
            .limit(1);
          if (!deposit) throw new RefundInputError("DEPOSIT_NOT_FOUND", "Deposit not found", 404);
          const heldBalance = deposit.amountHeld - deposit.amountRefunded - deposit.amountDeducted;
          if (heldBalance <= 0)
            throw new RefundInputError(
              "DEPOSIT_ALREADY_SETTLED",
              "Deposit has already been settled",
              409,
            );
          if (heldBalance !== request.body.expectedBalance) {
            throw new RefundInputError(
              "DEPOSIT_BALANCE_CHANGED",
              "Deposit balance changed. Refresh before settling it",
              409,
            );
          }
          const deductionAmount = action === "damage" ? Math.min(heldBalance, damageAmount!) : 0;
          const refundAmount = heldBalance - deductionAmount;
          if (refundAmount > 0 && (!refundReference || request.body.refundCompleted !== true)) {
            throw new RefundInputError(
              "REFUND_CONFIRMATION_REQUIRED",
              "Confirm the completed refund and provide its reference",
              400,
            );
          }
          const financials = await readReservationFinancials(tx, reservation.id);
          const scopedFinancials = { ...financials, deposits: [deposit] };
          const decision = {
            depositId: deposit.id,
            refundAmount,
            deductionAmount,
            ...(action === "damage" ? { damageAmount, deductionPurpose: "damage" as const } : {}),
            reason,
            refundReference: refundAmount > 0 ? refundReference : undefined,
          };
          validateCheckoutDeposits(scopedFinancials, [decision]);
          const outcomes = await settleCheckoutDeposits(tx, {
            reservationId: reservation.id,
            actorUserId: request.authUser!.id,
            reservationStatus: "checked_out",
            source: "post_checkout",
            paymentStatus: reservation.paymentStatus,
            financials: scopedFinancials,
            decisions: [decision],
          });
          const after = await readReservationFinancials(tx, reservation.id);
          const paymentStatus =
            action === "refund"
              ? reservation.paymentStatus
              : after.remainingBalance === 0
                ? "paid"
                : after.netPaidAmount > 0
                  ? "partial"
                  : "unpaid";
          await tx
            .update(reservations)
            .set({
              paymentStatus,
              version: sql`${reservations.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(reservations.id, reservation.id));
          return {
            reservationId: reservation.id,
            depositId: deposit.id,
            action,
            refundAmount,
            deductionAmount,
            damageAmount: action === "damage" ? damageAmount : 0,
            depositBalance: after.depositBalance,
            remainingBalance: after.remainingBalance,
            paymentStatus,
            outcome: outcomes[0],
          };
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof RefundInputError || error instanceof DepositSettlementError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );

  app.post<{
    Params: RefundParams & { depositId: string };
    Body: { reason: string; reference: string };
  }>(
    "/:id/deposits/:depositId/refund",
    {
      preHandler: app.requirePermission("payments.refund"),
      schema: {
        params: depositRefundParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason", "reference"],
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 2000 },
            reference: { type: "string", minLength: 1, maxLength: 160 },
          },
        },
      },
    },
    async (request, reply) => {
      const reason = request.body.reason.trim();
      const reference = request.body.reference.trim();
      if (!reason || !reference) {
        return reply.code(400).send({
          error: {
            code: "INVALID_DEPOSIT_REFUND",
            message: "Reason and refund reference are required",
          },
        });
      }

      try {
        const result = await app.db.transaction(async (tx) => {
          const [reservation] = await tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, request.params.id))
            .for("update")
            .limit(1);
          if (!reservation) {
            throw new RefundInputError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
          }
          if (reservation.reservationStatus !== "no_show") {
            throw new RefundInputError(
              "DEPOSIT_REFUND_NOT_ALLOWED",
              "No-show deposit refunds require a no-show reservation",
            );
          }
          const [deposit] = await tx
            .select()
            .from(reservationDeposits)
            .where(
              and(
                eq(reservationDeposits.id, request.params.depositId),
                eq(reservationDeposits.reservationId, reservation.id),
              ),
            )
            .for("update")
            .limit(1);
          if (!deposit) {
            throw new RefundInputError("DEPOSIT_NOT_FOUND", "Deposit not found", 404);
          }
          const amount = deposit.amountHeld - deposit.amountRefunded - deposit.amountDeducted;
          if (amount <= 0) {
            throw new RefundInputError(
              "DEPOSIT_ALREADY_SETTLED",
              "Deposit has already been settled",
            );
          }
          const occurredAt = new Date();
          await tx
            .update(reservationDeposits)
            .set({
              amountRefunded: deposit.amountRefunded + amount,
              status: "refunded",
              notes: [deposit.notes, `Refund ${reference}: ${reason}`].filter(Boolean).join("\n"),
              updatedAt: occurredAt,
            })
            .where(eq(reservationDeposits.id, deposit.id));
          await recordReservationEvent(tx, {
            reservationId: reservation.id,
            eventType: "deposit.settled",
            actorType: "user",
            actorUserId: request.authUser!.id,
            occurredAt,
            reservationStatusBefore: "no_show",
            reservationStatusAfter: "no_show",
            paymentStatusBefore: reservation.paymentStatus,
            paymentStatusAfter: reservation.paymentStatus,
            referenceId: deposit.id,
            details: {
              refundAmount: amount,
              deductionAmount: 0,
              remaining: 0,
              reason,
              refundReference: reference,
              source: "no_show_settlement",
            },
          });
          return { depositId: deposit.id, amount, status: "refunded", reference };
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof RefundInputError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: RefundParams }>(
    "/:id/refund-eligibility",
    {
      preHandler: app.requirePermission("payments.view_detail"),
      schema: { params: paramsSchema },
    },
    async (request, reply) => {
      const [reservation] = await app.db
        .select()
        .from(reservations)
        .where(eq(reservations.id, request.params.id))
        .limit(1);
      if (!reservation) {
        return reply.code(404).send({
          error: { code: "RESERVATION_NOT_FOUND", message: "Reservation not found" },
        });
      }
      if (!refundAllowed(reservation)) {
        return reply.code(409).send({
          error: {
            code: "REFUND_NOT_ALLOWED",
            message: "Only cancelled or no-show reservations can be refunded",
          },
        });
      }
      const [settlement, financials, noRefundDecision] = await Promise.all([
        calculateRefundSettlement(app.db, reservation),
        readReservationFinancials(app.db, reservation.id),
        getNoRefundDecision(app.db, reservation.id),
      ]);
      const methodIds = [...new Set(financials.payments.map((payment) => payment.methodId))];
      const methods = methodIds.length
        ? await app.db
            .select({ id: masterItems.id, name: masterItems.name })
            .from(masterItems)
            .where(inArray(masterItems.id, methodIds))
        : [];
      const methodById = new Map(methods.map((method) => [method.id, method.name]));
      return {
        reservationId: reservation.id,
        bookingCode: reservation.bookingCode,
        source: reservation.source,
        reservationStatus: reservation.reservationStatus,
        hasCancellationPolicySnapshot:
          reservation.reservationStatus === "no_show" ||
          reservation.cancellationPolicySnapshot !== null,
        noRefundDecision,
        settlement,
        grossPaidAmount: financials.grossPaidAmount,
        refundedAmount: financials.refundedAmount,
        pendingRefundAmount: financials.pendingRefundAmount,
        maxRefundWithOverride: Math.max(
          0,
          financials.netPaidAmount - financials.pendingRefundAmount,
        ),
        refunds: financials.refunds.map((refund) => ({
          id: refund.id,
          paymentId: refund.paymentId,
          amount: refund.amount,
          status: refund.status,
          reason: refund.reason,
          reference: refund.providerReference,
          processedAt: refund.processedAt,
        })),
        deposits: financials.deposits.map((deposit) => ({
          id: deposit.id,
          amountHeld: deposit.amountHeld,
          amountRefunded: deposit.amountRefunded,
          amountDeducted: deposit.amountDeducted,
          refundableRemaining: Math.max(
            0,
            deposit.amountHeld - deposit.amountRefunded - deposit.amountDeducted,
          ),
          status: deposit.status,
        })),
        payments: financials.payments
          .filter((payment) => ["succeeded", "partially_refunded"].includes(payment.status))
          .map((payment) => {
            const refunds = financials.refunds.filter((refund) => refund.paymentId === payment.id);
            const refundedAmount = refunds.reduce(
              (sum, refund) => sum + (refund.status === "succeeded" ? refund.amount : 0),
              0,
            );
            const pendingAmount = refunds.reduce(
              (sum, refund) => sum + (refund.status === "pending" ? refund.amount : 0),
              0,
            );
            return {
              id: payment.id,
              methodId: payment.methodId,
              methodName: methodById.get(payment.methodId) ?? null,
              paidAt: payment.paidAt,
              status: payment.status,
              amount: payment.amount,
              refundedAmount,
              pendingAmount,
              refundableRemaining: Math.max(0, payment.amount - refundedAmount - pendingAmount),
            };
          }),
      };
    },
  );

  app.post<{ Params: RefundParams; Body: RefundBody }>(
    "/:id/refunds",
    {
      preHandler: app.requirePermission("payments.refund"),
      schema: { params: paramsSchema, body: bodySchema },
    },
    async (request, reply) => {
      const reason = request.body.reason.trim();
      const reference = request.body.reference.trim();
      if (!reason || !reference) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REFUND_DETAILS",
            message: "Reason and refund reference are required",
          },
        });
      }

      try {
        const result = await app.db.transaction(async (tx) => {
          const [reservation] = await tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, request.params.id))
            .for("update")
            .limit(1);
          if (!reservation) {
            throw new RefundInputError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
          }
          if (!refundAllowed(reservation)) {
            throw new RefundInputError(
              "REFUND_NOT_ALLOWED",
              "Only cancelled or no-show reservations can be refunded",
            );
          }
          if (await getNoRefundDecision(tx, reservation.id)) {
            throw new RefundInputError(
              "REFUND_ALREADY_SETTLED",
              "This reservation was closed without a refund",
            );
          }

          const [payment] = await tx
            .select()
            .from(payments)
            .where(
              and(
                eq(payments.id, request.body.paymentId),
                eq(payments.reservationId, reservation.id),
              ),
            )
            .for("update")
            .limit(1);
          if (!payment) {
            throw new RefundInputError(
              "PAYMENT_NOT_FOUND",
              "Payment not found for this reservation",
              404,
            );
          }
          if (!["succeeded", "partially_refunded"].includes(payment.status)) {
            throw new RefundInputError("PAYMENT_NOT_REFUNDABLE", "Payment is not refundable");
          }

          const settlement = await calculateRefundSettlement(tx, reservation);
          const financials = await readReservationFinancials(tx, reservation.id);
          const existingRefunds = financials.refunds;
          const paymentRefundsSoFar = existingRefunds.filter(
            (item) => item.paymentId === payment.id,
          );
          if (paymentRefundsSoFar.some((item) => item.providerReference === reference)) {
            throw new RefundInputError(
              "DUPLICATE_REFUND_REFERENCE",
              "This refund reference has already been recorded for the payment",
            );
          }
          const completedForPayment = paymentRefundsSoFar.reduce(
            (sum, item) => sum + (item.status === "succeeded" ? item.amount : 0),
            0,
          );
          const reservedForPayment = paymentRefundsSoFar.reduce(
            (sum, item) => sum + (item.status === "pending" ? item.amount : 0),
            0,
          );
          if (request.body.amount > payment.amount - completedForPayment - reservedForPayment) {
            throw new RefundInputError(
              "REFUND_AMOUNT_EXCEEDED",
              "Refund amount exceeds the unrefunded payment balance",
            );
          }
          const ignoreCancellationPolicy = request.body.ignoreCancellationPolicy === true;
          const settlementOverrideReason = request.body.settlementOverrideReason?.trim();
          if (
            (ignoreCancellationPolicy ||
              settlement.calculationStatus === "manual_review_required") &&
            !settlementOverrideReason
          ) {
            throw new RefundInputError(
              "SETTLEMENT_REVIEW_REQUIRED",
              "Review the cancellation settlement and provide settlementOverrideReason",
            );
          }
          if (
            !ignoreCancellationPolicy &&
            request.body.amount >
              Math.max(
                0,
                (settlement.amounts.maximumRefundWithoutOverride ?? 0) -
                  financials.pendingRefundAmount,
              )
          ) {
            throw new RefundInputError(
              "REFUND_EXCEEDS_SETTLEMENT",
              "Refund amount exceeds the remaining cancellation settlement refund",
            );
          }

          const processedAt = new Date();
          const [refund] = await tx
            .insert(paymentRefunds)
            .values({
              paymentId: payment.id,
              amount: request.body.amount,
              reason,
              status: "succeeded",
              providerReference: reference,
              processedByUserId: request.authUser!.id,
              processedAt,
            })
            .returning();

          const refundedForPayment = completedForPayment + refund.amount;
          const paymentStatus =
            refundedForPayment === payment.amount ? "refunded" : "partially_refunded";
          await tx
            .update(payments)
            .set({
              status: paymentStatus,
              version: sql`${payments.version} + 1`,
              updatedAt: processedAt,
            })
            .where(eq(payments.id, payment.id));

          const netPaidAmount = financials.netPaidAmount - refund.amount;
          const reservationPaymentStatus = paymentStatusAfterCancellationRefund(
            financials.grossPaidAmount,
            netPaidAmount,
            financials.bookingTotal,
          );
          await tx
            .update(reservations)
            .set({
              paymentStatus: reservationPaymentStatus,
              version: sql`${reservations.version} + 1`,
              updatedAt: processedAt,
            })
            .where(eq(reservations.id, reservation.id));

          await recordReservationEvent(tx, {
            reservationId: reservation.id,
            eventType: "payment.refunded",
            actorType: "user",
            actorUserId: request.authUser!.id,
            occurredAt: processedAt,
            reservationStatusBefore: reservation.reservationStatus,
            reservationStatusAfter: reservation.reservationStatus,
            paymentStatusBefore: reservation.paymentStatus,
            paymentStatusAfter: reservationPaymentStatus,
            referenceId: refund.id,
            details: {
              paymentId: payment.id,
              amount: refund.amount,
              reason,
              reference,
              settlementCalculationStatus: settlement.calculationStatus,
              cancellationPolicyOverridden: ignoreCancellationPolicy,
              settlementOverrideReason: settlementOverrideReason ?? null,
              settlementReviewReasons: settlement.reviewReasons,
              cancellationPolicySnapshot: reservation.cancellationPolicySnapshot,
              estimatedRefundAmountBefore: settlement.amounts.estimatedRefundAmount,
              paymentRefundedAmount: refundedForPayment,
              netPaidAmount,
            },
          });

          return {
            refund,
            paymentStatus,
            reservationPaymentStatus,
            paymentRefundableRemaining: payment.amount - refundedForPayment - reservedForPayment,
            netPaidAmount,
          };
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof RefundInputError) {
          return reply.code(error.statusCode).send({
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: RefundParams; Body: { reason: string } }>(
    "/:id/refunds/no-refund",
    {
      preHandler: app.requirePermission("payments.refund"),
      schema: {
        params: paramsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: { reason: { type: "string", minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const reason = request.body.reason.trim();
      if (!reason) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_REASON", message: "Reason is required" } });
      }
      try {
        const result = await app.db.transaction(async (tx) => {
          const [reservation] = await tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, request.params.id))
            .for("update")
            .limit(1);
          if (!reservation)
            throw new RefundInputError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
          if (!refundAllowed(reservation)) {
            throw new RefundInputError(
              "REFUND_NOT_ALLOWED",
              "Only cancelled or no-show reservations can be refunded",
            );
          }
          if (await getNoRefundDecision(tx, reservation.id)) {
            throw new RefundInputError(
              "NO_REFUND_ALREADY_RECORDED",
              "No Refund has already been recorded",
            );
          }
          const [settlement, financials] = await Promise.all([
            calculateRefundSettlement(tx, reservation),
            readReservationFinancials(tx, reservation.id),
          ]);
          if (financials.pendingRefundAmount > 0 || financials.refundedAmount > 0) {
            throw new RefundInputError(
              "REFUND_IN_PROGRESS",
              "Resolve existing refunds before recording No Refund",
            );
          }
          if (reservation.reservationStatus === "no_show" && financials.depositBalance > 0) {
            throw new RefundInputError(
              "DEPOSIT_REFUND_REQUIRED",
              "Return the security deposit before closing settlement without a refund",
            );
          }
          if (financials.grossPaidAmount <= 0) {
            throw new RefundInputError(
              "NO_PAYMENT_TO_REFUND",
              "No payment was received for this reservation",
            );
          }
          if ((settlement.amounts.maximumRefundWithoutOverride ?? 0) > 0) {
            throw new RefundInputError(
              "REFUND_AVAILABLE",
              "A refund is due under the cancellation policy",
            );
          }
          const occurredAt = new Date();
          await recordReservationEvent(tx, {
            reservationId: reservation.id,
            eventType: "payment.no_refund",
            actorType: "user",
            actorUserId: request.authUser!.id,
            occurredAt,
            reservationStatusBefore: reservation.reservationStatus,
            reservationStatusAfter: reservation.reservationStatus,
            paymentStatusBefore: reservation.paymentStatus,
            paymentStatusAfter: reservation.paymentStatus,
            details: {
              reason,
              netPaidAmount: financials.netPaidAmount,
              cancellationCharge: settlement.amounts.cancellationCharge,
              calculationStatus: settlement.calculationStatus,
              reviewReasons: settlement.reviewReasons,
              cancellationPolicySnapshot: reservation.cancellationPolicySnapshot,
            },
          });
          return {
            status: "no_refund",
            reason,
            occurredAt,
            paymentStatus: reservation.paymentStatus,
          };
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof RefundInputError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );

  app.post<{
    Params: RefundParams;
    Body: {
      expectedAmount: number;
      reason: string;
      ignoreCancellationPolicy?: boolean;
      settlementOverrideReason?: string;
    };
  }>(
    "/:id/refunds/complete-settlement",
    {
      preHandler: app.requirePermission("payments.refund"),
      schema: {
        params: paramsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedAmount", "reason"],
          properties: {
            expectedAmount: { type: "integer", minimum: 1, maximum: 9007199254740991 },
            reason: { type: "string", minLength: 1, maxLength: 2000 },
            ignoreCancellationPolicy: { type: "boolean", default: false },
            settlementOverrideReason: { type: "string", minLength: 1, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const reason = request.body.reason.trim();
      const reviewReason = request.body.settlementOverrideReason?.trim();
      if (!reason) {
        return reply.code(400).send({
          error: { code: "INVALID_REFUND_REASON", message: "Refund reason is required" },
        });
      }

      try {
        const result = await app.db.transaction(async (tx) => {
          const [reservation] = await tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, request.params.id))
            .for("update")
            .limit(1);
          if (!reservation) {
            throw new RefundInputError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
          }
          if (!refundAllowed(reservation)) {
            throw new RefundInputError(
              "REFUND_NOT_ALLOWED",
              "Only cancelled or no-show reservations can be refunded",
            );
          }
          if (await getNoRefundDecision(tx, reservation.id)) {
            throw new RefundInputError(
              "REFUND_ALREADY_SETTLED",
              "This reservation was closed without a refund",
            );
          }

          const ignorePolicy = request.body.ignoreCancellationPolicy === true;
          if (
            ignorePolicy &&
            reservation.reservationStatus !== "no_show" &&
            !reservation.cancellationPolicySnapshot
          ) {
            throw new RefundInputError(
              "REFUND_OVERRIDE_NOT_ALLOWED",
              "No policy is available to override",
            );
          }
          const [settlement, financials] = await Promise.all([
            calculateRefundSettlement(tx, reservation),
            readReservationFinancials(tx, reservation.id),
          ]);
          if (financials.pendingRefundAmount > 0) {
            throw new RefundInputError(
              "REFUND_ALREADY_PENDING",
              "Complete or fail pending refunds first",
            );
          }
          if (
            (ignorePolicy || settlement.calculationStatus === "manual_review_required") &&
            !reviewReason
          ) {
            throw new RefundInputError(
              "SETTLEMENT_REVIEW_REQUIRED",
              "Settlement review reason is required",
            );
          }
          if (!ignorePolicy && settlement.amounts.maximumRefundWithoutOverride === null) {
            throw new RefundInputError(
              "SETTLEMENT_REVIEW_REQUIRED",
              "Cancellation refund cannot be calculated from the saved policy",
            );
          }

          const amount = ignorePolicy
            ? financials.netPaidAmount
            : settlement.amounts.maximumRefundWithoutOverride!;
          if (amount <= 0) {
            throw new RefundInputError(
              "REFUND_NOT_AVAILABLE",
              "No refund remains for this reservation",
            );
          }
          if (request.body.expectedAmount !== amount) {
            throw new RefundInputError(
              "REFUND_AMOUNT_CHANGED",
              "Refund amount changed. Refresh and review the calculation",
            );
          }

          const processedAt = new Date();
          const refundablePayments = financials.payments
            .filter((payment) => ["succeeded", "partially_refunded"].includes(payment.status))
            .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
          let remaining = amount;
          const completedRefunds = [];

          for (const payment of refundablePayments) {
            if (remaining === 0) break;
            const refundedForPayment = financials.refunds
              .filter((refund) => refund.paymentId === payment.id && refund.status === "succeeded")
              .reduce((sum, refund) => sum + refund.amount, 0);
            const available = payment.amount - refundedForPayment;
            const part = Math.min(remaining, available);
            if (part <= 0) continue;
            const [refund] = await tx
              .insert(paymentRefunds)
              .values({
                paymentId: payment.id,
                amount: part,
                reason,
                status: "succeeded",
                providerReference: `MANUAL-${randomUUID()}`,
                processedByUserId: request.authUser!.id,
                processedAt,
              })
              .returning();
            await tx
              .update(payments)
              .set({
                status:
                  refundedForPayment + part === payment.amount ? "refunded" : "partially_refunded",
                version: sql`${payments.version} + 1`,
                updatedAt: processedAt,
              })
              .where(eq(payments.id, payment.id));
            completedRefunds.push(refund);
            remaining -= part;
          }
          if (remaining !== 0) {
            throw new RefundInputError(
              "REFUND_AMOUNT_EXCEEDED",
              "Refund exceeds the available payments",
            );
          }

          const netPaidAmount = financials.netPaidAmount - amount;
          const reservationPaymentStatus = paymentStatusAfterCancellationRefund(
            financials.grossPaidAmount,
            netPaidAmount,
            financials.bookingTotal,
          );
          await tx
            .update(reservations)
            .set({
              paymentStatus: reservationPaymentStatus,
              version: sql`${reservations.version} + 1`,
              updatedAt: processedAt,
            })
            .where(eq(reservations.id, reservation.id));
          await recordReservationEvent(tx, {
            reservationId: reservation.id,
            eventType: "payment.refunded",
            actorType: "user",
            actorUserId: request.authUser!.id,
            occurredAt: processedAt,
            reservationStatusBefore: reservation.reservationStatus,
            reservationStatusAfter: reservation.reservationStatus,
            paymentStatusBefore: reservation.paymentStatus,
            paymentStatusAfter: reservationPaymentStatus,
            referenceId: completedRefunds[0].id,
            details: {
              amount,
              refundIds: completedRefunds.map((refund) => refund.id),
              reason,
              cancellationPolicyOverridden: ignorePolicy,
              settlementOverrideReason: reviewReason ?? null,
              cancellationPolicySnapshot: reservation.cancellationPolicySnapshot,
              cancellationCharge: settlement.amounts.cancellationCharge,
              netPaidAmount,
            },
          });
          return { amount, refunds: completedRefunds, reservationPaymentStatus, netPaidAmount };
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof RefundInputError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    },
  );
};
