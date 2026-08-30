import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from './helpers.mjs';
import {
  allocateResumeOutputPaths,
  resumeOutputBasename,
  resumeOutputDirectoryName,
} from '../resume-output.mjs';

test('resume output paths are job-scoped, professional, Windows-safe, and collision-safe', () => {
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
    assert.equal(second.key, '2026-08-30-pg-ai-engineering-intern-2');
    assert.equal(third.key, '2026-08-30-pg-ai-engineering-intern-3');
    assert.notEqual(first.root, second.root, 'an existing application directory is never reused silently');

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
