import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "../modules/auth/password.js";
import { permissions } from "./schema/permissions.schema.js";
import { rolePermissions } from "./schema/role_permissions.schema.js";
import { roles } from "./schema/roles.schema.js";
import { users } from "./schema/users.schema.js";

const roleNames = ["Owner", "Manager", "Admin", "Front Office", "Staff"] as const;
type RoleName = (typeof roleNames)[number];

const all = roleNames;
const operations = roleNames.slice(0, 4);
const management = roleNames.slice(0, 3);
const ownerAdmin = ["Owner", "Admin"] as const;
const senior = ["Owner", "Manager"] as const;

type PermissionSeed = {
  code: string;
  module: string;
  label: string;
  allowed: readonly RoleName[];
};

const permissionSeeds: PermissionSeed[] = [
  { code: "dashboard.view", module: "Dashboard", label: "View Dashboard", allowed: all },
  { code: "master.view", module: "Master", label: "View Master Data", allowed: all },
  {
    code: "web_settings.manage",
    module: "Web Settings",
    label: "Manage Web Settings",
    allowed: management,
  },
  ...[
    ["create", "Create Master Data"],
    ["edit", "Edit Master Data"],
    ["delete", "Delete Master Data"],
  ].map(([code, label]) => ({
    code: `master.${code}`,
    module: "Master",
    label,
    allowed: ownerAdmin,
  })),
  { code: "reservations.view", module: "Reservations", label: "View Reservations", allowed: all },
  ...[
    ["create", "Create Reservation"],
    ["edit", "Edit Reservation"],
    ["confirm", "Confirm Reservation"],
    ["cancel", "Cancel Reservation"],
  ].map(([code, label]) => ({
    code: `reservations.${code}`,
    module: "Reservations",
    label,
    allowed: operations,
  })),
  ...[
    ["view_arrivals_today", "View Arrivals Today"],
    ["view_departures_today", "View Departures Today"],
    ["view_in_house", "View In House"],
  ].map(([code, label]) => ({
    code: `reservations.${code}`,
    module: "Reservations",
    label,
    allowed: all,
  })),
  ...[
    ["check_in", "Check In Guest"],
    ["check_out", "Check Out Guest"],
  ].map(([code, label]) => ({
    code: `reservations.${code}`,
    module: "Reservations",
    label,
    allowed: operations,
  })),
  {
    code: "reservations.checkout_outstanding_override",
    module: "Reservations",
    label: "Checkout With Outstanding Override",
    allowed: senior,
  },
  ...[
    ["extend_stay", "Extend Stay"],
    ["change_room", "Change Room"],
    ["assign_room", "Assign Room"],
    ["manage_extra_bed", "Manage Extra Bed"],
    ["add_experience", "Add Experience to Reservation"],
  ].map(([code, label]) => ({
    code: `reservations.${code}`,
    module: "Reservations",
    label,
    allowed: operations,
  })),
  { code: "rooms.view_types", module: "Rooms", label: "View Room Types", allowed: all },
  ...[
    ["create_type", "Create Room Type"],
    ["edit_type", "Edit Room Type"],
    ["disable_type", "Disable Room Type"],
  ].map(([code, label]) => ({
    code: `rooms.${code}`,
    module: "Rooms",
    label,
    allowed: ownerAdmin,
  })),
  { code: "rooms.view_numbers", module: "Rooms", label: "View Room Numbers", allowed: all },
  {
    code: "rooms.create_number",
    module: "Rooms",
    label: "Create Room Number",
    allowed: ownerAdmin,
  },
  { code: "rooms.edit_number", module: "Rooms", label: "Edit Room Number", allowed: management },
  {
    code: "rooms.change_operational_status",
    module: "Rooms",
    label: "Change Room Operational Status",
    allowed: operations,
  },
  {
    code: "prices_stocks.view",
    module: "Prices & Stocks",
    label: "View Prices & Stocks",
    allowed: all,
  },
  ...[
    ["update_price", "Update Room Price"],
    ["update_stock", "Update Stock"],
    ["manage_stop_sell", "Manage Stop Sell"],
    ["manage_minimum_night", "Manage Minimum Night"],
  ].map(([code, label]) => ({
    code: `prices_stocks.${code}`,
    module: "Prices & Stocks",
    label,
    allowed: management,
  })),
  {
    code: "cancellation_policies.view",
    module: "Cancellation Policies",
    label: "View Cancellation Policies",
    allowed: all,
  },
  ...[
    ["create", "Create Policy"],
    ["edit", "Edit Policy"],
    ["disable", "Disable Policy"],
  ].map(([code, label]) => ({
    code: `cancellation_policies.${code}`,
    module: "Cancellation Policies",
    label,
    allowed: ownerAdmin,
  })),
  {
    code: "campaigns.view",
    module: "Campaigns & Promotions",
    label: "View Campaigns",
    allowed: all,
  },
  ...[
    ["create", "Create Campaign"],
    ["edit", "Edit Campaign"],
    ["disable", "Disable Campaign"],
    ["set_priority", "Set Campaign Priority"],
  ].map(([code, label]) => ({
    code: `campaigns.${code}`,
    module: "Campaigns & Promotions",
    label,
    allowed: management,
  })),
  { code: "experiences.view", module: "Experiences", label: "View Experiences", allowed: all },
  ...[
    ["create", "Create Experience"],
    ["edit", "Edit Experience"],
    ["disable", "Disable Experience"],
  ].map(([code, label]) => ({
    code: `experiences.${code}`,
    module: "Experiences",
    label,
    allowed: ownerAdmin,
  })),
  ...[
    ["view", "View Payments"],
    ["record", "Record Payment"],
    ["view_detail", "View Payment Detail"],
  ].map(([code, label]) => ({
    code: `payments.${code}`,
    module: "Payments",
    label,
    allowed: operations,
  })),
  ...[
    ["refund", "Refund Payment"],
    ["checkout_unpaid", "Checkout With Unpaid Balance"],
  ].map(([code, label]) => ({
    code: `payments.${code}`,
    module: "Payments",
    label,
    allowed: senior,
  })),
  { code: "payments.export", module: "Payments", label: "Export Payments", allowed: management },
  { code: "guests.view", module: "Guests", label: "View Guests", allowed: all },
  { code: "guests.edit", module: "Guests", label: "Edit Guest", allowed: operations },
  {
    code: "guests.view_stay_history",
    module: "Guests",
    label: "View Guest Stay History",
    allowed: all,
  },
  ...[
    ["view_reservations", "View Reservations Report"],
    ["export_reservations", "Export Reservations Report"],
  ].map(([code, label]) => ({
    code: `reports.${code}`,
    module: "Reports — Reservations",
    label,
    allowed: management,
  })),
  {
    code: "reports.view_revenue",
    module: "Reports — Revenue",
    label: "View Revenue Report",
    allowed: senior,
  },
  {
    code: "night_audit.view",
    module: "Night Audit",
    label: "View Night Audit Preview",
    allowed: senior,
  },
  {
    code: "night_audit.close",
    module: "Night Audit",
    label: "Close Night Audit",
    allowed: senior,
  },
];

const userSeeds = [
  {
    name: "Jhon Doe",
    email: "owner@greenhero.id",
    username: "owner",
    phone: "+62 812 1000 1001",
    role: "Owner",
    isActive: true,
  },
  {
    name: "Nadia Prameswari",
    email: "nadia@greenhero.id",
    username: "nadia",
    phone: "+62 812 1000 1002",
    role: "Manager",
    isActive: true,
  },
  {
    name: "Rizky Maulana",
    email: "rizky@greenhero.id",
    username: "rizky",
    phone: "+62 812 1000 1003",
    role: "Admin",
    isActive: true,
  },
  {
    name: "Siti Rahmawati",
    email: "siti@greenhero.id",
    username: "siti",
    phone: "+62 812 1000 1004",
    role: "Front Office",
    isActive: true,
  },
  {
    name: "Deni Kurniawan",
    email: "deni@greenhero.id",
    username: "deni",
    phone: "+62 812 1000 1005",
    role: "Staff",
    isActive: false,
  },
] as const;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.SEED_USER_PASSWORD;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!password || password.length < 5)
    throw new Error("SEED_USER_PASSWORD must contain at least 5 characters");

  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool });
  try {
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      const roleIds = new Map<RoleName, string>();
      for (const name of roleNames) {
        const [role] = await tx
          .insert(roles)
          .values({ name, isSystem: true })
          .onConflictDoUpdate({
            target: roles.name,
            set: { isSystem: true, isActive: true },
          })
          .returning({ id: roles.id });
        roleIds.set(name, role.id);
      }

      const permissionIds = new Map<string, string>();
      for (const permission of permissionSeeds) {
        const [row] = await tx
          .insert(permissions)
          .values({ code: permission.code, module: permission.module, label: permission.label })
          .onConflictDoUpdate({
            target: permissions.code,
            set: { module: permission.module, label: permission.label },
          })
          .returning({ id: permissions.id });
        permissionIds.set(permission.code, row.id);
      }

      for (const roleName of roleNames) {
        const roleId = roleIds.get(roleName)!;
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        const grants = permissionSeeds.filter((permission) =>
          permission.allowed.includes(roleName),
        );
        if (grants.length)
          await tx.insert(rolePermissions).values(
            grants.map((permission) => ({
              roleId,
              permissionId: permissionIds.get(permission.code)!,
            })),
          );
      }

      for (const user of userSeeds) {
        await tx
          .insert(users)
          .values({
            roleId: roleIds.get(user.role)!,
            name: user.name,
            email: user.email,
            username: user.username,
            phone: user.phone,
            passwordHash,
            isActive: user.isActive,
          })
          .onConflictDoUpdate({
            target: users.email,
            set: {
              roleId: roleIds.get(user.role)!,
              name: user.name,
              username: user.username,
              phone: user.phone,
              isActive: user.isActive,
            },
          });
      }
    });
    console.info(
      `Seeded ${roleNames.length} roles, ${permissionSeeds.length} permissions, and ${userSeeds.length} users.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Database seed failed:", error);
  process.exitCode = 1;
});
