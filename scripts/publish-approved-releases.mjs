#!/usr/bin/env node
// npm approval happens outside Actions. Finalize only this pipeline's drafts
// once the exact package version is publicly available, never just a dist-tag.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gitRunner, PACKAGE_NAME, resolveReleaseTag } from './stage-publish-validate.mjs';

export const STAGED_RELEASE_NOTICE =
  'Staged on npm; approve the npm stage with 2FA before publishing this draft.';

export async function publishApprovedReleases({ repo, git, gh, fetchImpl = fetch, log = console.log }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error('REPO must identify the GitHub owner/repository');
  }
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error('unexpected GitHub release inventory');
  }
  const published = [];
  for (const release of pages.flat()) {
    const body = release.body ?? '';
    if (!release.draft || (body !== STAGED_RELEASE_NOTICE && !body.startsWith(`${STAGED_RELEASE_NOTICE}\n`))) {
      continue;
    }
    if (!Number.isSafeInteger(release.id) || release.id <= 0) {
      throw new Error('unexpected GitHub release ID');
    }
    const { releaseTag, version } = resolveReleaseTag({ releaseTag: release.tag_name, git });
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 404) {
      log(`${releaseTag}: not public on npm; leaving draft unchanged`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`npm publication check for ${releaseTag} failed: HTTP ${response.status}`);
    }
    const pkg = await response.json();
    if (pkg.name !== PACKAGE_NAME || pkg.version !== version) {
      throw new Error(`npm metadata does not match ${PACKAGE_NAME}@${version}`);
    }
    gh(['api', `repos/${repo}/releases/${release.id}`, '--method', 'PATCH', '--input', '-'], JSON.stringify({
      draft: false,
      // An older stage may be approved after a newer release. Let GitHub select
      // latest by version rather than promoting the last draft processed.
      make_latest: release.prerelease ? 'false' : 'legacy',
      body: `Published on npm as ${PACKAGE_NAME}@${version}.${body.slice(STAGED_RELEASE_NOTICE.length)}`,
    }));
    log(`${releaseTag}: published GitHub release after confirming npm publication`);
    published.push(releaseTag);
  }
  return published;
}

export async function main(env = process.env, cwd = process.cwd()) {
  return publishApprovedReleases({
    repo: env.REPO,
    git: gitRunner(cwd),
    gh: (args, input) => execFileSync('gh', args, {
      cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
