import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEqual, computeShares, computeUnequal, computePercentage,
} from '../src/import/splitEngine.js';

const M = (id) => ({ id, name: `m${id}` });
const sum = (shares) => shares.reduce((a, s) => a + s.share_minor, 0);

test('equal split sums exactly to total', () => {
  const r = computeEqual(100, [M(1), M(2), M(3)]);
  assert.equal(sum(r.shares), 100);
});

test('share split uses weights', () => {
  const r = computeShares(360000, [
    { member: M(1), weight: 1 }, { member: M(2), weight: 2 },
    { member: M(3), weight: 1 }, { member: M(4), weight: 2 },
  ]);
  assert.equal(sum(r.shares), 360000);
  assert.equal(r.shares[1].share_minor, 120000);
});

test('unequal split matches when amounts add up', () => {
  const r = computeUnequal(150000, [
    { member: M(1), amount_minor: 70000 },
    { member: M(2), amount_minor: 40000 },
    { member: M(3), amount_minor: 40000 },
  ]);
  assert.equal(r.anomalies.length, 0);
  assert.equal(sum(r.shares), 150000);
});

test('unequal split flags + rescales when amounts mismatch', () => {
  const r = computeUnequal(200000, [
    { member: M(1), amount_minor: 70000 },
    { member: M(2), amount_minor: 40000 },
  ]);
  assert.equal(r.anomalies[0].type, 'unequal_sum_mismatch');
  assert.equal(sum(r.shares), 200000);
});

test('percentage split flags when not 100 but still sums exactly', () => {
  const r = computePercentage(220000, [
    { member: M(1), pct: 30 }, { member: M(2), pct: 30 },
    { member: M(3), pct: 30 }, { member: M(4), pct: 20 },
  ]);
  assert.equal(r.anomalies[0].type, 'percentage_sum_not_100');
  assert.equal(sum(r.shares), 220000);
});
