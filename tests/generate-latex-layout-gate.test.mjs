import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPdfLayoutValidation } from '../generate-latex.mjs';

test('LaTeX compilation remains inspectable but ERROR layout findings invalidate the result', () => {
  const report = { compiled: true, valid: true };
  const result = applyPdfLayoutValidation(report, 'fixture.pdf', () => ({
    valid: false,
    summary: { errors: 1, warnings: 0 },
    findings: [{ severity: 'ERROR', text: 'nodes.', utilizationPercent: 5 }],
  }));

  assert.equal(result.compiled, true);
  assert.equal(result.valid, false);
  assert.equal(result.layoutValidation.findings[0].severity, 'ERROR');
});

test('WARNING findings are surfaced without failing the layout gate', () => {
  const report = { compiled: true, valid: true };
  const result = applyPdfLayoutValidation(report, 'fixture.pdf', () => ({
    valid: true,
    summary: { errors: 0, warnings: 1 },
    findings: [{ severity: 'WARNING', text: 'moderately short final phrase', utilizationPercent: 42 }],
  }));

  assert.equal(result.valid, true);
  assert.equal(result.layoutValidation.summary.warnings, 1);
});

test('an unavailable deterministic validator cannot be reported as a layout pass', () => {
  const report = { compiled: true, valid: true };
  const result = applyPdfLayoutValidation(report, 'fixture.pdf', () => {
    throw new Error('pdftotext missing');
  });

  assert.equal(result.valid, false);
  assert.equal(result.layoutValidation.available, false);
  assert.match(result.layoutValidation.error, /pdftotext missing/);
});
