import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/stage-publish.yml', import.meta.url), 'utf8');
const validate = workflow.split('\n  validate:')[1].split('\n  stage:')[0];
const stage = workflow.split('\n  stage:')[1].split('\n  release:')[0];
const release = workflow.split('\n  release:')[1];

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
