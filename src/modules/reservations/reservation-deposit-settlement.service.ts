import { eq } from "drizzle-orm";
import { payments } from "../../db/schema/payments.schema.js";
import { reservationCharges } from "../../db/schema/reservation_charges.schema.js";
import { reservationDeposits } from "../../db/schema/reservation_deposits.schema.js";
import type { Database } from "../../plugins/database.js";
import { recordReservationEvent } from "./services/reservation-events.service.js";
import type { readReservationFinancials } from "./services/reservation-financials.service.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Financials = Awaited<ReturnType<typeof readReservationFinancials>>;

export type CheckoutDepositDecision = {
  depositId: string;
  refundAmount?: number;
  deductionAmount?: number;
  damageAmount?: number;
  deductionPurpose?: "balance" | "damage";
  deferRemaining?: boolean;
  reason?: string;
  refundReference?: string;
};

export class DepositSettlementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export function validateCheckoutDeposits(
  financials: Financials,
  decisions: CheckoutDepositDecision[],
): void {
  const active = financials.deposits.filter(
    (deposit) => deposit.amountHeld > deposit.amountRefunded + deposit.amountDeducted,
  );
  if (new Set(decisions.map((decision) => decision.depositId)).size !== decisions.length) {
    throw new DepositSettlementError(
      "DUPLICATE_DEPOSIT",
      "A deposit was included more than once",
      400,
    );
  }
  if (
    decisions.length !== active.length ||
    decisions.some((decision) => !active.some((deposit) => deposit.id === decision.depositId))
  ) {
    throw new DepositSettlementError(
      "DEPOSIT_DECISION_REQUIRED",
      "Provide one settlement decision for every deposit with a held balance",
    );
  }

  let availableBookingBalance = financials.remainingBalance;
  for (const decision of decisions) {
    const deposit = active.find((item) => item.id === decision.depositId)!;
    const refundAmount = decision.refundAmount ?? 0;
    const deductionAmount = decision.deductionAmount ?? 0;
    const remaining = deposit.amountHeld - deposit.amountRefunded - deposit.amountDeducted;
    const deferred = remaining - refundAmount - deductionAmount;
    if (decision.damageAmount !== undefined) {
      if (
        decision.deductionPurpose !== "damage" ||
        !Number.isSafeInteger(decision.damageAmount) ||
        decision.damageAmount <= 0 ||
        deductionAmount !== Math.min(remaining, decision.damageAmount) ||
        refundAmount !== remaining - deductionAmount
      ) {
        throw new DepositSettlementError(
          "INVALID_DAMAGE_SETTLEMENT",
          "Damage charge, deposit deduction, and refund must settle the deposit exactly",
          400,
        );
      }
    }
    if (refundAmount + deductionAmount === 0 && !decision.deferRemaining) {
      throw new DepositSettlementError(
        "INVALID_DEPOSIT_DECISION",
        "Choose refund, deduction, or defer",
      );
    }
    if (deferred < 0 || (deferred > 0 && !decision.deferRemaining)) {
      throw new DepositSettlementError(
        "INVALID_DEPOSIT_AMOUNT",
        "Deposit amounts must fit the held balance; defer any unsettled remainder",
      );
    }
    if (refundAmount > 0 && !decision.refundReference?.trim()) {
      throw new DepositSettlementError(
        "REFUND_REFERENCE_REQUIRED",
        "Record the completed deposit refund reference",
      );
    }
    if (deductionAmount > 0 && !decision.deductionPurpose) {
      throw new DepositSettlementError(
        "DEDUCTION_PURPOSE_REQUIRED",
        "Choose balance or damage for the deduction",
      );
    }
    if ((refundAmount > 0 || deductionAmount > 0) && !decision.reason?.trim()) {
      throw new DepositSettlementError(
        "DEPOSIT_REASON_REQUIRED",
        "Provide a reason for deposit settlement",
      );
    }
    if (deductionAmount > 0 && !deposit.methodId) {
      throw new DepositSettlementError(
        "DEPOSIT_METHOD_REQUIRED",
        "Deposit payment method is missing",
      );
    }
    if (decision.deductionPurpose === "balance") {
      if (deductionAmount > availableBookingBalance) {
        throw new DepositSettlementError(
          "DEDUCTION_EXCEEDS_BALANCE",
          "Deposit deduction exceeds the remaining booking balance",
        );
      }
      availableBookingBalance -= deductionAmount;
    }
    if (decision.deductionPurpose === "damage") {
      availableBookingBalance += (decision.damageAmount ?? deductionAmount) - deductionAmount;
    }
  }
}

export async function settleCheckoutDeposits(
  tx: Transaction,
  input: {
    reservationId: string;
    actorUserId: string;
    reservationStatus: "checked_in";
    paymentStatus: "unpaid" | "partial" | "paid" | "failed" | "expired" | "refunded";
    financials: Financials;
    decisions: CheckoutDepositDecision[];
  },
) {
  let currentBookingTotal = input.financials.bookingTotal;
  let currentPaidAmount = input.financials.netPaidAmount;
  let currentPaymentStatus = input.paymentStatus;
  const outcomes = [];

  for (const decision of input.decisions) {
    const deposit = input.financials.deposits.find((item) => item.id === decision.depositId)!;
    const refundAmount = decision.refundAmount ?? 0;
    const deductionAmount = decision.deductionAmount ?? 0;
    const reason = decision.reason?.trim() || null;
    const damageAmount =
      decision.deductionPurpose === "damage" ? (decision.damageAmount ?? deductionAmount) : 0;
    const refundedTotal = deposit.amountRefunded + refundAmount;
    const deductedTotal = deposit.amountDeducted + deductionAmount;
    const remaining = deposit.amountHeld - refundedTotal - deductedTotal;

    let damageChargeId: string | null = null;
    if (damageAmount > 0) {
      const [charge] = await tx
        .insert(reservationCharges)
        .values({
          reservationId: input.reservationId,
          kind: "adjustment",
          sourceId: deposit.id,
          description: `Damage charge at checkout: ${reason}`,
          quantity: "1",
          unitAmount: damageAmount,
          amount: damageAmount,
          createdByUserId: input.actorUserId,
        })
        .returning({ id: reservationCharges.id });
      damageChargeId = charge.id;
      currentBookingTotal += damageAmount;
    }
    if (deductionAmount > 0) {
      const paidAt = new Date();
      const [payment] = await tx
        .insert(payments)
        .values({
          reservationId: input.reservationId,
          methodId: deposit.methodId!,
          provider: "deposit_transfer",
          amount: deductionAmount,
          status: "succeeded",
          paidAt,
          recordedByUserId: input.actorUserId,
          notes: `Deposit ${deposit.id} applied to ${decision.deductionPurpose}: ${reason}`,
        })
        .returning({ id: payments.id });
      currentPaidAmount += deductionAmount;
      const nextPaymentStatus =
        currentPaidAmount >= currentBookingTotal
          ? "paid"
          : currentPaidAmount > 0
            ? "partial"
            : "unpaid";
      await recordReservationEvent(tx, {
        reservationId: input.reservationId,
        eventType: "payment.recorded",
        actorType: "user",
        actorUserId: input.actorUserId,
        occurredAt: paidAt,
        reservationStatusBefore: input.reservationStatus,
        reservationStatusAfter: input.reservationStatus,
        paymentStatusBefore: currentPaymentStatus,
        paymentStatusAfter: nextPaymentStatus,
        referenceId: payment.id,
        details: {
          amount: deductionAmount,
          source: "deposit_transfer",
          depositId: deposit.id,
          deductionPurpose: decision.deductionPurpose,
        },
      });
      currentPaymentStatus = nextPaymentStatus;
    }

    const status =
      remaining > 0
        ? refundedTotal > 0
          ? "partially_refunded"
          : "held"
        : deductedTotal > 0
          ? "deducted"
          : "refunded";
    if (refundAmount > 0 || deductionAmount > 0) {
      await tx
        .update(reservationDeposits)
        .set({
          amountRefunded: refundedTotal,
          amountDeducted: deductedTotal,
          status,
          updatedAt: new Date(),
        })
        .where(eq(reservationDeposits.id, deposit.id));
    }
    await recordReservationEvent(tx, {
      reservationId: input.reservationId,
      eventType: remaining > 0 ? "deposit.deferred" : "deposit.settled",
      actorType: "user",
      actorUserId: input.actorUserId,
      reservationStatusBefore: input.reservationStatus,
      reservationStatusAfter: input.reservationStatus,
      paymentStatusBefore: currentPaymentStatus,
      paymentStatusAfter: currentPaymentStatus,
      referenceId: deposit.id,
      details: {
        refundAmount,
        deductionAmount,
        damageAmount,
        damageChargeId,
        deductionPurpose: decision.deductionPurpose ?? null,
        remaining,
        reason,
        refundReference: decision.refundReference?.trim() || null,
      },
    });
    outcomes.push({
      depositId: deposit.id,
      refundAmount,
      deductionAmount,
      damageAmount,
      remaining,
      status,
    });
  }

  return outcomes;
}
