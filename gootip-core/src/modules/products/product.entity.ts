import {
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Column,
} from 'typeorm';

import type { ProductStatus } from './typings/products.js';

@Entity({ schema: 'core', name: 'products' })
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  sku!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 5000, nullable: true })
  description!: string | null;

  @Column({ type: 'uuid', name: 'category_id' })
  categoryId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, name: 'price_usd' })
  priceUsd!: string;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: '0.00',
    name: 'discount_percentage',
  })
  discountPercentage!: string;

  @Column({ type: 'integer', default: 0 })
  stock!: number;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  images!: string[];

  @Column({ type: 'varchar', length: 9, default: 'draft' })
  status!: ProductStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
