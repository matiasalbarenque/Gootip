import type { DatabaseError } from './typings/utils.js';

export const trimString = ({ value }: { value: unknown }): unknown => {
  return typeof value === 'string' ? value.trim() : value;
};

// Ensures a decimal value always includes at least two digits after the decimal point.
export const normalizeDecimal = (value: string): string => {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
};

// Extracts a database error from a wrapped or direct error object.
export const databaseError = (error: unknown): DatabaseError | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('driverError' in error) {
    const driverError = error.driverError;
    return typeof driverError === 'object' && driverError !== null
      ? (driverError as DatabaseError)
      : undefined;
  }
  return 'code' in error ? (error as DatabaseError) : undefined;
};
