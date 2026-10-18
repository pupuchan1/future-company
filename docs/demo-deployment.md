# 本人限定本番の配備記録

入口はhttps://future-company-demo.r74.workers.dev/。
起動、接続先更新と復帰は[本番運用手順](../deployment/PRODUCTION.md)を参照する。
下表は2026-10-18に確認した配備であり、最新のPR HEADを配備済みとみなさない。

| 項目 | 確認した値 |
| --- | --- |
| ソース | `feature/production-access`の`319ffc17ddecea0d3b9ff3a0a98efa65af42f818`、[#101](https://github.com/pupuchan1/future-company/pull/101)で共有 |
| 統合元 | #39の`7439949`を基点に既存の本番設定を統合 |
| Worker version | `c27057a9-c69b-4d7e-9ba6-dcb69cc383b9`、100%配信 |
| 配備時刻 | 2026-10-18 16:06 JST |
| 本番Nodeとrelay | 配備ホストのloopback4350と4351 |
| relay origin | `https://jamie-journey-redhead-smart.trycloudflare.com` |
| MCPと実機bridge | 上記originの`/mcp`と`/bridge`。実機はWSSとBearer認証 |
| 状態保存先 | 配備ホストの`.local/production-runtime/state` |
| 戻り先 | 上記319ffc1とWorker version。トンネル再起動後は現在のoriginで同じソースから再配備 |

配信versionと割合は今回`wrangler deployments list --config deployment/wrangler.local.jsonc --json`でも確認した。
Quick TunnelのURLは再起動で変わるため、利用前にホストの`.local/production-runtime/state.json`と実際のWorker設定を照合する。
同ファイルの`sourceCommit`は`26020e5`のままだったため、配備版の判定には使わない。
gitのHEAD、Worker versionと配備ログで確認する。

## 本番で記録された結果と受入待ち

16:13頃までの[一次記録](https://github.com/pupuchan1/future-company/issues/33#issuecomment-6247048799)では、実LiveとAgents、公開MCP、合成マイク、模擬電話で次を確認した。

- 同じHaaS caseでWorkerに人間回答を保存し、元HaaS AgentからLiveの英語音声と字幕へ返却した。
- caseは`case-c7ca555ff08dd0387dbd50c6932e253617ad501258f0156c7ffd090cbbe4ddc3`、requestは`request-handoff-d4abe369-2686-40a5-85a5-5bcc54a40eda`。D1はrevision5、answered、delivery=`live_submitted`、`simulated=true`。
- 同一commandでの社員回答再送、案件証明、case限定statusとSSE、所有者なし401、異Origin403、未認証Access302を確認した。
- 終了は200、`live_finalized=true`、`cleanup_pending=[]`だった。

この結果は実機のベル、実人間回答、実マイクによる聞こえ方の成功を含まない。
今回確認した本番Node4350の`GET /api/status`は`devices=[]`だった。
初回試験の`voice/status`530は原因未特定のままであり、恒久解消とは記録しない。
この配備版には後続の自動声交代、全文字幕とMP3、新版会話画面を含めていない。

| Issue | 残る受入 |
| --- | --- |
| [#35](https://github.com/pupuchan1/future-company/issues/35) | 最新本番での自動声交代、交代中の回答、HaaSから採用への交代、候補接続失敗時の旧会話維持 |
| [#32](https://github.com/pupuchan1/future-company/issues/32) | 最新本番での取消、切断、再接続、SSE再購読、回答再送と遅着時の別case隔離、二重依頼と重複発話の確認 |
| [#34](https://github.com/pupuchan1/future-company/issues/34) | 同じ本番Nodeの実機接続後、新しい依頼で実ベル、受諾、実人間回答保存と音声返却 |

530が再発した場合は時刻、case、path、HTTP status、CF-Ray、Workerログ、Nodeログとトンネルの生存を同じ試験記録へ残す。
過去のoffline依頼へ回答を追記して実機成功へ変更しない。

## 旧React試験デプロイの記録

以下は`2732ac45-f00d-4c84-9895-cd165aef3f25`の旧試験配信手順と結果。
そのlocalStorageデモの画面確認と、上記の実LiveからWorker保存までの確認は別の結果として扱う。

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
