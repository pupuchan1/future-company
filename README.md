# Future Company — 共通AI音声受付

音声の入口を一つにまとめ、発話の内容をAIが判定して採用AgentまたはHaaS Agentへ渡します。Reactは会話・担当・ツールや人への依頼状況を表示します。

## 本番の起動と復帰

公開本番の入口はhttps://future-company-voice-node.r74.workers.dev/です。音声NodeはCloudflare Containersで動きます。Sitesは予備入口です。
既存の本人限定APIはhttps://future-company-demo.r74.workers.dev/を維持します。
本番では案件所有者を確認した`/api/v1/cases/:caseId/voice/*`を使い、Node4350と認証付きrelay4351へ接続します。
配備版と接続先は[配備記録](docs/demo-deployment.md)、起動、接続先更新と復帰は[本番運用手順](deployment/PRODUCTION.md)を参照してください。
NodeとWorkerを同じ固定commitへ揃え、既存のstateDir、D1、CaseRoomとAccessを維持して更新します。

## ローカル起動

Node.js 24.14以上の24系を使用します。

```sh
npm ci
npm run db:migrate:local
npm run dev
```

同じcheckoutでReact（http://127.0.0.1:5173）、音声・Agents・MCPのNodeサーバー（4320）、認可relay（4330）、Workers/Hono/DO/D1（8787）を起動します。終了はCtrl+Cです。使用中のポートがある場合は起動を止め、既存プロセスの用途を確認してください。

秘密設定はルートの`.env.local`に置きます。変数名は[.env.example](.env.example)を参照してください。既存`.env`へ貼付済みのAPIキーもNodeが読み込みます。VITE_へAPIキーを置きません。

Node用`.env.local`へ`WORKER_API_URL=http://127.0.0.1:8787`と、既存の`OPENAI_API_KEY`、`HUMAN_MCP_URL`、`HUMAN_MCP_TOKEN`、`STAFF_API_TOKEN`、`NODE_RELAY_SECRET`を設定します。Worker用`.dev.vars`には同じ`STAFF_API_TOKEN`と`NODE_RELAY_SECRET`、`NODE_RELAY_ORIGIN=http://127.0.0.1:4330`、`NODE_RELAY_EVENTS_TRANSPORT=sse`を設定します。トークンは32〜200文字のURL-safe値を使い、FEへ渡しません。

`HUMAN_MCP_URL`は同じNodeの認証付き`/mcp`へ到達するHTTPS URLです。一時トンネルを使う許可がある場合は、`cloudflared`を用意して`npm run dev -- --mcp-tunnel`で起動します。4330へ接続し、その回のMCP URLをNodeへ渡します。Ctrl+Cでトンネルも終了します。通常の`npm run dev`では設定済みURLを使います。設定不足や接続エラーは案件作成後に表示し、マイク・Liveを開始しません。

`npm run phone:sim -- --auto`は架空の開発環境回答を返すシミュレーターです。実機ベル・実人間の回答とは区別してください。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | FE・音声BE・Workerをまとめて起動 |
| `npm run dev:frontend` | Reactのみ起動 |
| `npm run dev:worker` | ローカルWorkerのみ起動 |
| `npm run integration` | 音声BEのみ起動 |
| `npm run integration:relay` | 音声BEと認可relayを起動 |
| `npm run build` | ReactとWorkerの本番ビルド |
| `npm run typecheck` | ReactとWorkerの型チェック |
| `npm run test:frontend` | Reactの接続・状態テスト |
| `npm run integration:test` | 音声・MCP・委譲のテスト |
| `npm run test:worker` | DO/D1・認証・案件APIのテスト（Bunも必要） |
| `npm run db:migrate:local` | ローカルD1のmigration |

## 取り込んだ実装と境界

- PR #15: `frontend/` のReact UIとWebRTC/SSE接続。
- PR #4: `integration/` の共通音声受付、Decisions、採用/HaaS Agents、共通MCP・模擬電話。
- PR #12: `src/backend/` のHono案件API、社員認証、DO/D1永続化。

FEは`/api/v1/cases/:caseId/voice/*`へ接続し、Workerで案件所有者を毎回確認してから署名付きでNode relayへ転送します。開始bodyのcase限定証明をNodeでも検証します。バックエンドの担当切替を表示し、FEでは発話から担当を決めません。

Nodeのcase/handoffとWorkerのcase/requestは結果返却adapterで対応付けます。社員認証・claim・revisionを通して保存した本文を元Agentへ一度だけ返し、`live_submitted`はLiveへ送信済みまでを表します。音声説明完了のACKではありません。元のローカルデモはソースとテストを保持し、一般利用者の音声入口には表示しません。

実APIの音声往復にはサーバー側のOpenAI設定と外部から到達できる認証付きMCP URLが必要です。黒電話の実機は別担当です。

詳細: [音声BE](integration/README.md) / [React接続](frontend/LIVE-INTEGRATION.md) / [案件API](docs/backend-api.md) / [Workers接続](docs/backend-integration.md)。
