import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after build:frontend. The destination is a registered Vinext Sites project.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = resolve(process.argv[2] || '');
if (!process.argv[2] || !existsSync(join(destination, '.openai/hosting.json'))) throw new Error('Provide a registered Sites project directory.');
const manifest = JSON.parse(readFileSync(join(destination, '.openai/hosting.json'), 'utf8'));
if (!manifest.project_id) throw new Error('Register the Sites project before exporting.');
const built = join(source, 'frontend/dist');
const shell = readFileSync(join(built, 'index.html'), 'utf8');
function write(path, content) { mkdirSync(dirname(join(destination, path)), { recursive: true }); writeFileSync(join(destination, path), content); }
cpSync(built, join(destination, 'public'), { recursive: true });
cpSync(join(source, 'deployment/sites/proxy.mjs'), join(destination, 'lib/haas-proxy.mjs'));
write('lib/haas-proxy.d.mts', 'export function proxyVisitorApi(request: Request, env: { CF_ACCESS_CLIENT_ID?: string; CF_ACCESS_CLIENT_SECRET?: string }, fetcher?: typeof fetch): Promise<Response>;\n');
write('lib/haas-shell.ts', `const html = ${JSON.stringify(shell)};\nexport function shellResponse() { return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Permissions-Policy': 'microphone=(self)', 'X-Content-Type-Options': 'nosniff' } }); }\n`);
rmSync(join(destination, 'app/page.tsx'), { force: true });
write('app/route.ts', "export { shellResponse as GET } from '../lib/haas-shell';\n");
write('app/conversation/route.ts', "export { shellResponse as GET } from '../../lib/haas-shell';\n");
write('app/api/[...path]/route.ts', "import { env } from 'cloudflare:workers';\nimport { proxyVisitorApi } from '../../../lib/haas-proxy.mjs';\nconst proxy = (request: Request) => proxyVisitorApi(request, env);\nexport const GET = proxy;\nexport const POST = proxy;\nexport const DELETE = proxy;\n");
write('app/layout.tsx', "import type { Metadata } from 'next';\nexport const metadata: Metadata = { title: '株式会社HaaS', description: '声でつながる、株式会社HaaSの採用相談。' };\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html lang=\"ja\"><body>{children}</body></html>; }\n");
write('cloudflare-env.d.ts', 'declare namespace Cloudflare { interface Env { DB?: D1Database; BUCKET?: R2Bucket; CF_ACCESS_CLIENT_ID?: string; CF_ACCESS_CLIENT_SECRET?: string; } }\n');
write('README.md', '# 株式会社HaaS — 公開音声受付\n\npupuのフロントエンドを配信し、公開するvisitor APIだけ既存r74 Workerへ接続します。\n\n原本: https://github.com/pupuchan1/future-company （PR #39）。`npm run build:frontend` 後に `node deployment/sites/export-site.mjs <Sites checkout>` で更新します。Sites側の環境に `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` をsecretとして設定してください。ブラウザーやソースに値を含めません。案件所有は既存visitor cookieで検証し、staff・MCP APIはこの公開経路に含めません。\n\nLive/Agents/Slackは既存NodeとWorkerで処理し、モデルや会話状態を二重に作りません。\n');
console.log(JSON.stringify({ exported: true, project_id: manifest.project_id }));
