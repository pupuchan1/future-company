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

PR #4のa0134dcではHaaSルートと人間の回答`{text,language}`が追加されました。
UIは依頼先・作業内容・期待する回答を表示し、DELETE応答の`live_finalized`も確認します。
マイクは即座に停止し、サーバーの終了処理後にRTCを閉じます。最終応答が未確認なら表示します。
Workers/operator接続と実機・実モデルの通し検証は別途必要です。

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
# 担当別ボイスと音量の追加契約（PR #26）

画面デザインはpupuさんの実装を採用します。この差分は既存 `features/live` を拡張し、App・トップページ・スタイルを置き換えません。

- `useLiveConnection().start(route?)`: route省略で共通受付。
- `switchDepartment(route)`: 同一caseの会話履歴・Agentsを保持して担当の声へ交代。
- snapshot `inputLevel/outputLevel` は実音声のRMS（0〜1）、`speaking` は `user/assistant/both/silent`。オーブ表示に使えます。
- snapshot `voiceRoute/voice` は現在の声、`route` は業務の担当で別概念です。`switchConfigured` と `voiceMap` はサーバーstatusから取得します。
- `switching` 中は他の切替を止め、終了操作は有効にしてください。activate応答が不明な場合は無音を維持し、同じtokenで再試行した後に終了案内を表示します。
- 自動の業務ルーティングだけでは声は変わりません。初回の入口を1つにし、声の交代UIの配置はpupuさん側で決めます。

サーバーはPR #4の `POST /api/live/session/:oldId/handoff` →候補のWebRTC connectedとsession.started→`POST /api/live/session/:newId/activate` を使用します。失敗時は元の会話に戻し、同じマイクtrackを二重取得・停止しません。声の変更には新Live sessionが必要です（[公式ガイド](https://developers.openai.com/api/docs/guides/live-conversations)）。

32テスト、型検査、buildが成功。公開Workersのcase ID・認証との結合は #18、保存済み人間回答の返却は #19 です。新しいデザイン案を採用した意味や、実機黒電話を検証した意味ではありません。

## 共通受付への統合

`ReceptionPage` の既存レイアウトを保ち、信号表示を `AudioOrb` へ差し替えています。入力は既存マイクの時間領域データを48点へ縮約した実波形、出力は再生成功と再生状態を確認したRMSに連動する青いリングです。更新は最大10Hzで、音量だけから波形を生成しません。無音・ミュート・担当交代・終了時には波形を止めます。`prefers-reduced-motion` では補間と待機アニメーションを止めます。

通話中にオーブが画面外へ出た場合は、小さな音声表示と終了操作を残します。業務担当が変わった場合にのみ、その担当の声へ切り替える明示ボタンを表示します。写真・App・共通CSSのデザインは変更していません（#29 / #30）。実音声と実機の検証は、このブラウザ表示・モック試験とは別です。
