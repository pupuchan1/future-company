# 株式会社HaaSのフロントエンド

## 会社トップと実音声の入口（#16）

`/` は、会社紹介・写真・大きな音声オーブを持つ1画面です。開始は共通受付のオーブ1つだけで、音声から採用またはHaaSへ業務を振り分けます。3つのカードは開始前は説明のみ、通話中は担当の声への切替操作を提供します。既存4画面は `/prototype` を入口として残しています。

起動はこの `frontend` ディレクトリで実行します。別ターミナルでPR #4の `integration` を4320番で起動してください。

```sh
npm ci
npm run dev -- --config vite.live.config.ts --port 4321
npm run build
node --experimental-strip-types --test tests/*.test.ts
```

音量表示はWeb AudioでマイクとAI音声のRMSを測定します。会話テキストをもとに発話中を装うことはありません。担当ごとの声は受付 `shida`、採用 `harema`、HaaS `marin`。Liveの声はセッション開始後に変更できないため、同一caseの履歴を持つ候補接続を準備し、接続確認後にactivateします。業務の自動振り分けだけでは声は変わらず、声の交代は担当ボタンで明示的に行います。終話・失敗時の後始末、切替中の停止、応答喪失時の再試行も実装しています。

接続先の契約は `GET /api/status`、`GET /api/events`、`POST /api/live/session`、`POST /api/live/session/:id/handoff`、`POST /api/live/session/:id/activate`、`DELETE /api/live/session/:id` です。声の制約は[公式Live会話ガイド](https://developers.openai.com/api/docs/guides/live-conversations)を参照してください。

**統合の残り:** この差分はローカルNode接続で検証します。Workers発行case IDと認証つきAPIの接続は #18、人間の保存済み回答を元Agent/Liveへ返すアダプターは #19。公開Workersへデプロイ済みという意味ではありません。模擬電話は「模擬デバイス」と表示し、受話器応答だけで人間音声がつながったとは表示しません。新しいユーザー導線に作業者ダッシュボードは追加しません。

### 会社イメージ画像

`public/images/haas-office.png` は組み込みimage_genで生成した架空のコンセプト写真です。ページにも生成イメージであることを記載しています。実在企業の所在地・社員・実績を表すものではありません。

生成プロンプト: Modern Japanese design-engineering office, elegant black vintage rotary telephone on a light oak desk in the right foreground, two colleagues softly out of focus, floor-to-ceiling windows with greenery, warm natural daylight, subtle cobalt-blue notebook. Wide editorial architecture photograph with clean negative space. Authentic materials, no text, logos or watermark; fictional Human as a Service company concept, not a real company.

## 維持している4画面プロトタイプ

Issue [#7](https://github.com/pupuchan1/future-company/issues/7) の4画面を、[#9](https://github.com/pupuchan1/future-company/issues/9) のデザイン方針で実装しています。

```sh
npm ci
npm run dev
npm run build
node --test frontend/tests/demo.test.ts
```

ルートから実行します。黒 `#111111`・青 `#1447e6`・白 `#ffffff` の3色、角丸なし。PCは会話＋情報の2列、モバイルは会話中心と情報パネルです。

| URL | 画面 |
| --- | --- |
| `/prototype` | 従来の会社紹介・募集サンプル・AI受付への入口 |
| `/session/:id` | 会話・担当切替・文字入力・確認依頼 |
| `/session/:id/result` | 会話メモ・人の回答・未解決事項・再開 |
| `/operator` | 依頼一覧・引受・回答・応答なし |

## デモの試し方

1. 「AI受付と話す」から会話開始。文字を送信すると採用担当へ引継ぎます。「この仕事について話す」では採用担当へ直接進みます。
2. 経験や希望を入力し、「人に確認を依頼」から現場への質問を送ります。
3. 「担当者画面を別タブで開く」から同じブラウザの `/operator` を開きます。
4. 任意で「呼出し状態を試す」、続いて「引き受ける」。回答して「結果を報告」すると、元の会話タブへ結果が反映されます。
5. 「会話を終了」→「終了してメモを見る」。会話の再開とメモのダウンロードもできます。

「対応できない・応答なし」と依頼取消も試せます。完了・取消済みの依頼は再度操作できません。タブ間の更新はWeb Locksとstorageイベントを使います。Web Locksがない環境では同時更新の排他は保証されません。

## 接続の範囲

- 会話と依頼はlocalStorageに保存。別端末・別ブラウザでは共有されません。サーバーへの保存、応募、採否判定は行いません。ブラウザのサイトデータを削除すると消えます。
- AI応答は `src/lib/demo.ts` の定型デモです。言語の切替は文字の簡易判定で、初期表示はブラウザ設定、JP/ENボタンでも切替できます。
- ブラウザが対応していれば音声認識で入力できます。音声入力ボタンを押したときだけマイクを要求します。文字起こしを確認して送信します。音声認識はブラウザ側のサービスを利用する場合があります。実AIとの音声往復・自動言語認識は未接続です。
- 人間の回答は原文で表示。自動翻訳は未接続です。
- 黒電話の呼出しはデモ状態です。受話器応答や実音声接続の確認には使いません。
- `/operator` は認証なしのローカル試作。正式な社員画面へ接続する際は認証・案件API・実イベントに置き換えてください。
- 実音声アダプターは別担当の `features/live/` に分離し、「AI音声に接続」モードへ組み込み済みです。起動と接続範囲は [LIVE-INTEGRATION.md](LIVE-INTEGRATION.md) を参照してください。デモの文字・依頼は音声サーバーへ送信しません。

主要UIは `src/App.tsx`、デモ状態と更新処理は `src/lib/demo.ts`、共通スタイルは `src/styles/global.css` です。秘密鍵はフロントに置かず、接続の際はサーバー側で扱います。
