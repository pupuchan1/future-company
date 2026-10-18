# Future Company

採用面談と社員への確認依頼を扱うReact画面とCloudflare Workers・Honoバックエンド。案件の正本はSQLite Durable Objects、社員向けの案件一覧はD1に保存する。

## ローカル起動

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

Viteが表示するURL（通常は http://127.0.0.1:5173 ）を開く。同じサーバーで受付・会話・担当者画面と`/api/v1/*`のHono APIを利用できる。会話URLを直接開いたり再読込したりしても画面が表示される。CLIのmigrationとViteはルートの`.wrangler/state/`を共有し、ローカルDBだけを使う。

「AI受付と話す」→「開発環境を教えてください」→送信→「人に確認を依頼」でデモを試せる。別タブの`/operator`で引き受けて回答すると、元の会話へ反映される。この画面操作はブラウザのlocalStorageに保存する模擬デモで、Worker案件APIへの送信とは別。デモにはAPIキー・マイク・社員トークンは不要。

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
npm run typecheck:frontend
npm run lint
node --test frontend/tests/demo.test.ts frontend/tests/live-connection.test.ts
```

`typecheck`は`bun run cf-typegen`でWorker型も生成する。`build`はReactを`dist/client/`、Workerを`dist/future_company/`へ出力する。テストはローカルworkerd・DO・D1とBunで実行し、実OpenAIや電話は呼び出さない。

API契約は[docs/backend-api.md](docs/backend-api.md)、保存・環境設定・FEと音声担当への接続条件は[docs/backend-integration.md](docs/backend-integration.md)を参照。

採用APIでは面談送信、社員の引き受け・回答、D1一覧保存まで確認済み。Reactの画面フォームとWorker案件APIは未結合。実音声はPR #4のNodeサーバーへ接続する別構成で、[frontend/LIVE-INTEGRATION.md](frontend/LIVE-INTEGRATION.md)に起動方法を記載している。通常の`bun run dev`だけでは音声サーバーは起動しない。実OpenAI応答、Agentsへの回答返却・音声再開、MCP Eventsの実Work購読、黒電話の実機確認は別途必要。

Accessで保護した試験環境の配信手順は[docs/demo-deployment.md](docs/demo-deployment.md)を参照。ローカル起動にはCloudflareへのログインは不要。
## Reactフロントエンド

フロントエンドは`frontend/`に配置しています。React + TypeScript + Viteの構成です。ルートの`dev`・`build`で画面とWorkerをまとめて扱います。`:frontend`付きのコマンドはReact単独の開発・ビルドに使えます。

## 開発を始める

Node.js 24.14 以上の 24 系と npm を使用します。nvm を使う場合は `nvm install` / `nvm use` で切り替えられます。

リポジトリのルートで実行してください。

```sh
npm ci
npm run db:migrate:local
npm run dev
```

ターミナルに表示される URL（通常は http://localhost:5173）を開きます。
受付・会話・担当者画面の組み立ては `frontend/src/App.tsx` です。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | ReactとHono APIの開発サーバーを同じURLで起動 |
| `npm run build` | ReactとWorkerをまとめてビルド |
| `npm run dev:frontend` | Reactだけの開発サーバーを起動（Worker APIなし） |
| `npm run build:frontend` | Reactの型チェックと本番ビルド。出力先は `frontend/dist/` |
| `npm run lint` | Oxlint でコードをチェック |
| `npm run typecheck:frontend` | ReactのTypeScript型チェック |
| `npm run preview:frontend` | Reactのビルド済み画面をローカルで確認 |

Reactはnpm workspacesを使用します。npmの依存関係はルートの`package-lock.json`、Bunの依存関係は`bun.lock`で管理します。ルートとfrontendのpackage.jsonを変更した場合は両方のlockfileを更新してください。
パッケージ追加はルートから `npm install <package> -w frontend` を実行してください。

## 構成

```text
frontend/
├── public/           # そのまま配信する画像など
├── src/
│   ├── assets/       # import して使う画像など
│   ├── components/   # 共通 UI 部品
│   ├── features/     # 機能ごとの UI・処理
│   ├── hooks/        # 共通カスタムフック
│   ├── lib/          # API クライアント・共通処理
│   ├── pages/        # 画面
│   ├── styles/       # 共通 CSS
│   ├── types/        # 共通の型定義
│   ├── App.tsx       # アプリ全体の組み立て
│   └── main.tsx      # エントリーポイント
└── .env.example      # 環境変数の設定例
```

`@/` で `frontend/src/` を参照できます（例: `@/components/Button`）。
画面のデモ状態は`frontend/src/lib/demo.ts`、実音声接続は`frontend/src/features/live/`で扱います。

環境変数が必要になったら `frontend/.env.example` を `frontend/.env.local` にコピーしてください。
`VITE_` から始まる環境変数はブラウザに公開されます。秘密鍵やサーバー専用の認証情報は保存しないでください。
