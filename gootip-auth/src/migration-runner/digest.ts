import { createHash } from 'node:crypto';

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }

  return value;
};

/**
 * Serializes a value with object keys sorted at every depth so a digest is
 * stable regardless of key insertion order.
 */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
