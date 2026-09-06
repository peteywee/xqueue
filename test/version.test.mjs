import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const version = fs.readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('VERSION and package.json stay synchronized', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.version, version);
});
