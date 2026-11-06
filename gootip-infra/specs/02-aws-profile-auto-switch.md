# SPEC 02 — Automatic AWS_PROFILE Switch with direnv

> **Status:** Implemented
> **Date:** 2026-10-08
> **Objective:** Auto-export `AWS_PROFILE=gootip-dev` when entering `gootip-infra/` via direnv, removing manual `export` and preventing wrong-profile applies.

> **Architecture note:** SPEC 02.1 supersedes this spec's active profile and authorization model. This file remains historical evidence of the original `gootip-dev` direnv behavior; implementation must use the MFA-protected role profiles defined by SPEC 02.1.

## Scope

**In:**

- Tracked `.envrc` in repo root with single line `export AWS_PROFILE=gootip-dev` (profile name is non-sensitive).
- zsh hook setup: `eval "$(direnv hook zsh)"` in `~/.zshrc` + `brew install direnv`.
- `direnv allow` trust flow per machine.
- `.gitignore` update: keep `.envrc` tracked, ignore `.envrc.local` for personal overrides.
- Docs for enter/leave behavior and pre-apply check `echo $AWS_PROFILE`.

**Out of scope:**

- No AWS keys, tokens, or secrets in repo (same policy as SPEC 01).
- No Terraform `.tf` / `environments/*.tfvars` changes.
- No prod profile, no SSO migration, no cross-repo profiles.
- No `direnv` layouts, no secrets loading via `.envrc`.

## Implementation plan

1. Install direnv once per machine: `brew install direnv` + add hook to `~/.zshrc` + restart shell. Manual: `direnv --version` succeeds.
2. Add `.envrc` in `gootip-infra/` root with `export AWS_PROFILE=gootip-dev`. Manual: file contains only that export.
3. Authorize once per checkout: `direnv allow .`. Manual: `cd .` shows `direnv: export +AWS_PROFILE`.
4. Update `.gitignore` to ignore `.envrc.local` while keeping `.envrc` tracked. Manual: `git check-ignore .envrc.local` matches, `.envrc` does not.
5. Document usage: `cd gootip-infra` sets profile, `cd ..` unsets/restores. Manual: `echo $AWS_PROFILE` test passes.

## Acceptance criteria

- [ ] `cd gootip-infra && echo $AWS_PROFILE` prints `gootip-dev`.
- [ ] `cd .. && echo $AWS_PROFILE` unsets or restores previous value.
- [ ] Fresh shell after hook install loads `.envrc` without error after `direnv allow`.
- [ ] `terraform plan -var-file=environments/dev.tfvars` works with no manual export.
- [ ] `git status` shows `.envrc` as tracked candidate, `.envrc.local` ignored.
- [ ] Secrets check clean: no `secret_string`, `secret_binary`, `secret_version`, `random_password`, `password =` in new files.
- [ ] Spec in English, status `Draft`.

## Decisions

- **Yes:** commit `.envrc` with only `AWS_PROFILE`. Profile name is a reference, not a secret.
- **Yes:** zsh only. Default shell on Mac, covers current team.
- **Yes:** `.envrc.local` ignored for personal overrides. Keeps shared file stable.
- **No:** secrets or `AWS_ACCESS_KEY_ID` in `.envrc`. Keys stay in `~/.aws/credentials` via `aws configure`.
- **No:** Terraform changes in this spec. Pure local DX improvement.

## Risks

| Risk                                           | Mitigation                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| direnv not installed -> profile silently unset | Document install + hook; pre-apply `echo $AWS_PROFILE` check                      |
| User forgets `direnv allow` after clone        | direnv prints unallowed warning on cd; spec documents one-time allow              |
| Wrong profile exported in nested shells        | direnv restores on exit; verify with `direnv status` + `echo $AWS_PROFILE`        |
| Personal profile differs from `gootip-dev`     | Use ignored `.envrc.local` override, never edit tracked `.envrc` for personal use |

## What is **not** in this spec

- Prod auto-switch, multi-env matrix, SSO profiles.
- Shared team dotfiles or shell managers beyond direnv.
- CI changes (CI sets `AWS_*` via OIDC/role, not direnv).

Each of those, if it lands, goes in its own spec.
