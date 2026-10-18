import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadServerEnvironment } from './environment.mjs';

test('a bare pasted key is server-only fallback; existing credentials are preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'future-env-'));
  try {
    const root = pathToFileURL(dir + '/');
    writeFileSync(join(dir, '.env'), 'sk-fixture-not-a-real-key\n', { mode: 0o600 });
    const env = {};
    loadServerEnvironment(root, env, () => assert.fail('A bare key is not a dotenv document.'));
    assert.equal(env.OPENAI_API_KEY, 'sk-fixture-not-a-real-key');
    loadServerEnvironment(root, env, () => {});
    assert.equal(env.OPENAI_API_KEY, 'sk-fixture-not-a-real-key');
    writeFileSync(join(dir, '.env.local'), 'OPENAI_API_KEY=local-fixture\n');
    const precedence = {};
    loadServerEnvironment(root, precedence, () => { precedence.OPENAI_API_KEY = 'local-fixture'; });
    assert.equal(precedence.OPENAI_API_KEY, 'local-fixture');
    loadServerEnvironment(root, { OPENAI_API_KEY: 'shell-fixture' }, () => {});
  } finally { rmSync(dir, { recursive: true }); }
});
