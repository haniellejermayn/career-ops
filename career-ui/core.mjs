import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'fs';
import { dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import * as yaml from 'js-yaml';

import { appendToPipeline } from '../scan.mjs';
import { allocateResumeOutputPaths } from '../resume-output.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { extractTrackerReportNumbers, normalizeTextKey, parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';
import { cell, openTrackerTransaction, pathIsInsideCanonical, rebuildRow, writeFileAtomic } from '../tracker-utils.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { normalizeUrl } from '../url-key.mjs';
import { localToday } from '../lib/local-today.mjs';

const execFileAsync = promisify(execFile);
const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUBMISSION_FILE = 'submission.json';
const REUSE_FILE = 'reuse.json';

export class UiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'UiError';
    this.status = status;
    this.code = code;
  }
}

export function resolveUiPaths(root = getCareerOpsRoot()) {
  const dataRoot = resolve(root);
  return {
    dataRoot,
    tracker: resolveTrackerPath(dataRoot),
    pipeline: process.env.CAREER_OPS_PIPELINE?.trim()
      ? resolve(CODE_ROOT, process.env.CAREER_OPS_PIPELINE.trim())
      : join(dataRoot, 'data', 'pipeline.md'),
    pdfIndex: join(dataRoot, 'data', 'pdf-index.tsv'),
    output: join(dataRoot, 'output'),
    baselines: join(dataRoot, 'local', 'resume-baselines'),
    reports: join(dataRoot, 'reports'),
    profile: join(dataRoot, 'config', 'profile.yml'),
    additions: join(dataRoot, 'batch', 'tracker-additions', 'career-ui'),
    followups: join(dataRoot, 'data', 'follow-ups.md'),
    deletedApplications: join(dataRoot, 'data', 'deleted-applications.jsonl'),
  };
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function cleanText(value, field, { required = false, max = 500 } = {}) {
  const cleaned = cell(String(value ?? '')).replace(/\t/g, ' ').trim();
  if (required && !cleaned) throw new UiError(400, 'validation', `${field} is required.`);
  if (cleaned.length > max) throw new UiError(400, 'validation', `${field} must be ${max} characters or fewer.`);
  return cleaned;
}

function validateDate(value, field = 'Date', { allowFuture = true } = {}) {
  const date = cleanText(value || localToday(), field, { required: true, max: 10 });
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new UiError(400, 'validation', `${field} must use YYYY-MM-DD.`);
  }
  if (!allowFuture && date > localToday()) throw new UiError(400, 'validation', `${field} cannot be in the future.`);
  return date;
}

function validateOptionalDate(value, field, options = {}) {
  return String(value ?? '').trim() ? validateDate(value, field, options) : '';
}

function validatePostingUrl(value, { required = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw && !required) return '';
  const normalized = normalizeUrl(raw);
  if (!normalized) throw new UiError(400, 'validation', 'Job URL must be a complete http or https URL.');
  return normalized;
}

function markdownLink(value) {
  const match = String(value ?? '').match(/\[[^\]]*\]\(([^)]+)\)/);
  return match ? match[1] : '';
}

function rootRelative(root, absolutePath) {
  return relative(root, absolutePath).split('\\').join('/');
}

function safeExistingPath(root, input, { extension = null, inside = root } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new UiError(400, 'validation', 'A file path is required.');
  const candidate = resolve(root, raw);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new UiError(404, 'file-not-found', `File not found: ${raw}`);
  }
  const canonical = realpathSync(candidate);
  const canonicalInside = existsSync(inside) ? realpathSync(inside) : resolve(inside);
  if (!pathIsInsideCanonical(canonical, canonicalInside)) {
    throw new UiError(400, 'path-outside-workspace', 'The selected file is outside the allowed Career-Ops directory.');
  }
  if (extension && extname(canonical).toLowerCase() !== extension) {
    throw new UiError(400, 'validation', `The selected file must be a ${extension} file.`);
  }
  return canonical;
}

function parsePdfIndex(text) {
  const byReport = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [report, pdf] = line.split('\t');
    const normalized = String(report ?? '').trim().replace(/^0+(?=\d)/, '');
    if (normalized && pdf) byReport.set(normalized, pdf.trim());
  }
  return byReport;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function listPdfTree(searchRoot, dataRoot, kind) {
  if (!existsSync(searchRoot)) return [];
  const results = [];
  const stack = [searchRoot];
  while (stack.length && results.length < 2000) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.pdf') {
        const stats = statSync(absolute);
        const submission = readJson(join(dirname(absolute), SUBMISSION_FILE));
        results.push({
          path: rootRelative(dataRoot, absolute),
          name: entry.name,
          directory: rootRelative(dataRoot, dirname(absolute)),
          kind,
          modifiedAt: stats.mtime.toISOString(),
          submitted: Boolean(submission),
          submission,
        });
      }
    }
  }
  return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function listResumePdfs(outputRoot, dataRoot = dirname(outputRoot)) {
  return listPdfTree(outputRoot, dataRoot, 'generated');
}

export function listBaselinePdfs(baselineRoot, dataRoot = dirname(dirname(baselineRoot))) {
  return listPdfTree(baselineRoot, dataRoot, 'baseline');
}

function normalizeReportPath(value) {
  return String(value ?? '').replace(/^\.\.\//, '').replace(/\\/g, '/');
}

function visibleRole(value) {
  return String(value ?? '').replace(/\s+\[url:[a-f0-9]{8}\]$/i, '');
}

function sparseRoleReference(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 8);
}

function notesMetadata(notes) {
  const value = String(notes ?? '');
  const match = label => value.match(new RegExp(`(?:^|;\\s*)${label}:\\s*([^;]+)`, 'i'))?.[1]?.trim() || '';
  const metadataLabels = /^(?:via|location|deadline|compensation|submitted|job|resume|resume-plan|resume-source):\s*/i;
  return {
    via: match('via'),
    location: match('location'),
    deadline: match('deadline'),
    compensation: match('compensation'),
    submitted: match('submitted'),
    resume: match('resume'),
    resumePlan: match('resume-plan'),
    resumeSource: match('resume-source'),
    url: match('job') || value.match(/https?:\/\/[^\s;]+/i)?.[0] || '',
    notes: value.split(/;\s*/).filter(segment => segment && !metadataLabels.test(segment)).join('; '),
  };
}

function buildNotes({ notes = '', location = '', deadline = '', compensation = '', dateSubmitted = '', url = '', resumePath = '', resumePlan = '', resumeSource = '' }, trackerColumns = {}) {
  return [
    cleanText(notes, 'Notes', { max: 800 }),
    trackerColumns.location == null && location ? `location: ${location}` : '',
    deadline ? `deadline: ${deadline}` : '',
    compensation ? `compensation: ${compensation}` : '',
    dateSubmitted ? `submitted: ${dateSubmitted}` : '',
    trackerColumns.url == null && url ? `job: ${url}` : '',
    resumePath ? `resume: ${resumePath}` : '',
    resumePlan ? `resume-plan: ${resumePlan}` : '',
    resumeSource ? `resume-source: ${resumeSource}` : '',
  ].filter(Boolean).join('; ');
}

export function parseApplicationsText(text, {
  dataRoot,
  trackerPath,
  pdfIndexText = '',
  resumes = [],
} = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const pdfsByReport = parsePdfIndex(pdfIndexText);
  const submissionsByApp = new Map();
  for (const resume of resumes) {
    const appNum = Number(resume.submission?.tracker_or_report_number);
    if (Number.isInteger(appNum) && !submissionsByApp.has(appNum)) submissionsByApp.set(appNum, resume);
  }

  const rows = [];
  for (const line of lines) {
    const parsed = parseTrackerRow(line, colmap);
    if (!parsed) continue;
    const parts = line.split('|').map(part => part.trim());
    const reportNumbers = extractTrackerReportNumbers(parsed.report, parsed.notes);
    const reportNum = reportNumbers.length ? String(reportNumbers[0]) : '';
    const reportLink = normalizeReportPath(markdownLink(parsed.report));
    const indexedPdf = reportNum ? pdfsByReport.get(reportNum) : '';
    const submissionResume = submissionsByApp.get(parsed.num);
    const metadata = notesMetadata(parsed.notes);
    const status = String(parsed.status).replace(/\*\*/g, '').replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '').trim();
    const pdfPath = submissionResume?.path
      || normalizeReportPath(markdownLink(parsed.pdf))
      || indexedPdf
      || normalizeReportPath(metadata.resume);
    rows.push({
      id: `application:${parsed.num}`,
      source: 'application',
      num: parsed.num,
      date: parsed.date,
      dateSubmitted: metadata.submitted || (['Applied', 'Responded', 'Interview', 'Offer', 'Hired'].includes(status) && DATE_RE.test(parsed.date) ? parsed.date : ''),
      company: parsed.company,
      via: parsed.via || metadata.via,
      role: visibleRole(parsed.role),
      location: parsed.location || metadata.location,
      deadline: metadata.deadline,
      compensation: metadata.compensation,
      score: parsed.score,
      status,
      pdf: parsed.pdf,
      pdfPath,
      resumePlan: metadata.resumePlan || (pdfPath ? 'existing' : 'none'),
      resumeSource: metadata.resumeSource,
      report: parsed.report,
      reportNum,
      reportPath: reportLink,
      notes: metadata.notes,
      url: colmap.url != null ? (parts[colmap.url] || '') : metadata.url,
      submission: submissionResume?.submission || null,
    });
  }
  return rows;
}

function parseLabeledSegment(value) {
  const match = String(value).match(/^([a-z-]+):\s*(.*)$/i);
  return match ? [match[1].toLowerCase(), match[2].trim()] : null;
}

export function parsePipelineText(text) {
  const entries = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const match = raw.match(/^\s*-\s*\[([ x!])\]\s+(.+)$/i);
    if (!match) continue;
    const marker = match[1].toLowerCase();
    const body = match[2].replace(/^~~|~~$/g, '');
    const cells = body.split('|').map(value => value.trim());
    const urlIndex = cells.findIndex(value => /^https?:\/\//i.test(value));
    const labeled = {};
    for (const value of cells) {
      const segment = parseLabeledSegment(value);
      if (segment) labeled[segment[0]] = segment[1];
    }
    const id = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    entries.push({
      id: `pipeline:${id}`,
      source: 'pipeline',
      state: marker === ' ' ? 'pending' : marker === '!' ? 'issue' : 'processed',
      url: urlIndex >= 0 ? cells[urlIndex] : '',
      company: urlIndex >= 0 ? (cells[urlIndex + 1] || '') : '',
      role: urlIndex >= 0 ? (cells[urlIndex + 2] || '') : '',
      location: urlIndex >= 0 && cells[urlIndex + 3] && !parseLabeledSegment(cells[urlIndex + 3]) ? cells[urlIndex + 3] : '',
      posted: labeled.posted || '',
      dateSubmitted: '',
      deadline: '',
      compensation: '',
      status: 'Saved',
      pdfPath: '',
      resumePlan: 'none',
      resumeSource: '',
      notes: labeled.note || '',
      note: labeled.note || '',
      raw,
    });
  }
  return entries;
}

function loadStatuses() {
  const source = yaml.load(readFileSync(join(CODE_ROOT, 'templates', 'states.yml'), 'utf8'));
  return (source?.states || []).map(state => ({
    id: state.id,
    label: state.label,
    description: state.description,
    terminal: Boolean(state.terminal),
  }));
}

export function loadCareerUiState(root = getCareerOpsRoot()) {
  const paths = resolveUiPaths(root);
  const resumes = listResumePdfs(paths.output, paths.dataRoot);
  const baselines = listBaselinePdfs(paths.baselines, paths.dataRoot);
  const applications = parseApplicationsText(readIfExists(paths.tracker), {
    dataRoot: paths.dataRoot,
    trackerPath: paths.tracker,
    pdfIndexText: readIfExists(paths.pdfIndex),
    resumes,
  });
  const pipeline = parsePipelineText(readIfExists(paths.pipeline));
  const inbox = pipeline.filter(entry => entry.state !== 'processed');
  const records = [...applications, ...inbox];
  const counts = {};
  for (const record of records) counts[record.status] = (counts[record.status] || 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    today: localToday(),
    applications,
    inbox,
    records,
    processedInboxCount: pipeline.filter(entry => entry.state === 'processed').length,
    resumes,
    baselines,
    statuses: loadStatuses(),
    stats: {
      total: records.length,
      active: records.filter(app => !['Saved', 'Rejected', 'Discarded', 'SKIP', 'Hired'].includes(app.status)).length,
      applied: applications.filter(app => ['Applied', 'Responded', 'Interview', 'Offer', 'Hired'].includes(app.status)).length,
      interviews: applications.filter(app => app.status === 'Interview').length,
      pendingInbox: pipeline.filter(entry => entry.state === 'pending').length,
      byStatus: counts,
    },
  };
}

function applicationKey(company, role) {
  return `${normalizeTextKey(company, ' ')}\u0000${normalizeTextKey(role, ' ')}`;
}

export async function addInboxJob(root, input) {
  const paths = resolveUiPaths(root);
  const url = validatePostingUrl(input.url, { required: true });
  const company = cleanText(input.company, 'Company', { max: 160 });
  const title = cleanText(input.role, 'Role', { max: 200 });
  const location = cleanText(input.location, 'Location', { max: 160 });
  const posted = input.posted ? validateDate(input.posted, 'Posting date', { allowFuture: false }) : '';
  const state = loadCareerUiState(root);
  const key = normalizeUrl(url);
  if (state.inbox.some(entry => normalizeUrl(entry.url) === key)
      || state.applications.some(app => normalizeUrl(app.url) === key)) {
    throw new UiError(409, 'duplicate', 'This job URL is already in the inbox or application tracker.');
  }
  await appendToPipeline([{
    url,
    company,
    title,
    location,
    ...(posted ? { postedAt: Date.parse(`${posted}T00:00:00Z`) } : {}),
  }], { pipelinePath: paths.pipeline });
  return loadCareerUiState(root);
}

async function runCoreScript(script, args, root, extraEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, [join(CODE_ROOT, script), ...args], {
      cwd: CODE_ROOT,
      env: { ...process.env, CAREER_OPS_ROOT: resolve(root), ...extraEnv },
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result;
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new UiError(409, 'career-ops-write-failed', detail || `${script} failed.`);
  }
}

export async function addTrackedApplication(root, input) {
  const paths = resolveUiPaths(root);
  const companyInput = cleanText(input.company, 'Company', { max: 160 });
  const roleInput = cleanText(input.role, 'Role', { max: 200 });
  const url = validatePostingUrl(input.url);
  if (!companyInput && !roleInput && !url) {
    throw new UiError(400, 'validation', 'Add a company, role, or job URL so this application can be identified.');
  }
  const company = companyInput || '?';
  const roleBase = roleInput || 'Unspecified role';
  const role = url && (!companyInput || !roleInput) ? `${roleBase} [url:${sparseRoleReference(url)}]` : roleBase;
  const dateSubmitted = validateOptionalDate(input.dateSubmitted ?? input.date, 'Date submitted', { allowFuture: false });
  const date = dateSubmitted || '—';
  const location = cleanText(input.location, 'Location', { max: 160 });
  const deadline = validateOptionalDate(input.deadline, 'Deadline');
  const compensation = cleanText(input.compensation, 'Compensation', { max: 240 });
  const notes = cleanText(input.notes, 'Notes', { max: 800 });
  const before = loadCareerUiState(root);
  const status = cleanText(input.status || 'Saved', 'Status', { required: true, max: 40 });
  if (!before.statuses.some(item => item.label === status)) {
    throw new UiError(400, 'validation', 'Choose a valid Career-Ops status.');
  }
  const duplicate = before.applications.find(app =>
    (url && normalizeUrl(app.url) === normalizeUrl(url))
    || (companyInput && roleInput && applicationKey(app.company, app.role) === applicationKey(company, role)));
  if (duplicate) throw new UiError(409, 'duplicate', `Application #${duplicate.num} already tracks ${duplicate.company}, ${duplicate.role}.`);

  let deletedMax = 0;
  for (const line of readIfExists(paths.deletedApplications).split(/\r?\n/)) {
    try { deletedMax = Math.max(deletedMax, Number(JSON.parse(line).num) || 0); } catch { /* ignore malformed audit lines */ }
  }
  const nextNum = Math.max(deletedMax, ...before.applications.map(app => app.num), 0) + 1;
  const trackerText = readIfExists(paths.tracker);
  const trackerColumns = resolveColumns(trackerText.split(/\r?\n/));
  const fallbackNotes = buildNotes({ notes, location, deadline, compensation, dateSubmitted, url }, trackerColumns);
  mkdirSync(paths.additions, { recursive: true });
  const tsvPath = join(paths.additions, `ui-${Date.now()}-${randomUUID()}.tsv`);
  const extras = [trackerColumns.location != null ? location : '', url].filter(Boolean);
  const row = [nextNum, date, company, role, status, 'N/A', '—', '—', fallbackNotes, ...extras]
    .map(value => String(value).replace(/[\t\r\n]+/g, ' '))
    .join('\t');
  writeFileAtomic(tsvPath, `${row}\n`);
  await runCoreScript('merge-tracker.mjs', [], root, {
    CAREER_OPS_TRACKER: paths.tracker,
    CAREER_OPS_ADDITIONS: paths.additions,
  });
  const resumeChoice = String(input.resumeChoice || input.resumePath || 'none');
  if (resumeChoice !== 'none' && resumeChoice !== '') {
    return updateTrackedRecord(root, { ...input, recordId: `application:${nextNum}`, status, resumeChoice });
  }
  return loadCareerUiState(root);
}

function requireApplication(state, appNum) {
  const number = Number(appNum);
  const application = state.applications.find(app => app.num === number);
  if (!application) throw new UiError(404, 'application-not-found', `Application #${appNum} was not found.`);
  return application;
}

function requireRecord(state, recordId) {
  const record = state.records.find(item => item.id === String(recordId || ''));
  if (!record) throw new UiError(404, 'record-not-found', 'Tracker row was not found. Refresh and try again.');
  return record;
}

function validatedRecordFields(input, state) {
  const companyInput = cleanText(input.company, 'Company', { max: 160 });
  const roleInput = cleanText(input.role, 'Role', { max: 200 });
  const url = validatePostingUrl(input.url);
  if (!companyInput && !roleInput && !url) {
    throw new UiError(400, 'validation', 'Add a company, role, or job URL so this row can be identified.');
  }
  const company = companyInput || '?';
  const roleBase = roleInput || 'Unspecified role';
  const role = url && (!companyInput || !roleInput) ? `${roleBase} [url:${sparseRoleReference(url)}]` : roleBase;
  const status = cleanText(input.status || 'Saved', 'Status', { required: true, max: 40 });
  if (!state.statuses.some(item => item.label === status)) {
    throw new UiError(400, 'validation', 'Choose a valid Career-Ops status.');
  }
  return {
    company,
    role,
    url,
    status,
    dateSubmitted: validateOptionalDate(input.dateSubmitted, 'Date submitted', { allowFuture: false }),
    location: cleanText(input.location, 'Location', { max: 160 }),
    deadline: validateOptionalDate(input.deadline, 'Deadline'),
    compensation: cleanText(input.compensation, 'Compensation', { max: 240 }),
    notes: cleanText(input.notes, 'Notes', { max: 800 }),
  };
}

async function removePipelineRecord(paths, recordId) {
  await withPipelineLock(paths.pipeline, async () => {
    const source = readIfExists(paths.pipeline);
    const lines = source.split(/\r?\n/);
    const kept = lines.filter(line => {
      const parsed = parsePipelineText(line)[0];
      return !parsed || parsed.id !== recordId;
    });
    if (kept.length === lines.length) throw new UiError(404, 'record-not-found', 'Saved job was not found. Refresh and try again.');
    writeFileAtomic(paths.pipeline, kept.join('\n'));
  });
}

function resumeChoiceFor(input, application) {
  if (input.resumeChoice == null && input.resumePath == null) {
    if (application.resumePlan === 'career-ops') return { plan: 'career-ops', source: '', path: '' };
    return { plan: application.resumePlan || (application.pdfPath ? 'existing' : 'none'), source: application.resumeSource || '', path: application.pdfPath || '' };
  }
  const choice = String(input.resumeChoice ?? input.resumePath ?? 'none').trim();
  if (!choice || choice === 'none') return { plan: 'none', source: '', path: '' };
  if (choice === 'career-ops') return { plan: 'career-ops', source: '', path: '' };
  if (choice.startsWith('baseline:')) return { plan: 'baseline', source: choice.slice('baseline:'.length), path: '' };
  if (choice.startsWith('pdf:')) return { plan: 'existing', source: choice.slice('pdf:'.length), path: choice.slice('pdf:'.length) };
  return { plan: 'existing', source: choice, path: choice };
}

async function replaceApplicationRow(paths, appNum, fields, resume) {
  const transaction = await openTrackerTransaction(paths.tracker);
  try {
    const source = transaction.read();
    const lines = source.split(/\r?\n/);
    const columns = resolveColumns(lines);
    let found = false;
    const updated = lines.map(line => {
      const parsed = parseTrackerRow(line, columns);
      if (!parsed || parsed.num !== appNum) return line;
      found = true;
      const parts = line.split('|').map(value => value.trim());
      parts[columns.company] = fields.company;
      parts[columns.role] = fields.role;
      if (columns.location != null) parts[columns.location] = fields.location;
      if (columns.url != null) parts[columns.url] = fields.url;
      parts[columns.pdf] = resume.path ? `[Resume](../${resume.path})` : '—';
      parts[columns.notes] = buildNotes({
        ...fields,
        resumePath: resume.path,
        resumePlan: resume.plan,
        resumeSource: resume.source,
      }, columns);
      return rebuildRow(parts);
    });
    if (!found) throw new UiError(404, 'application-not-found', `Application #${appNum} was not found.`);
    transaction.replace(updated.join('\n'));
  } finally {
    transaction.close();
  }
}

export async function updateTrackedRecord(root, input) {
  const paths = resolveUiPaths(root);
  const state = loadCareerUiState(root);
  const record = requireRecord(state, input.recordId || (input.appNum ? `application:${input.appNum}` : ''));
  const fields = validatedRecordFields({ ...record, ...input }, state);
  if (record.status !== 'Applied' && fields.status === 'Applied' && !fields.dateSubmitted) {
    fields.dateSubmitted = validateDate(input.statusDate || localToday(), 'Date submitted', { allowFuture: false });
  }

  if (record.source === 'pipeline') {
    await addTrackedApplication(root, { ...fields, resumeChoice: input.resumeChoice || 'none' });
    await removePipelineRecord(paths, record.id);
    return loadCareerUiState(root);
  }

  let resume = resumeChoiceFor(input, record);
  if (resume.plan === 'baseline') {
    if (record.resumePlan === 'baseline' && record.resumeSource === resume.source && record.pdfPath && existsSync(join(paths.dataRoot, record.pdfPath))) {
      resume.path = record.pdfPath;
    } else {
      const prepared = copyResumeForApplication(root, {
        ...record,
        company: fields.company,
        role: visibleRole(fields.role),
      }, resume.source, localToday(), true);
      resume.path = prepared.copied_resume;
    }
  } else if (resume.plan === 'existing') {
    const absolute = safeExistingPath(paths.dataRoot, resume.path, { extension: '.pdf', inside: paths.output });
    resume.path = rootRelative(paths.dataRoot, absolute);
    resume.source = resume.path;
  }

  await replaceApplicationRow(paths, record.num, fields, resume);
  if (fields.status !== record.status) {
    await updateApplicationStatus(root, {
      appNum: record.num,
      status: fields.status,
      date: input.statusDate || localToday(),
    });
  }
  return loadCareerUiState(root);
}

export async function deleteTrackedRecord(root, input) {
  const paths = resolveUiPaths(root);
  const state = loadCareerUiState(root);
  const record = requireRecord(state, input.recordId);
  if (record.source === 'pipeline') {
    await removePipelineRecord(paths, record.id);
    return loadCareerUiState(root);
  }

  const transaction = await openTrackerTransaction(paths.tracker);
  try {
    const source = transaction.read();
    const lines = source.split(/\r?\n/);
    const columns = resolveColumns(lines);
    const kept = lines.filter(line => parseTrackerRow(line, columns)?.num !== record.num);
    if (kept.length === lines.length) throw new UiError(404, 'application-not-found', `Application #${record.num} was not found.`);
    transaction.replace(kept.join('\n'));
  } finally {
    transaction.close();
  }
  mkdirSync(dirname(paths.deletedApplications), { recursive: true });
  appendFileSync(paths.deletedApplications, `${JSON.stringify({
    num: record.num,
    deleted_at: new Date().toISOString(),
    company: record.company,
    role: record.role,
    artifacts_preserved: true,
  })}\n`, 'utf8');
  return loadCareerUiState(root);
}

export function careerOpsPromptForRecord(root, input) {
  const state = loadCareerUiState(root);
  const record = requireRecord(state, input.recordId);
  if (record.source === 'application') {
    return `Run Career-Ops resume preparation for tracker application #${record.num}. Read its company, role, job URL, and notes from data/applications.md. Use the existing baseline rules to decide reuse, reuse-with-edits, or regenerate. Create a job-scoped artifact and update the tracker PDF link. Do not submit the application.`;
  }
  return `Run Career-Ops auto-pipeline for this saved job: ${record.url || `${record.company} - ${record.role}`}. Evaluate it, decide whether to reuse a baseline, reuse with edits, or regenerate the resume, create a job-scoped artifact when appropriate, and update the tracker. Do not submit the application.`;
}

export async function updateApplicationStatus(root, input) {
  const paths = resolveUiPaths(root);
  const state = loadCareerUiState(root);
  const application = requireApplication(state, input.appNum);
  const status = cleanText(input.status, 'Status', { required: true, max: 40 });
  if (!state.statuses.some(item => item.label === status)) throw new UiError(400, 'validation', 'Choose a valid Career-Ops status.');
  const date = validateDate(input.date || localToday(), 'Status date', { allowFuture: false });
  const note = cleanText(input.note, 'Note', { max: 500 });
  const args = ['--row', String(application.num), status, '--on', date, '--source', 'web', '--json'];
  if (note) args.push('--note', note);
  await runCoreScript('set-status.mjs', args, root, { CAREER_OPS_TRACKER: paths.tracker });
  return loadCareerUiState(root);
}

function candidateName(profilePath) {
  const profile = yaml.load(readIfExists(profilePath)) || {};
  return profile?.candidate?.full_name || profile?.full_name || profile?.name || 'Candidate';
}

function sourceSidecars(sourcePdf) {
  const base = sourcePdf.slice(0, -extname(sourcePdf).length);
  return ['.tex', '.html', '.md']
    .map(extension => `${base}${extension}`)
    .filter(existsSync);
}

function preparedDraft(paths, application) {
  if (!existsSync(paths.output)) return null;
  for (const entry of readdirSync(paths.output, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(paths.output, entry.name);
    const reuse = readJson(join(directory, REUSE_FILE));
    if (Number(reuse?.application) !== application.num || !reuse?.copied_resume) continue;
    if (existsSync(join(directory, SUBMISSION_FILE))) {
      throw new UiError(409, 'legacy-submission', 'Preserve the legacy submission before editing this draft.');
    }
    const pdf = resolve(paths.dataRoot, reuse.copied_resume);
    if (dirname(pdf) === directory && existsSync(pdf)) return pdf;
  }
  return null;
}

function copyResumeForApplication(root, application, sourcePath, date, userOverride = false) {
  const paths = resolveUiPaths(root);
  const sourcePdf = safeExistingPath(paths.dataRoot, sourcePath, { extension: '.pdf', inside: paths.dataRoot });
  if (![paths.output, paths.baselines].some(allowed => pathIsInsideCanonical(sourcePdf, allowed))) {
    throw new UiError(400, 'path-outside-resumes', 'Choose a PDF from the dynamic baselines or generated resume list.');
  }
  const priorPdf = preparedDraft(paths, application);
  const allocated = priorPdf ? {
    root: dirname(priorPdf),
    pdf: priorPdf,
    tex: priorPdf.replace(/\.pdf$/i, '.tex'),
    html: priorPdf.replace(/\.pdf$/i, '.html'),
    markdown: priorPdf.replace(/\.pdf$/i, '.md'),
  } : allocateResumeOutputPaths({
    date,
    company: application.company,
    role: application.role,
    candidate: candidateName(paths.profile),
    root: paths.output,
  });
  const priorReuse = readJson(join(allocated.root, REUSE_FILE));
  if (priorReuse && Number(priorReuse.application) !== application.num) {
    throw new UiError(409, 'draft-in-use', 'Another application already uses this resume directory.');
  }
  if (!priorPdf && existsSync(allocated.pdf) && !priorReuse) {
    throw new UiError(409, 'draft-in-use', 'This resume directory already contains a draft. Select that PDF or use a distinct application identity.');
  }
  if (sourcePdf !== allocated.pdf) copyFileSync(sourcePdf, allocated.pdf);
  const copiedSources = [];
  for (const source of sourceSidecars(sourcePdf)) {
    const destination = allocated[extname(source).slice(1) === 'md' ? 'markdown' : extname(source).slice(1)];
    if (!destination) continue;
    if (source !== destination) copyFileSync(source, destination);
    copiedSources.push(rootRelative(paths.dataRoot, destination));
  }
  const record = {
    schema_version: 1,
    decision: 'reuse',
    application: application.num,
    company: application.company,
    role: application.role,
    compared_at: date,
    source_resume: rootRelative(paths.dataRoot, sourcePdf),
    copied_resume: rootRelative(paths.dataRoot, allocated.pdf),
    copied_sources: copiedSources,
    current_jd_or_report: application.reportPath || application.url || null,
    changed_sections: [],
    user_override: Boolean(userOverride),
  };
  writeFileAtomic(join(allocated.root, REUSE_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function prepareResumeReuse(root, input) {
  const state = loadCareerUiState(root);
  const application = requireApplication(state, input.appNum);
  if (input.confirmed !== true) {
    throw new UiError(400, 'review-required', 'Confirm that you reviewed this resume against the job and no changes are needed.');
  }
  const date = validateDate(input.date || localToday(), 'Preparation date', { allowFuture: false });
  const record = copyResumeForApplication(root, application, input.sourcePath, date);
  return { state: loadCareerUiState(root), prepared: record };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function confirmSubmission(root, input) {
  const paths = resolveUiPaths(root);
  const state = loadCareerUiState(root);
  const application = requireApplication(state, input.appNum);
  if (input.confirmed !== true) {
    throw new UiError(400, 'confirmation-required', 'Confirm that the employer or ATS accepted the application submission.');
  }
  const submittedAt = validateDate(input.submittedAt || localToday(), 'Submission date', { allowFuture: false });
  const submissionNote = cleanText(input.note, 'Submission note', { max: 500 });
  const resume = safeExistingPath(paths.dataRoot, input.resumePath, { extension: '.pdf', inside: paths.output });
  const draftDirectory = dirname(resume);
  if (existsSync(join(draftDirectory, SUBMISSION_FILE))) {
    throw new UiError(409, 'legacy-submission', 'Preserve the legacy submission before editing this draft.');
  }
  const snapshotsRoot = join(draftDirectory, 'submissions');
  mkdirSync(snapshotsRoot, { recursive: true });
  const time = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  let snapshotDirectory;
  for (let suffix = 1; ; suffix++) {
    snapshotDirectory = join(snapshotsRoot, `${submittedAt}-${time}${suffix === 1 ? '' : `-${suffix}`}`);
    try {
      mkdirSync(snapshotDirectory);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const snapshotPdf = join(snapshotDirectory, resume.split(/[\\/]/).at(-1));
  copyFileSync(resume, snapshotPdf);
  for (const source of sourceSidecars(resume)) copyFileSync(source, join(snapshotDirectory, source.split(/[\\/]/).at(-1)));
  const resumeHash = sha256(resume);
  if (sha256(snapshotPdf) !== resumeHash) throw new UiError(500, 'snapshot-mismatch', 'Submitted resume copy did not match the draft.');

  const reuse = readJson(join(draftDirectory, REUSE_FILE));
  const manifest = {
    schema_version: 1,
    company: application.company,
    role: application.role,
    submitted_at: submittedAt,
    resume_path: rootRelative(paths.dataRoot, snapshotPdf),
    resume_sha256: resumeHash,
    source_resume: reuse?.source_resume || null,
    reused: Boolean(reuse?.decision === 'reuse'),
    jd_or_report: application.reportPath || application.url || null,
    tracker_or_report_number: application.num,
    note: submissionNote || null,
    recorded_at: new Date().toISOString(),
  };
  writeFileAtomic(join(snapshotDirectory, SUBMISSION_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const alreadyBeyondApplied = ['Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'].includes(application.status);
  if (!alreadyBeyondApplied) {
    await updateApplicationStatus(root, {
      appNum: application.num,
      status: 'Applied',
      date: submittedAt,
      note: submissionNote,
    });
    await runCoreScript('followup-seed.mjs', [String(application.num), '--date', submittedAt, '--json'], root, {
      CAREER_OPS_TRACKER: paths.tracker,
      CAREER_OPS_FOLLOWUPS: paths.followups,
    });
  }
  return { state: loadCareerUiState(root), submission: manifest };
}

export function resolveReadableFile(root, requestedPath) {
  const paths = resolveUiPaths(root);
  const absolute = safeExistingPath(paths.dataRoot, requestedPath, { inside: paths.dataRoot });
  const allowedRoot = [paths.output, paths.baselines, paths.reports].find(candidate => pathIsInsideCanonical(absolute, candidate));
  if (!allowedRoot || !['.pdf', '.md', '.txt'].includes(extname(absolute).toLowerCase())) {
    throw new UiError(400, 'file-not-readable', 'Only Career-Ops reports and output PDFs or text artifacts can be opened here.');
  }
  return absolute;
}
