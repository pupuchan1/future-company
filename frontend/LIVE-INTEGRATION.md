# ReactとPR #4の音声接続

利用者向け画面はReactを使い、PR #4のNodeサーバーへWebRTCとSSEで接続します。
画面担当が`App.tsx`でデモ/音声を切り替え、接続担当は`src/features/live/`を実装します。
デモの文字・ローカルoperatorの操作は、実接続へ送信しません。

## 起動

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

## 画面との契約

```tsx
import { LiveConnectionPanel } from '@/features/live/LiveConnectionPanel'

<LiveConnectionPanel caseId={session.id} language={session.language} />
```

- `caseId`はPR #4 Nodeサーバーで会話・依頼を関連付けるIDです。現在はReactのデモセッションUUIDを流用します。
  Workersのcaseを作成する処理はなく、同一UUIDでもWorkersに存在するとは限りません。
- `language`は接続開始時の初期言語です。担当と言語はサーバーの`routing.updated`を表示します。
  ブラウザは言語・国籍やルーティングを推測しません。
- 任意の`onSnapshot(snapshot: LiveSnapshot)`で状態を購読できます。これは表示用です。
  localStorageデモデータへ混ぜたり、回答・音声の再開を推測したりしないでください。
- パネルをunmountすると、マイク・RTC・SSE・タイマーを停止し、サーバーの音声セッションをDELETEします。
  mode切替・画面離脱・pagehideでも同じ片付けを行います。
- 音声会話の内容はメモリ内のみです。デモの結果画面や再読込後の履歴へは保存されません。

利用するHTTPは`GET /api/status`、`GET /api/events`、
`POST /api/live/session {sdp,language,case_id}`、`DELETE /api/live/session/:id`です。
WebRTCは`oai-events`を使います。HTTP作成が開始を行うので`session.start`を送らず、
`session.started`を待ちます。PR #4はfrontend commandを許可していないため、文字送信も行いません。

## 状態の扱い

SSEはサーバー全体のイベントなのでcase IDを必須にして他の会話を除外します。
DataChannelとSSEに重複する文字起こしはevent IDで重複排除します。
人間依頼はrevisionが古い更新を無視し、simulatedと回答`{text,language}`を保ちます。
`accepted`は受話器の応答で、音声通話の確立を意味しません。
`completed`のみでは回答を作らず、回答本文がないことを表示します。
`backend.result`は業務処理結果で、AIの発話・再生完了とは別です。

現在のPR #4にはHaaSルートの実処理、Workers/operator接続、人間の回答本文を
返す統一契約が未実装の部分があります。UIが将来のresultを扱えても実装完了の証拠にはなりません。

## 確認

```sh
node --test frontend/tests/live-connection.test.ts
npx tsc -p frontend/tsconfig.live.json
npm run typecheck
npm run lint
npm run build
```

テストはイベント分離・重複排除・古い依頼の除外・遅れた接続応答の削除・
マイク拒否と停止・SSE再接続をモックで確認します。実モデル発話や実機リングの確認とは区別します。
公式仕様: https://developers.openai.com/api/docs/guides/voice-webrtc

関連: https://github.com/pupuchan1/future-company/issues/13
