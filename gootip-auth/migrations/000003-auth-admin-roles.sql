-- Better Auth 1.7.7 Admin plugin fields; preserve existing users and sessions.
ALTER TABLE "auth"."user" ADD COLUMN "role" text DEFAULT 'user';
ALTER TABLE "auth"."user" ADD COLUMN "banned" boolean DEFAULT false;
ALTER TABLE "auth"."user" ADD COLUMN "banReason" text;
ALTER TABLE "auth"."user" ADD COLUMN "banExpires" timestamptz;
ALTER TABLE "auth"."session" ADD COLUMN "impersonatedBy" text;
