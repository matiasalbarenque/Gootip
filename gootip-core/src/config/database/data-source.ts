import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { createDatabaseOptions } from './database.config.js';

const migrationDataSource = new DataSource({
  ...createDatabaseOptions(),
  entities: createDatabaseOptions().entities,
  migrations: createDatabaseOptions().migrations,
  migrationsTableName: 'typeorm_migrations',
});

export default migrationDataSource;
