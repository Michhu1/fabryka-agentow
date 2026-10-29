import type { MigrationInterface, QueryRunner } from 'typeorm';

const TIMESTAMPS = `"created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()`;

/** Accounts, projects with memberships, revoked session tokens and API keys (M1). */
export class Accounts1761696000000 implements MigrationInterface {
  name = 'Accounts1761696000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // "user" is a reserved word in PostgreSQL, so it is always quoted.
    await queryRunner.query(`CREATE TABLE "user" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "email" varchar(254) NOT NULL,
      "first_name" varchar(32) NOT NULL,
      "last_name" varchar(32) NOT NULL,
      "password_hash" varchar(255),
      "role" varchar(32) NOT NULL,
      "disabled" boolean NOT NULL DEFAULT false,
      "mfa_enabled" boolean NOT NULL DEFAULT false,
      "mfa_secret" text,
      "mfa_recovery_codes" text,
      "settings" jsonb NOT NULL DEFAULT '{}',
      "last_active_at" date,
      ${TIMESTAMPS},
      CONSTRAINT "UQ_user_email" UNIQUE ("email")
    )`);

    await queryRunner.query(`CREATE TABLE "project" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" varchar(255) NOT NULL,
      "type" varchar(16) NOT NULL,
      "icon" jsonb,
      "description" varchar(512),
      "creator_id" uuid,
      ${TIMESTAMPS},
      CONSTRAINT "FK_project_creator_id" FOREIGN KEY ("creator_id") REFERENCES "user" ("id") ON DELETE SET NULL
    )`);

    await queryRunner.query(`CREATE TABLE "project_relation" (
      "project_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "role" varchar(32) NOT NULL,
      ${TIMESTAMPS},
      PRIMARY KEY ("project_id", "user_id"),
      CONSTRAINT "FK_project_relation_project_id" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_project_relation_user_id" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_project_relation_user_id" ON "project_relation" ("user_id")`);
    // Exactly one personal project per user, enforced by the database even under concurrent signups.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_relation_personal_owner" ON "project_relation" ("user_id") WHERE role = 'project:personalOwner'`,
    );

    await queryRunner.query(`CREATE TABLE "invalid_auth_token" (
      "token_hash" varchar(64) PRIMARY KEY,
      "expires_at" timestamptz NOT NULL,
      ${TIMESTAMPS}
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_invalid_auth_token_expires_at" ON "invalid_auth_token" ("expires_at")`,
    );

    await queryRunner.query(`CREATE TABLE "api_key" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" uuid NOT NULL,
      "label" varchar(100) NOT NULL,
      "key_hash" varchar(64) NOT NULL,
      "hint" varchar(8) NOT NULL,
      "expires_at" timestamptz,
      "last_used_at" timestamptz,
      ${TIMESTAMPS},
      CONSTRAINT "UQ_api_key_key_hash" UNIQUE ("key_hash"),
      CONSTRAINT "FK_api_key_user_id" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_api_key_user_id" ON "api_key" ("user_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Indexes and constraints go with their tables.
    await queryRunner.query(`DROP TABLE "api_key"`);
    await queryRunner.query(`DROP TABLE "invalid_auth_token"`);
    await queryRunner.query(`DROP TABLE "project_relation"`);
    await queryRunner.query(`DROP TABLE "project"`);
    await queryRunner.query(`DROP TABLE "user"`);
  }
}
