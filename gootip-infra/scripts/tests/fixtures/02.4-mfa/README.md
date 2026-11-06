# SPEC 02.4 MFA fixtures

Offline fixtures for the automatic MFA renewal hook. They let the interactive
zsh helper be exercised without a network, an AWS account, or a real
credential. `scripts/tests/mfa_fixtures.py` builds an isolated `HOME` with
fake `~/.aws/config` and `~/.aws/credentials` files and places the `fake-aws`
executable first on `PATH`.

Nothing here is account-specific. The Account ID, role ARNs, MFA ARN, access
key, and session token are deterministic placeholders (`000000000000`,
`AKIAFIXTURE0000000000`, `fixture-session-token`) that can never resolve to a
live identity.

## Current one-hour flow (baseline)

Before SPEC 02.4 the operator mints a one-hour `gootip-mfa` source session
manually and then assumes the role profile selected by direnv:

```bash
aws configure mfa-login --profile gootip-dev \
  --duration-seconds 3600 --update-profile gootip-mfa
aws sts get-caller-identity --profile gootip-terraform-deploy
```

The source session, the shared human-role `aws:MultiFactorAuthAge` condition,
and both role `max_session_duration` values are all limited to 3,600 seconds.
Renewal is manual and entering `gootip-infra/` does not trigger it. SPEC 02.4
replaces this with the entry hook, a three-hour MFA **source** session, and
one-hour assumed-role sessions; the fixtures below model the source-session
classifications that hook must distinguish.

## Scenarios

| Scenario        | `sts get-caller-identity`          | Required hook behavior                       |
| --------------- | ---------------------------------- | -------------------------------------------- |
| `valid`         | fixture identity, exit 0           | reuse the session; no prompt                 |
| `missing`       | profile not found, exit 255        | renew once                                   |
| `expired`       | `ExpiredToken`, exit 255           | renew once                                   |
| `unreachable`   | connection error, exit 255         | actionable error; never renew                |
| `denied`        | `AccessDenied`, exit 255           | actionable error; never renew                |
| `malformed`     | `InvalidClientTokenId`, exit 255   | actionable error; never renew                |
| `missing-arn`   | profile not found + no `mfa_serial`| setup instruction; never guess the ARN       |
| `cancel`        | `ExpiredToken`; login exits 130    | report failure; never claim success          |

Only `missing` and `expired` mean "renew". Every other non-valid scenario is an
uncertain failure that must produce a clear error and must not launch MFA
login. `valid` is the only scenario that must be reused without a prompt.

## Fake CLI contract

`fake-aws` supports only three commands and logs every invocation to
`$GOOTIP_MFA_TEST_LOG`:

- `aws sts get-caller-identity ...` -- emits the scenario classification.
- `aws configure get mfa_serial --profile gootip-dev` -- returns the fixture ARN,
  or exits 1 for the `missing-arn` scenario.
- `aws configure mfa-login --profile ... --duration-seconds ... --update-profile
  ... [--serial-number ...]` -- simulates updating only the `--update-profile`
  target, exits 130 for `cancel`, and exits 99 if called for a scenario that
  must not renew.

`with_aws=False` in the helper removes the fake CLI from `PATH` so tests can
prove the hook reports a missing tool instead of prompting.
