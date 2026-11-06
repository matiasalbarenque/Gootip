# SPEC 15 — Postman Collection Generator

> **Status:** Implemented
> **Depends on:** SPEC 10
> **Date:** 2026-11-02
> **Objective:** Generate a local Postman collection containing explicit Auth and Core HTTP operations exposed through the deployed API Gateway, with illustrative request bodies and query parameters.

## Approved interface amendment — 2026-11-02

The user requested and approved replacing the explicit API/profile arguments
with a single parameterless command from `gootip-infra/`, reusing its active
MFA-backed AWS session. This amendment supersedes the original command contract.

## Scope

**In:**

- Python entry point: `gootip-infra/scripts/generate_postman.py`.
- Parameterless execution exclusively from `gootip-infra/`, using its existing AWS session and Terraform API output.
- Generated workspace-root file: `gootip.postman_collection.json`, ignored by Git.
- One Postman Collection v2.1 with separate Auth and Core folders.
- Live API Gateway discovery, including routes requiring JWT.
- Explicit HTTP methods and paths, with fictitious values replacing path parameters.
- Automatic request examples derived from local application contracts.
- Regeneration that adds new exposed operations and removes deleted operations.

**Out of scope:**

- Changes to API Gateway routes, Terraform resources, IAM, or deployments.
- Publishing documentation endpoints.
- Executing exported requests, creating test data, or obtaining credentials.
- Automatic login, token refresh, response examples, or Postman test scripts.
- Production/staging configuration and custom-domain discovery.

## Interfaces and data flow

### Command

After entering `gootip-infra/`, loading its existing direnv environment, and
completing the existing MFA flow, run this command from that directory:

`python3 scripts/generate_postman.py`

- This is the only supported execution interface. Reject positional arguments and configuration flags, including the former `--api-id`, `--profile`, and `--region` options. A conventional `--help` may describe usage without generating a collection.
- Require the resolved working directory to be the workspace's `gootip-infra/` directory. Reject other directories before running subprocesses or modifying output.
- Require the inherited `AWS_PROFILE=gootip-terraform-deploy`, as selected by `gootip-infra/.envrc`. Do not silently substitute another profile or use the AWS default profile.
- Reuse the existing AWS credential chain and MFA-backed session. Do not read credential files directly, collect MFA codes, invoke login or renewal, or rewrite the shell environment. Normal AWS CLI role resolution through the configured credential chain remains allowed.
- Run `terraform output -raw api_url` from `gootip-infra/` using the same inherited AWS environment. Read only that non-sensitive output; do not export the full state or all outputs.
- Parse the API ID and Region from the output's HTTPS execute-api origin. Require the existing project Region `us-east-2`; target the existing `$default` stage. Do not infer configuration from the AWS default Region or accept environment overrides for the API ID, Region, or output path.
- Fail clearly if Terraform is unavailable, its backend is not initialized, the output is missing/null/malformed, or the origin does not identify an execute-api endpoint in the project Region. Do not initialize Terraform, apply changes, enumerate APIs to guess an ID, or fall back to a hardcoded ID.
- Use Python's standard library, the installed AWS CLI, and the existing Terraform CLI/backend configuration.
- Resolve the output relative to the script so the JSON remains at the workspace root, never inside `gootip-infra/`.
- Require installed Auth/Core Node dependencies for local contract extraction.

Missing or expired AWS credentials produce an actionable error directing the
operator to restore the existing infra session and rerun the same command.
They do not trigger a new authentication workflow inside the generator.

### Route discovery

Using the API ID and Region resolved from Terraform and the inherited infra profile, read the API, stage, routes, and integrations through AWS CLI JSON output, including pagination. Confirm an HTTP API with an enabled execute-api endpoint and an existing `$default` stage. Require the returned API endpoint to match the Terraform origin.

Classify Auth/Core operations through their Lambda integrations. Exclude unrelated integrations and report them.

- Core: use deployed method/path pairs, enriched with local controller and DTO contracts.
- Auth: enumerate Better Auth's configured endpoint metadata, including plugins, and intersect it with the methods handled by Hono and routes exposed by Gateway.
- Include explicit Hono operations, such as OpenID discovery, when exposed by Gateway.
- Expand `ANY` and proxy routes into concrete operations from local contracts.
- Never emit `ANY`, `*`, or `{proxy+}`.
- Deduplicate by service, method, and normalized path.

Gateway determines exposure; local code supplies operation details. Require the local checkout to match the deployed application version.

### Local contract exporters

Add small metadata exporters under the existing Auth/Core script directories, invoked by Python.

- Auth: reuse the application's configuration through a metadata-only configuration factory. Read endpoint methods, paths, body schemas, and query schemas without initializing authentication runtime or accessing PostgreSQL.
- Core: inspect controller decorators and DTO types using the installed TypeScript compiler API. Resolve imported DTOs, inherited pagination fields, mapped partial DTOs, optional properties, enums, arrays, and existing validation decorators.
- Emit a shared intermediate JSON structure containing service, method, path, body, query parameters, and parameter examples.
- Do not maintain a separate endpoint list or use regular expressions to parse TypeScript.
- Fail clearly on an exposed route that cannot be resolved or a contract construct that prevents complete enumeration.

No new public application endpoints or business types are introduced.

### Postman representation

- Store the resolved Gateway origin as a collection variable.
- Use concrete fictitious path values, including valid-format UUIDs for resource IDs.
- Generate JSON bodies and `Content-Type` headers where applicable.
- Include query examples; mark optional filters disabled by default.
- Use deterministic schema-derived examples. Document fields requiring real credentials or related records.
- Configure an empty bearer-token variable for routes protected by Gateway JWT authorization.
- Leave Auth's application-level authentication requirements documented without inventing Gateway authorization.
- Never export real passwords, tokens, cookies, AWS credentials, or database data.

Examples are illustrative and may require editing before sending.

## Implementation plan

1. Add and test the local metadata exporters, including the minimal Auth configuration extraction needed to avoid runtime initialization.
2. Add the parameterless Python command, validate the infra working directory and inherited profile, resolve the API origin through the Terraform output, discover Gateway routes, combine them with local contracts, and generate the Postman collection.
3. Add deterministic ordering and atomic output replacement. Preserve the previous file on failure.
4. Update the root ignore file and add focused English usage documentation covering the existing infra MFA session, initialized backend, sole supported command, regeneration, import, and example limitations. Replace previous examples requiring CLI arguments or execution from another directory.

If one service has no deployed routes, export the other and warn. If neither has exportable operations, fail without replacing the previous JSON. Authentication failures, incomplete AWS reads, and unresolved exposed operations also fail without replacement.

## Acceptance criteria and tests

- [x] Postman imports the generated collection successfully.
- [x] From `gootip-infra/` with its existing MFA-backed session active, `python3 scripts/generate_postman.py` generates the collection without parameters or another login/MFA prompt from the generator.
- [ ] The API ID and Region come from `terraform output -raw api_url`; no manual identifiers or API-list permissions are required for discovery.
- [ ] The JSON is written to the workspace root, not the infra directory.
- [ ] Execution outside `gootip-infra/`, configuration arguments, and a missing or unexpected AWS profile fail before external reads or output replacement.
- [ ] Unavailable Terraform, an uninitialized backend, invalid/missing API output, expired credentials, and a mismatching live API endpoint fail without replacing an existing JSON file or starting authentication, initialization, or deployment.
- [ ] Every exported request has a concrete HTTP method and no wildcard path.
- [ ] Every exported operation is covered by a deployed Gateway route targeting its service.
- [ ] Auth plugin operations and Core protected routes are included.
- [ ] Bodies, filters, inherited DTO fields, partial updates, and fictitious IDs are represented.
- [ ] Adding or removing an exposed operation changes the next generated collection without editing an endpoint registry.
- [ ] Identical inputs produce byte-identical JSON.
- [ ] AWS pagination is covered by fixture tests.
- [ ] Missing services, unresolved contracts, expired credentials, and extraction failures follow the defined failure behavior.
- [ ] Failed generation preserves the previous JSON.
- [ ] Generation performs no application requests or database access.

Run Python unit tests with mocked Terraform/AWS/exporter responses, focused exporter tests, and applicable package type, lint, and format checks. Cover working-directory enforcement, argument rejection, inherited profile/session reuse, Terraform output parsing, and all startup failure paths. Validate the collection structure and manually import it into Postman. A read-only dev smoke run uses only the documented parameterless command after the existing infra MFA flow and verifies live discovery when routes are available; no exported requests are sent.

## Decisions and risks

- **Live Gateway discovery:** reflects deployed exposure instead of Terraform intent.
- **Single infra entry point:** reuse the directory's selected profile and MFA session instead of requiring users to supply identifiers or authenticate again.
- **Terraform output as API identity:** reuse the existing non-sensitive `api_url` output instead of introducing another configuration source or broad API enumeration permissions. The existing initialized backend is a prerequisite.
- **Local contract enrichment:** provides explicit Auth operations and request examples without changing infrastructure.
- **Ignored generated JSON:** keeps environment-specific exports outside Git.
- **Illustrative examples:** avoids requiring live data or credentials.
- **No Gateway proxy replacement:** explicit routes are required only in Postman.
- **Shared contract compiler:** Auth and Core use TypeScript 6.0.3, aligned with
  Front, so Core can use the classic TypeScript compiler API without a parallel
  compiler dependency.

Local/deployed version drift can produce inaccurate contracts behind Auth's proxy. Document this limitation and report detectable mismatches. Future unsupported contract constructs must produce an actionable error rather than silently omit operations.

## What is not in this spec

- Infrastructure changes, deployments, or public documentation endpoints.
- Live credentials, automatic authentication, or execution of generated requests.
- Alternate invocation directories, CLI configuration flags, automatic backend initialization, or a separate login flow.
- Guaranteed executable examples backed by real application records.
