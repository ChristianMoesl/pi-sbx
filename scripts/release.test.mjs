import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const source = new URL('./release.sh', import.meta.url);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-sbx-release-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(bin); mkdirSync(join(repo, 'scripts'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('init', '-q', '--bare', '-b', 'main', remote);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
  copyFileSync(source, join(repo, 'scripts/release.sh'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.0.0' }) + '\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  git('remote', 'add', 'origin', remote); git('push', '-q', '-u', 'origin', 'main');
  const log = join(root, 'commands.log');
  const mock = `#!/usr/bin/env node
const fs = require('fs');
const cmd = require('path').basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, cmd + ' ' + args.join(' ') + '\\n');
if (cmd === 'pnpm' && args.join(' ') === 'run check') process.exit(process.env.FAIL_CHECK ? 1 : 0);
if (cmd === 'pnpm' && args[0] === 'version' && args[2] === '--no-git-tag-version') {
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.version = args[1]; fs.writeFileSync('package.json', JSON.stringify(p) + '\\n'); process.exit(0);
}
if (cmd === 'npm' && args.join(' ') === 'pack --dry-run --ignore-scripts') process.exit(0);
console.error('Unexpected command: ' + cmd + ' ' + args.join(' ')); process.exit(99);
`;
  for (const cmd of ['pnpm', 'npm', 'gh']) {
    const path = join(bin, cmd); writeFileSync(path, mock); chmodSync(path, 0o755);
  }
  return {
    repo, git,
    commands: () => readFileSync(log, 'utf8').trim().split('\n'),
    run: (args, env = {}) => spawnSync('bash', [join(repo, 'scripts/release.sh'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, ...env },
    }),
  };
}

test('release validates, bumps, pushes main and annotated tag without publishing or gh', () => {
  const f = fixture();
  const r = f.run(['1.1.0-beta.1']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.commands(), [
    'pnpm run check', 'npm pack --dry-run --ignore-scripts', 'pnpm version 1.1.0-beta.1 --no-git-tag-version',
  ]);
  assert.equal(f.git('cat-file', '-t', 'v1.1.0-beta.1'), 'tag');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('rev-list', '-n', '1', 'v1.1.0-beta.1'), head);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], head);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v1.1.0-beta.1^{}').split(/\s/)[0], head);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('failed checks leave version and commits unchanged and push no tag', () => {
  const f = fixture(); const head = f.git('rev-parse', 'HEAD');
  const r = f.run(['1.0.1'], { FAIL_CHECK: '1' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(f.commands(), ['pnpm run check']);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('ls-remote', '--tags', 'origin'), '');
});

test('release rejects existing tags before validation or version changes', () => {
  const f = fixture(); f.git('tag', '-a', 'v1.0.1', '-m', 'existing'); f.git('push', '-q', 'origin', 'v1.0.1');
  const r = f.run(['1.0.1']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /already exists/);
  assert.equal(JSON.parse(readFileSync(join(f.repo, 'package.json'))).version, '1.0.0');
});

test('release rejects a dirty working tree', () => {
  const f = fixture(); writeFileSync(join(f.repo, 'dirty'), 'dirty');
  const r = f.run(['1.0.1']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /not clean/);
});

test('release rejects non-main checkouts', () => {
  const f = fixture(); f.git('checkout', '-q', '--detach');
  const r = f.run(['1.0.1']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /from main/);
});

test('release retains explicit version interface and supports help without authentication', () => {
  const f = fixture();
  assert.equal(f.run(['--help']).status, 0);
  for (const args of [[], ['patch'], ['1.0.1', 'extra']]) assert.equal(f.run(args).status, 2);
});

test('release rejects main ahead of origin before validation or mutations', () => {
  const f = fixture();
  f.git('commit', '-q', '--allow-empty', '-m', 'local only');
  const head = f.git('rev-parse', 'HEAD');
  const r = f.run(['1.0.1']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /not current/);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('tag', '--list'), '');
});
