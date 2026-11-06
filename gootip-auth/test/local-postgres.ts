export const suiteDatabaseUrl = (
  variable: string,
  expectedDatabase: string,
): string => {
  const value = process.env[variable] ?? '';

  if (value === '') {
    return '';
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid local PostgreSQL URL`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${variable} must use PostgreSQL`);
  }
  if (
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== `/${expectedDatabase}` ||
    url.username !== 'gootip_local_admin' ||
    url.password === '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `${variable} must target the local admin connection for ${expectedDatabase}`,
    );
  }

  return value;
};

export const requiredTestPassword = (variable: string): string => {
  const value = process.env[variable];

  if (!value) {
    throw new Error(
      `${variable} is required for the requested integration suite`,
    );
  }

  return value;
};

export const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;
