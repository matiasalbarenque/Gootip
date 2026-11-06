import {
  symmetricDecodeJWT,
  symmetricDecrypt,
  symmetricEncodeJWT,
  symmetricEncrypt,
  type SecretConfig,
} from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';

const previousSecret = 'previous-signing-secret-value-0123456789';
const currentSecret = 'current-signing-secret-value-9876543210';
const previousConfig: SecretConfig = {
  keys: new Map([[1, previousSecret]]),
  currentVersion: 1,
  legacySecret: previousSecret,
};
const currentConfig: SecretConfig = {
  keys: new Map([
    [2, currentSecret],
    [1, previousSecret],
  ]),
  currentVersion: 2,
  legacySecret: previousSecret,
};

describe('Better Auth 1.7.7 versioned secret rotation', () => {
  it('decrypts legacy and versioned values, while new values use the current key', async () => {
    const legacy = await symmetricEncrypt({
      key: previousSecret,
      data: 'legacy-persisted-value',
    });
    const oldVersioned = await symmetricEncrypt({
      key: previousConfig,
      data: 'old-versioned-value',
    });
    const rotated = await symmetricEncrypt({
      key: currentConfig,
      data: 'new-versioned-value',
    });

    await expect(
      symmetricDecrypt({ key: currentConfig, data: legacy }),
    ).resolves.toBe('legacy-persisted-value');
    await expect(
      symmetricDecrypt({ key: currentConfig, data: oldVersioned }),
    ).resolves.toBe('old-versioned-value');
    expect(rotated.startsWith('$ba$2$')).toBe(true);
    await expect(
      symmetricDecrypt({ key: currentConfig, data: rotated }),
    ).resolves.toBe('new-versioned-value');
  });

  it('continues verifying tokens made with the previous key during the grace version', async () => {
    const previousToken = await symmetricEncodeJWT(
      { sub: 'rotation-probe' },
      previousConfig,
      'better-auth-session',
    );

    await expect(
      symmetricDecodeJWT(previousToken, currentConfig, 'better-auth-session'),
    ).resolves.toMatchObject({ sub: 'rotation-probe' });
  });
});
