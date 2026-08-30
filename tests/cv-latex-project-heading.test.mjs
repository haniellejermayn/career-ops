import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjects } from '../build-cv-latex.mjs';

test('LaTeX project headings keep every pipe separator outside italic spans', () => {
  const rendered = buildProjects([
    {
      name: 'Schedicare',
      context: 'Accenture Capstone Project | Amazon Bedrock, Claude Sonnet, Next.js',
      bullets: ['Built a scheduling system'],
    },
    {
      name: 'JJ Apartments',
      context: 'Academic Client Project | GitHub Actions, Next.js, Spring Boot, MySQL',
      bullets: ['Led delivery'],
    },
    {
      name: 'WESM Price Prediction',
      context: 'Python, scikit-learn, PyTorch, TensorFlow',
      bullets: ['Benchmarked models'],
    },
  ]);

  assert.match(
    rendered,
    /\\textbf\{Schedicare\} \\textbar\{\} \\emph\{Accenture Capstone Project\} \\textbar\{\} \\emph\{Amazon Bedrock, Claude Sonnet, Next\.js\}/,
  );
  assert.match(
    rendered,
    /\\textbf\{JJ Apartments\} \\textbar\{\} \\emph\{Academic Client Project\} \\textbar\{\} \\emph\{GitHub Actions, Next\.js, Spring Boot, MySQL\}/,
  );
  assert.match(
    rendered,
    /\\textbf\{WESM Price Prediction\} \\textbar\{\} \\emph\{Python, scikit-learn, PyTorch, TensorFlow\}/,
  );
  assert.doesNotMatch(rendered, /\\emph\{[^}]*\\textbar\{\}/, 'pipe separators must never inherit italics');
  assert.equal((rendered.match(/\\textbar\{\}/g) || []).length, 5, 'all generated separators use ATS-readable text bars');
});
