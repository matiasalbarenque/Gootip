#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INFRA_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly DEFAULT_REGION="us-east-2"
temporary_files=()

cleanup() {
  if ((${#temporary_files[@]} > 0)); then
    rm -f "${temporary_files[@]}"
  fi
}

trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage:
  render_backend_config.sh --root application|bootstrap \
    --confirmed-account-id ACCOUNT_ID [--profile PROFILE] [--region REGION]

The confirmed account ID must come from the authenticated AWS Console or
another trusted record independent of the selected CLI profile.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_template_token() {
  local content="$1"
  local token="$2"

  [[ "${content}" == *"${token}"* ]] || fail "Template is missing ${token}."
}

validate_single_setting() {
  local file="$1"
  local setting="$2"
  local expected_line="$3"
  local count

  count="$(grep -Ec "^[[:space:]]*${setting}[[:space:]]*=" "${file}" || true)"
  [[ "${count}" == "1" ]] || fail "Rendered configuration must contain exactly one ${setting} setting."
  grep -Fqx "${expected_line}" "${file}" || fail "Rendered ${setting} setting does not match the canonical value."
}

install_if_current() {
  local temporary_file="$1"
  local backend_output="$2"

  if [[ -e "${backend_output}" ]]; then
    if cmp -s "${temporary_file}" "${backend_output}"; then
      rm -f "${temporary_file}"
      printf 'Backend configuration is already current: %s\n' "${backend_output}"
      return
    fi

    rm -f "${temporary_file}"
    fail "Refusing to overwrite stale generated file ${backend_output}. Remove it after reviewing the active backend, then rerun."
  fi

  mv "${temporary_file}" "${backend_output}"
  printf 'Rendered backend configuration: %s\n' "${backend_output}"
}

render_backend_config() {
  local backend_template="$1"
  local backend_output="$2"
  local backend_bucket="$3"
  local backend_key="$4"
  local backend_region="$5"
  local backend_account_id="$6"
  local backend_profile="$7"
  local content
  local setting_count
  local temporary_file

  [[ -f "${backend_template}" ]] || fail "Missing backend template ${backend_template}."
  content="$(<"${backend_template}")"

  require_template_token "${content}" "__BUCKET__"
  require_template_token "${content}" "__KEY__"
  require_template_token "${content}" "__REGION__"
  require_template_token "${content}" "__ACCOUNT_ID__"
  require_template_token "${content}" "__PROFILE__"

  content="${content//__BUCKET__/${backend_bucket}}"
  content="${content//__KEY__/${backend_key}}"
  content="${content//__REGION__/${backend_region}}"
  content="${content//__ACCOUNT_ID__/${backend_account_id}}"
  content="${content//__PROFILE__/${backend_profile}}"
  [[ "${content}" != *"__"* ]] || fail "Backend template contains an unresolved placeholder."

  temporary_file="$(mktemp "${backend_output}.tmp.XXXXXX")"
  temporary_files+=("${temporary_file}")
  printf '%s\n' "${content}" >"${temporary_file}"

  validate_single_setting "${temporary_file}" "bucket" "bucket              = \"${backend_bucket}\""
  validate_single_setting "${temporary_file}" "key" "key                 = \"${backend_key}\""
  validate_single_setting "${temporary_file}" "region" "region              = \"${backend_region}\""
  validate_single_setting "${temporary_file}" "encrypt" "encrypt             = true"
  validate_single_setting "${temporary_file}" "allowed_account_ids" "allowed_account_ids = [\"${backend_account_id}\"]"
  validate_single_setting "${temporary_file}" "profile" "profile             = \"${backend_profile}\""
  validate_single_setting "${temporary_file}" "use_lockfile" "use_lockfile        = true"

  setting_count="$(grep -Ec '^[[:space:]]*[a-z_]+[[:space:]]*=' "${temporary_file}" || true)"
  [[ "${setting_count}" == "7" ]] || fail "Rendered configuration contains an unsupported or missing backend setting."

  install_if_current "${temporary_file}" "${backend_output}"
}

render_bootstrap_backend_block() {
  local backend_block_template="${INFRA_DIR}/bootstrap/backend.tf.example"
  local backend_block_output="${INFRA_DIR}/bootstrap/backend.tf"
  local temporary_file

  [[ -f "${backend_block_template}" ]] || fail "Missing backend template ${backend_block_template}."
  temporary_file="$(mktemp "${backend_block_output}.tmp.XXXXXX")"
  temporary_files+=("${temporary_file}")
  cp "${backend_block_template}" "${temporary_file}"
  install_if_current "${temporary_file}" "${backend_block_output}"
}

reject_stale_bootstrap_backend_block() {
  local backend_block_template="${INFRA_DIR}/bootstrap/backend.tf.example"
  local backend_block_output="${INFRA_DIR}/bootstrap/backend.tf"

  [[ -f "${backend_block_template}" ]] || fail "Missing backend template ${backend_block_template}."
  if [[ -e "${backend_block_output}" ]] && ! cmp -s "${backend_block_template}" "${backend_block_output}"; then
    fail "Refusing to use stale generated file ${backend_block_output}. Remove it after reviewing the active backend, then rerun."
  fi
}

root_name=""
confirmed_account_id=""
profile=""
region="${DEFAULT_REGION}"

while (($# > 0)); do
  case "$1" in
    --root)
      (($# >= 2)) || fail "--root requires a value."
      root_name="$2"
      shift 2
      ;;
    --confirmed-account-id)
      (($# >= 2)) || fail "--confirmed-account-id requires a value."
      confirmed_account_id="$2"
      shift 2
      ;;
    --profile)
      (($# >= 2)) || fail "--profile requires a value."
      profile="$2"
      shift 2
      ;;
    --region)
      (($# >= 2)) || fail "--region requires a value."
      region="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ "${root_name}" == "application" || "${root_name}" == "bootstrap" ]] || fail "--root must be application or bootstrap."
[[ "${confirmed_account_id}" =~ ^[0-9]{12}$ ]] || fail "--confirmed-account-id must contain exactly twelve digits."
[[ "${region}" == "${DEFAULT_REGION}" ]] || fail "Region must be ${DEFAULT_REGION} for this dev contract."
command -v aws >/dev/null 2>&1 || fail "AWS CLI is required."

if [[ "${root_name}" == "application" ]]; then
  readonly expected_profile="gootip-terraform-deploy"
  readonly expected_role_path="gootip/deployment/GootipTerraformDeploy"
  readonly expected_role_name="GootipTerraformDeploy"
  readonly state_key="gootip/dev/terraform.tfstate"
  readonly template_file="${INFRA_DIR}/environments/dev.s3.tfbackend.example"
  readonly output_file="${INFRA_DIR}/environments/dev.s3.tfbackend"
else
  readonly expected_profile="gootip-bootstrap-admin"
  readonly expected_role_path="gootip/bootstrap/GootipBootstrapAdmin"
  readonly expected_role_name="GootipBootstrapAdmin"
  readonly state_key="bootstrap/terraform.tfstate"
  readonly template_file="${INFRA_DIR}/bootstrap/environments/dev.s3.tfbackend.example"
  readonly output_file="${INFRA_DIR}/bootstrap/environments/dev.s3.tfbackend"
fi

profile="${profile:-${expected_profile}}"
[[ "${profile}" == "${expected_profile}" ]] || fail "Root ${root_name} requires profile ${expected_profile}, not ${profile}."

if [[ "${root_name}" == "bootstrap" ]]; then
  reject_stale_bootstrap_backend_block
fi

identity_output="$(aws sts get-caller-identity \
  --profile "${profile}" \
  --region "${region}" \
  --query '[Account,Arn]' \
  --output text)" || fail "Unable to resolve STS identity for profile ${profile}."

read -r discovered_account_id caller_arn <<<"${identity_output}"
[[ "${discovered_account_id}" =~ ^[0-9]{12}$ ]] || fail "STS returned a malformed Account ID."
[[ "${discovered_account_id}" == "${confirmed_account_id}" ]] || fail "STS account does not match the independently confirmed account."

configured_role_arn="$(aws configure get role_arn --profile "${profile}")"
expected_role_arn="arn:aws:iam::${confirmed_account_id}:role/${expected_role_path}"
[[ "${configured_role_arn}" == "${expected_role_arn}" ]] || fail "Selected profile does not contain the canonical role ARN."

if [[ "${caller_arn}" =~ ^arn:([^:]+):sts::([0-9]{12}):assumed-role/(.+)/([^/]+)$ ]]; then
  readonly arn_account_id="${BASH_REMATCH[2]}"
  readonly caller_role_name="${BASH_REMATCH[3]}"
else
  fail "Selected profile did not resolve to an assumed-role ARN."
fi

[[ "${arn_account_id}" == "${confirmed_account_id}" ]] || fail "Caller ARN account does not match the confirmed account."
[[ "${caller_role_name}" == "${expected_role_name}" ]] || fail "Selected profile resolved to unexpected role name ${caller_role_name}."

readonly bucket="gootip-terraform-state-${confirmed_account_id}"

bucket_region="$(aws s3api get-bucket-location \
  --bucket "${bucket}" \
  --expected-bucket-owner "${confirmed_account_id}" \
  --profile "${profile}" \
  --region "${region}" \
  --query 'LocationConstraint' \
  --output text)" || fail "Cannot verify the Region of ${bucket}; refusing to render."
[[ "${bucket_region}" == "${region}" ]] || fail "Bucket ${bucket} is in ${bucket_region}, not required Region ${region}; refusing to render."

aws s3api list-objects-v2 \
  --bucket "${bucket}" \
  --prefix "${state_key}" \
  --max-keys 1 \
  --expected-bucket-owner "${confirmed_account_id}" \
  --profile "${profile}" \
  --region "${region}" >/dev/null || fail "Cannot verify that ${bucket} belongs to the confirmed account; refusing to render."

render_backend_config \
  "${template_file}" \
  "${output_file}" \
  "${bucket}" \
  "${state_key}" \
  "${region}" \
  "${confirmed_account_id}" \
  "${profile}"

if [[ "${root_name}" == "bootstrap" ]]; then
  render_bootstrap_backend_block
fi
