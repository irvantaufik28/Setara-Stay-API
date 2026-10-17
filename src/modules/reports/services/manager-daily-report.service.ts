import { sql } from "drizzle-orm";
import type { Database } from "../../../plugins/database.js";
import { buildAuditPreview } from "../../night-audit/services/night-audit.service.js";

type Queryable = Pick<Database, "execute">;

export type ManagerDailyMetrics = {
  availableRooms: number;
  soldRoomNights: number;
  occupancy: number;
  adr: number;
  revpar: number;
  roomRevenue: number;
  paymentsReceived: number;
  refundsPaid: number;
  netPayments: number;
  receivablesAtCapture: number;
  noShows: number;
  roomsNotReadyAtCapture: number;
};

export type ManagerDailySnapshot = {
  capturedAt: string;
  metrics: ManagerDailyMetrics;
  breakdown: ManagerDailyBreakdown;
};

export type ManagerDailyBreakdown = {
  roomTypes: {
    roomTypeId: string;
    name: string;
    availableRooms: number;
    soldRoomNights: number;
    occupancy: number;
    roomRevenue: number;
    adr: number;
    revpar: number;
  }[];
  paymentMethods: {
    methodId: string;
    name: string;
    paymentsReceived: number;
    refundsPaid: number;
    netPayments: number;
  }[];
  receivablesByStatus: {
    status: string;
    reservations: number;
    amount: number;
  }[];
};

export async function buildManagerDailySnapshot(
  db: Queryable,
  businessDate: string,
  auditSummary?: { paymentsReceived: number; refundsPaid: number },
): Promise<ManagerDailySnapshot> {
  const [roomResult, roomTypeResult, paymentMethodResult, receivableResult, preview] =
    await Promise.all([
      db.execute(sql<{
        available_rooms: number;
        sold_room_nights: number;
        room_revenue: number;
        no_shows: number;
        rooms_not_ready: number;
      }>`
      select
        (select count(*)::int from greenhero.room_units u
         join greenhero.room_types rt on rt.id = u.room_type_id
         where u.is_active and rt.is_active
           and u.operational_status not in ('maintenance', 'out_of_service')) as available_rooms,
        (select count(*)::int from greenhero.reservation_room_nights n
         join greenhero.reservation_rooms rr on rr.id = n.reservation_room_id
         join greenhero.reservations r on r.id = rr.reservation_id
         where n.stay_date = ${businessDate}::date
           and r.reservation_status in ('checked_in', 'checked_out')) as sold_room_nights,
        (select coalesce(sum(n.final_price), 0)::bigint from greenhero.reservation_room_nights n
         join greenhero.reservation_rooms rr on rr.id = n.reservation_room_id
         join greenhero.reservations r on r.id = rr.reservation_id
         where n.stay_date = ${businessDate}::date
           and r.reservation_status in ('checked_in', 'checked_out')) as room_revenue,
        (select count(*)::int from greenhero.reservations r
         where r.check_in_date = ${businessDate}::date and r.reservation_status = 'no_show') as no_shows,
        (select count(*)::int from greenhero.room_units u
         join greenhero.room_types rt on rt.id = u.room_type_id
         where u.is_active and rt.is_active
           and u.operational_status in ('cleaning', 'maintenance', 'out_of_service')) as rooms_not_ready
    `),
      db.execute(sql<{
        room_type_id: string;
        name: string;
        available_rooms: number;
        sold_room_nights: number;
        room_revenue: number;
      }>`
      with available as (
        select u.room_type_id, count(*)::int as available_rooms
        from greenhero.room_units u
        join greenhero.room_types rt on rt.id = u.room_type_id
        where u.is_active and rt.is_active
          and u.operational_status not in ('maintenance', 'out_of_service')
        group by u.room_type_id
      ), sold as (
        select rr.room_type_id, count(*)::int as sold_room_nights,
          coalesce(sum(n.final_price), 0)::bigint as room_revenue
        from greenhero.reservation_room_nights n
        join greenhero.reservation_rooms rr on rr.id = n.reservation_room_id
        join greenhero.reservations r on r.id = rr.reservation_id
        where n.stay_date = ${businessDate}::date
          and r.reservation_status in ('checked_in', 'checked_out')
        group by rr.room_type_id
      )
      select rt.id as room_type_id, rt.name,
        coalesce(a.available_rooms, 0)::int as available_rooms,
        coalesce(s.sold_room_nights, 0)::int as sold_room_nights,
        coalesce(s.room_revenue, 0)::bigint as room_revenue
      from available a
      full outer join sold s on s.room_type_id = a.room_type_id
      join greenhero.room_types rt on rt.id = coalesce(a.room_type_id, s.room_type_id)
      order by rt.name, rt.id
    `),
      db.execute(sql<{
        method_id: string;
        name: string;
        payments_received: number;
        refunds_paid: number;
      }>`
      with received as (
        select p.method_id, sum(p.amount)::bigint as payments_received
        from greenhero.payments p
        where p.status in ('succeeded', 'partially_refunded', 'refunded')
          and (p.paid_at at time zone 'Asia/Jakarta')::date = ${businessDate}::date
        group by p.method_id
      ), refunded as (
        select p.method_id, sum(f.amount)::bigint as refunds_paid
        from greenhero.payment_refunds f
        join greenhero.payments p on p.id = f.payment_id
        where f.status = 'succeeded'
          and (f.processed_at at time zone 'Asia/Jakarta')::date = ${businessDate}::date
        group by p.method_id
      )
      select m.id as method_id, m.name,
        coalesce(r.payments_received, 0)::bigint as payments_received,
        coalesce(f.refunds_paid, 0)::bigint as refunds_paid
      from received r
      full outer join refunded f on f.method_id = r.method_id
      join greenhero.master_items m on m.id = coalesce(r.method_id, f.method_id)
      order by m.name, m.id
    `),
      db.execute(sql<{
        status: string;
        reservations: number;
        amount: number;
      }>`
      with balances as (
        select r.reservation_status as status,
          greatest(coalesce(c.total, 0) - coalesce(p.total, 0) + coalesce(f.total, 0), 0) as amount
        from greenhero.reservations r
        left join lateral (
          select sum(amount)::bigint as total from greenhero.reservation_charges
          where reservation_id = r.id
        ) c on true
        left join lateral (
          select sum(amount)::bigint as total from greenhero.payments
          where reservation_id = r.id and status in ('succeeded', 'partially_refunded', 'refunded')
        ) p on true
        left join lateral (
          select sum(f.amount)::bigint as total from greenhero.payment_refunds f
          join greenhero.payments pay on pay.id = f.payment_id
          where pay.reservation_id = r.id and f.status = 'succeeded'
        ) f on true
        where r.reservation_status in ('pending', 'confirmed', 'checked_in', 'checked_out')
      )
      select status, count(*)::int as reservations, sum(amount)::bigint as amount
      from balances where amount > 0
      group by status order by status
    `),
      auditSummary ? Promise.resolve(null) : buildAuditPreview(db, businessDate, null),
    ]);

  const rooms = roomResult.rows[0];
  const availableRooms = Number(rooms.available_rooms ?? 0);
  const soldRoomNights = Number(rooms.sold_room_nights ?? 0);
  const roomRevenue = Number(rooms.room_revenue ?? 0);
  const paymentsReceived = auditSummary?.paymentsReceived ?? preview!.summary.paymentsReceived;
  const refundsPaid = auditSummary?.refundsPaid ?? preview!.summary.refundsPaid;
  const breakdown: ManagerDailyBreakdown = {
    roomTypes: roomTypeResult.rows.map((row) => {
      const available = Number(row.available_rooms);
      const sold = Number(row.sold_room_nights);
      const revenue = Number(row.room_revenue);
      return {
        roomTypeId: String(row.room_type_id),
        name: String(row.name),
        availableRooms: available,
        soldRoomNights: sold,
        occupancy: available > 0 ? (sold / available) * 100 : 0,
        roomRevenue: revenue,
        adr: sold > 0 ? revenue / sold : 0,
        revpar: available > 0 ? revenue / available : 0,
      };
    }),
    paymentMethods: paymentMethodResult.rows.map((row) => ({
      methodId: String(row.method_id),
      name: String(row.name),
      paymentsReceived: Number(row.payments_received),
      refundsPaid: Number(row.refunds_paid),
      netPayments: Number(row.payments_received) - Number(row.refunds_paid),
    })),
    receivablesByStatus: receivableResult.rows.map((row) => ({
      status: String(row.status),
      reservations: Number(row.reservations),
      amount: Number(row.amount),
    })),
  };

  return {
    capturedAt: new Date().toISOString(),
    metrics: {
      availableRooms,
      soldRoomNights,
      occupancy: availableRooms > 0 ? (soldRoomNights / availableRooms) * 100 : 0,
      adr: soldRoomNights > 0 ? roomRevenue / soldRoomNights : 0,
      revpar: availableRooms > 0 ? roomRevenue / availableRooms : 0,
      roomRevenue,
      paymentsReceived,
      refundsPaid,
      netPayments: paymentsReceived - refundsPaid,
      receivablesAtCapture: breakdown.receivablesByStatus.reduce((sum, row) => sum + row.amount, 0),
      noShows: Number(rooms.no_shows ?? 0),
      roomsNotReadyAtCapture: Number(rooms.rooms_not_ready ?? 0),
    },
    breakdown,
  };
}
