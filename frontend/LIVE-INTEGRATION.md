# Reactと共通音声窓口の接続

利用者向けの共通受付は `ReceptionPage` → `useReceptionConnection` → `useLiveConnection` です。
開始ボタンでWorker案件を作成し、所有者cookieで認可された案件単位のAPIからNodeへ接続します。
案件と開始証明の契約は [WORKER-CASE-CONTRACT.md](./WORKER-CASE-CONTRACT.md) を参照してください。
オーブはpupuの `VoiceOrb` と同じWeb Audio解析を使います。表示用の合成波形は実音声の証拠にしません。

## Node単体の開発用接続

PR #4の`integration/`があるcheckoutで、サーバー側の設定を用意して起動します。
ブラウザにAPIキーやMCPトークンを渡す必要はありません。設定方法はPR #4の`integration/README.md`を参照してください。

```sh
npm run integration
```

Reactのcheckoutで起動します。既存の通常Vite設定は変更していません。

```sh
npm run dev -- --config vite.live.config.ts
```

サーバーは`127.0.0.1:4320`、Reactはターミナルに表示されるlocalhost URLを使います。
専用Vite設定が`/api`をサーバーへ転送します。同一originからのOriginヘッダーだけを
転送先へ合わせます。cross-site判定やbackendのloopback制限は保持します。
通常の`npm run dev`で起動した場合は音声サーバーへ転送されません。
本番環境への公開やWorkers接続は、この開発用proxyでは扱いません。

トップから会話画面に進み「AI音声に接続」を選びます。パネルの表示は設定・イベントの
取得のみで、マイクは「AI音声を開始」を押すまで使いません。未設定時は開始できません。

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
`session`・担当交代・終了をすべてこの配下へ送ります。公開受付は空の案件IDでNodeの全体APIを呼びません。
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

テストはイベント分離・重複排除・古い依頼の除外・遅れた接続応答の削除・
マイク拒否と停止・SSE再接続をモックで確認します。実モデル発話や実機リングの確認とは区別します。
公式仕様: https://developers.openai.com/api/docs/guides/voice-webrtc

関連: https://github.com/pupuchan1/future-company/issues/13
