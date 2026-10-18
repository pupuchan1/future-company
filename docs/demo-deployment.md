# React画面を含む試験デプロイ

試験URLはhttps://future-company-demo.r74.workers.dev/。R74のAccessで所有者のメールだけを許可し、プレビューURLは無効にしている。

Honoのbackendと、PR #15のReactビルドを同じWorkerに配信する。`/api/*`と`/mcp`はWorkerを優先し、画面はStatic Assetsから配信する。会話・operatorの直打ちと再読込にはSPA fallbackを使う。FEの元ファイルは別担当のまま保持し、独立したビルドを使う。

## ビルドと配信

frontendはPR #15の確認済みcommit `4cbf25ad311e7292cc1b23b801e217151087548a`。ここでは`.local/frontend-site-4cbf25a`へそのcommitを展開している。生成物・依存・配信成果物をgitへ追加しない。

```sh
git fetch origin
mkdir -p .local/frontend-site-4cbf25a
git archive 4cbf25ad311e7292cc1b23b801e217151087548a -o .local/frontend-site-4cbf25a.tar
tar -xf .local/frontend-site-4cbf25a.tar -C .local/frontend-site-4cbf25a
```

frontend側でnpmの既存scriptを使用する。リポジトリの指定Nodeは24系。

```sh
cd .local/frontend-site-4cbf25a
npm ci
npm run build
```

リポジトリルートへ戻り、backendのビルドと成果物の結合を行う。CLIは確認時点で`cf 1.0.0-beta.14`。準備scriptはこのCLIに同梱されたBuild Outputのschemaとutilityを使い、出力を検証してからdeployする。

```sh
bun run build
node scripts/prepare-demo-deploy.mjs a35a4c201dc020caa185829b1d74acbf 5c48aef5-7f4a-4400-8822-a2ef79bf9eaa .local/frontend-site-4cbf25a/frontend/dist
cd .local/cf-site
cf deploy --prebuilt --dry-run
cf deploy --prebuilt
```

ローカルの`.env`をこのscriptで読むことはない。OpenAI接続とNodeの音声サーバーは別担当との結合待ち。Accessと社員認証は別の認証であり、`STAFF_API_TOKEN`はWorkerの既存secretを使う。秘密値をビルドのJS・CLI引数・gitへ入れない。

## 2026-10-18の確認

配信versionは`2732ac45-f00d-4c84-9895-cd165aef3f25`。React buildとCLI dry-runが成功し、Access認証済みのChromeで以下を確認した。

- 受付トップの表示、会話画面への遷移、会話URLの再読込。
- 開発環境の質問から、ブラウザ内デモの担当者依頼・引受・模擬回答を会話へ反映。
- `/operator`の直接表示。
- `/api/v1/company`がReact HTMLではなく会社情報のJSONを返すこと。

デモ画面の依頼・回答はlocalStorageで同期する。実AIの音声・黒電話・Workerの案件保存へのUI接続は、この表示確認の証拠に含めない。認証後のWorker API通し試験は[backend-integration.md](backend-integration.md)に別記する。

Static Assetsの配信とSPA fallbackは[Cloudflare公式仕様](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)に従う。
