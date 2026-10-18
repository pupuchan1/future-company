# Worker と Node 音声の配置

最新の一般公開入口は **Codex Sites**。pupuのビルド済み画面を `sites/export-site.mjs` で登録済みSitesのVinext checkoutへ反映する。`sites/proxy.mjs` はvisitor APIだけを既存Workerへ中継する。Sites側に `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` をsecretで設定し、全員が音声会話できるpublic audienceで公開する。これは既存Worker・Node・Slack認証の設定を置き換えない。r74techは下記の既存backend配置を担当する。

既存の Worker に React・DO・D1 を残し、Node 24 の音声・人間MCPを常駐プロセスで動かす。`server.mjs` の localhost guard はそのまま使う。Worker 側の既存 Access 本人限定設定と社員認証も変更しない。

```text
Browser -- existing visitor cookie --> Worker /api/v1/cases/:caseId/voice/*
        <-- SSE / WebRTC setup -----   | authorizeVisitorCase on every request
                                      | signed request / WebSocket backhaul
                                      v
                                Node relay :4351
                                      | fixed loopback destination
                                      v
                                integration :4350
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
| `/session/{id}/language` | POST | `/api/live/session/{id}/language`。同じcaseの言語選択を更新 |
| `/session/{id}` | DELETE | `/api/live/session/{id}` |

POST/DELETE は同一originを要求する。Worker が `authorizeVisitorCase` で毎回cookie所有者を検証し、case ID・method・path・body hash・時刻・nonceをHMAC署名する。署名は30秒有効。同じnonceの再送は409、新しいHTTP要求は新しいnonceになる。自動的なPOST再試行は追加していない。秘密は `NODE_RELAY_SECRET` として Worker/Node のサーバー側だけに置く。

JSONの既存フィールドは維持し、`case_id` をURLのcaseへ固定する。別caseの指定は拒否する。#19 の `bridge_token`・`case_proof` 等も保持する。フロントは既存の `POST /api/v1/cases/{caseId}/bridge-token` で受けた `bridgeToken`（有効期間900秒）を音声 `/session` のbodyへ `bridge_token` として加える。relay は成功応答から Live ID→case を記録し、handoff/activate/言語変更/終了の対象を照合する。relay 再起動後の未知IDは404で拒否する。稼働中の音声を継続したままrelayだけ再起動しない。

通常のWorker結果返却は #19 のWebSocket通知で受ける。利用者による明示的な再同期だけ `/results` へ `{bridge_token}` をPOSTする。Worker proxyがcaseを固定し、Nodeへ `{case_id, bridge_token}` を送る。`202` は再同期の受付であり、結果の保存・配送完了を意味しない。定期pollは追加していない。

SSEは最大60秒で閉じ、EventSourceの再接続時に再認可する。既定では **Worker–relay間をWebSocket、Worker–ブラウザ間をSSE** にする。これにより、SSE非対応のQuick TunnelでもWebSocket部分を通せる。SSEのイベント履歴再送は未実装で、再接続の間の表示はstatus再取得で補う。公開先でWebSocket upgradeが通ることは別途検証する。

`NODE_RELAY_EVENTS_TRANSPORT=sse` を Worker に設定すると、SSE対応のnamed tunnel/ホストでHTTPストリームを直接転送できる。[Quick Tunnel はSSE非対応](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)なので、この設定では使わない。

## Nodeの起動

リポジトリルートで依存を用意し、既存の秘密設定を保持して必要なenvだけ追加する。`deployment/env.example` は項目一覧であり、本物の値を含まない。

```sh
npm ci
INTEGRATION_PORT=4350 NODE_RELAY_PORT=4351 node --env-file=.env.local deployment/start.mjs
```

`NODE_RELAY_SECRET` と `HUMAN_MCP_TOKEN` はそれぞれ独立したランダムな32–200文字のURL-safe値。`OPENAI_API_KEY`、#19で必要な `STAFF_API_TOKEN` などは既存のサーバー専用設定を使う。`.env.local` は私有ファイルにし、値をCLI引数・ログ・ビルド成果物へ出さない。

起動スクリプトの既定値とは別に、現在の本番はNode 4350 / relay 4351を明示し、**127.0.0.1だけ** で待ち受ける。使用中のportで失敗しても既存プロセスを停止しない。`INTEGRATION_STATE_DIR` は永続・私有領域を指定する。MCP Eventsの購読/outboxとprovider resource IDを保持するが、会話のメモリ状態を再起動から復元するものではない。

既存の許可済みトンネルを `http://127.0.0.1:4351` に向ける。4350を直接公開しない。恒久hostが未確定の場合は同じrelayをハッカソン中のMacと一時トンネルで使用できるが、PC・プロセス・トンネル停止で接続も止まる。トンネルにブラウザ専用のメール認証を重ねると、Worker/Agents/実機からの接続は通らない。公開フロントのAccess設定とは分離し、relayのHMAC/Bearerを維持する。

relayの公開pathは `/relay/voice/*`（HMAC）、`/mcp`（Bearer）、`/bridge`（Bearer WebSocket）、`/health`（プロセス生存のみ）。`/`、旧 `/api/*`、任意upstream URLは公開しない。`/health` はprovider接続成功や実機接続の証拠ではない。

## Workerの配置

### 音声NodeのCloudflare Containers配置

`deployment/cloud/wrangler.jsonc`は同じR74アカウントの`future-company-voice-node`へNode24を配置する。`production`という固定コンテナへ全案件を送り、既存relayのHMAC署名とMCP/bridgeのBearer認証を維持する。Node内部APIはloopbackのみ、認証付きrelayだけをコンテナの4351番ポートへ公開する。Dockerイメージへ秘密設定をコピーしない。

```sh
npx wrangler deploy --config deployment/cloud/wrangler.jsonc
npx wrangler secret bulk /private/path/cloud-node-secrets.json --config deployment/cloud/wrangler.jsonc
```

secretファイルには既存の`OPENAI_API_KEY`、`STAFF_API_TOKEN`、`NODE_RELAY_SECRET`、`HUMAN_MCP_TOKEN`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`、`SLACK_BOT_TOKEN`をサーバー専用で渡す。返信取得用の`SLACK_USER_TOKEN`がある場合だけ追加する。ファイルはGit管理外の0700ディレクトリへ0600で置く。

クラウドの`/health`と署名付きstatus、所有者のvoice/statusで`prewarm_configured`・Slack設定を確認した後、既存Workerの`NODE_RELAY_ORIGIN`を`https://future-company-voice-node.r74.workers.dev`へ変更する。Mac版は切替確認後に停止する。既存D1・CaseRoom・Access・サーバーsecretは維持する。

30分の無通信でコンテナは停止し、次の要求で起動する。再起動時は進行中の通話・Slack thread対応・ローカルMCP Eventsの状態を復元しない。案件の正本は既存D1に保存する。稼働中の通話を保ったままコンテナの版を切り替えない。

### 採用のSlack通知・人間回答

r74techがNodeの私有環境に `SLACK_CHANNEL_ID=C0CA6A7F4E5` と `SLACK_BOT_TOKEN` を設定する。内部用Appに `chat:write`・`channels:history` を許可し、#aiに参加させる。取得した値をWorkerの公開変数やブラウザーへ渡さない。[設定と返信形式](../integration/human/SLACK.md)を参照。採用の人間確認はこのSlack経路を使う。

Node・relay・Workerを同じ確定commitにそろえ、通話終了後に既存構成で再起動する。case別 `voice/status` の `recruiting_human_transport=slack`、`slack_configured=true`、`slack_replies_configured=true` は設定項目の存在を示す。実認証の成功は、採用通知とそのthreadへの `回答: …` が元の音声会話へ戻ったことで確認する。

### 現在の本番へ配置する場合

`deployment/wrangler.production.jsonc` は既存の `future-company-demo.r74.workers.dev`、R74アカウント、D1、CaseRoomを指定している。配置担当はr74tech。既存アカウント・配置権限を使う。今回、新たな招待承諾やログイン、秘密のrotationは必須にしない。担当と本番受入条件は [Issue #94](https://github.com/pupuchan1/future-company/issues/94) を正本とする。

```sh
npx wrangler whoami
npm ci
npm run build:frontend
npx wrangler deploy --dry-run --keep-vars --config deployment/wrangler.production.jsonc
npx wrangler deploy --keep-vars --config deployment/wrangler.production.jsonc
```

この既存CaseRoomはcf CLIの宣言方式で作成されているため、configには `exports.CaseRoom` を使う。`migrations` と併記しない。`migrations` だけでは `provisioned_class_missing_from_config` で配置に失敗した。[公式のclass exports仕様](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)も参照。

音声接続では、NodeとWorkerに設定済みの `NODE_RELAY_SECRET` と `STAFF_API_TOKEN` の一致を維持する。以下のsecret設定コマンドは欠落・不一致を確認した場合だけ使う。値を確認し直すときは、既存のNode設定を使い、コード・Slack返信・CLI引数へ貼らない。Wranglerの入力プロンプトまたは私有ファイルのstdinから渡す。

```sh
npx wrangler secret put NODE_RELAY_SECRET --config deployment/wrangler.production.jsonc
npx wrangler secret put STAFF_API_TOKEN --config deployment/wrangler.production.jsonc
```

`--keep-vars` は既存変数を保持する。relayのトンネルを変更する場合は、configの `NODE_RELAY_ORIGIN` と実際のWorker変数を一致させる。現在のrelay/MCPは `https://jamie-journey-redhead-smart.trycloudflare.com` / 同originの `/mcp` を使い、Node 4350 / relay 4351へ対応させる。トンネル・stateDir・既存secretは維持する。共有AccessはNodeサーバーの `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` に設定し、`WORKER_API_URL=https://future-company-demo.r74.workers.dev` を明示する。現在の `integration/server.mjs` は `WORKER_API_URL` でWorkerBridgeの起動を判定するため、`WORKER_API_ORIGIN` だけでは起動しない。ブラウザのビルド変数へ秘密値を入れない。

配置後はAccess認証付きの `haas` 案件作成201、同じvisitor cookieによる `bridge-token` 200、case別 `voice/status` 200を順に確認する。`voice_relay_unconfigured` はWorkerのrelay設定不足、status 200は接続口の確認まで。Live開始・保存済み人間回答の返却・音声出力は別に通し確認する。既存Accessポリシーとpreview無効を維持する。

### 他の承認済み配置先へ移す場合

本番Workerへのサーバー間接続は、`WORKER_API_URL`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET` を私有の `.env.local` に保存する。NodeのWorkerBridgeはHTTPとWebSocketの両方にAccessの2ヘッダーを付ける。Access通過後も案件cookie・`bridge_token`・`STAFF_API_TOKEN` のアプリ認可は必要。Accessの値はWranglerの配置権限ではない。切替時には実際の `WORKER_API_URL` が意図した接続先かを確認する。

公開gatewayも同じ2ヘッダーで固定本番Workerへ接続できる。`DEMO_GATEWAY_WORKER_ORIGIN=https://future-company-demo.r74.workers.dev` を指定し、同じ私有envを読み込む。許可した固定originだけへ送信し、ブラウザへAccess値を渡さない。本番の `haas` 案件、案件証明、voice/status、社員認証が揃ってから接続先を切り替える。稼働中のローカルWorkerを使うデモは、それまでは維持する。

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
