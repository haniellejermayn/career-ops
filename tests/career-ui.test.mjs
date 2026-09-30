import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createCareerUiServer } from '../career-ui.mjs';
import {
  UiError,
  addInboxJob,
  addTrackedApplication,
  careerOpsPromptForRecord,
  confirmSubmission,
  deleteTrackedRecord,
  loadCareerUiState,
  parsePipelineText,
  prepareResumeReuse,
  resolveReadableFile,
  updateTrackedRecord,
} from '../career-ui/core.mjs';
import { rmSync } from './helpers.mjs';
import { localToday } from '../lib/local-today.mjs';

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-08-30 | Acme | AI Engineer | 4.5/5 | Evaluated | ❌ | — | Strong fit | https://jobs.example.com/acme-ai |
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-ui-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'local', 'resume-baselines', 'ai-engineering'), { recursive: true });
  mkdirSync(join(root, 'output', 'existing'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), TRACKER);
  writeFileSync(join(root, 'data', 'pipeline.md'), `# Pipeline

## Pending

- [ ] https://jobs.example.com/beta | Beta Labs | Data Engineer | Manila | posted: 2026-08-25 | note: referral
- [!] https://jobs.example.com/login | Login Co | Platform Engineer

## Processed

- [x] #002 | https://jobs.example.com/old | Old Co | Engineer | 4.0/5 | PDF ✅
`);
  writeFileSync(join(root, 'config', 'profile.yml'), 'candidate:\n  full_name: Test Candidate\n');
  writeFileSync(join(root, 'local', 'resume-baselines', 'ai-engineering', 'Test-Candidate-Resume.pdf'), Buffer.from('%PDF-1.4\nfixture\n'));
  writeFileSync(join(root, 'local', 'resume-baselines', 'ai-engineering', 'Test-Candidate-Resume.tex'), '\\documentclass{article}\n');
  writeFileSync(join(root, 'output', 'existing', 'Existing-Resume.pdf'), Buffer.from('%PDF-1.4\nexisting\n'));
  return root;
}

test('pipeline parsing keeps pending metadata and excludes nothing implicitly', () => {
  const entries = parsePipelineText(`- [ ] https://jobs.example.com/1 | Acme | Engineer | Remote | posted: 2026-08-01 | note: saved\n- [x] #2 | https://jobs.example.com/2 | Done | Role`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].source, 'pipeline');
  assert.match(entries[0].id, /^pipeline:/);
  assert.equal(entries[0].status, 'Saved');
  assert.equal(entries[0].url, 'https://jobs.example.com/1');
  assert.equal(entries[0].company, 'Acme');
  assert.equal(entries[0].role, 'Engineer');
  assert.equal(entries[0].location, 'Remote');
  assert.equal(entries[0].posted, '2026-08-01');
  assert.equal(entries[0].notes, 'saved');
  assert.equal(entries[1].state, 'processed');
});

test('state loader preserves the Markdown tracker and discovers local resumes', () => {
  const root = fixture();
  try {
    const state = loadCareerUiState(root);
    assert.equal(state.applications.length, 1);
    assert.equal(state.applications[0].company, 'Acme');
    assert.equal(state.applications[0].url, 'https://jobs.example.com/acme-ai');
    assert.equal(state.applications[0].dateSubmitted, '');
    assert.equal(state.inbox.length, 2);
    assert.equal(state.processedInboxCount, 1);
    assert.equal(state.records.length, 3);
    assert.equal(state.records.filter(row => row.status === 'Saved').length, 2);
    assert.equal(state.resumes.length, 1);
    assert.match(state.resumes[0].path, /^output\//);
    assert.equal(state.baselines.length, 1);
    assert.match(state.baselines[0].path, /^local\/resume-baselines\//);
    mkdirSync(join(root, 'local', 'resume-baselines', 'new-baseline'), { recursive: true });
    writeFileSync(join(root, 'local', 'resume-baselines', 'new-baseline', 'New.pdf'), '%PDF-1.4\nnew\n');
    assert.equal(loadCareerUiState(root).baselines.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('job capture uses the pipeline format and rejects duplicate URLs', async () => {
  const root = fixture();
  try {
    await addInboxJob(root, {
      url: 'https://jobs.example.com/new?utm_source=test',
      company: 'New Co',
      role: 'Backend Engineer',
    });
    const pipeline = readFileSync(join(root, 'data', 'pipeline.md'), 'utf8');
    assert.match(pipeline, /https:\/\/jobs\.example\.com\/new \| New Co \| Backend Engineer/);
    await assert.rejects(
      () => addInboxJob(root, { url: 'https://jobs.example.com/new?utm_campaign=again' }),
      error => error instanceof UiError && error.status === 409,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual application insertion delegates through a TSV merge', async () => {
  const root = fixture();
  try {
    const state = await addTrackedApplication(root, {
      company: 'Gamma Systems',
      role: 'Platform Engineer',
      dateSubmitted: '2026-09-01',
      url: 'https://jobs.example.com/gamma-platform',
      deadline: '2026-09-30',
      compensation: 'PHP 120,000 monthly',
      status: 'Applied',
      resumePath: 'output/existing/Existing-Resume.pdf',
      notes: 'Manual evaluation',
    });
    const app = state.applications.find(row => row.company === 'Gamma Systems');
    assert.ok(app);
    assert.equal(app.status, 'Applied');
    assert.equal(app.score, 'N/A');
    assert.equal(app.url, 'https://jobs.example.com/gamma-platform');
    assert.equal(app.dateSubmitted, '2026-09-01');
    assert.equal(app.deadline, '2026-09-30');
    assert.equal(app.compensation, 'PHP 120,000 monthly');
    assert.equal(app.pdfPath, 'output/existing/Existing-Resume.pdf');
    assert.equal(app.notes, 'Manual evaluation');
    assert.ok(existsSync(join(root, 'batch', 'tracker-additions', 'career-ui', 'merged')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual application allows sparse records and preserves metadata in the default tracker', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
    const state = await addTrackedApplication(root, {
      url: 'https://jobs.example.com/delta-cloud',
      location: 'Makati',
      compensation: 'Open to discussion',
    });
    const app = state.applications[0];
    assert.equal(app.status, 'Saved');
    assert.equal(app.company, '?');
    assert.equal(app.role, 'Unspecified role');
    assert.equal(app.dateSubmitted, '');
    assert.equal(app.url, 'https://jobs.example.com/delta-cloud');
    assert.equal(app.location, 'Makati');
    assert.equal(app.compensation, 'Open to discussion');
    assert.match(readFileSync(join(root, 'data', 'applications.md'), 'utf8'), /location: Makati; compensation: Open to discussion; job: https:\/\/jobs\.example\.com\/delta-cloud/);
    const withSecondSparseRecord = await addTrackedApplication(root, { url: 'https://jobs.example.com/another-role' });
    assert.equal(withSecondSparseRecord.applications.length, 2);
    await assert.rejects(
      () => addTrackedApplication(root, { notes: 'No identifying information' }),
      error => error instanceof UiError && error.status === 400 && /company, role, or job URL/i.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editing a row updates optional fields and baseline selection creates a job-scoped copy without changing status', async () => {
  const root = fixture();
  try {
    const baseline = 'local/resume-baselines/ai-engineering/Test-Candidate-Resume.pdf';
    let state = await updateTrackedRecord(root, {
      recordId: 'application:1',
      company: 'Acme Updated',
      role: 'Senior AI Engineer',
      url: 'https://jobs.example.com/acme-ai-updated',
      dateSubmitted: '2026-08-31',
      location: 'Remote',
      deadline: '2026-09-20',
      compensation: 'PHP 150,000 monthly',
      notes: 'Referral route',
      status: 'Evaluated',
      resumeChoice: `baseline:${baseline}`,
    });
    let app = state.applications[0];
    assert.equal(app.company, 'Acme Updated');
    assert.equal(app.role, 'Senior AI Engineer');
    assert.equal(app.status, 'Evaluated');
    assert.equal(app.dateSubmitted, '2026-08-31');
    assert.equal(app.resumePlan, 'baseline');
    assert.equal(app.resumeSource, baseline);
    assert.match(app.pdfPath, new RegExp(`^output/${localToday()}-acme-updated-senior-ai-engineer`));
    assert.ok(existsSync(join(root, app.pdfPath)));
    assert.ok(existsSync(join(root, app.pdfPath, '..', 'reuse.json')));

    const copiedPath = app.pdfPath;
    state = await updateTrackedRecord(root, { ...app, recordId: app.id, status: 'Applied' });
    app = state.applications[0];
    assert.equal(app.status, 'Applied');
    assert.equal(app.dateSubmitted, '2026-08-31');
    assert.equal(app.pdfPath, copiedPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('moving a saved row to Applied records the submission date without touching its resume choice', async () => {
  const root = fixture();
  try {
    let state = await addTrackedApplication(root, { company: 'Date Check' });
    const saved = state.applications.find(row => row.company === 'Date Check');
    state = await updateTrackedRecord(root, { ...saved, recordId: saved.id, status: 'Applied' });
    const applied = state.applications.find(row => row.company === 'Date Check');
    assert.equal(applied.status, 'Applied');
    assert.equal(applied.dateSubmitted, localToday());
    assert.equal(applied.resumePlan, 'none');
    assert.equal(applied.pdfPath, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editing a scanner row promotes it into the application tracker', async () => {
  const root = fixture();
  try {
    const saved = loadCareerUiState(root).records.find(row => row.company === 'Beta Labs');
    const state = await updateTrackedRecord(root, { ...saved, recordId: saved.id, status: 'Evaluated', notes: 'Reviewed in UI' });
    const promoted = state.applications.find(row => row.company === 'Beta Labs');
    assert.ok(promoted);
    assert.equal(promoted.status, 'Evaluated');
    assert.equal(promoted.notes, 'Reviewed in UI');
    assert.equal(state.inbox.some(row => row.company === 'Beta Labs'), false);
    assert.doesNotMatch(readFileSync(join(root, 'data', 'pipeline.md'), 'utf8'), /Beta Labs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delete removes only the selected row and reserves its number while preserving artifacts', async () => {
  const root = fixture();
  try {
    const artifact = join(root, 'output', 'existing', 'Existing-Resume.pdf');
    let state = await deleteTrackedRecord(root, { recordId: 'application:1' });
    assert.equal(state.applications.length, 0);
    assert.ok(existsSync(artifact));
    assert.match(readFileSync(join(root, 'data', 'deleted-applications.jsonl'), 'utf8'), /"num":1/);
    state = await addTrackedApplication(root, { company: 'After Delete' });
    assert.equal(state.applications[0].num, 2);

    const pipeline = state.inbox[0];
    state = await deleteTrackedRecord(root, { recordId: pipeline.id });
    assert.equal(state.inbox.some(row => row.id === pipeline.id), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Career-Ops prompt is row-specific and keeps resume judgment in Career-Ops', () => {
  const root = fixture();
  try {
    const prompt = careerOpsPromptForRecord(root, { recordId: 'application:1' });
    assert.match(prompt, /application #1/);
    assert.match(prompt, /reuse, reuse-with-edits, or regenerate/);
    assert.match(prompt, /Do not submit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume reuse keeps one application draft directory across revisions', () => {
  const root = fixture();
  try {
    const result = prepareResumeReuse(root, {
      appNum: 1,
      sourcePath: 'local/resume-baselines/ai-engineering/Test-Candidate-Resume.pdf',
      date: '2026-09-01',
      confirmed: true,
    });
    assert.equal(result.prepared.decision, 'reuse');
    assert.notEqual(result.prepared.source_resume, result.prepared.copied_resume);
    assert.ok(existsSync(join(root, result.prepared.copied_resume)));
    assert.ok(existsSync(join(root, result.prepared.copied_resume.replace(/\.pdf$/, '.tex'))));
    assert.ok(existsSync(join(root, result.prepared.copied_resume, '..', 'reuse.json')));
    const revised = prepareResumeReuse(root, {
      appNum: 1,
      sourcePath: 'local/resume-baselines/ai-engineering/Test-Candidate-Resume.pdf',
      date: '2026-09-02',
      confirmed: true,
    });
    assert.equal(revised.prepared.copied_resume, result.prepared.copied_resume);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('confirmed submission hashes the exact PDF, updates status, and seeds follow-up', async () => {
  const root = fixture();
  try {
    const prepared = prepareResumeReuse(root, {
      appNum: 1,
      sourcePath: 'local/resume-baselines/ai-engineering/Test-Candidate-Resume.pdf',
      date: '2026-09-01',
      confirmed: true,
    }).prepared;
    const result = await confirmSubmission(root, {
      appNum: 1,
      resumePath: prepared.copied_resume,
      submittedAt: '2026-09-01',
      confirmed: true,
      note: 'ATS confirmation shown',
    });
    assert.equal(result.submission.reused, true);
    assert.match(result.submission.resume_sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.state.applications[0].status, 'Applied');
    assert.match(result.submission.resume_path, /\/submissions\/2026-09-01-\d{6}\/Test-Candidate-Resume\.pdf$/);
    assert.ok(existsSync(join(root, result.submission.resume_path)));
    assert.ok(existsSync(join(root, result.submission.resume_path, '..', 'submission.json')));
    assert.ok(existsSync(join(root, result.submission.resume_path.replace(/\.pdf$/, '.tex'))));
    assert.ok(existsSync(join(root, prepared.copied_resume)));
    assert.equal(readFileSync(join(root, result.submission.resume_path)).toString(), readFileSync(join(root, prepared.copied_resume)).toString());
    assert.match(readFileSync(join(root, 'data', 'follow-ups.md'), 'utf8'), /next #1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file serving resolver rejects paths outside the Career-Ops data root', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.env'), 'SECRET=do-not-serve\n');
    assert.throws(
      () => resolveReadableFile(root, '../outside.txt'),
      error => error instanceof UiError && [400, 404].includes(error.status),
    );
    assert.throws(
      () => resolveReadableFile(root, '.env'),
      error => error instanceof UiError && error.code === 'file-not-readable',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local HTTP server serves the UI and protects write routes with a custom header', async () => {
  const root = fixture();
  const launches = [];
  const server = createCareerUiServer({ root, shellLauncher: input => launches.push(input) });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Personal job tracker/);
    const stateResponse = await fetch(`${base}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.applications[0].company, 'Acme');
    const rejected = await fetch(`${base}/api/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://jobs.example.com/no-header' }),
    });
    assert.equal(rejected.status, 403);
    const launched = await fetch(`${base}/api/powershell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Career-Ops-UI': '1' },
      body: JSON.stringify({ recordId: 'application:1' }),
    });
    assert.equal(launched.status, 200);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].cwd, root);
    assert.match(launches[0].prompt, /application #1/);
  } finally {
    await new Promise(resolveClosed => server.close(resolveClosed));
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser form payload is captured before controls are disabled', () => {
  const source = readFileSync(join(process.cwd(), 'career-ui', 'public', 'app.js'), 'utf8');
  const submitStart = source.indexOf('async function submitForm');
  const submitEnd = source.indexOf('\nfunction bindEvents', submitStart);
  const submitSource = source.slice(submitStart, submitEnd);
  assert.ok(submitSource.indexOf('const payload = formObject(form)') >= 0);
  assert.ok(submitSource.indexOf('const payload = formObject(form)') < submitSource.indexOf('setBusy(form, true)'));
});
