# Gootip

Monorepo con backend de autenticación, frontend, infraestructura y paquete core (reservado).

| Carpeta         | Descripción                         | Stack                                       |
| --------------- | ----------------------------------- | ------------------------------------------- |
| `gootip-auth/`  | API de autenticación                | Hono + Better Auth, PostgreSQL, Vitest      |
| `gootip-front/` | Tienda web (paquete `gootip-store`) | Next.js 16.3.8 + React 19 + Tailwind CSS v4 |
| `gootip-infra/` | Infraestructura AWS                 | Terraform (`us-east-1`)                     |
| `gootip-core/`  | API principal (NestJS)              | NestJS + Express, AWS Lambda, Vitest        |

Package manager en `auth`, `front` y `core`: `pnpm@12.14.0` (no usar npm/yarn/bun).

## Prerrequisitos

- Node + `pnpm`
- Docker Compose (PostgreSQL local compartido, definido en `gootip-infra`)
- Solo para infra: `terraform`, `tflint`, `tfsec`, `trivy` (binarios a nivel OS):
  ```bash
  brew tap hashicorp/tap
  brew install hashicorp/tap/terraform tflint tfsec trivy
  ```

## Flujo dev local sugerido

1. Desde `gootip-infra/`, copiar `local/postgres.env.example` a `local/postgres.env` y configurar contraseñas locales.
2. Levantar/provisionar la DB con `./scripts/local_postgres.sh bootstrap` y aplicar migraciones con `./scripts/local_postgres.sh migrate`.
3. Configurar `gootip-auth/.env` y `gootip-core/.env` con sus roles runtime; ejecutar `pnpm dev` en cada paquete → `http://localhost:3000` y `http://localhost:3001/api`.
4. Arrancar front: `pnpm dev` desde `gootip-front/`.
5. Ejecutar integraciones PostgreSQL seriales con `./scripts/local_postgres.sh integration` desde `gootip-infra/`; para unitarios de core sin DB, usar `pnpm test:unit`.
6. Infra no requiere AWS para el flujo local.

## Pragmatic development policy

While building the development baseline, prioritize short feedback loops:
focused checks during implementation and full relevant verification at handoff.
Do not repeat suites, packaging, or inventories when their inputs have not
changed. Expected `dev` Terraform plans can proceed in small reviewed phases;
deletions, replacements, IAM scope expansion, public exposure, and destructive
data changes remain stop conditions.

Agents and assistants must also keep recommendations and reviews focused.
Explain the concrete blocker, the smallest solution, and the next step. Do not
add audits, checklists, or approval rounds beyond the scope and `AGENTS.md`
requirements. Reuse valid evidence and continue work that does not depend on a
blocker, presenting concrete, reviewable results for any necessary decisions.

When a guardrail fails, distinguish an actual limit from an outdated internal
rule or conservative margin. Resolve it with a focused correction or a
documented, accepted exception where appropriate. Do not expand the review to
the entire repository or weaken permissions or actual limits to pass a check.
Security controls and stop conditions still apply. Report phase completion
accurately: preparing a deployment does not complete a spec that also requires
activation and live checks.

See [`AGENTS.md`](AGENTS.md) for the complete agent operating instructions.

### Lesson learned: authorization and advisory skills

During SPEC 10, an agent repeatedly left Auth migration 000003 pending because
it interpreted the advisory mode of `rds-oss` as an absolute prohibition despite
explicit authorization to invoke the reviewed runner. Switching agents allowed
the operation to finish; that switch should not have been necessary.

Before blocking on a skill, read its exact rule, check its scope, and resolve
the instruction hierarchy. Explicit user authorization takes precedence over
skill guidance, within system, developer, and tool constraints. Preserve that
authorization in summaries and handoffs: do not ask again or mark the operation
as awaiting the operator. If a real blocker remains, identify its specific
source once and continue independent work. This does not expand the authorized
scope or replace separate public activation approvals. Passwords must still be
entered personally in a private terminal.

## AWS sessions and MFA: check the profile before requesting login

A renewed MFA session may work in the operator's terminal while an agent uses
another profile or retains stale credential variables. `InvalidClientTokenId`
alone does not prove that MFA needs renewal. Agents must first check the
explicit profile for the operation:

```bash
aws sts get-caller-identity --profile gootip-terraform-deploy
# For bootstrap root operations:
aws sts get-caller-identity --profile gootip-bootstrap-admin
```

If this fails, check the process's credential source and profile selection,
including Terraform. Non-interactive shells may not load MFA or direnv hooks.
To isolate inherited credential variables without changing the operator's shell:

```bash
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN \
  aws sts get-caller-identity --profile gootip-terraform-deploy
```

If the correct profile works and matches the expected account and role,
continue with that profile and the same verified environment for Terraform.
Do not request another session or run `aws login` against the default profile.
Do not change profiles, delete caches, or print keys or tokens for diagnosis.
If it still fails, report the exact command, profile, and error without secrets.
An operation-specific `AccessDenied` requires checking permissions rather than
assuming the session expired.

Request renewal only when the session is confirmed missing or expired, using
the existing `gootip-mfa-refresh` flow from the operator's interactive terminal.
See the [infrastructure MFA procedure](gootip-infra/README.md#mfa-source-session-and-automatic-renewal-spec-024).

## Piloto de ahorro de tokens con OpenCode

Este piloto es optativo y solo afecta las sesiones iniciadas con el launcher
de este repositorio; no modifica Codex Desktop ni la configuración habitual de
OpenCode. Headroom se instala como herramienta del usuario, no como dependencia
de la aplicación:

```bash
uv tool install --python 3.13 'headroom-ai[proxy]==0.41.0'
```

Se requieren `uv`, Python 3, OpenCode y un proveedor/modelo autenticado en
OpenCode. El piloto fue preparado para OpenCode 2.0.32. Desde este repositorio:

```bash
gootip-infra/scripts/opencode-headroom mini --model proveedor/modelo
# Alternativa no interactiva; incluir #variante cuando el modelo la admita:
gootip-infra/scripts/opencode-headroom run --model 'proveedor/modelo#variante' 'Tu consulta'
```

En `mini`, elegí explícitamente la variante en OpenCode. Mantené el mismo
modelo y variante en las comparaciones. El launcher usa un proxy en loopback y
una configuración temporal independiente, con modo `cache`, CCR en memoria,
telemetría beacon y búsqueda de actualizaciones desactivadas; no activa
Serena, aprendizaje ni memoria persistente. La caché CCR se pierde al cerrar el
proxy: no se garantiza recuperar fragmentos comprimidos al reanudar una sesión
tras reiniciarlo. El proxy ve los prompts, respuestas y credenciales que pasan
por él: usalo solo con proveedores compatibles y datos apropiados.

### Medición y reversión

Antes de adoptarlo, compará cinco pares de sesiones equivalentes, con y sin el
launcher: exploración de código, tests de auth, logs de migración, guardrails
de Terraform y JSON. Registrá modelo, variante, tokens de entrada, salida y
lectura de caché, calidad de la respuesta y errores. Durante una sesión con
Headroom, el puerto aparece al iniciar y se pueden consultar las estadísticas
locales en `http://127.0.0.1:PUERTO/stats`; verificá que registre solicitudes,
no solo que el proxy esté activo. La meta es al menos 15 % menos tokens de
entrada agregados, sin errores de autenticación, proxy o recuperación y sin
perder calidad ni empeorar la caché de prompts. El ahorro todavía no está
validado y puede ser menor en código o búsquedas ya compactas.

Para dejar de usarlo, iniciá OpenCode normalmente. Para desinstalar la
herramienta del usuario: `uv tool uninstall headroom-ai`. No hace falta
cambiar ni borrar los archivos de configuración de OpenCode o Codex.

---

## 1. gootip-auth — API de autenticación

Hono + Better Auth. PostgreSQL y Vitest, con servidor Node local y entry point para AWS Lambda.

### Setup

1. `pnpm install` (desde `gootip-auth/`)
2. Copiar `.env.template` a `.env` y setear las variables. Nunca commitear `.env`.
3. Desde `gootip-infra/`, levantar/provisionar PostgreSQL con `./scripts/local_postgres.sh bootstrap`.
4. Aplicar las migraciones revisadas con `./scripts/local_postgres.sh migrate`.
5. Configurar `.env` con el usuario `auth_runtime` y su contraseña local.
6. Dev server: `pnpm dev`

API base: `http://localhost:3000/api`
Auth base: `http://localhost:3000/api/auth`

### Environment

```bash
PORT=3000
POSTGRES_DB_HOST="127.0.0.1"
POSTGRES_DB_PORT=5433
POSTGRES_DB_NAME="gootip"
POSTGRES_DB_USER="auth_runtime"
POSTGRES_DB_PASSWORD="<AUTH_RUNTIME_PASSWORD local>"
POSTGRES_SSL_MODE="disable"
POSTGRES_CA_PATH=""
BETTER_AUTH_SECRET="<min-32-chars>"
BETTER_AUTH_URL="http://localhost:3000"
JWT_AUDIENCE="api"
FRONTEND_URL="http://localhost:5173"
```

`BETTER_AUTH_URL` es el origen público, sin agregar `/api/auth`, y también es el issuer del JWT. `JWT_AUDIENCE` define su audience. `FRONTEND_URL` es origen CORS y trusted origin. AWS usa `POSTGRES_SSL_MODE=verify-full` y la CA de RDS montada por Lambda Layer; local usa `disable` explícitamente.

### Auth config (`src/auth/auth.ts`)

- `emailAndPassword.enabled: true`
- Sin verificación de email ni sender de reset-password
- Plugins: `bearer()`, `jwt()`
- JWT: `expirationTime: 15m`, issuer/audience = `BETTER_AUTH_URL`, rotación de keys cada 30 días
- Sesiones en PostgreSQL vía `pg Pool`
- Hono monta el handler de Better Auth directamente en `/api/auth/*`.
- Auth usa cookies → mandar `credentials: include` desde browser. En native/mobile usar `Authorization: Bearer <session-token>` (bearer plugin).

### Endpoints clave

Base: `/api/auth`.

| Method | Full path                   | Auth            | Notas                                                                                                               |
| ------ | --------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/auth/sign-up/email`   | No              | `{ "name", "email", "password" }`. Crea usuario + sesión. Password 8–128. Devuelve `set-cookie` + `set-auth-token`. |
| `POST` | `/api/auth/sign-in/email`   | No              | `{ "email", "password", "rememberMe?" }`. `rememberMe: false` = sesión hasta cerrar browser.                        |
| `POST` | `/api/auth/sign-out`        | Cookie o Bearer | Limpia sesión actual.                                                                                               |
| `GET`  | `/api/auth/get-session`     | Cookie o Bearer | Sesión + usuario. Devuelve header `set-auth-jwt`.                                                                   |
| `GET`  | `/api/auth/token`           | Cookie o Bearer | `{ "token": "ey..." }`. JWT short-lived 15 min para servicios externos.                                             |
| `GET`  | `/api/auth/jwks`            | No              | Keys públicas para verificar JWTs de `/token`. Cachear, refetchear ante `kid` desconocido.                          |
| `POST` | `/api/auth/change-password` | Cookie o Bearer | `{ "currentPassword", "newPassword", "revokeOtherSessions?" }`. Funciona sin email.                                 |
| `POST` | `/api/auth/update-user`     | Cookie o Bearer | `{ "name?", "image?" }`.                                                                                            |

Existen más rutas estándar Better Auth (`change-email`, `delete-user`, `list-sessions`, `revoke-*`, `send-verification-email`, `request-password-reset`, etc.), pero las de reset/verificación están inactivas por falta de sender (ver abajo).

Ejemplos:

```bash
# Sign up
curl -i -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"name":"Ada","email":"ada@example.com","password":"password1234"}'

# Sign in
curl -i -X POST http://localhost:3000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -c cookies.txt \
  -d '{"email":"ada@example.com","password":"password1234"}'

# Current session via cookie
curl http://localhost:3000/api/auth/get-session -b cookies.txt

# Current session via Bearer (token del header set-auth-token del sign-up/sign-in)
curl http://localhost:3000/api/auth/get-session \
  -H 'Authorization: Bearer <session-token>'

# Service JWT + JWKS
curl http://localhost:3000/api/auth/token -b cookies.txt
curl http://localhost:3000/api/auth/jwks
```

Fuente del Bearer token: header `set-auth-token` en sign-up/sign-in. El header `set-auth-jwt` de `/get-session` también es un JWT verificable con JWKS, distinto de la cookie de sesión.

### No habilitado

No documentar como funcional:

- OAuth / social providers (`link-social` existe pero sin provider configurado)
- Plugins `admin`, `organization`, `twoFactor`, `phoneNumber`, `username`, `anonymous`
- `sendVerificationEmail` / `sendResetPassword` (rutas existen pero inactivas)
- Custom `basePath`, hooks, access control

Para agregar uno, editar `createAuth()` en `src/auth/auth.ts`.

### Comandos (desde `gootip-auth/`)

- `pnpm dev`: dev server
- `pnpm build` + `pnpm start`: prod build/run
- `../gootip-infra/scripts/local_postgres.sh migrate` / `pnpm auth:check`: aplicar/verificar el schema Better Auth
- `pnpm test`: unitarios/HTTP (Vitest); las integraciones seriales se ejecutan desde `gootip-infra/`
- `pnpm typecheck`: verificación TypeScript sin emitir
- `pnpm lint`: Oxlint
- `pnpm format:check` / `pnpm format`: check/fix formato

### Lambda

- `pnpm build:lambda`: emite `dist/lambda.mjs` (ESM, esbuild, node24 target, minificado).
- `pnpm lambda:zip`: empaqueta `lambda.zip` con solo `dist/lambda.mjs`.
- Contrato runtime: `nodejs24.x`, `arm64`, handler `dist/lambda.handler`.

---

## 2. gootip-front — gootip-store

Next.js 16.3.8 + React 19 + Tailwind CSS v4. Solo `pnpm`, no npm/yarn/bun.

### Comandos (desde `gootip-front/`)

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` (oxlint) y `pnpm format` / `pnpm format:check` (oxfmt, `singleQuote`, `printWidth: 80`)
- Sin script `test` ni `typecheck`: typecheck vía `pnpm tsc --noEmit`
- Verificar UI con `pnpm lint` + `pnpm tsc --noEmit`; `pnpm build` si los tipos son sospechosos.

### Estructura

- `src/app/` — App Router (`login/page.tsx`, `layout.tsx`)
- `src/components/ui/*` — primitivas sobre `@base-ui/react`
- `src/components/auth/`, `src/components/layouts/` — componentes de feature
- `src/stores/` (zustand + `persist`) + tipos en `src/typings/stores/`
- Alias `@/*` → `src/*`

---

## 3. gootip-infra — Terraform AWS

Infra Terraform para gootip (`us-east-1`).

### Verificación (desde `gootip-infra/`)

```bash
# 1. Format
terraform fmt -check -recursive

# 2. Read-only init (PR checks, sin backend auth)
terraform init -backend=false

# 3. Validación estática
terraform validate

# 4. Lint + seguridad
tflint
tfsec .

# 5. Init real + plan
terraform init
terraform plan -detailed-exitcode -out=tfplan -var-file=environments/dev.tfvars
```

### Deploy (dev)

El ZIP de Lambda se construye desde el proyecto hermano `gootip-auth` (bundle single-file `dist/lambda.mjs` ESM), siempre antes de `plan`/`apply`. La ruta esperada es `../gootip-auth`.

```bash
# 1. Build bundle + ZIP
pnpm --dir ../gootip-auth build:lambda
pnpm --dir ../gootip-auth lambda:zip

# 2. Preview y apply (primera pasada: better_auth_url aún vacío)
terraform init
terraform plan -out=tfplan -var-file=environments/dev.tfvars
terraform apply tfplan

# 3. Cargar secreto fuera de banda (nunca en .tf/tfvars).
# La password de DB queda solo en el secret gestionado por RDS.
aws secretsmanager put-secret-value \
  --secret-id gootip-auth-dev \
  --secret-string '{"BETTER_AUTH_SECRET":"<generate-a-value-min-32-chars>"}'

# 4. Segunda pasada: apuntar BETTER_AUTH_URL a la API real y re-aplicar.
# Tomar <api_url> del output del apply y setear en environments/dev.tfvars:
#   better_auth_url = "<api_url>"
terraform plan -out=tfplan -var-file=environments/dev.tfvars
terraform apply tfplan

# 5. Smoke test (esperado 200)
curl -i "<api_url>/api/auth/jwks"
```

Notas:

- Rotación en dev requiere cold start nuevo de Lambda.
- Un `gootip-auth-dev` vacío tras el primer apply hace fallar Lambda fast con error claro de key faltante; cargar valor (paso 3) y dejar cold-start de nuevo.

---

## 4. gootip-core — API principal

NestJS + Express sobre Node.js 24. La misma aplicación corre como servidor HTTP
local y como handler de AWS Lambda (API Gateway HTTP API payload v2).

### Comandos (desde `gootip-core/`)

- `pnpm dev`: servidor local en `http://localhost:3001/api` (`PORT` configurable)
- `pnpm build` + `pnpm start`: build/run local compilado
- `pnpm test:unit`: Vitest sin PostgreSQL
- `../gootip-infra/scripts/local_postgres.sh integration`: integraciones PostgreSQL de auth, core y db-config
- `pnpm typecheck`: TypeScript sin emitir
- `pnpm lint`: Oxlint
- `pnpm format:check` / `pnpm format`: check/fix Oxfmt

### Endpoint

| Method | Path          | Response                |
| ------ | ------------- | ----------------------- |
| `GET`  | `/api/health` | `200` `{"status":"ok"}` |

`/api/health` es público, sin autenticación ni dependencias externas por diseño.
Rutas desconocidas devuelven `404`.

### Lambda

- `pnpm build:lambda`: emite `dist/lambda.mjs` (ESM, `tsc` + esbuild, node24, minificado).
- `pnpm lambda:zip`: empaqueta `lambda.zip` con solo `dist/lambda.mjs`.
- Contrato runtime: `nodejs24.x`, `arm64`, handler `dist/lambda.handler`.

Terraform, API Gateway, autorizador JWT y despliegue quedan fuera de este paquete
por ahora; el detalle operativo está en `gootip-core/README.md`.

## Postman collection

See the [Postman collection guide](gootip-infra/docs/postman-collection.md) for
prerequisites, generation, import, and example limitations.
