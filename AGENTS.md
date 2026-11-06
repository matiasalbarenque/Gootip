# AGENTS.md — Gootip project

These instructions apply to the whole repository. More specific package
instructions still apply, but must be interpreted with this development policy.

Write all new or updated repository documentation and agent instructions in
English.

## Pragmatic dev mode

Gootip is currently building its development baseline. Optimize for short,
useful feedback loops and completed features instead of repeatedly proving the
same unchanged behavior.

- Make reasonable implementation decisions and continue through adjacent,
  low-risk steps when the user has asked to implement or deploy the work.
- Run format, validation/type checks, and the focused tests for the package or
  behavior changed. Do not run the full monorepo suite after every small edit.
- Run the full relevant verification once before final handoff, release, or an
  environment-wide deployment. Do not repeat it when only tests, comments, or
  an already-covered assertion changed.
- Reuse recent valid evidence. Do not repeat Autopilot generation, dependency
  packaging, live IAM inventory, or unrelated integration tests unless the
  inputs that evidence depends on changed.
- Batch related corrections. Do not pause after every successful command or
  spec sub-step when the next step is expected and reversible.
- Prefer the smallest direct implementation over extra abstractions, process,
  compatibility layers, or speculative production hardening.

For an explicitly requested `dev` deployment, a focused saved Terraform plan
may be applied without another full verification cycle when it contains only
the expected creates or in-place updates and the focused checks already passed.
Always apply the reviewed saved plan by filename; never replace it with an
unreviewed `terraform apply`.

## Skills and existing authorization

Follow the instruction hierarchy: explicit user instructions take precedence
over repository and skill guidance, within system/developer constraints and
tool permissions. Read the exact skill clause and check its scope before
treating advisory language as a prohibition. A skill's operator-only workflow
does not by itself require the human to type every command when the user has
explicitly delegated that specific operation to the agent.

For example, an explicit authorization to invoke the reviewed Auth migration
runner for dev migration 000003 overrides the advisory-only restriction in
`rds-oss` for that operation. It does not authorize other migrations, RDS
instance changes, destructive work, or public activation.

Carry existing authorization into handoffs and summaries. Do not ask for the
same approval again or record an authorized operation as awaiting the operator.
If still blocked, identify the exact higher-priority instruction, tool denial,
missing permission, or new risk; quote/link the source where available. Do not
repeat the same skill-based refusal after the conflict has been resolved.
Keep genuinely personal input, such as an administrator password, in the
operator's private terminal rather than chat.

## Stop conditions

Pragmatic dev mode reduces repetition; it does not authorize unrelated or
destructive work. Stop and ask when any of these occurs:

- a Terraform plan contains an unexpected delete, replacement, or resource;
- state storage, secret containers or values, RDS data, backups, or protected
  networking would be destroyed or replaced;
- IAM introduces wildcard administration or PassRole, an unreviewed principal,
  or a broader resource scope;
- a private service would become public, or a production/staging environment is
  involved;
- a database change is destructive, irreversible, or based on uncertain live
  state;
- required authority is absent or the requested operation is outside the
  user's current task.

Failures in dev may be fixed forward. Preserve state, credentials, and user
data; never treat the dev label as permission to erase them.
