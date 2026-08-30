import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from './helpers.mjs';
import { buildExperience, buildProjects } from '../build-cv-latex.mjs';

const template = readFileSync(join(ROOT, 'templates', 'cv-template.tex'), 'utf8');

test('LaTeX resume bullets use list-level spacing rather than trailing horizontal vspace', () => {
  const itemStart = template.indexOf('\\newcommand{\\resumeItem}');
  const subheadingStart = template.indexOf('\\newcommand{\\resumeSubheading}', itemStart);
  const itemMacro = template.slice(itemStart, subheadingStart);

  assert.notEqual(itemStart, -1, 'resumeItem macro is present');
  assert.notEqual(subheadingStart, -1, 'resumeSubheading macro follows resumeItem');
  assert.doesNotMatch(
    itemMacro,
    /\\vspace/,
    'resumeItem must not place vspace after horizontal bullet content',
  );

  const subItemMacro = template.split('\n').find((line) => line.includes('\\newcommand{\\resumeSubItem}')) || '';
  assert.notEqual(subItemMacro, '', 'resumeSubItem macro is present');
  assert.doesNotMatch(
    subItemMacro,
    /\\vspace/,
    'resumeSubItem must not append trailing per-item vspace',
  );

  const listStart = template.match(
    /\\newcommand\{\\resumeItemListStart\}\[1\]\{([^\n]+)\}/,
  )?.[1] || '';
  assert.match(listStart, /^\\vspace\{#1\}\\begin\{itemize\}/, 'the shared list primitive accepts explicit pre-list spacing');
  assert.match(listStart, /itemsep\s*=\s*0pt/, 'adjacent items keep the natural wrapped-line rhythm');
  assert.doesNotMatch(listStart, /itemsep\s*=\s*-3pt/, 'items must not be compressed below the natural baseline');
  assert.match(listStart, /parsep\s*=\s*0pt/, 'paragraph spacing cannot vary between items');
  assert.match(listStart, /topsep\s*=\s*0pt/, 'list opening spacing is explicit');
  assert.match(listStart, /partopsep\s*=\s*0pt/, 'blank-paragraph list spacing is disabled');

  const experienceListStart = template.split('\n').find((line) => line.includes('\\newcommand{\\resumeExperienceItemListStart}')) || '';
  const projectListStart = template.split('\n').find((line) => line.includes('\\newcommand{\\resumeProjectItemListStart}')) || '';
  assert.match(experienceListStart, /\\resumeItemListStart\{1pt\}/, 'experience lists receive approximately 1pt pre-list separation');
  assert.match(projectListStart, /\\resumeItemListStart\{-6pt\}/, 'project lists receive -6pt pre-list separation');

  const experience = buildExperience([{ company: 'Acme', role: 'Engineer', dates: '2026', bullets: ['Built it'] }]);
  const projects = buildProjects([{ name: 'Project', context: 'Node.js', bullets: ['Built it'] }]);
  assert.match(experience, /\\resumeExperienceItemListStart/, 'experience rendering selects the experience list-start macro');
  assert.doesNotMatch(experience, /\\resumeProjectItemListStart/, 'experience rendering does not select project spacing');
  assert.match(projects, /\\resumeProjectItemListStart/, 'project rendering selects the project list-start macro');
  assert.doesNotMatch(projects, /\\resumeExperienceItemListStart/, 'project rendering does not inherit experience spacing');
});
