# Reactと共通音声窓口の接続

利用者向けの共通受付は `ReceptionPage` → `useReceptionConnection` → `useLiveConnection` です。
開始ボタンでWorker案件を作成し、所有者cookieで認可された案件単位のAPIからNodeへ接続します。
案件と開始証明の契約は [WORKER-CASE-CONTRACT.md](./WORKER-CASE-CONTRACT.md) を参照してください。
オーブはpupuの `VoiceOrb` と同じWeb Audio解析を使います。表示用の合成波形は実音声の証拠にしません。

## 共通受付の接続

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

## 開発用パネルとの契約

```tsx
import { LiveConnectionPanel } from '@/features/live/LiveConnectionPanel'

<LiveConnectionPanel caseId={session.id} language={session.language} />
```

- この開発用パネルの`caseId`はNodeの会話・依頼を関連付けるIDです。単体で使う場合はWorker案件の存在・所有を保証しません。
  共通受付はWorker発行IDを使い、デモセッションUUIDを流用しません。
- `language`は接続開始時の初期言語です。担当と言語はサーバーの`routing.updated`を表示します。
  ブラウザは言語・国籍やルーティングを推測しません。
- 任意の`onSnapshot(snapshot: LiveSnapshot)`で状態を購読できます。これは表示用です。
  localStorageデモデータへ混ぜたり、回答・音声の再開を推測したりしないでください。
- パネルをunmountすると、マイク・RTC・SSE・タイマーを停止し、サーバーの音声セッションをDELETEします。
  mode切替・画面離脱・pagehideでも同じ片付けを行います。
- 音声会話の内容はメモリ内のみです。デモの結果画面や再読込後の履歴へは保存されません。

Node単体で利用するHTTPは`GET /api/status`、`GET /api/events`、
`POST /api/live/session {sdp,language,case_id}`、`DELETE /api/live/session/:id`です。
WebRTCは`oai-events`を使います。HTTP作成が開始を行うので`session.start`を送らず、
`session.started`を待ちます。PR #4はfrontend commandを許可していないため、文字送信も行いません。

共通受付は `apiPrefix: /api/v1/cases/:caseId/voice` を指定し、`status`・`events`・
`session`・言語変更・担当交代・終了をすべてこの配下へ送ります。公開受付は空の案件IDでNodeの全体APIを呼びません。
開始時の短命な `bridge_token` は毎回取得し、初回session作成本文だけに含めます。
ブラウザからの秘密設定UIはありません。

## 状態の扱い

公開SSEはWorkerが案件ごとに認可します。開発用の全体SSEもあるため、ブラウザもcase IDを必須にして他の会話を除外します。
DataChannelとSSEに重複する文字起こしはevent IDで重複排除します。
人間依頼はrevisionが古い更新を無視し、simulatedと回答`{text,language}`を保ちます。
`accepted`は受話器の応答で、音声通話の確立を意味しません。
`completed`のみでは回答を作らず、回答本文がないことを表示します。
`backend.result`は業務処理結果で、AIの発話・再生完了とは別です。

PR #4のa0134dcではHaaSルートと人間の回答`{text,language}`が追加されました。
UIは依頼先・作業内容・期待する回答を表示し、DELETE応答の`live_finalized`も確認します。
マイクは即座に停止し、サーバーの終了処理後にRTCを閉じます。最終応答が未確認なら表示します。
Workers/operator接続と実機・実モデルの通し検証は別途必要です。

## 確認

```sh
npm run test:frontend
npm run typecheck:frontend
npm run lint
npm run build:frontend
```

結合テストは実Worker/DO/D1、案件cookie・証明、署名付きrelay、Node HTTP/SSE、本物のフロント接続クライアントを通します。外部モデルとマイク/WebRTC機器、案件の人間回答WebSocketは代替します。開始・話者別履歴・重複除外・言語更新・他案件拒否・終了後の履歴保持を確認します。実モデルの音声、実機、人間回答の成功とは区別します。

## 会話記録と言語

`ReceptionPage` が単一の `useReceptionConnection` を所有します。ホームと `/conversation` の移動は History APIで表示だけを変え、WebRTC・録音を再作成しません。後続のホーム文言とフローティングオーブの導線も `/conversation` に統一しています。

会話画面の `ConversationRecord` は同じhookの全件字幕と `recording` を受け、全文TXTと終了後のMP3を端末内から保存できます。候補の担当音声は採用前に記録せず、新しいマイク権限や音声アップロードを追加しません。終了後もそのタブに履歴とMP3を残します。

言語選択は `POST .../voice/session/:id/language {language,language_preference}`。日本語/Englishの手動選択は自動分類より優先し、Autoで発話からの判定へ戻ります。担当の声を切り替えても同じcaseの選択を維持します。失敗は会話を終了せず表示し、再試行できます。

## 実環境で残る確認

現状と担当の正本は [Issue #94](https://github.com/pupuchan1/future-company/issues/94)。本番配置はr74techが既存アカウントで行い、既存のAccess・秘密設定・stateDirを維持します。稼働状態と実音声の受入は [VERIFICATION](../integration/VERIFICATION.md) の日時付き記録で確認します。会話はタブ内メモリで、リロード後の復元は含みません。PR #87のOrb更新はpupu担当で別統合です。
