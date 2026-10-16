CREATE TABLE "greenhero"."ai_chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "greenhero"."ai_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(12) NOT NULL,
	"content" text NOT NULL,
	"model_used" varchar(160),
	"data_source" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_chat_messages_role_check" CHECK ("greenhero"."ai_chat_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "greenhero"."ai_chat_conversations" ADD CONSTRAINT "ai_chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "greenhero"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "greenhero"."ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_conversation_id_ai_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "greenhero"."ai_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_chat_conversations_user_updated_idx" ON "greenhero"."ai_chat_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_chat_messages_conversation_sequence_idx" ON "greenhero"."ai_chat_messages" USING btree ("conversation_id","sequence");