#!/usr/bin/env node
// Direct main commits are the source of release notes; PRs are not required.
import { execFileSync } from 'node:child_process';
import { validateReleaseTag } from './stage-publish-validate.mjs';

const repository = 'https://github.com/ChristianMoesl/pi-sbx';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function isReleaseTag(tag) {
  try { validateReleaseTag(tag); return true; } catch { return false; }
}

function previousTag(tag, target) {
  const stable = !tag.includes('-');
  const candidates = git('tag', '--merged', target).split('\n').filter(candidate =>
    isReleaseTag(candidate) && (!stable || !candidate.includes('-')) &&
    git('rev-parse', `refs/tags/${candidate}^{commit}`) !== target,
  );
  if (!candidates.length) return undefined;
  // Git chooses the closest reachable tag, not the highest version or newest
  // GitHub release. Tags on this exact commit cannot form the baseline.
  return git('describe', '--tags', '--abbrev=0', `--candidates=${candidates.length}`,
    ...candidates.flatMap(candidate => ['--match', candidate]), target);
}

function markdown(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_\[\]]/g, '\\$&');
}

function main(tag) {
  validateReleaseTag(tag);
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    throw new Error('Release notes require full Git history and release tags; fetch with --unshallow --tags first.');
  }
  const target = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  const previous = previousTag(tag, target);
  const range = previous ? `refs/tags/${previous}..${target}` : target;
  const fields = git('log', '--no-merges', '--reverse', '--topo-order', '--format=%H%x00%s%x00%b%x00', range).split('\0');
  const groups = new Map(['Breaking changes', 'Features', 'Fixed', 'Changes'].map(name => [name, []]));
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const hash = fields[i].trim();
    const subject = fields[i + 1];
    const body = fields[i + 2];
    const match = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    const [, type, scope, bang, description] = match ?? [];
    const breaking = /(?:^|\n)BREAKING[ -]CHANGE:\s*([^\n]*)/.exec(body);
    if (!bang && !breaking && ['chore', 'ci', 'test'].includes(type)) continue;
    const group = bang || breaking ? 'Breaking changes' : type === 'feat' ? 'Features' : type === 'fix' ? 'Fixed' : 'Changes';
    const title = match ? `${scope ? `${scope}: ` : ''}${description}` : subject;
    let entry = `- ${markdown(title)} ([${hash.slice(0, 7)}](${repository}/commit/${hash}))`;
    // The opening paragraph explains the user-visible behavior; later
    // paragraphs commonly contain implementation or validation details.
    const detail = body.trim().split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ');
    if (detail && !/^(?:BREAKING[ -]CHANGE|[A-Za-z-]+-by):/.test(detail)) {
      entry += `\n  ${markdown(detail)}`;
    }
    if (breaking?.[1]) entry += `\n  - ${markdown(breaking[1])}`;
    groups.get(group).push(entry);
  }
  const sections = [...groups].filter(([, entries]) => entries.length)
    .map(([name, entries]) => `## ${name}\n\n${entries.join('\n')}`);
  if (!sections.length) sections.push('No user-facing changes.');
  const comparison = previous ? `${previous}...${tag}` : tag;
  const url = previous ? `${repository}/compare/${comparison}` : `${repository}/commits/${tag}`;
  sections.push(`**Full Changelog**: [${comparison}](${url})`);
  console.log(sections.join('\n\n'));
}

try {
  main(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
