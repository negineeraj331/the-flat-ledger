import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from '../src/lib/dates.js';

test('parses ISO dates', () => {
  assert.equal(parseDate('2026-02-01').iso, '2026-02-01');
});

test('parses DD/MM/YYYY (file convention)', () => {
  assert.equal(parseDate('01/03/2026').iso, '2026-03-01');
  assert.equal(parseDate('28/03/2026').iso, '2026-03-28'); // day 28 proves DD/MM
});

test('parses month-name with inferred year', () => {
  const r = parseDate('Mar 14');
  assert.equal(r.iso, '2026-03-14');
  assert.match(r.format, /inferred/);
});

test('flags day&month<=12 as ambiguous but still commits to DD/MM', () => {
  const r = parseDate('04/05/2026');
  assert.equal(r.iso, '2026-05-04');
  assert.equal(r.ambiguous, true);
});

test('rejects impossible calendar dates', () => {
  assert.equal(parseDate('31/02/2026').iso, null);
  assert.equal(parseDate('garbage').iso, null);
});
