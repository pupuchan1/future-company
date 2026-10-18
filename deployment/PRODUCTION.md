# 本番の起動と復帰

配備版と戻り先は[配備記録](../docs/demo-deployment.md)を使う。
Node、Worker、React assetsを同じ固定commitに揃える。
実行中の通話が終了したことを画面で確認してから再起動する。
`/health`と`/api/status`の成功だけでは通話終了を判断できない。

## 保持する設定

| 設定 | 本番の指定 |
| --- | --- |
| Worker | `https://future-company-demo.r74.workers.dev` |
| Node | `INTEGRATION_PORT=4350`、loopbackのみ |
| relay | `NODE_RELAY_PORT=4351`、loopbackのみ |
| 状態保存 | `INTEGRATION_STATE_DIR`に既存の`.local/production-runtime/state`の絶対パス |
| NodeからWorker | `WORKER_API_URL`、既存`STAFF_API_TOKEN`、Access service tokenの2値 |
| WorkerからNode | 実際の`NODE_RELAY_ORIGIN`とNodeに一致する`NODE_RELAY_SECRET` |
| Agentsと実機 | 同じNodeのrelayを指す`HUMAN_MCP_URL`と既存`HUMAN_MCP_TOKEN` |

NodeのAccess変数は`CF_ACCESS_CLIENT_ID`と`CF_ACCESS_CLIENT_SECRET`を使う。
`WORKER_ACCESS_CLIENT_ID`と`WORKER_ACCESS_CLIENT_SECRET`も実装が受け付ける。
`WORKER_API_ORIGIN`だけでは現行NodeのWorkerBridgeが起動しないため、`WORKER_API_URL`を指定する。
秘密値は既存の私有ファイルから読み、Issue、PR、CLI引数や`VITE_*`へ貼らない。
既存D1、CaseRoomと本人限定Access、`preview_urls=false`を維持する。

## 配備ホストの現在の起動方法

2026-10-18に確認したホストではlaunchdの`dev.r74.future-company.production`がNodeとQuick Tunnelを起動する。
ホスト固有の起動定義と秘密設定はGit管理外なので、この節は同じMacでの復帰用。
別のホストから再現する場合は次節を使う。

```sh
REPO=/Users/r74/dev/github/future-company
MEMORY="$REPO/.local/memory/261018_future-company-design"
launchctl print "gui/$(id -u)/dev.r74.future-company.production"
curl --fail http://127.0.0.1:4351/health
```

通話終了後、次で停止と起動を行う。

```sh
launchctl bootout "gui/$(id -u)/dev.r74.future-company.production"
launchctl bootstrap "gui/$(id -u)" "$MEMORY/tmp/production-runtime.plist"
```

この起動定義は`$MEMORY/tmp/production-runtime.mjs`を実行する。
16:36更新後のNodeソースは`$REPO/.local/deploy-6176125`、復帰元は`$REPO/.local/worktrees/production-access`の319ffc1。状態保存先は`$REPO/.local/production-runtime/state`。
更新が並行するため、実際の起動ソースはruntimeの`checkout`と配備記録を開いて確認する。
OpenAI設定は元checkoutの`.env`、Nodeトークンは`/Users/r74/.codex/worktrees/issue19-voice-demo/future-company/.env.local`、Accessは`$REPO/.local/access/future-company-20261018/shared.env`を読む。
これらの私有ファイルの存在を確認し、内容を出力しない。

起動後にruntimeが生成する`state.json`と`deployment/wrangler.local.jsonc`のoriginを照合する。
`sourceCommit`欄は16:36に6176125へ更新された。配備版はWorker versionとソースを照合し、Git checkoutであれば`git rev-parse HEAD`も使う。
標準出力は`$MEMORY/tmp/production-runtime.log`、標準エラーは`$MEMORY/tmp/production-runtime-error.log`。
トンネル起動でoriginが変わった後は、必ず次のWorker更新まで行う。

## リポジトリからの再現起動

Node24と依存、配備記録にある固定commitを用意する。
起動する`node --version`が24系であることを確認する。配備ホストではnode@24というパスが実際にはv25.8.1を返したため、ディレクトリ名だけで版を判定しない。
`deployment/env.example`を項目一覧として、既存の秘密値を安全な受渡しで私有envファイルに設定する。
そのファイルには上の表のポート、絶対stateDir、Worker URL、OpenAIとMCP、relayと社員のトークン、Accessの2値を含める。
既存のstateDirを空の新規ディレクトリへ置き換えない。

先に別ターミナルでrelay用のトンネルを起動する。

```sh
cloudflared tunnel --url http://127.0.0.1:4351 --no-autoupdate
```

表示されたoriginを私有envの`HUMAN_MCP_URL=<origin>/mcp`へ反映し、同じoriginをWorker設定にも使う。
Node側はリポジトリルートで起動する。
`PRIVATE_ENV`は既存の秘密設定を受け渡した絶対パスに置き換える。

```sh
npm ci
PRIVATE_ENV=/absolute/path/to/private-production.env
node --env-file="$PRIVATE_ENV" deployment/start.mjs
```

現在のlaunchdと同時に起動しない。
既定の4330/4340で起動した検証Nodeと本番Nodeの機器一覧は共有されない。

## Workerの接続先更新

`deployment/wrangler.production.jsonc`を元にGit管理外の`deployment/wrangler.local.jsonc`を用意する。
`vars.NODE_RELAY_ORIGIN`へ今回のトンネルoriginを設定し、既存のD1 ID、CaseRoom、Accessとsecretを保持する。
イベント転送は既定のWebSocketを使う。
[Quick TunnelはSSEに対応しない](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)ため、`NODE_RELAY_EVENTS_TRANSPORT=sse`へ変更しない。

```sh
npm run build:frontend
node_modules/.bin/wrangler whoami
node_modules/.bin/wrangler deploy --dry-run --keep-vars --config deployment/wrangler.local.jsonc
node_modules/.bin/wrangler deploy --keep-vars --config deployment/wrangler.local.jsonc
node_modules/.bin/wrangler deployments list --config deployment/wrangler.local.jsonc --json
```

既存secretを変更しない通常の再配備では`--keep-vars`を使う。
ホストの初回配備で使った`--secrets-file`は私有ファイルを参照する場合だけに限定し、ファイル内容を公開しない。
トンネルorigin更新時はNodeの`HUMAN_MCP_URL`、Workerのorigin、実機の`wss://<host>/bridge`を一組で更新する。

## 復帰と確認

戻り先は配備記録の`319ffc1`とWorker version。
通話を終了し、保持したソースを使う別checkoutへNodeの起動先を戻す。
既存stateDirと秘密設定を引き継ぎ、Nodeとトンネルを起動し、現在のoriginを設定した同じソースからWorkerを再配備する。
旧originが生存している場合に限り、Worker versionへのrollbackも候補になる。
version指定のrollbackは[Wrangler公式手順](https://developers.cloudflare.com/workers/wrangler/commands/)を確認して行う。
この文書では復帰操作自体の成功を記録していない。

1. 未認証の入口がAccessへリダイレクトされ、認証後の会社APIがJSONを返すことを確認する。
2. 新規caseの作成、所有者のbridge-token、case別voice/statusとeventsを確認する。
3. 所有者cookieなし401と異Origin403を確認する。
4. 同じcaseで実Live、Workerの人間回答保存、元Agentへの1回の返却、音声と正常終了を確認する。
5. 実機は本番Nodeの一覧で`online=true`と`simulated=false`を確認してから、新しい依頼で試す。

取消、切断、再接続、SSE再購読と交代中の回答は[#32](https://github.com/pupuchan1/future-company/issues/32)と[#35](https://github.com/pupuchan1/future-company/issues/35)の受入として別に記録する。
実ベルと実人間回答は[#34](https://github.com/pupuchan1/future-company/issues/34)で確認し、模擬電話の成功で置き換えない。
