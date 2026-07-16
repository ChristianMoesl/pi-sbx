#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

registry="https://registry.npmjs.org/"
dry_run=false

case "${1:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  *)
    echo "Usage: npm run publish:npm -- [--dry-run]" >&2
    exit 2
    ;;
esac

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Error: releases must be published from main." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: the working tree is not clean." >&2
  exit 1
fi

package_name=$(node -p "require('./package.json').name")
package_version=$(node -p "require('./package.json').version")
release_tag="v${package_version}"
head_commit=$(git rev-parse HEAD)

if ! git rev-parse --verify --quiet "refs/tags/${release_tag}" >/dev/null; then
  echo "Error: ${release_tag} does not exist. Tag this release first." >&2
  exit 1
fi

if [[ "$(git rev-list -n 1 "${release_tag}")" != "${head_commit}" ]]; then
  echo "Error: ${release_tag} does not point to HEAD." >&2
  exit 1
fi

remote_main=$(git ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')
if [[ "${remote_main}" != "${head_commit}" ]]; then
  echo "Error: HEAD is not the commit currently pushed to origin/main." >&2
  exit 1
fi

remote_tag=$(git ls-remote origin "refs/tags/${release_tag}^{}" | awk 'NR == 1 { print $1 }')
if [[ -z "${remote_tag}" ]]; then
  remote_tag=$(git ls-remote origin "refs/tags/${release_tag}" | awk 'NR == 1 { print $1 }')
fi
if [[ "${remote_tag}" != "${head_commit}" ]]; then
  echo "Error: ${release_tag} is not pushed to origin or does not point to HEAD." >&2
  exit 1
fi

echo "Checking ${package_name}@${package_version}..."
npm run check
npm pack --dry-run

if [[ "${dry_run}" == true ]]; then
  echo "Dry run complete; nothing was published."
  exit 0
fi

npm_args=(--registry "${registry}")
temporary_npmrc=""
cleanup() {
  if [[ -n "${temporary_npmrc}" ]]; then
    rm -f "${temporary_npmrc}"
  fi
}
trap cleanup EXIT

if [[ -n "${NPM_TOKEN:-}" ]]; then
  temporary_npmrc=$(mktemp)
  chmod 600 "${temporary_npmrc}"
  printf '//registry.npmjs.org/:_authToken=%s\n' "${NPM_TOKEN}" >"${temporary_npmrc}"
  npm_args=(--userconfig "${temporary_npmrc}" "${npm_args[@]}")
fi

npm "${npm_args[@]}" whoami >/dev/null

if published_version=$(npm "${npm_args[@]}" view "${package_name}@${package_version}" version 2>/dev/null); then
  echo "Error: ${package_name}@${published_version} is already published." >&2
  exit 1
fi

printf 'Publish %s@%s to npm? [y/N] ' "${package_name}" "${package_version}"
read -r confirmation
if [[ "${confirmation}" != "y" && "${confirmation}" != "Y" ]]; then
  echo "Publication cancelled."
  exit 1
fi

npm "${npm_args[@]}" publish --access public
echo "Published ${package_name}@${package_version}."
