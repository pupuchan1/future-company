import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Existing shell variables and .env.local take precedence; a pasted .env key is a fallback.
export function loadServerEnvironment(root, env = process.env, load = path => process.loadEnvFile(path)) {
  for (const name of ['.env.local', '.env']) {
    const path = fileURLToPath(new URL(name, root));
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8').trim();
    const assignments = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(content);
    const pasted = content.match(/\bsk-[A-Za-z0-9_-]+/g) || [];
    if (!assignments && pasted.length === 1) {
      if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = pasted[0];
    } else load(path);
  }
}
