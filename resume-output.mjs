#!/usr/bin/env node

/**
 * Resolve a stable, job-scoped directory for resume drafts.
 *
 * Draft revisions reuse the same directory. Use the application's original date
 * on later revisions; submitted artifacts belong in separate snapshots.
 */

import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import { slugifySegment } from './application-artifacts.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DEFAULT_OUTPUT_ROOT = resolve('output');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asciiWords(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'&]/g, '')
    .match(/[A-Za-z0-9]+/g) || [];
}

/** Convert a company or role label to a Windows-safe directory segment. */
export function slugifyResumeSegment(value, fallback) {
  return slugifySegment(asciiWords(value).join('-'), fallback);
}

/** Build the unsuffixed directory name for a resume generation. */
export function resumeOutputDirectoryName({ date, company, role }) {
  if (!DATE_RE.test(String(date ?? ''))) {
    throw new Error('date must use YYYY-MM-DD');
  }
  return [
    date,
    slugifyResumeSegment(company, 'company'),
    slugifyResumeSegment(role, 'role'),
  ].join('-');
}

/** Build a short professional basename from the candidate's first/last names. */
export function resumeOutputBasename(candidate) {
  const words = asciiWords(candidate);
  if (words.length === 0) return 'Candidate-Resume';
  const selected = words.length === 1 ? words : [words[0], words.at(-1)];
  return `${selected.join('-')}-Resume`;
}

function pathsFor(outputRoot, key, basename) {
  const applicationRoot = join(outputRoot, key);
  return {
    key,
    outputRoot,
    root: applicationRoot,
    basename,
    html: join(applicationRoot, `${basename}.html`),
    markdown: join(applicationRoot, `${basename}.md`),
    tex: join(applicationRoot, `${basename}.tex`),
    pdf: join(applicationRoot, `${basename}.pdf`),
  };
}

/**
 * Create or reuse the application's draft directory without modifying files.
 * Legacy submissions must be preserved before their former directory is reused.
 */
export function allocateResumeOutputPaths({
  date,
  company,
  role,
  candidate,
  root = DEFAULT_OUTPUT_ROOT,
}) {
  const outputRoot = resolve(root);
  const baseKey = resumeOutputDirectoryName({ date, company, role });
  const basename = resumeOutputBasename(candidate);
  const paths = pathsFor(outputRoot, baseKey, basename);
  if (existsSync(join(paths.root, 'submission.json'))) {
    throw new Error('This directory contains a legacy submission.json. Preserve the submitted files in a submission snapshot before revising this draft.');
  }
  mkdirSync(paths.root, { recursive: true });
  return paths;
}

const KNOWN_FLAGS = ['--date', '--company', '--role', '--candidate', '--root', '--help', '-h'];
const VALUE_FLAGS = ['--date', '--company', '--role', '--candidate', '--root'];
const USAGE = `Usage:
  node resume-output.mjs --date YYYY-MM-DD --company NAME --role ROLE --candidate NAME [--root DIR]

Creates or reuses output/<date>-<company>-<role>/ and prints the professional
HTML, Markdown, TeX, and PDF draft paths as JSON. Resolving paths does not modify
existing files. Retain the original application date for later revisions.

  --date DATE       original application draft date, YYYY-MM-DD (required)
  --company NAME    employer/company name (required)
  --role ROLE       target role title (required)
  --candidate NAME  candidate full name used for the resume basename (required)
  --root DIR        output root (default: output)
  --help, -h        show this message`;

function main() {
  validateFlags(process.argv.slice(2), KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      company: { type: 'string' },
      role: { type: 'string' },
      candidate: { type: 'string' },
      root: { type: 'string' },
    },
    strict: true,
  });
  if (!values.date || !values.company || !values.role || !values.candidate) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const paths = allocateResumeOutputPaths(values);
  console.log(JSON.stringify(paths, null, 2));
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`resume-output: ${error.message}`);
    process.exitCode = 1;
  }
}
