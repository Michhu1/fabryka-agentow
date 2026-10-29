import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Single project owner and per-account team project limit (owner decisions after PR #1):
 * - `user.team_projects_limit`: NULL = the instance default `TEAM_PROJECTS_LIMIT`; a value overrides it
 *   for that account (later: paid plans).
 * - At most one `project:admin` (the owner) per project, enforced by a partial unique index.
 */
export class ProjectOwnership1761782400000 implements MigrationInterface {
  name = 'ProjectOwnership1761782400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" ADD "team_projects_limit" integer`);
    // Projects with several admins (possible before) keep one owner: the creator if still an admin,
    // otherwise the admin who joined first. The others become editors.
    await queryRunner.query(`UPDATE "project_relation" r
      SET role = 'project:editor', updated_at = now()
      FROM (
        SELECT a.project_id, a.user_id,
          row_number() OVER (
            PARTITION BY a.project_id
            ORDER BY (a.user_id IS NOT DISTINCT FROM p.creator_id) DESC, a.created_at, a.user_id
          ) AS position
        FROM "project_relation" a JOIN "project" p ON p.id = a.project_id
        WHERE a.role = 'project:admin'
      ) ranked
      WHERE r.project_id = ranked.project_id AND r.user_id = ranked.user_id AND ranked.position > 1`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_relation_one_admin" ON "project_relation" ("project_id") WHERE role = 'project:admin'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // The demoted admins stay editors: who was an admin before is not recorded.
    await queryRunner.query(`DROP INDEX "UQ_project_relation_one_admin"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "team_projects_limit"`);
  }
}
