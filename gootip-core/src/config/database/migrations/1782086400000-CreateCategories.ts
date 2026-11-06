import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCategories1782086400000 implements MigrationInterface {
  name = 'CreateCategories1782086400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "core"."categories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(120) NOT NULL,
        "description" character varying(5000),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_categories_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_categories_name_lower" ON "core"."categories" (lower("name"))',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "core"."UQ_categories_name_lower"');
    await queryRunner.query('DROP TABLE "core"."categories"');
  }
}
