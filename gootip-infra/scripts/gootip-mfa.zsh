# SPEC 02.4 — automatic MFA renewal for local AWS access.
#
# Install once per machine by adding this line to ~/.zshrc (absolute path):
#
#   source /absolute/path/to/gootip-infra/scripts/gootip-mfa.zsh
#
# The hook verifies the long-lived `gootip-mfa` source session only when you
# enter this project tree (or start an interactive shell inside it) and only
# when it is missing or explicitly expired. It never replaces direnv: direnv
# still selects `AWS_PROFILE`; this file only manages the source session's
# interactive lifecycle. `gootip-mfa-refresh` renews the source session on
# demand while you stay in the directory.
#
# Verification and renewal run in a child environment with the inherited AWS
# credential variables removed, so an assumed role or a stale profile can never
# mask the source session. The parent shell is never modified.

typeset -g GOOTIP_MFA_ROOT="${${(%):-%N}:A:h:h}"

typeset -g GOOTIP_MFA_SOURCE_PROFILE=gootip-dev
typeset -g GOOTIP_MFA_SESSION_PROFILE=gootip-mfa
typeset -g GOOTIP_MFA_DURATION=10800
typeset -g GOOTIP_MFA_STS_TIMEOUT=5

# Run a command in a child environment that removes every inherited AWS
# credential variable and any inherited AWS_PROFILE, then explicitly selects
# the intended profile through the command's own flags.
_gootip_mfa_clear_env() {
  command env \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    -u AWS_SECURITY_TOKEN \
    -u AWS_PROFILE \
    "$@"
}

# Only interactive zsh with a usable terminal, outside CI and direnv's own
# environment evaluation. GOOTIP_MFA_DISABLE is an operator escape hatch.
_gootip_mfa_enabled() {
  [[ -o interactive ]] || return 1
  [[ -t 0 || -t 1 ]] || return 1
  [[ -z "${CI:-}" ]] || return 1
  [[ -z "${DIRENV_IN_ENVRC:-}" ]] || return 1
  [[ -z "${GOOTIP_MFA_DISABLE:-}" ]] || return 1
  return 0
}

# Sets _GOOTIP_MFA_STATE to one of: valid, renew, error.
# Sets _GOOTIP_MFA_REASON to a short human label for the error case.
# A read-only, time-bounded STS call against the source session only.
_gootip_mfa_verify() {
  _GOOTIP_MFA_STATE=error
  _GOOTIP_MFA_REASON="unrecognized error"

  if ! (( ${+commands[aws]} )); then
    _GOOTIP_MFA_REASON="the AWS CLI ('aws') is not on PATH"
    return 0
  fi

  local output rc
  output="$(_gootip_mfa_clear_env aws sts get-caller-identity \
    --profile "$GOOTIP_MFA_SESSION_PROFILE" \
    --output json \
    --no-cli-pager \
    --cli-connect-timeout "$GOOTIP_MFA_STS_TIMEOUT" \
    --cli-read-timeout "$GOOTIP_MFA_STS_TIMEOUT" 2>&1)"
  rc=$?

  if (( rc == 0 )); then
    _GOOTIP_MFA_STATE=valid
    _GOOTIP_MFA_REASON=""
    return 0
  fi

  case "$output" in
    (*ExpiredToken*|*"token included in the request is expired"*|*"session has expired"*)
      _GOOTIP_MFA_STATE=renew
      _GOOTIP_MFA_REASON="expired"
      ;;
    (*ProfileNotFound*|*"could not be found"*|*"Unable to locate credentials"*)
      _GOOTIP_MFA_STATE=renew
      _GOOTIP_MFA_REASON="missing source session"
      ;;
    (*AccessDenied*|*"not authorized"*)
      _GOOTIP_MFA_REASON="access denied"
      ;;
    (*"Could not connect"*|*"Connect timeout"*|*"Read timeout"*|*"endpoint URL"*|*"Name or service not known"*|*"nodename nor servname"*)
      _GOOTIP_MFA_REASON="network failure"
      ;;
    (*InvalidClientTokenId*|*"security token included in the request is invalid"*)
      _GOOTIP_MFA_REASON="invalid credentials"
      ;;
    (*)
      _GOOTIP_MFA_REASON="unrecognized error"
      ;;
  esac
  return 0
}

# Renew the source session. Interactive only: the AWS CLI prompts for the MFA
# code and the prompt must reach the terminal. Never guesses a missing ARN.
_gootip_mfa_renew() {
  if [[ ! -t 0 || ! -t 1 ]]; then
    print -u2 -- "gootip-mfa: renewal needs an interactive terminal."
    return 1
  fi

  local serial
  serial="$(_gootip_mfa_clear_env aws configure get mfa_serial \
    --profile "$GOOTIP_MFA_SOURCE_PROFILE" 2>/dev/null)"

  if [[ -z "$serial" ]]; then
    print -u2 -- "gootip-mfa: no MFA device ARN is configured for profile '$GOOTIP_MFA_SOURCE_PROFILE'."
    print -u2 -- "gootip-mfa: configure it locally (never commit it):"
    print -u2 -- "  aws configure set mfa_serial <MFA_DEVICE_ARN> --profile $GOOTIP_MFA_SOURCE_PROFILE"
    return 1
  fi

  local rc
  _gootip_mfa_clear_env aws configure mfa-login \
    --profile "$GOOTIP_MFA_SOURCE_PROFILE" \
    --duration-seconds "$GOOTIP_MFA_DURATION" \
    --update-profile "$GOOTIP_MFA_SESSION_PROFILE" \
    --serial-number "$serial"
  rc=$?

  if (( rc != 0 )); then
    print -u2 -- "gootip-mfa: renewal failed or was cancelled; the shell is unchanged."
    return $rc
  fi

  print -u2 -- "gootip-mfa: renewed the '$GOOTIP_MFA_SESSION_PROFILE' source session for $(( GOOTIP_MFA_DURATION / 3600 )) hours."
  return 0
}

# Manual renewal while the operator stays in the directory.
gootip-mfa-refresh() {
  if [[ ! -t 0 || ! -t 1 ]]; then
    print -u2 -- "gootip-mfa-refresh: needs an interactive terminal."
    return 1
  fi
  _gootip_mfa_renew
}

# Entry check: reuse a valid session silently; renew only when missing or
# expired; report every uncertain failure without launching MFA login.
_gootip_mfa_check() {
  _gootip_mfa_enabled || return 0

  _gootip_mfa_verify
  case "$_GOOTIP_MFA_STATE" in
    (valid)
      return 0
      ;;
    (renew)
      _gootip_mfa_renew
      return 0
      ;;
    (error)
      print -u2 -- "gootip-mfa: could not verify the '$GOOTIP_MFA_SESSION_PROFILE' source session ($_GOOTIP_MFA_REASON)."
      print -u2 -- "gootip-mfa: not launching MFA login. Run 'gootip-mfa-refresh' to renew manually."
      return 0
      ;;
  esac
}

typeset -g _GOOTIP_MFA_INSIDE=0

_gootip_mfa_update_inside() {
  if [[ "$PWD" == "$GOOTIP_MFA_ROOT" || "$PWD" == "$GOOTIP_MFA_ROOT"/* ]]; then
    _GOOTIP_MFA_INSIDE=1
  else
    _GOOTIP_MFA_INSIDE=0
  fi
}

# Fires on cd/pushd/popd. Prompts only on a transition from outside to inside;
# moving between descendants leaves the flag set and does nothing.
_gootip_mfa_chpwd() {
  local was_inside=$_GOOTIP_MFA_INSIDE
  _gootip_mfa_update_inside
  if (( was_inside == 0 && _GOOTIP_MFA_INSIDE == 1 )); then
    _gootip_mfa_check
  fi
}

typeset -ga chpwd_functions
chpwd_functions=(${chpwd_functions:#_gootip_mfa_chpwd})
chpwd_functions+=(_gootip_mfa_chpwd)

# One startup check when the shell opens inside the tree.
_gootip_mfa_update_inside
if (( _GOOTIP_MFA_INSIDE == 1 )); then
  _gootip_mfa_check
fi
