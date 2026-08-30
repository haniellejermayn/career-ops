#!/usr/bin/env node

/**
 * Deterministic post-render layout QA for resume PDFs.
 *
 * Poppler's `pdftotext -bbox-layout` supplies page dimensions plus positioned
 * words. This validator uses that geometry to find wrapped bullet endings that
 * are too short to pass as intentional resume layout.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BULLET_RE = /^(?:[•●◦▪‣‧·]|\uF0B7)$/u;
const DEFAULTS = Object.freeze({
  errorWidthRatio: 0.25,
  warningWidthRatio: 0.50,
  maxErrorWords: 2,
  baselineTolerance: 2.25,
  continuationIndentTolerance: 6,
  continuationGapTolerance: 16,
});

function parseAttrs(source) {
  const attrs = {};
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function numberAttr(attrs, key) {
  const value = Number(attrs[key]);
  return Number.isFinite(value) ? value : 0;
}

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** Parse Poppler bbox-layout XHTML into pages containing positioned line fragments. */
export function parseBboxLayout(xml) {
  if (typeof xml !== 'string' || !xml.includes('<page')) {
    throw new Error('pdftotext returned no bbox-layout pages.');
  }

  const pages = [];
  for (const pageMatch of xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)) {
    const pageAttrs = parseAttrs(pageMatch[1]);
    const fragments = [];

    for (const lineMatch of pageMatch[2].matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)) {
      const words = [];
      for (const wordMatch of lineMatch[2].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
        const attrs = parseAttrs(wordMatch[1]);
        const text = decodeXml(wordMatch[2].replace(/<[^>]+>/g, '')).trim();
        if (!text) continue;
        words.push({
          text,
          xMin: numberAttr(attrs, 'xMin'),
          yMin: numberAttr(attrs, 'yMin'),
          xMax: numberAttr(attrs, 'xMax'),
          yMax: numberAttr(attrs, 'yMax'),
        });
      }
      if (words.length === 0) continue;
      const attrs = parseAttrs(lineMatch[1]);
      fragments.push({
        words,
        xMin: numberAttr(attrs, 'xMin') || Math.min(...words.map((word) => word.xMin)),
        yMin: numberAttr(attrs, 'yMin') || Math.min(...words.map((word) => word.yMin)),
        xMax: numberAttr(attrs, 'xMax') || Math.max(...words.map((word) => word.xMax)),
        yMax: numberAttr(attrs, 'yMax') || Math.max(...words.map((word) => word.yMax)),
      });
    }

    pages.push({
      number: pages.length + 1,
      width: numberAttr(pageAttrs, 'width'),
      height: numberAttr(pageAttrs, 'height'),
      fragments,
    });
  }
  return pages;
}

function mergeVisualLines(fragments, tolerance) {
  const sorted = [...fragments].sort((a, b) => {
    const aCenter = (a.yMin + a.yMax) / 2;
    const bCenter = (b.yMin + b.yMax) / 2;
    return aCenter - bCenter || a.xMin - b.xMin;
  });
  const groups = [];

  for (const fragment of sorted) {
    const center = (fragment.yMin + fragment.yMax) / 2;
    let group = groups.at(-1);
    if (!group || Math.abs(center - group.center) > tolerance) {
      group = { center, fragments: [] };
      groups.push(group);
    }
    group.fragments.push(fragment);
    group.center = group.fragments.reduce(
      (sum, item) => sum + (item.yMin + item.yMax) / 2,
      0,
    ) / group.fragments.length;
  }

  return groups.map((group) => {
    const words = group.fragments.flatMap((fragment) => fragment.words)
      .sort((a, b) => a.xMin - b.xMin || a.xMax - b.xMax);
    return {
      words,
      text: words.map((word) => word.text).join(' '),
      xMin: Math.min(...words.map((word) => word.xMin)),
      xMax: Math.max(...words.map((word) => word.xMax)),
      yMin: Math.min(...words.map((word) => word.yMin)),
      yMax: Math.max(...words.map((word) => word.yMax)),
      center: group.center,
    };
  }).sort((a, b) => a.center - b.center || a.xMin - b.xMin);
}

function bulletInfo(line) {
  const markerIndex = line.words.findIndex((word) => BULLET_RE.test(word.text));
  if (markerIndex === -1) return null;
  const marker = line.words[markerIndex];
  const textWords = line.words.filter((word, index) => index !== markerIndex && word.xMin > marker.xMin);
  if (textWords.length === 0) return null;
  return {
    marker,
    textWords,
    textStart: Math.min(...textWords.map((word) => word.xMin)),
    text: textWords.map((word) => word.text).join(' '),
  };
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Analyze Poppler bbox-layout XHTML without invoking any external process.
 * This pure boundary is used by the small geometry fixtures in the test suite.
 */
export function analyzeBboxLayout(xml, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const pages = parseBboxLayout(xml);
  const findings = [];
  let bulletCount = 0;
  let wrappedBulletCount = 0;
  let checkedContinuationLines = 0;

  for (const page of pages) {
    const lines = mergeVisualLines(page.fragments, settings.baselineTolerance);
    const observedRight = Math.max(...lines.map((line) => line.xMax));
    const observedLeft = Math.min(...lines.map((line) => line.xMin));
    // Resume body margins are symmetric in the shipped LaTeX template. Cap an
    // unusually wide header/contact line at that body boundary, while retaining
    // the observed edge for PDFs whose declared page width is unavailable.
    const symmetricRight = page.width > 0 ? page.width - observedLeft : observedRight;
    const rightBoundary = Math.min(observedRight, symmetricRight);

    for (let index = 0; index < lines.length; index++) {
      const start = bulletInfo(lines[index]);
      if (!start) continue;
      bulletCount++;

      const continuations = [];
      let previous = lines[index];
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
        const next = lines[nextIndex];
        if (bulletInfo(next)) break;
        if (next.center - previous.center > settings.continuationGapTolerance) break;
        if (Math.abs(next.xMin - start.textStart) > settings.continuationIndentTolerance) break;
        continuations.push(next);
        previous = next;
      }

      if (continuations.length === 0) continue;
      wrappedBulletCount++;
      checkedContinuationLines++;

      const finalLine = continuations.at(-1);
      const availableWidth = rightBoundary - start.textStart;
      if (!(availableWidth > 0)) continue;
      const lineWidth = Math.max(0, finalLine.xMax - finalLine.xMin);
      const utilization = lineWidth / availableWidth;
      const wordCount = countWords(finalLine.text);
      let severity = null;
      const reasons = [];

      if (wordCount <= settings.maxErrorWords) {
        severity = 'ERROR';
        reasons.push(`${wordCount}-word continuation`);
      }
      if (utilization < settings.errorWidthRatio) {
        severity = 'ERROR';
        reasons.push(`under ${Math.round(settings.errorWidthRatio * 100)}% width`);
      } else if (!severity && utilization < settings.warningWidthRatio) {
        severity = 'WARNING';
        reasons.push(`under ${Math.round(settings.warningWidthRatio * 100)}% width`);
      }

      if (!severity) continue;
      findings.push({
        page: page.number,
        text: finalLine.text,
        bulletText: [start.text, ...continuations.map((line) => line.text)].join(' '),
        wordCount,
        lineWidth: round(lineWidth, 2),
        availableWidth: round(availableWidth, 2),
        utilizationPercent: round(utilization * 100, 1),
        severity,
        reasons,
      });
    }
  }

  const errors = findings.filter((finding) => finding.severity === 'ERROR').length;
  const warnings = findings.filter((finding) => finding.severity === 'WARNING').length;
  return {
    valid: errors === 0,
    pageGeometry: pages.map((page) => ({
      page: page.number,
      width: page.width,
      height: page.height,
    })),
    thresholds: {
      errorWidthPercent: settings.errorWidthRatio * 100,
      warningWidthPercent: settings.warningWidthRatio * 100,
      maxErrorWords: settings.maxErrorWords,
    },
    summary: {
      pages: pages.length,
      bullets: bulletCount,
      wrappedBullets: wrappedBulletCount,
      checkedContinuationLines,
      errors,
      warnings,
    },
    findings,
  };
}

function probeExecutable(candidate) {
  try {
    execFileSync(candidate, ['-v'], {
      stdio: 'pipe',
      timeout: 5_000,
      windowsHide: true,
    });
    return candidate;
  } catch {
    return null;
  }
}

function localPopplerCandidates(root) {
  const candidates = [];
  for (const base of [join(root, 'tmp', 'pdfs', 'tools', 'poppler'), join(root, 'tools', 'poppler')]) {
    if (!existsSync(base)) continue;
    candidates.push(join(base, 'Library', 'bin', 'pdftotext.exe'));
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        join(base, entry.name, 'Library', 'bin', 'pdftotext.exe'),
        join(base, entry.name, 'bin', 'pdftotext.exe'),
        join(base, entry.name, 'bin', 'pdftotext'),
      );
    }
  }
  return candidates.filter(existsSync);
}

/** Resolve Poppler without adding a package dependency. */
export function resolvePdftotext(explicitPath = null, options = {}) {
  const env = options.env || process.env;
  const root = options.root || ROOT;
  const requested = explicitPath || env.CAREER_OPS_PDFTOTEXT || null;
  if (requested) {
    const resolved = probeExecutable(requested);
    if (!resolved) throw new Error(`Configured pdftotext is unavailable: ${requested}`);
    return resolved;
  }

  const fromPath = probeExecutable(process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext');
  if (fromPath) return fromPath;
  for (const candidate of localPopplerCandidates(root)) {
    const resolved = probeExecutable(candidate);
    if (resolved) return resolved;
  }
  throw new Error('Poppler pdftotext was not found on PATH or in the local Career-Ops Poppler tools directory.');
}

/** Run Poppler against a final PDF and return structured layout diagnostics. */
export function validatePdfLayout(pdfPath, options = {}) {
  const absolutePdf = resolve(pdfPath);
  if (!existsSync(absolutePdf)) throw new Error(`PDF not found: ${absolutePdf}`);
  if (extname(absolutePdf).toLowerCase() !== '.pdf') throw new Error(`Expected a .pdf file: ${absolutePdf}`);
  const pdftotext = resolvePdftotext(options.pdftotextPath, options);
  let xml;
  try {
    xml = execFileSync(pdftotext, ['-bbox-layout', '-enc', 'UTF-8', absolutePdf, '-'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`pdftotext bbox extraction failed: ${error.message}`);
  }
  return {
    pdf: absolutePdf,
    pdftotext,
    available: true,
    ...analyzeBboxLayout(xml, options),
  };
}

function printSummary(result) {
  console.log(`PDF layout QA: ${result.valid ? 'PASS' : 'FAIL'} (${result.summary.errors} error(s), ${result.summary.warnings} warning(s))`);
  for (const finding of result.findings) {
    console.log(`${finding.severity} page ${finding.page}: ${JSON.stringify(finding.text)} — ${finding.utilizationPercent}% width (${finding.reasons.join(', ')})`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const summary = args.includes('--summary');
  const explicit = args.find((arg) => arg.startsWith('--pdftotext='))?.slice('--pdftotext='.length) || null;
  const positional = args.filter((arg) => arg !== '--summary' && !arg.startsWith('--pdftotext='));
  if (positional.length !== 1 || !positional[0]) {
    console.error('Usage: node validate-pdf-layout.mjs <resume.pdf> [--summary] [--pdftotext=<path>]');
    process.exitCode = 1;
    return;
  }
  try {
    const result = validatePdfLayout(positional[0], { pdftotextPath: explicit });
    if (summary) printSummary(result);
    else console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    console.error(`PDF layout QA unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
