#!/usr/bin/env node
// Validates the inputs for the staged npm release pipeline.
// No dependencies. Git is invoked with argument arrays, never through a shell.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Strict vX.Y.Z with optional prerelease (no build metadata).
const RELEASE_TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
// Starts with a letter (no leading digit or dash), only safe characters.
const NPM_TAG_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/i;

export function validateReleaseTag(tag) {
  if (typeof tag !== 'string' || !RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`release_tag must be an exact v<semver> tag, got ${JSON.stringify(tag)}`);
  }
  return tag;
}

export function validateNpmTag(tag) {
  if (typeof tag !== 'string' || !NPM_TAG_PATTERN.test(tag) || /^v\d/i.test(tag)) {
    throw new Error(`npm_tag must be a non-version dist-tag, got ${JSON.stringify(tag)}`);
  }
  return tag;
}

export function gitRunner(cwd) {
  return (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOr(git, args, message) {
  try {
    return git(args);
  } catch {
    throw new Error(message);
  }
}

export function validateStagePublish({ eventName, ref, releaseTag, npmTag, git }) {
  validateReleaseTag(releaseTag);
  validateNpmTag(npmTag);

  if (eventName === 'workflow_dispatch') {
    if (ref !== 'refs/heads/main') {
      throw new Error(`workflow_dispatch must run from main, got ${ref}`);
    }
  } else if (eventName === 'push') {
    if (ref !== `refs/tags/${releaseTag}`) {
      throw new Error(`push ref ${ref} does not match release_tag ${releaseTag}`);
    }
  } else {
    throw new Error(`unsupported event ${JSON.stringify(eventName)}`);
  }

  if (releaseTag.includes('-') && npmTag === 'latest') {
    throw new Error('prereleases must use a non-latest npm dist-tag (for example next)');
  }

  const objectType = gitOr(
    git,
    ['cat-file', '-t', `refs/tags/${releaseTag}`],
    `tag ${releaseTag} not found`,
  ).trim();
  if (objectType !== 'tag') {
    throw new Error(`tag ${releaseTag} must be annotated`);
  }

  const sha = gitOr(
    git,
    ['rev-parse', '--verify', '--quiet', `refs/tags/${releaseTag}^{commit}`],
    `tag ${releaseTag} does not resolve to a commit`,
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not resolve ${releaseTag} to a commit`);
  }

  try {
    git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
  } catch {
    throw new Error(`${releaseTag} (${sha}) is not reachable from origin/main`);
  }

  const pkg = JSON.parse(git(['show', `${sha}:package.json`]));
  if (pkg.name !== '@christianmoesl/pi-sbx') {
    throw new Error('tagged package.json has an unexpected package name');
  }
  if (`v${pkg.version}` !== releaseTag) {
    throw new Error(
      `package.json version ${JSON.stringify(pkg.version)} at ${sha} does not match tag ${releaseTag}`,
    );
  }

  return { releaseTag, npmTag, sha, version: pkg.version };
}

// GitHub Actions provides GITHUB_EVENT_NAME and GITHUB_REF; RELEASE_TAG and NPM_TAG come from the workflow env.
export function main(env = process.env, cwd = process.cwd()) {
  const result = validateStagePublish({
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    releaseTag: env.RELEASE_TAG,
    npmTag: env.NPM_TAG,
    git: gitRunner(cwd),
  });
  const lines =
    `release_tag=${result.releaseTag}\nsha=${result.sha}\n` +
    `version=${result.version}\nnpm_tag=${result.npmTag}\n`;
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, lines);
  } else {
    process.stdout.write(lines);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
