# Generate and import the Postman collection

The collection reflects operations currently exposed by the dev API Gateway
HTTP API. API Gateway determines which operations are included; local Auth and
Core contracts provide request examples.

## Prerequisites

- Python 3.10 or newer and the AWS CLI installed.
- The existing initialized Terraform backend under `gootip-infra/`.
- The infra direnv environment loaded and its existing MFA-backed session active;
  `AWS_PROFILE` must be `gootip-terraform-deploy`.
- `pnpm` and installed dependencies in both `gootip-auth/` and `gootip-core/`.
- Local `gootip-auth/lambda.zip` and `gootip-core/lambda.zip` artifacts matching
  the deployed Lambda code. Generation stops if either artifact is missing or
  its SHA-256 does not match the deployed function. Build the artifacts with
  the package's documented build process if they are missing or stale.

Install package dependencies from each application directory if needed:

```bash
cd gootip-auth && pnpm install
cd ../gootip-core && pnpm install
```

## Generate or regenerate

After entering `gootip-infra/` and loading its direnv environment, complete the
usual MFA flow. Then run the only supported command from `gootip-infra/`:

```bash
python3 scripts/generate_postman.py
```

The command takes no arguments and is rejected from any other directory. The
generator reads only `terraform output -raw api_url` to determine the API ID and
Region (`us-east-2`); it does not initialize Terraform or start another login or
MFA flow. If the backend is uninitialized or the session is unavailable, restore
the existing infra setup and rerun this same command.

The generator performs read-only AWS discovery and local metadata extraction; it
does not send application requests, connect to PostgreSQL, deploy resources,
or retrieve credentials. Each successful run replaces the workspace-root file
`gootip.postman_collection.json`. The generated file is ignored by Git. Repeat
the command from `gootip-infra/` to reflect current deployed routes and local
contracts.

## Import and configure

1. In Postman, select **Import** and choose `gootip.postman_collection.json`.
2. Open the collection variables and set `baseUrl` only if you need to change
   the discovered API origin.
3. For routes protected by API Gateway JWT authorization, set the collection's
   `bearerToken` variable to a suitable token. It is empty by default.

Auth's application-level session or credential requirements are not represented
as Gateway JWT authorization. The collection does not log in, refresh tokens,
manage cookies, or include Postman test scripts or response examples.

## Example limitations

Request values are deterministic, fictitious examples, not test data. Replace
example email/password values with credentials you are authorized to use.
Resource IDs such as `categoryId` may need to refer to records that already
exist. Examples can require edits before sending and are not guaranteed to
succeed. Never put real passwords, tokens, cookies, AWS credentials, or database
data into the generated collection.

Generation is scoped to the dev execute-api endpoint and `$default` stage. It
does not discover custom domains or configure production/staging environments.
The local artifacts are used to detect deployed-version drift; if they do not
match the deployed Lambda code, generation fails rather than combining contracts
from a different artifact.
