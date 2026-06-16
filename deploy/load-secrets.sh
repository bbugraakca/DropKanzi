#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${AWS_REGION:-}" ]]; then
  echo "AWS_REGION is required"
  exit 1
fi

PARAM_PATH="${SSM_PARAM_PATH:-/dropkanzi/prod}"
OUT_FILE="${OUT_FILE:-/opt/dropkanzi/.env.runtime}"

aws ssm get-parameters-by-path \
  --path "${PARAM_PATH}" \
  --with-decryption \
  --recursive \
  --region "${AWS_REGION}" \
  --query 'Parameters[*].[Name,Value]' \
  --output text | while IFS=$'\t' read -r name value; do
    key="${name##*/}"
    printf "%s=%s\n" "${key}" "${value}"
  done > "${OUT_FILE}"

chmod 600 "${OUT_FILE}"
