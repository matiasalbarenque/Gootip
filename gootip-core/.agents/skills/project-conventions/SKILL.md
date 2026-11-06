---
name: project-conventions
description: Enforce gootip-core text conventions for specs, comments, and documentation. Use when creating or editing files under specs/, writing code comments or error messages, or adding docs to gootip-core.
---

# project-conventions

Mandatory rules for specs and committed text in this repo.

## 1. English-only specs and config text

All specs, code comments, descriptions, error messages, and docs use English.

Rules:

- Specs in `specs/`: headings, scope, criteria, decisions all in English
- Code comments, JSDoc, and error messages all in English
- Never mix Spanish/Portuguese into committed text or keys
- Existing non-English text touched during an edit must be translated to English in the same change
- Exception: specs already written in Spanish are grandfathered; new specs must be English

Good:

```ts
// Allowed CORS origin for the HTTP API.
export const frontendUrl = process.env.FRONTEND_URL;
```

Bad:

```ts
// URL del frontend para CORS.
export const frontendUrl = process.env.FRONTEND_URL;
```

## 2. Scalable allowlists and union types

For finite sets of accepted string values, keep a single `as const` list and
use `.includes()` (through a type guard when the input is `unknown`) instead of
growing chains of equality comparisons. Derive the corresponding union type
from that list so runtime validation and TypeScript stay in sync.

```ts
const ROLES = ['user', 'editor', 'admin'] as const;
type Role = (typeof ROLES)[number];

const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);
```

## 3. Braces for control-flow branches

Always use braces for `if`/`else` branches, including branches containing only
a single `return` statement. Keep the returned statement on its own line inside
the braces.

```ts
if (!isValid(value)) {
  return undefined;
}
```

## Verification checklist

Before finishing any task touching `specs/` or adding committed text:

- [ ] All new or edited text is English (except grandfathered Spanish specs)
- [ ] No Spanish/Portuguese mixed into identifiers, keys, or messages
