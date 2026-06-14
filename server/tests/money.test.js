import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmountToMinor, allocateByWeights, allocateEqually, roundHalfUp, formatMinor,
} from '../src/lib/money.js';

test('parseAmountToMinor handles thousands separators', () => {
  const r = parseAmountToMinor('1,200');
  assert.equal(r.minor, 120000);
  assert.equal(r.hadComma, true);
});

test('parseAmountToMinor trims whitespace', () => {
  const r = parseAmountToMinor(' 1450 ');
  assert.equal(r.minor, 145000);
  assert.equal(r.hadWhitespace, true);
});

test('parseAmountToMinor rounds sub-paise half-up', () => {
  const r = parseAmountToMinor('899.995');
  assert.equal(r.minor, 90000); // 89999.5 -> 90000
  assert.equal(r.hadSubMinor, true);
});

test('parseAmountToMinor keeps negatives (refunds)', () => {
  assert.equal(parseAmountToMinor('-30').minor, -3000);
});

test('parseAmountToMinor rejects garbage', () => {
  assert.equal(parseAmountToMinor('abc').minor, null);
  assert.equal(parseAmountToMinor('').minor, null);
});

test('roundHalfUp is symmetric around zero', () => {
  assert.equal(roundHalfUp(2.5), 3);
  assert.equal(roundHalfUp(-2.5), -3);
});

test('allocateEqually sums exactly to the total (no lost paise)', () => {
  const a = allocateEqually(100, 3);
  assert.deepEqual(a, [34, 33, 33]);
  assert.equal(a.reduce((x, y) => x + y, 0), 100);
});

test('allocateByWeights respects weights and sums exactly', () => {
  const a = allocateByWeights(3600_00, [1, 2, 1, 2]); // scooter rentals
  assert.equal(a.reduce((x, y) => x + y, 0), 360000);
  assert.deepEqual(a, [60000, 120000, 60000, 120000]);
});

test('allocateByWeights handles negative totals (refunds)', () => {
  const a = allocateByWeights(-100, [1, 1, 1, 1]);
  assert.equal(a.reduce((x, y) => x + y, 0), -100);
});

test('percentage-style weights normalise when they do not total 100', () => {
  // 30/30/30/20 = 110 total -> proportional allocation, exact sum
  const a = allocateByWeights(2200_00, [30, 30, 30, 20]);
  assert.equal(a.reduce((x, y) => x + y, 0), 220000);
});

test('formatMinor renders INR with grouping', () => {
  assert.equal(formatMinor(4800000, 'INR'), '₹48,000.00');
  assert.equal(formatMinor(-249000, 'INR'), '-₹2,490.00');
});
