# Future Company — 共通AI音声受付

音声の入口を一つにまとめ、発話の内容をAIが判定して採用AgentまたはHaaS Agentへ渡します。Reactは会話・担当・ツールや人への依頼状況を表示します。

## ローカル起動

Node.js 24.14以上の24系を使用します。

```sh
npm ci
npm run db:migrate:local
npm run dev
```

同じcheckoutでReact（http://127.0.0.1:5173）、音声・Agents・MCPのNodeサーバー（4320）、Workers/Hono/DO/D1（8787）を起動します。終了はCtrl+Cです。既に同じポートを使う開発サーバーがある場合は終了してから起動してください。

秘密設定はルートの `.env.local` に置きます（Git管理外）。変数名は [.env.example](.env.example) を参照してください。Node側にだけ渡し、VITE_へAPIキーを置きません。設定がない場合もローカルの画面とAPIの確認はでき、AI音声の開始は無効になります。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | FE・音声BE・Workerをまとめて起動 |
| `npm run dev:frontend` | Reactのみ起動 |
| `npm run dev:worker` | ローカルWorkerのみ起動 |
| `npm run integration` | 音声BEのみ起動 |
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

FEの `/api/status`・`/api/events`・`/api/live/*` はNodeへ、`/api/v1/*` はWorkerへ同一originで転送します。バックエンドの担当切替を表示し、FEでは発話から担当を決めません。

Nodeのcase/handoffとWorkerのcase/requestを対応付ける結果返却adapterは別の結合点です。両BEを起動できることを、AI会話とDO/D1の保存まで結合済みという意味にはしません。元のローカルデモはソースとテストを保持し、一般利用者の音声入口には表示しません。

実APIの音声往復にはサーバー側のOpenAI設定と外部から到達できる認証付きMCP URLが必要です。黒電話の実機は別担当です。

詳細: [音声BE](integration/README.md) / [React接続](frontend/LIVE-INTEGRATION.md) / [案件API](docs/backend-api.md) / [Workers接続](docs/backend-integration.md)。
