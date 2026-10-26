import assert from 'node:assert/strict';
import test from 'node:test';
import { publishApprovedReleases, STAGED_RELEASE_NOTICE } from './publish-approved-releases.mjs';
import { PACKAGE_NAME } from './stage-publish-validate.mjs';

function fixture({ version = '0.7.2', pages, response } = {}) {
  const release = { id: 12, tag_name: `v${version}`, draft: true, body: `${STAGED_RELEASE_NOTICE}\n\nRelease notes` };
  const calls = { gh: [], fetch: [] };
  const options = {
    repo: 'example/pi-sbx',
    log() {},
    git(args) {
      if (args[0] === 'cat-file') return 'tag';
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'show') return JSON.stringify({ name: PACKAGE_NAME, version });
      assert.fail(`unexpected git arguments: ${args}`);
    },
    gh(args, input) {
      calls.gh.push({ args, input });
      if (args.includes('--paginate')) return JSON.stringify(pages ?? [[release]]);
      assert.equal(args[1], 'repos/example/pi-sbx/releases/12');
      release.draft = false;
      return '{}';
    },
    async fetchImpl(url, options) {
      calls.fetch.push({ url, options });
      return response ?? { status: 200, ok: true, json: async () => ({ name: PACKAGE_NAME, version }) };
    },
  };
  return { release, calls, options, run: (overrides = {}) => publishApprovedReleases({ ...options, ...overrides }) };
}

const patches = f => f.calls.gh.filter(call => call.args.includes('PATCH'));

test('publishes the matching pipeline draft only after an exact public npm version check', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), ['v0.7.2']);
  assert.equal(f.calls.fetch[0].url, 'https://registry.npmjs.org/%40christianmoesl%2Fpi-sbx/0.7.2');
  assert.ok(f.calls.fetch[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(patches(f)[0].input), {
    draft: false, make_latest: 'legacy', body: `Published on npm as ${PACKAGE_NAME}@0.7.2.\n\nRelease notes`,
  });
  assert.deepEqual(patches(f)[0].args, ['api', 'repos/example/pi-sbx/releases/12', '--method', 'PATCH', '--input', '-']);
  assert.deepEqual(await f.run(), []);
  assert.equal(patches(f).length, 1, 'already published releases are not modified again');
});

test('an unpublished or rejected stage remains a draft across publication checks', async () => {
  const f = fixture({ response: { status: 404, ok: false } });
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.run(), []);
  assert.equal(f.release.draft, true);
  assert.equal(patches(f).length, 0);
});

test('published releases and drafts not owned by the staging pipeline are untouched', async () => {
  const f = fixture({ pages: [[
    { draft: false, body: STAGED_RELEASE_NOTICE },
    { draft: true, body: 'Hand-written release notes' },
    { draft: true, body: `Other notes\n${STAGED_RELEASE_NOTICE}` },
    { draft: true, body: `${STAGED_RELEASE_NOTICE} extra text` },
    { draft: true, body: null },
  ]] });
  assert.deepEqual(await f.run({ git: () => assert.fail('must not inspect unrelated releases') }), []);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(patches(f).length, 0);
});

test('reads all GitHub inventory pages rather than missing older drafts', async () => {
  const f = fixture({ pages: [[{ draft: false }], [{ id: 12, draft: true, tag_name: 'v0.7.2', body: STAGED_RELEASE_NOTICE }]] });
  assert.deepEqual(await f.run(), ['v0.7.2']);
  assert.deepEqual(f.calls.gh[0].args, ['api', '--paginate', '--slurp', 'repos/example/pi-sbx/releases?per_page=100']);
});

test('prereleases use their exact npm version and preserve the GitHub prerelease flag', async () => {
  const f = fixture({ version: '1.0.0-beta.1' });
  f.release.prerelease = true;
  await f.run();
  assert.ok(f.calls.fetch[0].url.endsWith('/1.0.0-beta.1'));
  assert.equal('prerelease' in JSON.parse(patches(f)[0].input), false);
  assert.equal(JSON.parse(patches(f)[0].input).make_latest, 'false');
});

test('HTTP and network errors fail closed rather than treating an outage as approval', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture({ response: { status, ok: false } });
    await assert.rejects(f.run(), new RegExp(`HTTP ${status}`));
    assert.equal(patches(f).length, 0);
  }
  const f = fixture();
  await assert.rejects(f.run({ fetchImpl: async () => { throw new Error('timeout'); } }), /timeout/);
  assert.equal(patches(f).length, 0);
});

test('registry metadata must identify this exact package and version', async () => {
  for (const pkg of [{ name: 'other', version: '0.7.2' }, { name: PACKAGE_NAME, version: '0.7.3' }, {}]) {
    const f = fixture({ response: { status: 200, ok: true, json: async () => pkg } });
    await assert.rejects(f.run(), /npm metadata does not match/);
    assert.equal(patches(f).length, 0);
  }
  const f = fixture({ response: { status: 200, ok: true, json: async () => { throw new Error('invalid JSON'); } } });
  await assert.rejects(f.run(), /invalid JSON/);
  assert.equal(patches(f).length, 0);
});

test('untrusted tags fail before registry access or release publication', async () => {
  for (const invalid of ['malformed', 'lightweight', 'missing', 'off-main', 'wrong-version']) {
    const f = fixture();
    if (invalid === 'malformed') f.release.tag_name = 'v0.7.2;id';
    const git = args => {
      if (args[0] === 'cat-file' && invalid === 'lightweight') return 'commit';
      if (args[0] === 'cat-file' && invalid === 'missing') throw new Error('missing');
      if (args[0] === 'merge-base' && invalid === 'off-main') throw new Error('off main');
      if (args[0] === 'show' && invalid === 'wrong-version') return JSON.stringify({ name: PACKAGE_NAME, version: '0.7.1' });
      return f.options.git(args);
    };
    await assert.rejects(f.run({ git }));
    assert.equal(f.calls.fetch.length, 0, invalid);
    assert.equal(patches(f).length, 0, invalid);
  }
});

test('invalid inventory, repository, and release IDs cannot reach a publication request', async () => {
  const f = fixture();
  await assert.rejects(f.run({ repo: 'example/pi-sbx;id' }), /REPO must identify/);
  assert.equal(f.calls.gh.length, 0);
  await assert.rejects(f.run({ gh: () => '{}' }), /unexpected GitHub release inventory/);
  f.release.id = '../other';
  await assert.rejects(f.run(), /unexpected GitHub release ID/);
  assert.equal(patches(f).length, 0);
});

test('a failed GitHub publication request remains a visible check failure', async () => {
  const f = fixture();
  await assert.rejects(f.run({ gh: (args, input) => {
    if (args.includes('PATCH')) throw new Error('GitHub unavailable');
    return f.options.gh(args, input);
  } }), /GitHub unavailable/);
  assert.equal(f.release.draft, true);
});
