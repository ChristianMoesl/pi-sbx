import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitRunner,
  validateNpmTag,
  validateReleaseTag,
  validateStagePublish,
} from './stage-publish-validate.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writePackage(dir, version) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@christianmoesl/pi-sbx', version }, null, 2) + '\n',
  );
}

// Temp repo on main; refs/remotes/origin/main points at main HEAD (no remote needed).
function makeFixture(version = '0.6.3') {
  const dir = mkdtempSync(join(tmpdir(), 'stage-publish-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writePackage(dir, version);
  git(dir, 'add', 'package.json');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { dir, run: gitRunner(dir) };
}

function validate(fixture, overrides = {}) {
  return validateStagePublish({
    eventName: 'workflow_dispatch',
    ref: 'refs/heads/main',
    releaseTag: 'v0.6.3',
    npmTag: 'latest',
    git: fixture.run,
    ...overrides,
  });
}

test('accepts dispatch from main with annotated tag on origin/main and matching version', () => {
  const fixture = makeFixture('0.6.3');
  git(fixture.dir, 'tag', '-a', 'v0.6.3', '-m', 'v0.6.3');
  const result = validate(fixture, { npmTag: 'next' });
  assert.equal(result.sha, git(fixture.dir, 'rev-parse', 'HEAD'));
  assert.equal(result.version, '0.6.3');
  assert.equal(result.npmTag, 'next');
});

test('accepts push of the matching tag ref', () => {
  const fixture = makeFixture('0.6.3');
  git(fixture.dir, 'tag', '-a', 'v0.6.3', '-m', 'v0.6.3');
  const result = validate(fixture, { eventName: 'push', ref: 'refs/tags/v0.6.3' });
  assert.equal(result.releaseTag, 'v0.6.3');
});

test('accepts dispatched prerelease with explicit npm tag', () => {
  const fixture = makeFixture('1.0.0-beta.1');
  git(fixture.dir, 'tag', '-a', 'v1.0.0-beta.1', '-m', 'beta');
  const result = validate(fixture, { releaseTag: 'v1.0.0-beta.1', npmTag: 'beta' });
  assert.equal(result.npmTag, 'beta');
});

test('rejects staging a prerelease with latest', () => {
  const fixture = makeFixture('1.0.0-beta.1');
  git(fixture.dir, 'tag', '-a', 'v1.0.0-beta.1', '-m', 'beta');
  assert.throws(
    () => validate(fixture, { eventName: 'push', ref: 'refs/tags/v1.0.0-beta.1', releaseTag: 'v1.0.0-beta.1' }),
    /prereleases must use a non-latest/,
  );
});

test('rejects dispatch from a non-main ref', () => {
  const fixture = makeFixture('0.6.3');
  git(fixture.dir, 'tag', '-a', 'v0.6.3', '-m', 'v0.6.3');
  assert.throws(() => validate(fixture, { ref: 'refs/heads/feature' }), /must run from main/);
});

test('rejects push whose ref does not match release_tag', () => {
  const fixture = makeFixture('0.6.3');
  git(fixture.dir, 'tag', '-a', 'v0.6.3', '-m', 'v0.6.3');
  assert.throws(
    () => validate(fixture, { eventName: 'push', ref: 'refs/tags/v0.6.2' }),
    /does not match release_tag/,
  );
});

test('rejects unsupported event names', () => {
  const fixture = makeFixture('0.6.3');
  git(fixture.dir, 'tag', '-a', 'v0.6.3', '-m', 'v0.6.3');
  assert.throws(() => validate(fixture, { eventName: 'pull_request' }), /unsupported event/);
});

test('rejects a lightweight tag', () => {
  const fixture = makeFixture('0.6.3');
  git(fixture.dir, 'tag', 'v0.6.3');
  assert.throws(() => validate(fixture), /must be annotated/);
});

test('rejects a tag whose package.json version differs', () => {
  const fixture = makeFixture('0.6.2');
  git(fixture.dir, 'tag', '-a', 'v0.6.3', '-m', 'v0.6.3');
  assert.throws(() => validate(fixture), /does not match tag v0\.6\.3/);
});

test('rejects an annotated tag not reachable from origin/main', () => {
  const fixture = makeFixture('0.6.3');
  git(fixture.dir, 'checkout', '-q', '-b', 'side');
  writePackage(fixture.dir, '0.6.4');
  git(fixture.dir, 'commit', '-q', '-am', 'side');
  git(fixture.dir, 'tag', '-a', 'v0.6.4', '-m', 'v0.6.4');
  git(fixture.dir, 'checkout', '-q', 'main');
  assert.throws(
    () => validate(fixture, { releaseTag: 'v0.6.4', eventName: 'push', ref: 'refs/tags/v0.6.4' }),
    /not reachable from origin\/main/,
  );
});

test('rejects a missing tag', () => {
  const fixture = makeFixture('0.6.3');
  assert.throws(() => validate(fixture, { releaseTag: 'v9.9.9' }), /tag v9\.9\.9 not found/);
});

test('accepts exact strict release tags', () => {
  assert.equal(validateReleaseTag('v0.6.3'), 'v0.6.3');
  assert.equal(validateReleaseTag('v1.0.0-beta.1'), 'v1.0.0-beta.1');
});

test('rejects malformed or unsafe release tags', () => {
  for (const tag of [
    '0.6.3', 'v0.6', 'v01.0.0', 'v0.6.3 ', 'v0.6.3;id', '-v0.6.3',
    '$(id)', 'refs/tags/v0.6.3', '', undefined,
  ]) {
    assert.throws(() => validateReleaseTag(tag), /release_tag must be/, `accepted ${tag}`);
  }
});

test('accepts safe non-version npm dist-tags', () => {
  for (const tag of ['latest', 'next', 'beta-1', 'stable.channel']) {
    assert.equal(validateNpmTag(tag), tag);
  }
});

test('rejects npm dist-tags that look like versions or contain unsafe characters', () => {
  for (const tag of ['', '1.0.0', 'v1.0.0', 'v1', '-latest', 'a b', 'latest;rm', 'x'.repeat(65), undefined]) {
    assert.throws(() => validateNpmTag(tag), /npm_tag must be/, `accepted ${tag}`);
  }
});

test('rejects invalid inputs before running git', () => {
  let called = false;
  assert.throws(
    () => validateStagePublish({
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      releaseTag: 'bad',
      npmTag: 'latest',
      git: () => (called = true),
    }),
    /release_tag must be/,
  );
  assert.equal(called, false);
});

test('accepts a pushed prerelease using next', () => {
  const fixture = makeFixture('1.0.0-beta.1');
  git(fixture.dir, 'tag', '-a', 'v1.0.0-beta.1', '-m', 'beta');
  const result = validate(fixture, {
    eventName: 'push', ref: 'refs/tags/v1.0.0-beta.1', releaseTag: 'v1.0.0-beta.1', npmTag: 'next',
  });
  assert.equal(result.npmTag, 'next');
});

test('rejects tags for an unexpected package name', () => {
  const fixture = makeFixture('0.6.3');
  writeFileSync(join(fixture.dir, 'package.json'), JSON.stringify({ name: 'other', version: '0.6.3' }));
  git(fixture.dir, 'commit', '-q', '-am', 'wrong package');
  git(fixture.dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(fixture.dir, 'tag', '-a', 'v0.6.3', '-m', 'v0.6.3');
  assert.throws(() => validate(fixture), /unexpected package name/);
});
