CREATE TABLE "greenhero"."night_audit_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"start_date" date NOT NULL,
	"initialized_by_user_id" uuid NOT NULL,
	"initialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "night_audit_settings_singleton_check" CHECK (id = 1)
);
--> statement-breakpoint
ALTER TABLE "greenhero"."night_audit_settings" ADD CONSTRAINT "night_audit_settings_initialized_by_user_id_users_id_fk" FOREIGN KEY ("initialized_by_user_id") REFERENCES "greenhero"."users"("id") ON DELETE no action ON UPDATE no action;
