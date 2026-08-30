import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from './helpers.mjs';

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

  const listStart = template.match(
    /\\newcommand\{\\resumeItemListStart\}\{([^\n]+)\}/,
  )?.[1] || '';
  assert.match(listStart, /itemsep\s*=\s*-3pt/, 'compact inter-item spacing is explicit');
  assert.match(listStart, /parsep\s*=\s*0pt/, 'paragraph spacing cannot vary between items');
  assert.match(listStart, /topsep\s*=\s*0pt/, 'list opening spacing is explicit');
  assert.match(listStart, /partopsep\s*=\s*0pt/, 'blank-paragraph list spacing is disabled');
});
