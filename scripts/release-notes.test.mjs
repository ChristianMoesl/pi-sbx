import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { STAGED_RELEASE_NOTICE } from './publish-approved-releases.mjs';

const script = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-sbx-release-notes-'));
  dirs.push(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Example Developer');
  git('config', 'user.email', 'developer@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  let count = 0;
  const commit = (subject, body) => {
    writeFileSync(join(cwd, 'fixture'), String(++count));
    git('add', 'fixture');
    git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
    return git('rev-parse', 'HEAD');
  };
  const tag = name => git('tag', '-a', name, '-m', name);
  const run = version => spawnSync(process.execPath, [script, ...(version === undefined ? [] : [version])], { cwd, encoding: 'utf8' });
  const notes = version => {
    const result = run(version);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { cwd, git, commit, tag, run, notes };
}

test('direct main commits produce grouped notes with user-facing details and commit links', () => {
  const f = fixture();
  f.commit('chore: initial'); f.tag('v1.0.0');
  const feature = f.commit('feat(tools): add sandbox search', 'Search now runs inside the selected sandbox.\n\nImplementation and test details stay out of the release notes.');
  f.commit('fix: allow newer SBX versions', 'Require stable SBX 0.48.0 or newer, including v0.50.');
  f.commit('docs: clarify setup');
  for (const type of ['chore', 'ci', 'test']) f.commit(`${type}: routine maintenance`);
  f.tag('v1.1.0');
  f.commit('fix: change after the release tag');
  const notes = f.notes('v1.1.0');
  assert.match(notes, /## Features\n\n- tools: add sandbox search/);
  assert.ok(notes.includes(`([${feature.slice(0, 7)}](https://github.com/ChristianMoesl/pi-sbx/commit/${feature}))`));
  assert.match(notes, /Search now runs inside the selected sandbox/);
  assert.match(notes, /## Fixed\n\n- allow newer SBX versions/);
  assert.match(notes, /Require stable SBX 0\.48\.0 or newer, including v0\.50/);
  assert.match(notes, /## Changes\n\n- clarify setup/);
  assert.doesNotMatch(notes, /routine maintenance|Implementation and test details|change after the release tag/);
  assert.match(notes, /compare\/v1\.0\.0\.\.\.v1\.1\.0/);
});

test('breaking changes override routine filtering and retain breaking-change explanations', () => {
  const f = fixture();
  f.commit('chore: initial'); f.tag('v1.0.0');
  f.commit('chore!: require the new runtime');
  f.commit('test: update fixtures', 'BREAKING CHANGE: Remove obsolete protocol support.');
  f.tag('v2.0.0');
  const notes = f.notes('v2.0.0');
  assert.match(notes, /## Breaking changes/);
  assert.match(notes, /require the new runtime/);
  assert.match(notes, /Remove obsolete protocol support/);
  assert.equal((notes.match(/Remove obsolete protocol support/g) ?? []).length, 1);
});

test('the first release includes all user-facing history; maintenance-only releases say so', () => {
  const f = fixture();
  f.commit('chore: initial');
  f.commit('feat: add sandbox tools'); f.tag('v1.0.0');
  assert.match(f.notes('v1.0.0'), /add sandbox tools/);
  assert.match(f.notes('v1.0.0'), /commits\/v1\.0\.0/);
  f.commit('chore: release metadata'); f.tag('v1.0.1');
  assert.match(f.notes('v1.0.1'), /No user-facing changes/);
});

test('stable releases compare against the previous stable tag while prereleases can use prereleases', () => {
  const f = fixture();
  f.commit('chore: initial'); f.tag('v1.0.0');
  f.commit('feat: add beta feature'); f.tag('v1.1.0-beta.1');
  f.commit('fix: refine beta feature'); f.tag('v1.1.0-beta.2');
  const beta = f.notes('v1.1.0-beta.2');
  assert.match(beta, /compare\/v1\.1\.0-beta\.1\.\.\.v1\.1\.0-beta\.2/);
  assert.doesNotMatch(beta, /add beta feature/);
  f.commit('fix: stabilize feature'); f.tag('v1.1.0');
  const stable = f.notes('v1.1.0');
  assert.match(stable, /compare\/v1\.0\.0\.\.\.v1\.1\.0/);
  assert.match(stable, /add beta feature/);
  assert.match(stable, /refine beta feature/);
});

test('the baseline is the closest reachable release tag, excluding same-commit and unrelated tags', () => {
  const f = fixture();
  f.commit('chore: initial'); f.tag('v8.0.0');
  f.commit('feat: older feature'); f.tag('v1.0.0');
  f.git('checkout', '-q', '-b', 'side');
  f.commit('fix: unrelated branch'); f.tag('v9.0.0');
  f.git('checkout', '-q', 'main');
  f.commit('fix: current release'); f.tag('not-a-release'); f.tag('v1.1.0'); f.tag('v7.0.0');
  const notes = f.notes('v1.1.0');
  assert.match(notes, /compare\/v1\.0\.0\.\.\.v1\.1\.0/);
  assert.match(notes, /current release/);
  assert.doesNotMatch(notes, /older feature|unrelated branch/);
});

test('plain commit subjects are retained and untrusted Markdown is escaped', () => {
  const f = fixture();
  f.commit('chore: initial'); f.tag('v1.0.0');
  f.commit('Improve sandbox discovery');
  f.commit('fix: preserve <value> and [label] *literally*', 'Handle <script> and `code` as plain text.');
  f.tag('v1.0.1');
  const notes = f.notes('v1.0.1');
  assert.match(notes, /Improve sandbox discovery/);
  assert.ok(notes.includes('preserve &lt;value&gt; and \\[label\\] \\*literally\\*'));
  assert.ok(notes.includes('Handle &lt;script&gt; and \\`code\\` as plain text.'));
});

test('shallow histories and malformed or missing tags fail instead of emitting misleading notes', () => {
  const f = fixture();
  f.commit('chore: initial'); f.tag('v1.0.0');
  f.commit('fix: current release'); f.tag('v1.0.1');
  for (const tag of [undefined, '1.0.1', 'v01.0.1', 'v1.0.1;id', 'v9.9.9']) {
    const result = f.run(tag);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  const root = mkdtempSync(join(tmpdir(), 'pi-sbx-shallow-'));
  dirs.push(root);
  const clone = join(root, 'repo');
  f.git('clone', '-q', '--depth=1', `file://${f.cwd}`, clone);
  const result = spawnSync(process.execPath, [script, 'v1.0.1'], { cwd: clone, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /full Git history/);
  assert.equal(result.stdout, '');
});

test('the release workflow creates a draft with commit-based notes and the publication marker', t => {
  // GitHub's Ubuntu runner has Bash 5. macOS's bundled Bash 3.2 cannot expand
  // the workflow's existing empty prerelease array under nounset.
  const major = Number(execFileSync('bash', ['-c', 'printf "%s" "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' }));
  if (major < 5) return t.skip('requires the Bash version used by GitHub Ubuntu runners');
  const f = fixture();
  f.commit('chore: initial'); f.tag('v1.0.0');
  f.commit('fix: allow newer SBX versions', 'Require stable SBX 0.48.0 or newer, including v0.50.'); f.tag('v1.1.0');
  const bin = join(f.cwd, 'bin');
  const scripts = join(f.cwd, 'scripts');
  mkdirSync(bin); mkdirSync(scripts);
  for (const file of ['release-notes.mjs', 'stage-publish-validate.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(scripts, file));
  }
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'api') process.exit(0);
if (args[0] !== 'release' || args[1] !== 'create' || args.includes('--generate-notes')) process.exit(99);
const index = args.indexOf('--notes-file');
if (index < 0) process.exit(98);
fs.copyFileSync(args[index + 1], process.env.CAPTURE_NOTES);
fs.writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(args));
`);
  chmodSync(gh, 0o755);
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const shell = workflow.split('      - name: Create draft release or preserve existing one\n')[1]
    .split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const result = spawnSync('bash', ['-c', shell], {
    cwd: f.cwd, encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: f.cwd,
      REPO: 'example/pi-sbx', RELEASE_TAG: 'v1.1.0', RELEASE_SHA: f.git('rev-parse', 'HEAD'),
      CAPTURE_NOTES: join(f.cwd, 'captured.md'), CAPTURE_ARGS: join(f.cwd, 'args.json'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const notes = readFileSync(join(f.cwd, 'captured.md'), 'utf8');
  assert.ok(notes.startsWith(`${STAGED_RELEASE_NOTICE}\n\n`));
  assert.match(notes, /## Fixed/);
  assert.match(notes, /stable SBX 0\.48\.0 or newer/);
  const args = JSON.parse(readFileSync(join(f.cwd, 'args.json'), 'utf8'));
  assert.equal(args[2], 'v1.1.0');
  assert.ok(args.includes('--draft'));
});
