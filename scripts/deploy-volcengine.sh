#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -z "${VOLCENGINE_ACCESS_KEY:-}" || -z "${VOLCENGINE_SECRET_KEY:-}" ]]; then
  echo "Export VOLCENGINE_ACCESS_KEY and VOLCENGINE_SECRET_KEY first." >&2
  exit 1
fi

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production. Copy .env.example and fill the model values." >&2
  exit 1
fi

if [[ ! -f deploy/volcengine/terraform.tfvars ]]; then
  echo "Missing deploy/volcengine/terraform.tfvars." >&2
  echo "Copy terraform.tfvars.example and fill the region-specific values." >&2
  exit 1
fi

set -a
source .env.production
set +a

if [[ "${MODEL_API_KEY:-}" == "" || "${MODEL_NAME:-}" == "" || "${MODEL_BASE_URL:-}" == "" || "${APP_AUTH_TOKEN:-}" == "" ]]; then
  echo "MODEL_API_KEY, MODEL_NAME, MODEL_BASE_URL and APP_AUTH_TOKEN are required in .env.production." >&2
  exit 1
fi

export TF_VAR_model_api_key="$MODEL_API_KEY"
export TF_VAR_app_auth_token="$APP_AUTH_TOKEN"
export TF_VAR_model_name="$MODEL_NAME"
export TF_VAR_model_base_url="$MODEL_BASE_URL"

terraform -chdir=deploy/volcengine init
terraform -chdir=deploy/volcengine apply

echo
echo "Deployment requested. Cloud-init may take 5-10 minutes."
terraform -chdir=deploy/volcengine output app_url
