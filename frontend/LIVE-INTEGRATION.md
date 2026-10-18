# 会話画面とBEの接続

関連: [対応開始 #83](https://github.com/pupuchan1/future-company/issues/83) / [接続契約・引継ぎ #88](https://github.com/pupuchan1/future-company/issues/88) / [BE統合 PR #39](https://github.com/pupuchan1/future-company/pull/39)

## 接続経路

1. ホームの開始操作で `WorkerCaseClient` が `POST /api/v1/cases` を呼びます。同じvisitor cookieで案件を確認し、`POST /api/v1/cases/:id/bridge-token` から短期の所有者証明を取得します。
2. 案件作成後に `LiveClient` が同一originの `/api/v1/cases/:id/voice/status` と `/events` を購読します。確認前にマイクを開きません。
3. 設定が確認できたらマイクとWebRTCを準備し、`POST .../voice/session` にSDP・案件ID・短期証明を送ります。Workerが所有者を認可し、署名付きrelayを通してNodeへ渡します。サーバー専用キーはブラウザへ渡しません。
4. `session.started` で `/conversation` へ移動します。`LiveSnapshot.transcripts` を右側の会話履歴へ表示し、SSEとDataChannelの同じevent IDは重複させません。左側のオーブは音声計測を使います。
5. 言語変更・担当切替・終了も同じ案件のvoice APIを使います。画面移動では接続を作り直さず、終了後も現在のタブに履歴を残します。

開始前の認証・案件証明・status失敗は画面に表示し、準備中の表示を解除します。設定が復旧したら「接続を再確認」後に再度開始できます。未作成の案件でグローバルな `/api/events` を購読しません。

## ローカル設定と起動

ルートの `.env.example` と `.dev.vars.example` を参照し、既存の私有設定に不足分を追加します。秘密値をGitへ登録しないでください。

- Node `.env.local`: `OPENAI_API_KEY`、`HUMAN_MCP_URL`、`HUMAN_MCP_TOKEN`、`WORKER_API_URL=http://127.0.0.1:8787`、`STAFF_API_TOKEN`、`NODE_RELAY_SECRET`。
- Worker `.dev.vars`: Nodeと同じ `STAFF_API_TOKEN` と `NODE_RELAY_SECRET`、`NODE_RELAY_ORIGIN=http://127.0.0.1:4330`、`NODE_RELAY_EVENTS_TRANSPORT=sse`。
- MCP URLはAgentsが到達できる既存の認証付きHTTPS `/mcp` を使います。

```sh
npm run db:migrate:local
npm run dev
```

Node 4320、relay 4330、Worker 8787、FE 5173。`NODE_RELAY_SECRET` がある場合、起動スクリプトがNodeと認可relayを一緒に起動します。設定なしでも画面は起動しますが音声は開通しません。別画面用の5197も同じWorkerへ接続するFEプレビューです。既に他の作業が各ポートを使っている場合は、その作業者と起動元を揃えてください。

`src/index.tsx` は既存の案件認可proxyを登録します。開発ビルドのみloopback HTTP relayを許可し、本番ビルドはHTTPS relayを要求します。公開配置の既存設定は [deployment/README.md](../deployment/README.md) を参照してください。

## 確認

```sh
npm run test:conversation-backend
npm run test:frontend
node --test deployment/proxy.test.mjs
npm run typecheck
npm run build
```

結合テストは実Worker/DO/D1、案件cookie・証明、署名付きrelay、Node HTTP/SSE、本物のフロント接続クライアントを通します。外部モデルとマイク/WebRTC機器、案件の人間回答WebSocketは代替します。開始・話者別履歴・重複除外・言語更新・他案件拒否・終了後の履歴保持を確認します。実モデルの音声、実機、人間回答の成功とは区別します。

## 実環境で残る確認

このPCの稼働BEは音声・MCP・Worker連携が未設定です。PR #39の16:06の記録では既存公開Workerが `voice_relay_unconfigured` と社員認証401で、現在の稼働状態は別途確認が必要です。担当者への不足設定と確認項目は #88 に記録しています。会話内容はタブ内メモリで、リロード後の復元は含みません。
