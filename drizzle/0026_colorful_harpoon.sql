CREATE TABLE "greenhero"."night_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_date" date NOT NULL,
	"snapshot" jsonb NOT NULL,
	"closed_by_user_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "greenhero"."night_audits" ADD CONSTRAINT "night_audits_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "greenhero"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "night_audits_business_date_uq" ON "greenhero"."night_audits" USING btree ("business_date");--> statement-breakpoint
INSERT INTO "greenhero"."permissions" ("id", "code", "module", "label", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'night_audit.view', 'Night Audit', 'View Night Audit Preview', now(), now()),
  (gen_random_uuid(), 'night_audit.close', 'Night Audit', 'Close Night Audit', now(), now())
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "greenhero"."role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "greenhero"."roles" r
CROSS JOIN "greenhero"."permissions" p
WHERE r."name" IN ('Owner', 'Manager')
  AND p."code" IN ('night_audit.view', 'night_audit.close')
ON CONFLICT DO NOTHING;
