# Future Company

採用面談と社員への確認依頼を扱うCloudflare Workers・Honoバックエンド。案件の正本はSQLite Durable Objects、社員一覧の保存先はD1。

## ローカル起動

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev --host 127.0.0.1
```

Viteが表示するURLで起動する。ローカルDBだけを使い、Cloudflare accountやremote database IDは設定していない。

社員APIを使う場合は、gitignore対象の`.dev.vars`へ`STAFF_API_TOKEN`を設定してから起動する。32〜200文字の英数字・`_`・`-`を使い、既存ファイルを上書きしない。`POST /api/v1/staff/session`にBearerで渡すと、固定のデモ社員としてログインできるHttpOnly cookieを取得する。未設定時は社員APIを503で拒否する。トークンをFEソース・URLへ埋め込まない。

## 採用APIのデモ

ローカルサーバーを起動し、サーバーと同じ`STAFF_API_TOKEN`を環境変数にexportしてから実行する。`curl`、`jq`、`uuidgen`が必要。`BASE_URL`はViteが表示するURLに合わせる。

```sh
BASE_URL=http://127.0.0.1:5173 bash scripts/demo-recruitment.sh
```

採用案件作成・面談送信・社員ログイン・引き受け・模擬回答の保存まで進み、最後に保存後の案件を表示する。cookie・案件ID・依頼ID・revisionは自動で引き継ぐ。実行ごとに新しい案件を作り、トークンはファイルへ保存しない。一時cookieは終了時に削除する。実AIや電話への接続は含まない。

## 検証

```sh
bun run typecheck
bun run test
bun run build
```

`typecheck`は`bun run cf-typegen`でWorker型も生成する。テストはローカルworkerd・DO・D1とBunで実行し、実OpenAIや電話は呼び出さない。

API契約は[docs/backend-api.md](docs/backend-api.md)、保存・環境設定・FEと音声担当への接続条件は[docs/backend-integration.md](docs/backend-integration.md)を参照。

採用面談送信、社員の引き受け・回答、D1一覧保存まで接続済み。Live・AgentsのHTTP経路は登録済みだが、sideband・業務ツール・音声会話の再開は別担当との接続待ち。React FE、MCP Events、黒電話、remoteへのdeployも実接続・検証待ち。
