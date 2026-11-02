const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyAnalysisResult } = require('../aiOpportunityAnalysisService');

test('classifyAnalysisResult: completed -> 200', () => {
  assert.equal(classifyAnalysisResult({ status: 'completed' }).httpStatus, 200);
});

test('classifyAnalysisResult: failed (safely rejected) -> 200', () => {
  assert.equal(classifyAnalysisResult({ status: 'failed' }).httpStatus, 200);
});

test('classifyAnalysisResult: rate_limited -> 429', () => {
  assert.equal(classifyAnalysisResult({ status: 'rate_limited' }).httpStatus, 429);
});

test('classifyAnalysisResult: timeout -> 503', () => {
  assert.equal(classifyAnalysisResult({ status: 'timeout' }).httpStatus, 503);
});

test('classifyAnalysisResult: unavailable -> 503', () => {
  assert.equal(classifyAnalysisResult({ status: 'unavailable' }).httpStatus, 503);
});
