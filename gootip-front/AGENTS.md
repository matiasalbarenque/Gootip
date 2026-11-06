<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# gootip-store

Next.js 15.5.29 + React 19 + Tailwind CSS v4. Next.js 15 is required because the app is deployed on AWS Amplify, whose officially supported maximum Next.js version is 15. Package manager is `pnpm@12.14.0` — never use npm/yarn/bun commands (README examples using them are stale).

## Commands

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` (oxlint) and `pnpm format` (oxfmt). Check with `pnpm format:check`.
- No `test` or `typecheck` script: typecheck via `pnpm tsc --noEmit`.
- Verify UI work with `pnpm lint` + `pnpm tsc --noEmit`; run `pnpm build` when types are suspect. No test runner in repo — specs explicitly require no tests.
- oxfmt enforces `singleQuote`, `printWidth: 80`, sorted imports (see `.oxfmtrc.json`).

## Structure

- `src/app/` — App Router routes (`login/page.tsx`, `layout.tsx`). Path alias `@/*` maps to `src/*` (`tsconfig.json`); `components.json` adds `@/components/ui`, `@/lib`, `@/hooks` aliases.
- `src/components/ui/*` — coss primitives on `@base-ui/react` (shadcn-style DX, registry `@coss` in `components.json`). Do not invent component APIs; verify against `.agents/skills/coss/SKILL.md` and its `references/primitives/*.md` before composing trigger-based primitives (Dialog, Menu, Select, Popover, Tooltip, Toast).
- `src/components/auth/`, `src/components/layouts/` — feature components. `src/stores/` (zustand + `persist`, e.g. `auth.store.ts`) with types in `src/typings/stores/`. `src/lib/utils.ts` exports `cn`.
- `templates/` holds Astro reference templates only — reimplement with Tailwind + `ui/*`, never import CSS from there.
- `specs/` holds the spec-driven workflow (`NN-slug.md` + `.spec-config.yml` with `AutoCreateBranch: true`).

## Conventions

Enforced by `.agents/skills/project-conventions/SKILL.md` — follow it on every code/spec edit:

- Kebab-case filenames and directories (`sign-in-card.tsx` exporting `SignInCard`); never camelCase/snake_case/PascalCase in paths.
- Arrow functions for all custom functions/components/hooks (`const X = () => ...`), including async.
- No new `any`/`unknown`; type external payloads as `unknown` and narrow with a guard.
- English-only specs, comments, and UI strings; translate touched non-English text in the same change.

## Spec workflow

- New features start with `/spec` (see `.agents/skills/spec/SKILL.md`); implementation via `/spec-impl NN-slug` (see `.agents/skills/spec-impl/SKILL.md`).
- Only implement specs whose status means Approved; otherwise stop.
- Branch per spec: `spec-NN-slug` (auto-created unless `AutoCreateBranch: false`). Never commit automatically — code and diffs only until the user asks.
