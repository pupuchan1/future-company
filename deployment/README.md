# Worker と Node 音声の配置

既存の Worker に React・DO・D1 を残し、Node 24 の音声・人間MCPを常駐プロセスで動かす。`server.mjs` の localhost guard はそのまま使う。Worker 側の既存 Access 本人限定設定と社員認証も変更しない。

```text
Browser -- existing visitor cookie --> Worker /api/v1/cases/:caseId/voice/*
        <-- SSE / WebRTC setup -----   | authorizeVisitorCase on every request
                                      | signed request / WebSocket backhaul
                                      v
                                Node relay :4330
                                      | fixed loopback destination
                                      v
                                integration :4340
Agents API -- MCP Bearer --> relay /mcp       --> same integration gateway
Black phone -- Bearer WSS --> relay /bridge   --> same integration gateway
```

## 公開APIの契約

`/api/v1/cases/{caseId}/voice` をクライアントのbase pathにする。既存 visitor cookie は `Path=/api/v1` なので、各リクエストにそのまま届く。case ID は Worker が作成したものを使う。

| 公開path（base path以降） | method | Nodeへの転送先 |
| --- | --- | --- |
| `/status` | GET | `/api/status`。requestsは当該caseのみ、devicesもその依頼で使用中の機器だけ |
| `/events` | GET | 当該caseのSSE。case不明・別case・矛盾するcase情報は配送しない |
| `/results` | POST | `/api/worker/results`。明示的な結果再同期の受付 |
| `/session` | POST | `/api/live/session` |
| `/session/{id}/handoff` | POST | `/api/live/session/{id}/handoff` |
| `/session/{id}/activate` | POST | `/api/live/session/{id}/activate` |
| `/session/{id}` | DELETE | `/api/live/session/{id}` |

POST/DELETE は同一originを要求する。Worker が `authorizeVisitorCase` で毎回cookie所有者を検証し、case ID・method・path・body hash・時刻・nonceをHMAC署名する。署名は30秒有効。同じnonceの再送は409、新しいHTTP要求は新しいnonceになる。自動的なPOST再試行は追加していない。秘密は `NODE_RELAY_SECRET` として Worker/Node のサーバー側だけに置く。

JSONの既存フィールドは維持し、`case_id` をURLのcaseへ固定する。別caseの指定は拒否する。#19 の `bridge_token`・`case_proof` 等も保持する。フロントは既存の `POST /api/v1/cases/{caseId}/bridge-token` で受けた `bridgeToken`（有効期間900秒）を音声 `/session` のbodyへ `bridge_token` として加える。relay は成功応答から Live ID→case を記録し、handoff/activate/終了の対象を照合する。relay 再起動後の未知IDは404で拒否する。稼働中の音声を継続したままrelayだけ再起動しない。

通常のWorker結果返却は #19 のWebSocket通知で受ける。利用者による明示的な再同期だけ `/results` へ `{bridge_token}` をPOSTする。Worker proxyがcaseを固定し、Nodeへ `{case_id, bridge_token}` を送る。`202` は再同期の受付であり、結果の保存・配送完了を意味しない。定期pollは追加していない。

SSEは最大60秒で閉じ、EventSourceの再接続時に再認可する。既定では **Worker–relay間をWebSocket、Worker–ブラウザ間をSSE** にする。これにより、SSE非対応のQuick TunnelでもWebSocket部分を通せる。SSEのイベント履歴再送は未実装で、再接続の間の表示はstatus再取得で補う。公開先でWebSocket upgradeが通ることは別途検証する。

`NODE_RELAY_EVENTS_TRANSPORT=sse` を Worker に設定すると、SSE対応のnamed tunnel/ホストでHTTPストリームを直接転送できる。[Quick Tunnel はSSE非対応](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)なので、この設定では使わない。

## Nodeの起動

リポジトリルートで依存を用意し、既存の秘密設定を保持して必要なenvだけ追加する。`deployment/env.example` は項目一覧であり、本物の値を含まない。

```sh
npm ci
INTEGRATION_PORT=4340 NODE_RELAY_PORT=4330 node --env-file=.env.local deployment/start.mjs
```

`NODE_RELAY_SECRET` と `HUMAN_MCP_TOKEN` はそれぞれ独立したランダムな32–200文字のURL-safe値。`OPENAI_API_KEY`、#19で必要な `STAFF_API_TOKEN` などは既存のサーバー専用設定を使う。`.env.local` は私有ファイルにし、値をCLI引数・ログ・ビルド成果物へ出さない。

起動スクリプトの既定は4340と4330で、**127.0.0.1だけ** で待ち受ける。既存の4320での実機試験と別に起動できる。使用中のportで失敗しても既存プロセスを停止しない。`INTEGRATION_STATE_DIR` は永続・私有領域を指定する。MCP Eventsの購読/outboxとprovider resource IDを保持するが、会話のメモリ状態を再起動から復元するものではない。

既存の許可済みトンネルを `http://127.0.0.1:4330` に向ける。4340を直接公開しない。恒久hostが未確定の場合は同じrelayをハッカソン中のMacと一時トンネルで使用できるが、PC・プロセス・トンネル停止で接続も止まる。トンネルにブラウザ専用のメール認証を重ねると、Worker/Agents/実機からの接続は通らない。公開フロントのAccess設定とは分離し、relayのHMAC/Bearerを維持する。

relayの公開pathは `/relay/voice/*`（HMAC）、`/mcp`（Bearer）、`/bridge`（Bearer WebSocket）、`/health`（プロセス生存のみ）。`/`、旧 `/api/*`、任意upstream URLは公開しない。`/health` はprovider接続成功や実機接続の証拠ではない。

## Workerの配置

`deployment/worker-entry.ts` は既存appとCaseRoomを取り込み、case付きvoice pathだけproxyへ流し、画面はStatic Assetsから配信する。既存server/apiの直接変更は不要。フロントには上記base pathを適用してから配信する。

```sh
npm run build:frontend
cp deployment/wrangler.example.jsonc deployment/wrangler.local.jsonc
```

`wrangler.local.jsonc` はignored。**既存の正規アカウント・Worker名・D1 ID** に合わせ、`NODE_RELAY_ORIGIN` に許可済みHTTPS relay originを設定する。既存本番repoが確定したら、確認済みcommitをそちらへ移す。exampleにはアカウントの実値を含めていない。

配置担当者は既存認証で `NODE_RELAY_SECRET` をsecretとして設定する。既存の `STAFF_API_TOKEN` と #19 の設定を維持し、Access本人限定・preview無効のまま、同じconfigでdry-runと配置を行う。手元で未認証の場合はアカウント所有者に依頼する。新しい公開範囲を作る手順ではない。

```sh
npx wrangler secret put NODE_RELAY_SECRET --config deployment/wrangler.local.jsonc
npx wrangler deploy --dry-run --config deployment/wrangler.local.jsonc
npx wrangler deploy --config deployment/wrangler.local.jsonc
```

`HUMAN_MCP_URL` は Node relay の `/mcp` を指定する。ブラウザ専用Accessログインが必要なWorkerの `/mcp` と取り違えない。MCP v2の `MCP-Protocol-Version`・`MCP-Method`・`MCP-Name`・`Mcp-Param-*` と従来のsession/resume headersを転送し、実SDKがbodyとの一致を検証する。このrelayが任意pathを包括転送することはない。

## 検証

```sh
node --test deployment/proxy.test.mjs
mkdir -p deployment/.work
npx wrangler types deployment/.work/worker-configuration.d.ts --env-interface CloudflareBindings
npx tsc --noEmit -p deployment/tsconfig.json
npx esbuild deployment/worker-entry.ts --bundle --platform=browser --format=esm '--external:cloudflare:*' --outfile=deployment/.work/worker.js
```

テストはfake providerを使ったローカルHTTP/WebSocket試験。cookie認可呼出し、body/proof保持、別case拒否、SSE/status隔離、HMAC改変・期限・再送拒否、handoff後の所有権、再起動時拒否、結果再同期の202保持、実MCP SDKのdiscovery/tool call、MCP header透過、実WebSocketを確認する。実CloudflareのAccess、OpenAI音声、#19結果アダプター、黒電話実機、実ChatGPT MCP Events購読はこのテストの成功だけでは確認済みにならない。
