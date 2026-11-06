#!/usr/bin/env bash
# SPEC 05.2: the only workstation entry point for private dev RDS access.
# It checks the configured dev account and fixes the profile, Region, resources, database
# identifier, remote SSH port, and remote PostgreSQL port. Only the local
# listening port may be overridden, and only after strict validation.
set -euo pipefail

readonly PROFILE="gootip-db-operator"
readonly REGION="us-east-2"
readonly ACCOUNT_ID="${TF_VAR_aws_account_id:-}"
readonly OPERATOR_ROLE_NAME="GootipDatabaseOperator"

readonly EICE_NAME="gootip-dev-db-eice"
readonly INSTANCE_NAME="gootip-dev-db-tunnel"
readonly DB_IDENTIFIER="gootip-dev"
readonly DB_NAME="gootip"
readonly DB_USERNAME="gootip_dev_operator"
readonly DB_OS_USER="ec2-user"
readonly SECRET_NAME="gootip-dev-db-operator"

readonly DEFAULT_LOCAL_PORT="15432"
readonly REMOTE_SSH_PORT="22"
readonly REMOTE_DB_PORT="5432"
readonly MAX_TUNNEL_DURATION="3600"
readonly LOCAL_BIND_ADDRESS="127.0.0.1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCHIVE_PATH="$ROOT_DIR/rds-ca-layer.zip"
CA_DIR="$ROOT_DIR/.db-access"
CA_PATH="$CA_DIR/rds-ca-bundle.pem"

# These are set by discovery. They are global so the EXIT trap can stop exactly
# the instance this invocation started, even if discovery or the tunnel fails.
instance_id=""
instance_state=""
instance_subnet=""
instance_vpc=""
eice_id=""
eice_state=""
eice_dns=""
eice_subnet=""
eice_vpc=""
db_endpoint=""
db_vpc=""
started_by_this_invocation=0
cleanup_done=0

log() {
  printf '%s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' was not found on PATH."
}

aws_cli() {
  command aws --profile "$PROFILE" --region "$REGION" --no-cli-pager "$@"
}

validate_local_port() {
  local port="${GOOTIP_DB_LOCAL_PORT:-$DEFAULT_LOCAL_PORT}"

  # Accept decimal digits only, then normalize leading zeroes before the
  # integer range check. Remote ports and the bind address are never inputs.
  if [[ ! "$port" =~ ^[0-9]{1,5}$ ]]; then
    die "GOOTIP_DB_LOCAL_PORT must be an integer between 1024 and 65535."
  fi
  port=$((10#$port))
  if ((port < 1024 || port > 65535)); then
    die "GOOTIP_DB_LOCAL_PORT must be an unprivileged integer between 1024 and 65535."
  fi
  printf '%s\n' "$port"
}

assert_identity() {
  local identity account arn

  [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] ||
    die "Load the independently confirmed TF_VAR_aws_account_id from local dev configuration."

  if ! identity="$(aws_cli sts get-caller-identity --output json 2>/dev/null)"; then
    die "Could not verify the gootip-db-operator profile. Run the MFA login and try again."
  fi
  account="$(printf '%s' "$identity" | jq -er '.Account' 2>/dev/null)" ||
    die "The AWS identity response did not contain an account."
  arn="$(printf '%s' "$identity" | jq -er '.Arn' 2>/dev/null)" ||
    die "The AWS identity response did not contain a role ARN."

  if [[ "$account" != "$ACCOUNT_ID" ]]; then
    die "Refusing to use profile '$PROFILE': it is not in the expected Gootip account."
  fi
  if [[ "$arn" != "arn:aws:sts::$ACCOUNT_ID:assumed-role/$OPERATOR_ROLE_NAME/"* ]]; then
    die "Refusing to use profile '$PROFILE': it is not the expected Gootip database operator role."
  fi
}

ensure_ca() {
  local verifier="$SCRIPT_DIR/verify_rds_ca_layer.sh"
  local temp_ca

  require_command unzip
  require_command shasum
  require_command grep
  [[ -f "$verifier" ]] || die "The RDS CA archive verifier is missing."

  # Verify the checksum and exact archive contents before creating or replacing
  # any local TLS material. The verifier writes its confirmation to stderr so
  # `info` keeps stdout reserved for DBeaver settings.
  if ! bash "$verifier" >&2; then
    die "The reviewed RDS CA archive did not pass verification; refusing to use TLS material."
  fi

  mkdir -p "$CA_DIR" || die "Could not create the local .db-access directory."
  chmod 700 "$CA_DIR" || die "Could not restrict the local .db-access directory."

  temp_ca="$(umask 077; mktemp "$CA_DIR/rds-ca-bundle.pem.tmp.XXXXXX")" ||
    die "Could not create a temporary CA file."
  if ! unzip -p "$ARCHIVE_PATH" "certs/rds-ca-bundle.pem" >"$temp_ca"; then
    rm -f "$temp_ca"
    die "Could not extract the reviewed RDS CA bundle."
  fi
  if ! grep -q -- '-----BEGIN CERTIFICATE-----' "$temp_ca" ||
    ! grep -q -- '-----END CERTIFICATE-----' "$temp_ca"; then
    rm -f "$temp_ca"
    die "The extracted RDS CA bundle is not a usable certificate bundle."
  fi
  chmod 600 "$temp_ca" || {
    rm -f "$temp_ca"
    die "Could not restrict the extracted RDS CA bundle."
  }
  mv -f "$temp_ca" "$CA_PATH" || die "Could not install the extracted RDS CA bundle."
}

discover_endpoint() {
  local payload details
  local tag_project tag_env tag_purpose tag_managed_by tag_name

  if ! payload="$(aws_cli ec2 describe-instance-connect-endpoints \
    --filters \
    "Name=tag:project,Values=gootip" \
    "Name=tag:env,Values=dev" \
    "Name=tag:purpose,Values=db-tunnel" \
    "Name=tag:managed_by,Values=terraform" \
    "Name=tag:Name,Values=$EICE_NAME" \
    --output json 2>/dev/null)"; then
    die "Could not discover the private database endpoint."
  fi

  details="$(printf '%s' "$payload" | jq -er '
    def tag($key): ([.Tags[]? | select(.Key == $key) | .Value] | if length == 1 then .[0] else "" end);
    .InstanceConnectEndpoints
    | if length != 1 then error("expected exactly one endpoint") else .[0] end
    | [
        .InstanceConnectEndpointId,
        .State,
        (.DnsName // ""),
        (.SubnetId // ""),
        (.VpcId // ""),
        tag("project"),
        tag("env"),
        tag("purpose"),
        tag("managed_by"),
        tag("Name")
      ]
    | join("\u001f")
  ' 2>/dev/null)" || die "Expected exactly one tagged private database endpoint."

  IFS=$'\x1f' read -r eice_id eice_state eice_dns eice_subnet eice_vpc \
    tag_project tag_env tag_purpose tag_managed_by tag_name <<<"$details"

  [[ "$eice_id" =~ ^eice-[A-Za-z0-9]+$ ]] ||
    die "The discovered Instance Connect endpoint identifier is invalid."
  [[ "$eice_state" == "create-complete" || "$eice_state" == "update-complete" ]] ||
    die "The discovered Instance Connect endpoint is not ready (state: $eice_state)."
  [[ "$eice_dns" =~ ^[A-Za-z0-9.-]+$ ]] ||
    die "The discovered Instance Connect endpoint has no valid DNS name."
  [[ "$eice_subnet" =~ ^subnet-[0-9a-f]+$ ]] ||
    die "The discovered Instance Connect endpoint subnet is invalid."
  [[ "$eice_vpc" =~ ^vpc-[0-9a-f]+$ ]] ||
    die "The discovered Instance Connect endpoint VPC is invalid."
  [[ "$tag_project" == "gootip" && "$tag_env" == "dev" &&
    "$tag_purpose" == "db-tunnel" && "$tag_managed_by" == "terraform" &&
    "$tag_name" == "$EICE_NAME" ]] ||
    die "The discovered Instance Connect endpoint does not carry the reviewed ownership tags."
}

discover_instance() {
  local safe_mode="${1:-true}"
  local payload details
  local public_ip iam_profile metadata_tokens metadata_endpoint
  local tag_project tag_env tag_purpose tag_managed_by tag_name

  if ! payload="$(aws_cli ec2 describe-instances \
    --filters \
    "Name=tag:project,Values=gootip" \
    "Name=tag:env,Values=dev" \
    "Name=tag:purpose,Values=db-tunnel" \
    "Name=tag:managed_by,Values=terraform" \
    "Name=tag:Name,Values=$INSTANCE_NAME" \
    --output json 2>/dev/null)"; then
    die "Could not discover the private database tunnel host."
  fi

  details="$(printf '%s' "$payload" | jq -er '
    def tag($key): ([.Tags[]? | select(.Key == $key) | .Value] | if length == 1 then .[0] else "" end);
    [.Reservations[]?.Instances[]?] as $instances
    | if ($instances | length) != 1 then error("expected exactly one instance") else $instances[0] end
    | [
        .InstanceId,
        .State.Name,
        (.PublicIpAddress // ""),
        (.IamInstanceProfile.Arn // ""),
        (.SubnetId // ""),
        (.VpcId // ""),
        (.MetadataOptions.HttpTokens // ""),
        (.MetadataOptions.HttpEndpoint // ""),
        tag("project"),
        tag("env"),
        tag("purpose"),
        tag("managed_by"),
        tag("Name")
      ]
    | join("\u001f")
  ' 2>/dev/null)" || die "Expected exactly one tagged private database tunnel host."

  IFS=$'\x1f' read -r instance_id instance_state public_ip iam_profile \
    instance_subnet instance_vpc metadata_tokens metadata_endpoint \
    tag_project tag_env tag_purpose tag_managed_by tag_name <<<"$details"

  [[ "$instance_id" =~ ^i-[0-9a-f]+$ ]] ||
    die "The discovered tunnel host identifier is invalid."
  if [[ "$safe_mode" == "true" ]]; then
    [[ "$instance_state" == "running" || "$instance_state" == "stopped" ]] ||
      die "The tunnel host is in an unexpected state (state: $instance_state)."
    [[ -z "$public_ip" ]] ||
      die "Refusing to use a tunnel host with a public IPv4 address."
    [[ -z "$iam_profile" ]] ||
      die "Refusing to use a tunnel host with an instance profile."
    [[ "$metadata_tokens" == "required" ]] ||
      die "Refusing to use a tunnel host without mandatory IMDSv2."
    [[ "$metadata_endpoint" == "enabled" ]] ||
      die "Refusing to use a tunnel host with the instance metadata endpoint disabled."
  else
    [[ "$instance_state" == "running" || "$instance_state" == "stopped" ||
      "$instance_state" == "stopping" ]] ||
      die "Refusing to stop a tunnel host in an unexpected state (state: $instance_state)."
  fi
  [[ "$instance_subnet" =~ ^subnet-[0-9a-f]+$ && "$instance_vpc" =~ ^vpc-[0-9a-f]+$ ]] ||
    die "The discovered tunnel host networking information is invalid."
  [[ "$tag_project" == "gootip" && "$tag_env" == "dev" &&
    "$tag_purpose" == "db-tunnel" && "$tag_managed_by" == "terraform" &&
    "$tag_name" == "$INSTANCE_NAME" ]] ||
    die "The discovered tunnel host does not carry the reviewed ownership tags."
}

discover_database() {
  local payload details
  local db_identifier_check db_status db_public db_port db_arn

  if ! payload="$(aws_cli rds describe-db-instances \
    --db-instance-identifier "$DB_IDENTIFIER" \
    --output json 2>/dev/null)"; then
    die "Could not discover the private dev database."
  fi

  details="$(printf '%s' "$payload" | jq -er '
    .DBInstances
    | if length != 1 then error("expected exactly one database") else .[0] end
    | [
        .DBInstanceIdentifier,
        (.DBInstanceStatus // ""),
        ((.PubliclyAccessible // false) | tostring),
        ((.Endpoint.Port // 0) | tostring),
        (.Endpoint.Address // ""),
        (.DBInstanceArn // ""),
        (.DBSubnetGroup.VpcId // "")
      ]
    | join("\u001f")
  ' 2>/dev/null)" || die "Expected exactly one private dev database."

  IFS=$'\x1f' read -r db_identifier_check db_status db_public db_port db_endpoint db_arn db_vpc <<<"$details"

  [[ "$db_identifier_check" == "$DB_IDENTIFIER" ]] ||
    die "The discovered database identifier does not match the reviewed dev database."
  [[ "$db_status" == "available" ]] ||
    die "The dev database is not available (state: $db_status)."
  [[ "$db_public" == "false" ]] ||
    die "Refusing to use a database that is publicly accessible."
  [[ "$db_port" == "$REMOTE_DB_PORT" ]] ||
    die "The dev database is not listening on the reviewed PostgreSQL port."
  [[ "$db_arn" == "arn:aws:rds:$REGION:$ACCOUNT_ID:db:$DB_IDENTIFIER" ]] ||
    die "The discovered database ARN is not the reviewed dev database."
  [[ "$db_endpoint" =~ ^$DB_IDENTIFIER\.[A-Za-z0-9.-]+\.$REGION\.rds\.amazonaws\.com$ ]] ||
    die "The discovered database endpoint is not the reviewed regional RDS endpoint."
}

validate_topology() {
  [[ "$eice_vpc" == "$instance_vpc" ]] ||
    die "The private endpoint and tunnel host are not in the same VPC."
  [[ "$eice_subnet" == "$instance_subnet" ]] ||
    die "The private endpoint and tunnel host are not in the reviewed private subnet."
  if [[ -n "${db_vpc:-}" && "$db_vpc" != "$instance_vpc" ]]; then
    die "The database and tunnel host are not in the same VPC."
  fi
}

cleanup() {
  local status=$?

  trap - EXIT
  trap - INT
  trap - TERM

  if [[ "$cleanup_done" == "0" ]]; then
    cleanup_done=1
    if [[ "$started_by_this_invocation" == "1" && -n "$instance_id" ]]; then
      log "Stopping the tunnel host because this session started it."
      if ! aws_cli ec2 stop-instances --instance-ids "$instance_id" >/dev/null 2>&1; then
        log "warning: the tunnel host did not accept the stop request."
        log "Run: $SCRIPT_DIR/db_access.sh stop"
        status=1
      elif ! aws_cli ec2 wait instance-stopped --instance-ids "$instance_id" >/dev/null 2>&1; then
        log "warning: the tunnel host stop was requested but not confirmed."
        log "Run: $SCRIPT_DIR/db_access.sh stop"
        status=1
      else
        log "Tunnel host stopped."
      fi
    fi
  fi

  exit "$status"
}

cmd_info() {
  local port
  port="$(validate_local_port)"

  require_command aws
  require_command jq
  assert_identity
  ensure_ca
  discover_endpoint
  discover_instance
  discover_database
  validate_topology

  printf 'Driver: PostgreSQL\n'
  printf 'Host: localhost\n'
  printf 'Port: %s\n' "$port"
  printf 'Database: %s\n' "$DB_NAME"
  printf 'Username: %s\n' "$DB_USERNAME"
  printf 'Authentication: Password from shell command\n'
  printf 'Password command: %q password\n' "$SCRIPT_DIR/db_access.sh"
  printf 'Saved password: Disabled\n'
  printf 'SSL mode: verify-full\n'
  printf 'CA certificate: %s\n' "$CA_PATH"
  printf 'Certificate hostname: %s\n' "$db_endpoint"
  printf 'Skip hostname validation: Disabled\n'
  printf 'Verify server certificate: Enabled\n'
}

cmd_tunnel() {
  local port forwarding

  port="$(validate_local_port)"
  require_command aws
  require_command jq
  require_command ssh
  assert_identity
  ensure_ca
  discover_endpoint
  discover_instance
  discover_database
  validate_topology

  if [[ "$instance_state" == "stopped" ]]; then
    log "Starting the private tunnel host."
    if ! aws_cli ec2 start-instances --instance-ids "$instance_id" >/dev/null 2>&1; then
      die "Could not start the private tunnel host."
    fi
    # From this point on, this invocation owns the stopped-to-running change.
    started_by_this_invocation=1
    if ! aws_cli ec2 wait instance-running --instance-ids "$instance_id" >/dev/null 2>&1; then
      die "The private tunnel host did not reach the running state."
    fi
    log "Tunnel host is running."
  else
    log "Tunnel host was already running; this session will leave it running."
  fi

  forwarding="$LOCAL_BIND_ADDRESS:$port:$db_endpoint:$REMOTE_DB_PORT"
  log "Opening $LOCAL_BIND_ADDRESS:$port to the private database on $REMOTE_DB_PORT."
  log "Press Ctrl-C to close the tunnel."
  if ! aws_cli ec2-instance-connect ssh \
    --instance-id "$instance_id" \
    --connection-type eice \
    --os-user "$DB_OS_USER" \
    --ssh-port "$REMOTE_SSH_PORT" \
    --eice-options "maxTunnelDuration=$MAX_TUNNEL_DURATION,endpointId=$eice_id" \
    --local-forwarding "$forwarding"; then
    die "The foreground tunnel ended with an error."
  fi
}

cmd_password() {
  local payload password secret_arn

  require_command aws
  require_command jq
  assert_identity

  if ! payload="$(aws_cli secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --output json 2>/dev/null)"; then
    die "Could not read the database operator secret."
  fi

  secret_arn="$(printf '%s' "$payload" | jq -er '.ARN' 2>/dev/null)" ||
    die "The database operator secret response did not contain an ARN."
  if [[ ! "$secret_arn" =~ ^arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:$SECRET_NAME-[A-Za-z0-9]{6}$ ]]; then
    die "The database operator secret ARN is not the reviewed secret container."
  fi

  if ! password="$(printf '%s' "$payload" | jq -er --arg username "$DB_USERNAME" '
    .SecretString
    | fromjson
    | select(.username == $username)
    | .password
    | select(type == "string" and length > 0)
  ' 2>/dev/null)"; then
    die "The database operator secret is missing the expected username or password."
  fi

  case "$password" in
    *$'\n'* | *$'\r'*)
      die "The database operator password contains an unsupported line break."
      ;;
  esac

  # This is the only command that writes a value to stdout. No JSON, ARN,
  # username, diagnostic, or success message may precede the password.
  printf '%s\n' "$password"
}

cmd_stop() {
  require_command aws
  require_command jq
  assert_identity
  discover_instance false

  case "$instance_state" in
    stopped)
      log "Tunnel host is already stopped."
      ;;
    stopping)
      log "Tunnel host is already stopping; waiting for it to stop."
      aws_cli ec2 wait instance-stopped --instance-ids "$instance_id" >/dev/null 2>&1 ||
        die "The tunnel host stop could not be confirmed."
      log "Tunnel host stopped."
      ;;
    running)
      log "Stopping the tunnel host."
      aws_cli ec2 stop-instances --instance-ids "$instance_id" >/dev/null 2>&1 ||
        die "Could not stop the tunnel host."
      aws_cli ec2 wait instance-stopped --instance-ids "$instance_id" >/dev/null 2>&1 ||
        die "The tunnel host stop could not be confirmed."
      log "Tunnel host stopped."
      ;;
    *)
      die "Refusing to stop a tunnel host in an unexpected state (state: $instance_state)."
      ;;
  esac
}

usage() {
  cat >&2 <<'EOF'
Usage: db_access.sh {info|tunnel|password|stop}

  info      Print non-sensitive DBeaver settings and verify the RDS CA.
  tunnel    Start the private host if needed and keep the tunnel in the foreground.
  password  Read the operator password and write only it to stdout.
  stop      Stop the exact tagged tunnel host after an interrupted session.

GOOTIP_DB_LOCAL_PORT may override only the local listening port (default 15432).
The profile and Region are fixed to gootip-db-operator and us-east-2.
EOF
}

main() {
  if [[ "$#" -ne 1 ]]; then
    usage
    exit 2
  fi

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  case "$1" in
    info) cmd_info ;;
    tunnel) cmd_tunnel ;;
    password) cmd_password ;;
    stop) cmd_stop ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
