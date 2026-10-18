import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const [accountId, databaseId, frontendDirectory] = process.argv.slice(2)
assert(accountId && databaseId && frontendDirectory, 'Usage: node scripts/prepare-demo-deploy.mjs <account-id> <database-id> <frontend-dist>')
assert.match(readFileSync(resolve(frontendDirectory, 'index.html'), 'utf8'), /<div id="root">/)

const cfEntry = realpathSync(execFileSync('which', ['cf'], { encoding: 'utf8' }).trim())
const config = await import(pathToFileURL(resolve(dirname(cfEntry), '../../@cloudflare/config/dist/index.mjs')))
const output = await import(pathToFileURL(resolve(dirname(cfEntry), '../../@cloudflare/build-output-utils/dist/index.mjs')))
const root = resolve('.local/cf-site')
const worker = config.InputWorkerSchema.parse({
  name: 'future-company-demo',
  compatibilityDate: '2025-08-03',
  workersDev: true,
  previewUrls: false,
  assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*', '/mcp'] },
  exports: { CaseRoom: { type: 'durable-object', storage: 'sqlite' } },
  env: {
    CASES: { type: 'durable-object', worker: 'future-company-demo', exportName: 'CaseRoom' },
    DB: { type: 'd1', id: databaseId, name: 'future-company-demo' },
  },
})
const bundle = output.getWorkerBundleDir(root)
mkdirSync(bundle, { recursive: true })
copyFileSync(resolve('dist/future_company/index.js'), resolve(bundle, 'index.js'))
await output.writeRootConfig(root, { accountId }, { isPreview: false })
await output.writeWorkerConfig({ root, config: worker, manifest: { type: 'complete', mainModule: 'index.js', modules: { 'index.js': { type: 'esm' } } } })
await output.writeAssets({ root, sourceDirectory: resolve(frontendDirectory) })
await output.readBuildOutput(root)
console.log('Validated React + Worker build output:', root)
