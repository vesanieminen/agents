import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHue, projectHex, hslHex, monogram } from '../src/color.js';
import { labelDef } from '../src/render.js';

test('project hue is deterministic and spread', () => {
  assert.equal(projectHue('api-server'), projectHue('api-server'));
  const hues = ['api-server', 'web-app', 'infra', 'claude-board', 'agents', 'docs-site', 'mobile-app', 'data-pipeline'].map(projectHue);
  assert.equal(new Set(hues).size, hues.length, 'eight common names get eight distinct hues: ' + hues.join(','));
  for (const h of hues) assert.ok(h >= 0 && h < 360);
});

test('hslHex produces valid hex and known anchors', () => {
  assert.equal(hslHex(0, 100, 50), 'FF0000');
  assert.equal(hslHex(120, 100, 25), '008000');
  assert.match(projectHex('anything'), /^[0-9A-F]{6}$/);
});

test('repo labels take the project color; other kinds keep theirs', () => {
  assert.equal(labelDef('repo:api-server').color, projectHex('api-server'));
  assert.notEqual(labelDef('repo:api-server').color, labelDef('repo:web-app').color);
  assert.equal(labelDef('surface:cloud').color, '4B5563');
});

test('monogram', () => {
  assert.equal(monogram('api-server'), 'AS');
  assert.equal(monogram('agents'), 'AG');
  assert.equal(monogram('claude_board.v2'), 'CB');
  assert.equal(monogram(''), '?');
});
