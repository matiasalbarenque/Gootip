# Frontend dependency review — 2026-11-05

- Next.js is pinned to 15.5.29, the latest stable Next.js 15 release at review
  time. Next.js 15 is required for AWS Amplify deployment because Amplify's
  officially supported maximum Next.js version is 15. Its peer range accepts
  React 19, and its Node engine accepts Node 24.22.1.
- React and React DOM are pinned together at 19.3.1; the matching React type
  packages are 19.3.0. Next.js 15.5.29 accepts React 19.
- Runtime and development dependencies were checked against registry version,
  engine, and peer metadata. Available compatible updates were applied; packages
  with no newer compatible release remain pinned as-is.
- Lucide is pinned to 1.68.0, the newest release allowed by pnpm's release-age
  policy at review time; 1.69.0 was published on the review date and was not
  exempted from that policy.
- PostCSS is overridden to 8.5.32 because Next.js 15.5.29 otherwise resolves
  vulnerable PostCSS 8.4.31. This satisfies the advisories' patched minimum.
- TypeScript 7 is deferred: it is a new major beyond the current TypeScript 6
  line, and this spec only needs the latest TypeScript 6 release for the Next.js
  15 compatibility check. Revisit it separately after framework/tooling support
  is confirmed.
- `@types/node` 26 is deferred because the project runs Node 24; the Node 24 type
  line is the matching supported major.
- Next.js 16 is not selected because it exceeds AWS Amplify's officially
  supported maximum Next.js version for this deployment.
