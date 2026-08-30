import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBboxLayout } from '../validate-pdf-layout.mjs';

function xmlWord(text, xMin, xMax, yMin, yMax) {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<word xMin="${xMin}" yMin="${yMin}" xMax="${xMax}" yMax="${yMax}">${escaped}</word>`;
}

function xmlLine(words, yMin, yMax = yMin + 9) {
  return `<line xMin="${words[0][1]}" yMin="${yMin}" xMax="${words.at(-1)[2]}" yMax="${yMax}">${words.map(([text, xMin, xMax]) => xmlWord(text, xMin, xMax, yMin, yMax)).join('')}</line>`;
}

function fixture(lines) {
  return `<?xml version="1.0"?><html><body><doc><page width="600" height="840"><flow><block>${lines.join('')}</block></flow></page></doc></body></html>`;
}

function bullet(firstY, finalText, finalWidth, { firstText = 'Built a production system with deterministic validation and reliable execution.', finalWords } = {}) {
  const first = [
    ['•', 40, 44],
    ...firstText.split(' ').map((word, index) => [word, 50 + index * 24, 70 + index * 24]),
  ];
  const words = finalWords || finalText.split(' ');
  const perWord = finalWidth / words.length;
  const continuation = words.map((word, index) => [
    word,
    50 + index * perWord,
    50 + (index + 1) * perWord - 1,
  ]);
  return [xmlLine(first, firstY), xmlLine(continuation, firstY + 11)];
}

test('one-word continuations from the failed PDF are ERROR findings', () => {
  const fragments = ['countries.', 'caching.', 'initiatives.', 'nodes.', 'reliability.'];
  const lines = [xmlLine([['Employer', 30, 90], ['2026', 540, 570]], 80)];
  fragments.forEach((text, index) => lines.push(...bullet(100 + index * 35, text, 40)));
  const result = analyzeBboxLayout(fixture(lines));

  assert.deepEqual(result.findings.map((finding) => finding.text), fragments);
  assert.ok(result.findings.every((finding) => finding.severity === 'ERROR'));
  assert.ok(result.findings.every((finding) => finding.utilizationPercent < 10));
  assert.deepEqual(result.pageGeometry, [{ page: 1, width: 600, height: 840 }]);
});

test('a continuation under 25 percent is an ERROR even with three words', () => {
  const result = analyzeBboxLayout(fixture([
    xmlLine([['Role', 30, 70], ['2026', 540, 570]], 80),
    ...bullet(100, 'small final fragment', 100),
  ]));

  assert.equal(result.findings[0].severity, 'ERROR');
  assert.ok(result.findings[0].utilizationPercent < 25);
});

test('a 25-50 percent continuation is a WARNING', () => {
  const result = analyzeBboxLayout(fixture([
    xmlLine([['Role', 30, 70], ['2026', 540, 570]], 80),
    ...bullet(100, 'moderately balanced final phrase', 190),
  ]));

  assert.equal(result.findings[0].severity, 'WARNING');
  assert.ok(result.findings[0].utilizationPercent >= 25);
  assert.ok(result.findings[0].utilizationPercent < 50);
});

test('a balanced continuation passes', () => {
  const result = analyzeBboxLayout(fixture([
    xmlLine([['Role', 30, 70], ['2026', 540, 570]], 80),
    ...bullet(100, 'balanced continuation with useful supporting evidence', 300),
  ]));

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.checkedContinuationLines, 1);
});

test('headings, dates, contacts, skills, and single-line bullets are ignored', () => {
  const result = analyzeBboxLayout(fixture([
    xmlLine([['Technical', 30, 95], ['Skills', 100, 140]], 40),
    xmlLine([['Languages:', 40, 100], ['Python,', 105, 155], ['SQL', 160, 180]], 55),
    xmlLine([['candidate@example.com', 120, 260], ['2026', 540, 570]], 70),
    xmlLine([['•', 40, 44], ['Single-line', 50, 110], ['bullet', 115, 150]], 90),
    xmlLine([['Employer', 30, 90], ['2025', 540, 570]], 110),
  ]));

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.checkedContinuationLines, 0);
});

test('fragments from the same baseline are merged before bullet detection', () => {
  const result = analyzeBboxLayout(fixture([
    xmlLine([['Role', 30, 70], ['2026', 540, 570]], 80),
    xmlLine([['•', 40, 44]], 101, 107),
    xmlLine([['Built', 50, 78], ['with', 82, 105], ['bold', 110, 140], ['evidence', 145, 190]], 100, 109),
    xmlLine([['reliability.', 50, 95]], 111, 120),
  ]));

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'ERROR');
  assert.equal(result.findings[0].text, 'reliability.');
});
