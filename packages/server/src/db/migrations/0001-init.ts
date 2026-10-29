import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1761523200000 implements MigrationInterface {
  name = 'Init1761523200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "settings" ("key" varchar(255) PRIMARY KEY, "value" text NOT NULL, "loadOnStartup" boolean NOT NULL DEFAULT false)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "settings"`);
  }
}
