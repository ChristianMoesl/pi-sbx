import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { STAGED_RELEASE_NOTICE } from './publish-approved-releases.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const validate = workflow.split('\n  validate:')[1].split('\n  stage:')[0];
const stage = workflow.split('\n  stage:')[1].split('\n  release:')[0];
const release = workflow.split('\n  release:')[1];
const publish = readFileSync(new URL('../.github/workflows/publish-approved-releases.yml', import.meta.url), 'utf8');

test('validation fetches annotated tags from explicit main before checking out the validated commit', () => {
  const checkout = validate.split('- name: Checkout with tags and history')[1].split('- name: Set up Node')[0];
  assert.match(checkout, /ref: main\n/);
  assert.match(checkout, /fetch-depth: 0\n/);
  assert.match(checkout, /fetch-tags: true\n/);
  assert.match(checkout, /persist-credentials: false\n/);
  assert.ok(validate.indexOf('node scripts/stage-publish-validate.mjs') < validate.indexOf('git checkout --detach "$RESOLVED_SHA"'));
});

test('staging retains OIDC, exact artifact verification and actionable npm authentication diagnostics', () => {
  assert.match(stage, /id-token: write/);
  assert.match(stage, /shasum -a 256 -c -/);
  assert.match(stage, /npm stage publish "\.\/dist\/\$TARBALL"/);
  assert.match(stage, /--loglevel verbose/);
  assert.match(stage, /--provenance/);
  assert.match(stage, /--ignore-scripts/);
  assert.doesNotMatch(stage, /NPM_TOKEN|NODE_AUTH_TOKEN|npm stage approve|^\s+npm publish /m);
});

test('a successful stage gates draft release creation with generated notes', () => {
  assert.match(release, /needs: \[validate, stage\]/);
  assert.match(release, /gh release create/);
  assert.match(release, /--draft/);
  assert.match(release, /--generate-notes/);
});

test('daily and dispatched publication checks cannot restage packages', () => {
  assert.match(publish, /schedule:\n[\s\S]*?- cron: '17 6 \* \* \*'/);
  assert.match(publish, /workflow_dispatch:/);
  assert.match(publish, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /group: publish-approved-releases/);
  assert.match(publish, /cancel-in-progress: false/);
  assert.match(publish, /timeout-minutes: 5/);
  assert.match(publish, /contents: write/);
  assert.match(publish, /ref: main/);
  assert.match(publish, /fetch-depth: 0/);
  assert.match(publish, /fetch-tags: true/);
  assert.match(publish, /persist-credentials: false/);
  assert.match(publish, /node scripts\/publish-approved-releases\.mjs/);
  assert.doesNotMatch(publish, /id-token: write|NPM_TOKEN|NODE_AUTH_TOKEN|npm stage approve|npm publish|npm install|pnpm/);
  assert.ok(release.includes(STAGED_RELEASE_NOTICE), 'only drafts marked by the release pipeline are eligible');
});
