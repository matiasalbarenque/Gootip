export interface ExistingAdminCandidate {
  email: string;
  role: string;
}

export type InitialAdminAction = 'create' | 'no_changes' | 'stop';

export const safeAdminBootstrapErrorCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return 'UNCLASSIFIED';
  const code = 'code' in error ? error.code : undefined;
  const allowed = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    '28P01',
    '42501',
    '23505',
    '42P01',
    '42703',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ];
  return typeof code === 'string' && allowed.includes(code)
    ? code
    : 'UNCLASSIFIED';
};

export const initialAdminAction = (
  users: ExistingAdminCandidate[],
  requestedEmail: string,
): InitialAdminAction => {
  const matchingUsers = users.filter(
    (user) => user.email.toLowerCase() === requestedEmail.toLowerCase(),
  );
  const admins = users.filter((user) => user.role === 'admin');

  if (admins.length > 0) {
    return admins.length === 1 && matchingUsers[0]?.role === 'admin'
      ? 'no_changes'
      : 'stop';
  }

  return matchingUsers.length === 0 ? 'create' : 'stop';
};
