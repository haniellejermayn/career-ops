import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from './helpers.mjs';
import {
  allocateResumeOutputPaths,
  resumeOutputBasename,
  resumeOutputDirectoryName,
} from '../resume-output.mjs';

test('resume draft paths are stable, professional, Windows-safe, and preserve existing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-resume-output-'));
  try {
    assert.equal(
      resumeOutputDirectoryName({ date: '2026-08-30', company: 'P&G', role: 'AI Engineering Intern' }),
      '2026-08-30-pg-ai-engineering-intern',
    );
    assert.equal(resumeOutputBasename('Hanielle Jermayn E. Chua'), 'Hanielle-Chua-Resume');

    const first = allocateResumeOutputPaths({
      date: '2026-08-30',
      company: 'P&G',
      role: 'AI Engineering Intern',
      candidate: 'Hanielle Jermayn E. Chua',
      root,
    });
    assert.equal(first.key, '2026-08-30-pg-ai-engineering-intern');
    assert.equal(first.tex, join(first.root, 'Hanielle-Chua-Resume.tex'));
    assert.equal(first.pdf, join(first.root, 'Hanielle-Chua-Resume.pdf'));
    assert.equal(first.html, join(first.root, 'Hanielle-Chua-Resume.html'));
    assert.equal(first.markdown, join(first.root, 'Hanielle-Chua-Resume.md'));
    assert.equal(first.root.split(/[\\/]/).length, root.split(/[\\/]/).length + 1, 'the layout adds only one directory level');
    assert.ok(existsSync(first.root), 'allocation reserves the application directory');

    writeFileSync(first.pdf, 'existing PDF bytes');
    const snapshot = join(first.root, 'submissions', '2026-08-30-120000');
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, 'Jane-Smith-Resume.pdf'), 'submitted PDF bytes');
    const second = allocateResumeOutputPaths({
      date: '2026-08-30',
      company: 'P&G',
      role: 'AI Engineering Intern',
      candidate: 'Hanielle Jermayn E. Chua',
      root,
    });
    const third = allocateResumeOutputPaths({
      date: '2026-08-30',
      company: 'P&G',
      role: 'AI Engineering Intern',
      candidate: 'Hanielle Jermayn E. Chua',
      root,
    });
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(readFileSync(first.pdf, 'utf8'), 'existing PDF bytes');
    assert.equal(readFileSync(join(snapshot, 'Jane-Smith-Resume.pdf'), 'utf8'), 'submitted PDF bytes');
    assert.equal(existsSync(`${first.root}-2`), false);

    writeFileSync(join(first.root, 'submission.json'), '{}');
    assert.throws(() => allocateResumeOutputPaths({
      date: '2026-08-30', company: 'P&G', role: 'AI Engineering Intern',
      candidate: 'Hanielle Jermayn E. Chua', root,
    }), /legacy submission.json/);
    assert.equal(readFileSync(first.pdf, 'utf8'), 'existing PDF bytes');

    const sanitized = allocateResumeOutputPaths({
      date: '2026-08-31',
      company: 'ACME: Global / Labs?',
      role: 'SRE <Platform> | Cloud*',
      candidate: 'Jane Q. O\'Neil',
      root,
    });
    assert.match(sanitized.key, /^[a-z0-9-]+$/, 'directory keys contain only Windows-safe slug characters');
    assert.match(sanitized.basename, /^[A-Za-z0-9-]+$/, 'resume basenames contain only Windows-safe characters');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an application path occupied by a file fails without allocating a suffix', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-resume-output-'));
  try {
    const options = { date: '2026-09-30', company: 'Flycatcher', role: 'Developer Intern', candidate: 'Jane Smith', root };
    const path = join(root, resumeOutputDirectoryName(options));
    writeFileSync(path, 'keep this file');
    assert.throws(() => allocateResumeOutputPaths(options), { code: 'EEXIST' });
    assert.equal(readFileSync(path, 'utf8'), 'keep this file');
    assert.equal(existsSync(`${path}-2`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
