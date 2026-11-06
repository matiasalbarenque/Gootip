---
name: project-conventions
description: Enforce project code conventions for gootip-store. Use when creating or editing components, files, functions, types, specs, or UI text. Ensures kebab-case naming, arrow functions, minimal any/unknown usage, and English-only specs and UI strings.
---

# project-conventions

Mandatory rules for all code and specs in this repo.

## 1. Kebab-case for components and filenames

All component files, directories, and related assets use kebab-case.

Rules:

- Component files: `user-profile-card.tsx`, `checkout-form.tsx`
- Directories: `src/components/user-profile/`, `src/components/checkout-flow/`
- Test / story / style co-located files match base name: `user-profile-card.test.tsx`, `user-profile-card.stories.tsx`, `user-profile-card.module.css`
- Exported component symbol uses PascalCase derived from filename: `user-profile-card.tsx` exports `UserProfileCard`
- Never use camelCase, snake_case, or PascalCase in filenames

Good:

```tsx
// src/components/user-profile-card.tsx
export const UserProfileCard = () => { ... };
```

Bad:

```tsx
// src/components/UserProfileCard.tsx -> rename to user-profile-card.tsx
// src/components/user_profile_card.tsx -> rename to user-profile-card.tsx
```

## 2. Custom functions are arrow functions

All custom functions, including components, hooks, helpers, and callbacks, use arrow function syntax.

Rules:

- Prefer `const Name = (...) => ...` over `function Name(...)`
- Applies to exported and internal functions
- Applies to async functions: `const fetchOrders = async () => ...`
- Exception only for APIs requiring `function` semantics (never for plain components/helpers). Document exception inline when unavoidable.

Good:

```tsx
export const formatPrice = (value: number): string => `$${value.toFixed(2)}`;

export const UserProfileCard = ({ name }: UserProfileCardProps) => {
  return <p>{name}</p>;
};

export const useOrders = () => {
  const loadOrders = async (): Promise<void> => { ... };
  return { loadOrders };
};
```

Bad:

```tsx
export function formatPrice(value: number): string { ... }
export default function UserProfileCard() { ... }
```

## 3. Minimize any and unknown

Avoid `any` and `unknown` unless no precise type exists. Prefer explicit, narrow types.

Rules:

- Never use `any` as shortcut for laziness, props, API responses, or event handlers
- Prefer union types, interfaces, generics, `Record<string, ...>` with known value type, discriminated unions
- If `unknown` required (e.g. caught error, unvalidated external payload), narrow it immediately with type guard / schema validation before use
- If `any` unavoidable (third-party untyped API), isolate to single line, add `// eslint-disable-next-line` equivalent only if required, plus comment explaining why and follow-up
- `oxlint` / `tsc` must pass without new `any`/`unknown` warnings

Good:

```tsx
type OrderStatus = 'pending' | 'paid' | 'shipped';

type Order = {
  id: string;
  status: OrderStatus;
  total: number;
};

export const isOrder = (value: unknown): value is Order => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' && typeof candidate.total === 'number'
  );
};
```

Bad:

```tsx
export const renderOrder = (data: any) => data.total;
export const parsePayload = (input: unknown) => (input as any).value;
```

Decision flow:

1. Can type be expressed exactly? Write it.
2. External data untrusted? Type as `unknown`, validate, then narrow.
3. Third-party library untyped? Type boundary once, expose typed wrapper.

## 4. English-only specs and component text

All specs, code comments, UI strings, error messages, prop names, and docs inside components use English.

Rules:

- Specs in `specs/`: headings, scope, criteria, decisions all in English
- User-visible strings: buttons, labels, placeholders, empty states, errors, toasts all in English
- Code comments and JSDoc in English
- Never mix Spanish/Portuguese into committed UI text. i18n dictionaries, if added later, use English keys and English source strings.
- Existing non-English text touched during edit must be translated to English in same change

Good:

```tsx
export const EmptyCart = () => <p>Your cart is empty.</p>;
```

Bad:

```tsx
export const EmptyCart = () => <p>Tu carrito está vacío.</p>;
```

## Verification checklist

Before finishing task touching components/specs:

- [ ] All new/renamed files kebab-case
- [ ] All new/edited custom functions arrow functions
- [ ] Zero new `any`/`unknown` without justification + narrowing
- [ ] All specs/comments/UI strings English
- [ ] `pnpm lint` and `tsc --noEmit` pass (or `pnpm build` if types suspect)
