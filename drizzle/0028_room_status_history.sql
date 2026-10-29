CREATE TABLE "greenhero"."room_status_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_unit_id" uuid NOT NULL REFERENCES "greenhero"."room_units"("id"),
  "status_before" varchar(30) NOT NULL,
  "status_after" varchar(30) NOT NULL,
  "actor_user_id" uuid NOT NULL REFERENCES "greenhero"."users"("id"),
  "source" varchar(30) NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "room_status_events_unit_time_idx" ON "greenhero"."room_status_events" ("room_unit_id", "occurred_at");
