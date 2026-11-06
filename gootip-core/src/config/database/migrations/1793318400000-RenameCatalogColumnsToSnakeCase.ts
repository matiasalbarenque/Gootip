import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameCatalogColumnsToSnakeCase1793318400000 implements MigrationInterface {
  name = 'RenameCatalogColumnsToSnakeCase1793318400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."categories" RENAME COLUMN "createdAt" TO "created_at"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."categories" RENAME COLUMN "updatedAt" TO "updated_at"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "categoryId" TO "category_id"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "priceUsd" TO "price_usd"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "discountPercentage" TO "discount_percentage"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "createdAt" TO "created_at"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "updatedAt" TO "updated_at"',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "updated_at" TO "updatedAt"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "created_at" TO "createdAt"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "discount_percentage" TO "discountPercentage"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "price_usd" TO "priceUsd"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."products" RENAME COLUMN "category_id" TO "categoryId"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."categories" RENAME COLUMN "updated_at" TO "updatedAt"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."categories" RENAME COLUMN "created_at" TO "createdAt"',
    );
  }
}
