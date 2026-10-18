import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Existing shell variables and .env.local take precedence; a pasted .env key is a fallback.
export function loadServerEnvironment(root, env = process.env, load = path => process.loadEnvFile(path)) {
  for (const name of ['.env.local', '.env']) {
    const path = fileURLToPath(new URL(name, root));
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8').trim();
    if (/^sk-[A-Za-z0-9_-]+$/.test(content)) {
      if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = content;
    } else load(path);
  }
}
