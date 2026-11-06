import { createHash } from 'node:crypto';

export type MigrationManifest = {
  format_version: 1;
  commit_sha: string;
  migrations: { name: string; timestamp: number; source_sha256: string }[];
};

export type RegisteredMigration = {
  new (): { name?: string };
  name?: string;
};

export const validateMigrationManifest = (
  value: unknown,
): MigrationManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid migration manifest');
  }

  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).length !== 3 ||
    manifest.format_version !== 1 ||
    typeof manifest.commit_sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.commit_sha) ||
    !Array.isArray(manifest.migrations)
  ) {
    throw new Error('Invalid migration manifest');
  }

  const names = new Set<string>();
  const timestamps = new Set<number>();
  let previousTimestamp = -1;
  for (const item of manifest.migrations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid migration manifest');
    }
    const migration = item as Record<string, unknown>;
    if (
      Object.keys(migration).length !== 3 ||
      typeof migration.name !== 'string' ||
      migration.name.length === 0 ||
      typeof migration.timestamp !== 'number' ||
      !Number.isSafeInteger(migration.timestamp) ||
      migration.timestamp < 0 ||
      typeof migration.source_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(migration.source_sha256) ||
      names.has(migration.name) ||
      timestamps.has(migration.timestamp) ||
      migration.timestamp <= previousTimestamp
    ) {
      throw new Error('Invalid migration manifest');
    }
    names.add(migration.name);
    timestamps.add(migration.timestamp);
    previousTimestamp = migration.timestamp;
  }

  return value as MigrationManifest;
};

export const assertManifestMatchesRegistry = (
  manifest: MigrationManifest,
  registry: RegisteredMigration[],
): void => {
  if (manifest.migrations.length !== registry.length) {
    throw new Error('Migration registry does not match manifest');
  }
  manifest.migrations.forEach((entry, index) => {
    const migration = registry[index];
    if (!migration)
      throw new Error('Migration registry does not match manifest');
    const instance = new migration();
    if (
      entry.name !== (instance.name ?? migration.name) ||
      entry.timestamp !== Number(entry.name.match(/(\d+)$/)?.[1])
    ) {
      throw new Error('Migration registry does not match manifest');
    }
  });
};

export const migrationManifestSha256 = (
  manifestBytes: string | Uint8Array,
): string => createHash('sha256').update(manifestBytes).digest('hex');
