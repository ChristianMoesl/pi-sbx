#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
	cat >&2 <<'EOF'
Usage: npm run release -- <version>

<version> must be an explicit semantic version, for example 1.2.3.
This command expects npm to already be authenticated for publishing.
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

# Fail before changing package files when npm login or the release tag is invalid.
npm --registry "${registry}" whoami >/dev/null

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

npm version "${requested_version}" --no-git-tag-version
package_version=$(node -p "require('./package.json').version")
if [[ "${package_version}" != "${requested_version}" ]]; then
	git restore -- package.json package-lock.json
	echo "Error: npm normalized the version to ${package_version}; aborting before commit." >&2
	exit 1
fi

git add package.json package-lock.json
git commit -m "chore: release ${release_tag}"
git push origin main

git tag -a "${release_tag}" -m "${release_tag}"
git push origin "${release_tag}"

npm run publish:npm
