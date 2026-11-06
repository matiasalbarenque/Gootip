const parseCents = (value: string): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
};

export const calculateFinalPriceUsd = (
  priceUsd: string,
  discountPercentage: string,
): string => {
  const priceCents = parseCents(priceUsd);
  const discountBasisPoints = BigInt(
    discountPercentage.replace('.', '').padEnd(3, '0'),
  );
  const finalCents =
    (priceCents * (10_000n - discountBasisPoints) + 5_000n) / 10_000n;
  return `${finalCents / 100n}.${(finalCents % 100n).toString().padStart(2, '0')}`;
};
