import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProducts1793059200000 implements MigrationInterface {
  name = 'CreateProducts1793059200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "core"."products" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sku" character varying(100) NOT NULL,
        "name" character varying(200) NOT NULL,
        "description" character varying(5000),
        "categoryId" uuid NOT NULL,
        "priceUsd" numeric(12,2) NOT NULL,
        "discountPercentage" numeric(5,2) NOT NULL DEFAULT 0.00,
        "stock" integer NOT NULL DEFAULT 0,
        "images" text[] NOT NULL DEFAULT '{}',
        "status" character varying(9) NOT NULL DEFAULT 'draft',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_products_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_products_category_id" FOREIGN KEY ("categoryId")
          REFERENCES "core"."categories"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "CHK_products_price_positive" CHECK ("priceUsd" > 0),
        CONSTRAINT "CHK_products_discount_range" CHECK ("discountPercentage" >= 0 AND "discountPercentage" <= 100),
        CONSTRAINT "CHK_products_stock_nonnegative" CHECK ("stock" >= 0),
        CONSTRAINT "CHK_products_status" CHECK ("status" IN ('draft', 'published', 'archived')),
        CONSTRAINT "CHK_products_sku_normalized" CHECK ("sku" = upper(btrim("sku")))
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_products_sku_normalized" ON "core"."products" (upper(btrim("sku")))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_products_created_at_id" ON "core"."products" ("createdAt", "id")',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_products_category_created_at_id" ON "core"."products" ("categoryId", "createdAt", "id")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "core"."products"');
  }
}
