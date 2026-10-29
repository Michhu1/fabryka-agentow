import type { MigrationInterface, QueryRunner } from 'typeorm';

const TIMESTAMPS = `"created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()`;

/**
 * Project invitations and project transfers (owner decisions after PR #1). Both are accepted through a
 * one-time link mailed to an address; only the sha256 of the link's token is stored.
 * - `project_invitation`: one pending invitation per project and address (inviting again replaces it).
 * - `project_transfer`: one pending transfer per project (a new request replaces the old one).
 */
export class ProjectInvitationsAndTransfers1761868800000 implements MigrationInterface {
  name = 'ProjectInvitationsAndTransfers1761868800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "project_invitation" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "project_id" uuid NOT NULL,
      "email" varchar(254) NOT NULL,
      "role" varchar(32) NOT NULL,
      "token_hash" varchar(64) NOT NULL,
      "invited_by" uuid,
      "expires_at" timestamptz NOT NULL,
      ${TIMESTAMPS},
      CONSTRAINT "UQ_project_invitation_token_hash" UNIQUE ("token_hash"),
      CONSTRAINT "UQ_project_invitation_project_email" UNIQUE ("project_id", "email"),
      CONSTRAINT "FK_project_invitation_project_id" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_project_invitation_invited_by" FOREIGN KEY ("invited_by") REFERENCES "user" ("id") ON DELETE SET NULL
    )`);
    // Deleting an account sets `invited_by` to NULL: without the index that would scan the table.
    await queryRunner.query(
      `CREATE INDEX "IDX_project_invitation_invited_by" ON "project_invitation" ("invited_by")`,
    );

    await queryRunner.query(`CREATE TABLE "project_transfer" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "project_id" uuid NOT NULL,
      "from_user_id" uuid NOT NULL,
      "to_email" varchar(254) NOT NULL,
      "token_hash" varchar(64) NOT NULL,
      "expires_at" timestamptz NOT NULL,
      ${TIMESTAMPS},
      CONSTRAINT "UQ_project_transfer_project_id" UNIQUE ("project_id"),
      CONSTRAINT "UQ_project_transfer_token_hash" UNIQUE ("token_hash"),
      CONSTRAINT "FK_project_transfer_project_id" FOREIGN KEY ("project_id") REFERENCES "project" ("id") ON DELETE CASCADE,
      CONSTRAINT "FK_project_transfer_from_user_id" FOREIGN KEY ("from_user_id") REFERENCES "user" ("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_project_transfer_from_user_id" ON "project_transfer" ("from_user_id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Indexes and constraints go with their tables.
    await queryRunner.query(`DROP TABLE "project_transfer"`);
    await queryRunner.query(`DROP TABLE "project_invitation"`);
  }
}
