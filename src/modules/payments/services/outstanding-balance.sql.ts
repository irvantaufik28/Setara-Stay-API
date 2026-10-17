import { sql } from "drizzle-orm";
import { paymentRefunds } from "../../../db/schema/payment_refunds.schema.js";
import { payments } from "../../../db/schema/payments.schema.js";
import { reservationCharges } from "../../../db/schema/reservation_charges.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";

export const bookingTotal = sql<number>`coalesce((
  select sum(c.amount) from ${reservationCharges} c
  where c.reservation_id = ${reservations.id}
), 0)::bigint`.mapWith(Number);

export const grossPaid = sql<number>`coalesce((
  select sum(p.amount) from ${payments} p
  where p.reservation_id = ${reservations.id}
    and p.status in ('succeeded', 'partially_refunded', 'refunded')
), 0)::bigint`.mapWith(Number);

export const refunded = sql<number>`coalesce((
  select sum(r.amount) from ${paymentRefunds} r
  join ${payments} p on p.id = r.payment_id
  where p.reservation_id = ${reservations.id} and r.status = 'succeeded'
), 0)::bigint`.mapWith(Number);

export const remainingBalance =
  sql<number>`greatest(0, ${bookingTotal} - ${grossPaid} + ${refunded})`.mapWith(Number);
