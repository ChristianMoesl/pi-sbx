#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
	cat >&2 <<'EOF'
Usage: pnpm run release <version>

<version> must be an explicit semantic version, for example 1.2.3.
This command expects pnpm to be authenticated with the npm registry and gh to be authenticated for GitHub releases.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi

if [[ $# -ne 1 ]]; then
	usage
	exit 2
fi

requested_version=$1
registry="https://registry.npmjs.org/"

if [[ ! "${requested_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
	echo "Error: version must be an explicit semantic version, for example 1.2.3." >&2
	exit 2
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
	echo "Error: releases must be created from main." >&2
	exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Error: the working tree is not clean." >&2
	exit 1
fi

# Fail before changing package files when required authentication or the release tag is invalid.
pnpm --registry "${registry}" whoami >/dev/null
if ! command -v gh >/dev/null; then
	echo "Error: gh is required to create the GitHub release." >&2
	exit 1
fi
gh auth status >/dev/null

git fetch origin main --tags
head_commit=$(git rev-parse HEAD)
if [[ "$(git rev-parse origin/main)" != "${head_commit}" ]]; then
	echo "Error: local main is not current with origin/main; pull the latest changes first." >&2
	exit 1
fi

release_tag="v${requested_version}"
if git rev-parse --verify --quiet "refs/tags/${release_tag}" >/dev/null || \
	git ls-remote --exit-code --tags origin "refs/tags/${release_tag}" >/dev/null 2>&1; then
	echo "Error: ${release_tag} already exists." >&2
	exit 1
fi

pnpm version "${requested_version}" --no-git-tag-version
package_version=$(node -p "require('./package.json').version")
if [[ "${package_version}" != "${requested_version}" ]]; then
	git restore -- package.json pnpm-lock.yaml
	echo "Error: pnpm normalized the version to ${package_version}; aborting before commit." >&2
	exit 1
fi

git add package.json pnpm-lock.yaml
git commit -m "chore: release ${release_tag}"
git push origin main

git tag -a "${release_tag}" -m "${release_tag}"
git push origin "${release_tag}"

pnpm run publish:npm
gh release create "${release_tag}" --title "${release_tag}" --generate-notes
