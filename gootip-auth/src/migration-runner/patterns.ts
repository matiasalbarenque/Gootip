/**
 * Shared bounded-format patterns.
 *
 * The same bounds apply to a value whether it arrives in the invocation event,
 * in the artifact manifest, or in the stored history, so they live in one place.
 */

export const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const APPROVAL_REFERENCE_PATTERN = /^[A-Za-z0-9._:/#-]{1,256}$/;
