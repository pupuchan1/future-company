# Cloudflareバックエンドの接続とローカル起動

完了基準は、採用面談と社員回答が同じDO案件へ保存され、D1一覧に最新revisionで反映されること。音声側の完成条件は、応募者の開発環境の質問を人間へ照会し、回答本文を元の採用AIが応募者の言語で説明すること。

2026-10-18にローカルの実コード、[Issue #3](https://github.com/pupuchan1/future-company/issues/3)、[PR #4](https://github.com/pupuchan1/future-company/pull/4)、[Issue #8](https://github.com/pupuchan1/future-company/issues/8)、Slackのgeneralの14:24投稿を確認した。Cloudflare側の保存とHTTP接続は実装済み。音声・Agents・電話を含む完成条件は未達である。

## 保存の契約

```ts
import { persistCase } from './backend/persistence'
import type { BackendEnv } from './backend/case-room'
import type { CaseSnapshot, IntegrationView } from './backend/contracts'

// 公開する保存関数の型
type PersistCase = (
  env: Pick<BackendEnv, 'DB'>,
  snapshot: CaseSnapshot,
  integration?: IntegrationView,
) => Promise<void>
```

既存の`projectCase(env, caseId, actor)`がowner認可を通してDOの最新`getIntegration(actor)`を読み、snapshotとintegrationを`persistCase`へ渡す。HTTP更新はDOの命令を確定してからD1へ保存する。再送時も、命令の過去の戻り値ではなくDOの最新状態をD1へ投影する。

| 対象 | 正本・保存先 | 維持する性質 |
| --- | --- | --- |
| 面談、社員依頼、回答 | DOの案件JSON | owner認可、命令IDの重複排除、revision競合検出 |
| 社員一覧 | D1の`cases.summary` | `excluded.revision > cases.revision`のときだけ更新 |
| provider sessionとの対応 | `summary.integration` | 同じrevisionガードで保存し、旧sessionの遅着で上書きしない |
| 注文交換の業務記録 | 既存`replacements` | 既存の注文・案件の一意制約を維持 |

`cases`には既に`id / created_at / updated_at / revision / summary TEXT`がある。面談と回答はJSONで保持できるため、追加migrationは不要と判断した。既存migrationは変更していない。

要約には案件ID・種別・言語・状態・revision・時刻、`recruitment`、`requests`、`ai`、任意のintegrationを保存する。面談の`source: visitor_self_report`を維持する。回答本文・回答時刻は`requests[].answer / answeredAt`に残り、Issue #8の結果本文・言語・模擬区分は`requests[].result / simulated`を保持する。`assignedTo`、ownerHash、integration操作のfingerprint・SDP・内部イベント履歴は保存しない。一覧は社員認証を通して返す。詳細と更新前の最新状態はDOの個別GETで取得する。

遅いrevisionと同一revisionの保存は成功扱いの無変更となる。D1の失敗は503 `projection_failed`を返す。DOの確定済み更新は残るので、呼出元は同じ`commandId`・本文・`expectedRevision`で再送する。DOが重複操作を増やさず、APIが最新状態をD1へ再保存する。保存関数にはタイマー・polling・自動retryを設けていない。

## Worker入口

`src/index.tsx`は次を登録する。

- `/api/v1`に案件API。`authorizeDemoStaff`を注入する。
- 同じprefixに既存`createOpenAIApi`。来訪者のowner検証と`projectCase`を共有する。
- `/mcp`に既存MCPハンドラー。認証とcallback transportの注入が無いため401で閉じる。
- `/`は既存のHono雛形。React FEはこのcheckoutに統合されていない。

音声APIの登録は音声業務の実接続を意味しない。Liveはsidebandハンドラー未注入で503 `live_backend_unconfigured`。Agentsはキー・モデル・業務ツールのいずれかが未設定なら503となる。capabilitiesのvoice・agent・mcpEventsは`available: false`を維持する。回答後の`ai.resume_pending`は元Agentsや音声の再開成功ではない。

## ローカル起動

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev --host 127.0.0.1
```

起動時にViteが表示するURLを使用する。migrationは`0001_company.sql`と`0002_mcp_events.sql`を`.wrangler/state/v3/d1`のローカルDBへ適用する。DOのSQLiteテーブルはCaseRoomが作成する。`wrangler.jsonc`の`CASES`・`DB`と`CaseRoom`のSQLite migrationを使用し、Cloudflare account・remote database IDは設定していない。remoteリソースの作成やdeployは行わない。

社員操作には、gitignore対象の`.dev.vars`へサーバー専用の`STAFF_API_TOKEN`を手動設定してからdevを起動する。32〜200文字の英数字・`_`・`-`を使う。既存ファイルを上書きしない。この作業では秘密値を作成・保存していない。

`POST /api/v1/staff/session`にBearerでトークンを渡し、署名付きHttpOnly cookieを取得する。以後は同一originのcookieで社員APIとWebSocketを利用できる。固定の`demo-staff`として扱い、社員個人別の識別は行わない。未設定・形式不正は503、不正な認証情報は401。ログインAPIとFE契約の詳細は[backend-api.md](backend-api.md)を参照。

| 設定名 | 用途・現在の状態 |
| --- | --- |
| `CASES` | 案件DO binding |
| `DB` | D1 binding。ローカルmigration済み |
| `STAFF_API_TOKEN` | デモ社員の共有トークン。未設定時は社員操作を拒否 |
| `OPENAI_API_KEY` | 既存OpenAI adapterのサーバー専用キー。取得・保存・実API呼出し未実施 |
| `OPENAI_AGENTS_MODEL` | 既存Agents adapterが要求する明示的モデル名。未設定 |
| `OPENAI_LIVE_MODEL` | 既存Live adapterのモデル設定。sidebandは別担当の接続待ち |
| `OPENAI_WEBHOOK_SECRET` | 既存Agents webhookの署名検証用。未設定 |

`OPENAI_*`や`STAFF_API_TOKEN`を`VITE_*`・FEソース・URLへ入れない。OpenAIキーを設定するだけでは、Live sidebandと業務ツールは接続されない。

## FEと音声担当への受け渡し

GitHubのmainの`frontend/src/pages/HomePage.tsx`は案内だけのReact雛形で、`frontend/.env.example`の`VITE_API_BASE_URL=http://localhost:8000`は未使用の例だった。`frontend/vite.config.ts`にはAPI proxyがない。現在のCloudflare APIはcookieと同一originを前提とするため、FE担当は同一originの`/api/v1`へ接続し、開発時も同一origin経由のproxyを用意する必要がある。FEやVite設定は担当外のため変更していない。

PR #4の確認対象はcommit `aaa81910f4ae2f9c6f18865f3c97fb5bf04e5763`の`integration/server.mjs / backend.mjs / README.md`。Nodeプロトタイプの`/api/live/session`、`/api/events`のSSE、`case_id`・`language`は、DO側の`/api/v1/cases/:id/live`、案件WebSocket、`case.id`・`locale`と直接互換ではない。Node側のloopback制限と`HUMAN_MCP_TOKEN`は社員認証ではない。

Issue #8は依頼を`case_id / handoff_id / target_role / task / expected_result / language / idempotency_key`、結果を同じcaseとhandoffへ紐づく`result: {text, language}`とする提案である。`simulated`を結果へ引き継ぎ、回答なしの`completed`は回答未取得とする。Slackの完成条件に従い、状態だけから回答本文を作らない。

| 外部契約 | 現在のCloudflare側 | 接続時に必要な処理 |
| --- | --- | --- |
| `case_id` | `case.id` | DOで作ったIDを元の会話に保持。別のIDを作り直さない |
| `handoff_id` | `requests[].id` | 同じIDを使う。新規採用のrequest IDはcase IDも含む |
| `language` | `case.locale` | 応募者への説明言語。回答本文の言語とは分ける |
| `result.text` | `requests[].result.text`と`answer` | 人間の実際の回答本文を保存し、元Agentsへデータとして渡す |
| `result.language`・`simulated` | `requests[].result.language`・`simulated` | DOとD1で保持する。API担当が明示入力を検証して渡し、文字列から推測しない |
| 依頼の役割・作業・期待する結果 | `summary / question / facts` | HaaS担当と項目の対応を確定 |
| 回答到着・会話再開 | `ready / ai.resume_pending` | 別担当が同じAgent sessionへ結果を1回渡し、応募者の言語で説明する |

音声・Agents・MCP・HaaSの内部は重複実装していない。Cloudflare側では回答本文の保存と再開待ち状態までを確認した。DOのanswer命令は`answerLanguage`と`simulated`の両方が明示されたときだけ結果メタデータを保存し、従来のanswerだけなら言語や模擬区分を補わない。担当1の既存answer APIは`result: {text, language}`と`simulated`を受け取り、DOへそれぞれ`answer`・`answerLanguage`・`simulated`を渡す。模擬回答の実Worker入口からD1までの保存を確認済み。Node側から認可済みDO命令へ渡すadapter、元AgentsとLiveの再開は他担当との接続待ち。追加の状態機構やテーブルは作っていない。

## 検証

```sh
bun run typecheck
bun run test
bun run build
```

`typecheck`はWranglerで型を生成してからTypeScriptを実行する。`test`は既存のNode・Miniflareのworkerd試験とBun試験に、保存処理と実Worker入口の試験を含める。lint・formatの専用scriptは現在のpackage.jsonに無い。

保存試験は面談・社員回答の保持、旧・同一revisionの上書き拒否、内部情報の非保存、D1障害後の同じsnapshotの再送を確認する。実Worker入口の試験は採用送信のDO確定後にD1保存を失敗させ、DOの情報が残り、同じ命令IDの再送でD1へ1件保存できることを確認する。社員cookieで引き受け・回答・一覧反映まで進め、Live・Agents・MCPの未接続を成功扱いしない。

試験中の社員トークンはメモリ内で生成し、保存やログ出力をしない。外部providerへのfetchはテストで遮断する。模擬の社員回答は接続試験データであり、実在する社員の回答・実AI再開・実機通話の証拠ではない。応募者の`locale: en`と人間の回答言語`ja`は別に保存し、回答を英語へ翻訳した事実は主張しない。

2026-10-18、最終ソース`d93780a`は親チャットの実行記録でtest全59件・build成功、追加修正担当の記録でtypecheck成功を確認。Nodeのworkerd試験31件、Bun試験28件。ローカルmigrationも適用済み。実Worker入口で、英語の応募者が開発環境を質問し、日本語の明示模擬回答を同じcase/requestへ保存し、D1一覧に本文・言語`ja`・`simulated: true`が残ることを確認した。`ai.resume_pending`までで、元AIの英語説明は未確認。

Viteも実起動してcompany取得、採用送信と再送、D1のrevision=1・依頼1件・本人申告区分を確認した。ローカルDBに`connection-test-task3`の模擬面談が残る。devサーバーは終了済み。API試験で一度ECONNRESETを観測したが、単体と最終全体試験は成功し、原因は未確定。実OpenAI、React画面からの操作、ChatGPT Workイベント、黒電話は未検証。試験デプロイの状況は次節に記載する。

## Access付き試験環境

2026-10-18、ユーザー承認のもと親チャットがR74 accountへ`cf deploy --prebuilt`で[試験デプロイ](https://future-company-demo.r74.workers.dev)を実施。既存Viteビルドを`.local/cf-demo`のBuild Outputへ変換して使用した。初回ソースは`250bab2`、Worker versionは`6392eed1-c66e-4b6a-8a05-10471640069b`。

最終ソースは`d93780a`、Worker versionは`355f3741-8bf9-492d-9b9d-649bdd2f708c`、deploymentは`81272ce7-db68-4ad4-9562-d9f18a698815`。親チャットが`cf workers deployments list`でsource=`cf_cli`・100%配信・annotation=`d93780a`を確認済み。URLとAccess制限は初回と同じ。

- D1は`future-company-demo`、IDは`5c48aef5-7f4a-4400-8822-a2ef79bf9eaa`。`0001_company.sql`と`0002_mcp_events.sql`の適用をremoteの`d1_migrations`で確認した。
- Access appは`16f3252e-f749-41f8-91d4-323c91bb7e0a`。対象ホスト全体の`self_hosted`で、本人メール1件だけをallowする。未認証`GET /api/v1/company`がHTTP302で`r74.cloudflareaccess.com`へ転送されることを確認した。
- Worker取得結果の`subdomain.previews_enabled`は`false`。Build Outputの`previewUrls: false`とも一致する。配信versionのbindingはCASESとDBで、社員用・OpenAI用の秘密値は未設定。

Access認証後の実API操作は未確認。OpenAIキーはユーザーが後で`.env`へ設定する予定で、秘密値の読取・保存・有料API呼出しは今回行っていない。Accessログインの成功だけで、社員認証や採用AI・音声の接続完了とは扱わない。

## 発表に向けた接続状況

バックエンドの実証範囲は、採用面談の保存、社員の引き受けと回答、DOからD1一覧への反映、同一命令の再送での復旧まで。画面の`/`は現在も`Hello!`というHono雛形であり、採用の完成画面としては提示できない。

ローカル起動には既存migrationを適用し、社員操作には`.dev.vars`の`STAFF_API_TOKEN`を設定する。追加の認証サービスやテーブルは不要。OpenAIキー・有料API・外部Cloudflare設定はこの担当では触っていない。

元の採用Agentsが人間の回答本文を受け取って応募者の言語で説明し、Live音声へ返す部分、React FE、HaaS・電話、MCP認証と配信は別担当との実接続待ち。`ai.resume_pending`や電話の`accepted/completed`だけで、この部分まで動いたとは発表しない。

参照した公式仕様は[Prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)、[D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Hono routing](https://hono.dev/docs/api/routing)。
