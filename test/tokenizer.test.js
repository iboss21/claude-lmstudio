import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import {
  countRequestTokens,
  estimateImageTokens,
  pngDimensions,
  TokenCalibrator,
} from '../src/tokenizer.js';

/** Build a minimal valid PNG header so the dimension reader has something real to parse. */
function pngBase64(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const body = Buffer.concat([sig, ihdr, deflateSync(Buffer.alloc(16))]);
  return body.toString('base64');
}

test('PNG dimensions are read straight out of the base64 header', () => {
  assert.deepEqual(pngDimensions(pngBase64(1536, 864)), { width: 1536, height: 864 });
});

test('non-PNG data does not pretend to have dimensions', () => {
  assert.equal(pngDimensions(Buffer.from('not an image at all').toString('base64')), null);
  assert.equal(pngDimensions('!!!!'), null);
});

test('image cost follows Anthropic\'s width*height/750 approximation', () => {
  const tokens = estimateImageTokens({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngBase64(750, 750) },
  });
  assert.equal(tokens, 750);
});

test('image cost stays bounded for absurd inputs', () => {
  const tokens = estimateImageTokens({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngBase64(20000, 20000) },
  });
  assert.equal(tokens, 4000);
});

test('token counts grow with content and are never zero', () => {
  const small = countRequestTokens({ messages: [{ role: 'user', content: 'hi' }] });
  const large = countRequestTokens({
    messages: [{ role: 'user', content: 'hi '.repeat(5000) }],
  });

  assert.ok(small >= 1);
  assert.ok(large > small * 100);
});

test('system prompt and tool schemas are counted, not ignored', () => {
  const base = { messages: [{ role: 'user', content: 'hi' }] };
  const withSystem = { ...base, system: [{ type: 'text', text: 'x'.repeat(1000) }] };
  const withTools = {
    ...base,
    tools: [{ name: 'Read', description: 'y'.repeat(1000), input_schema: { type: 'object' } }],
  };

  assert.ok(countRequestTokens(withSystem) > countRequestTokens(base) + 200);
  assert.ok(countRequestTokens(withTools) > countRequestTokens(base) + 200);
});

test('nested tool_result content is counted', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'z'.repeat(3500) }] },
        ],
      },
    ],
  };
  assert.ok(countRequestTokens(body) >= 1000);
});

test('the calibrator converges on the real ratio', () => {
  const calibrator = new TokenCalibrator();
  assert.equal(calibrator.value, 1);

  for (let i = 0; i < 20; i++) calibrator.record(1000, 1200);

  assert.ok(calibrator.value > 1.15 && calibrator.value <= 1.2);
});

test('the calibrator refuses to be moved by garbage samples', () => {
  const calibrator = new TokenCalibrator();
  calibrator.record(0, 500);
  calibrator.record(500, 0);
  calibrator.record(NaN, 10);
  assert.equal(calibrator.value, 1);
});

test('the calibrator clamps outliers instead of overreacting', () => {
  const calibrator = new TokenCalibrator();
  for (let i = 0; i < 50; i++) calibrator.record(10, 100_000);
  assert.ok(calibrator.value <= 2.5);
});

test('calibration is applied to the reported count', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(3500) }] };
  const plain = countRequestTokens(body);
  const scaled = countRequestTokens(body, { calibration: 2 });
  assert.equal(scaled, Math.ceil(plain * 2));
});
