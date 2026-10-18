# 採用相談の Slack 接続（#107）

採用・受付の `request_human` は Slack、HaaS の物理作業は既存黒電話ブリッジです。採用は未設定でも黒電話へフォールバックしません。ローカル `/api/demo/handoff` は独立した黒電話確認用で、進行中の採用案件には使用できません。

r74 が Node の秘密環境に設定します（Git、ブラウザー、Slack本文へトークンを出さない）。

```dotenv
SLACK_CHANNEL_ID=C0CA6A7F4E5
# 次のいずれか。両方ある場合、投稿はbot、返信取得はuserを使用。
SLACK_BOT_TOKEN=<server-only>
# SLACK_USER_TOKEN=<server-only>
```

指定先は DevDay Community Hackathon Tokyo の **#ai**。アプリをこのチャンネルへ参加させ、投稿 `chat:write` と公開チャンネル返信取得 `channels:history` を許可します。現行公式 `conversations.replies` は bot/user 両方の history scope を記載しています。実際の権限は API 応答で判定し、`missing_scope` 等は回答成功にしません。

初回採用ターンの `notify_recruiter` は案件ごとに一度、本人が話した事実のみで来訪通知します。氏名・経歴が無ければ「未確認」。これは人間相談や回答ではありません。後の `request_human` は同じ案件threadに質問を追加し、**「採用担当への確認」**、応募者の発言、相談・質問、返してほしい内容を plain_text Block Kit で表示します。採否判断・推薦は行いません。モデルはチャンネルを指定できません。

人間はそのthreadへ **`回答: 内容`** または **`answer: text`** と返信します。bot、別thread、相談以前の返信、prefix無しの雑談は採用しません。最初の該当返信を untrusted result として `human.completed` → 既存Worker回答保存・元Agent・Live経路へ返します。投稿成功は `requested / transport=slack / notification_status=sent` であり、ringing・accepted・音声接続ではありません。

内部専用appとして全案件で共有する5秒間隔のround-robin pollです。検出待ち0–5秒（複数案件時は一巡分）にAgents/Live処理時間が加わります。429はRetry-After、欠落時60秒を守ります。依頼開始から10分で期限切れになり、読取失敗で期限は延びません。Stop・case closeでpollと遅延結果の取込を止めますが、送信済みSlack本文は削除しません。

冪等性とthread対応は現在のNodeプロセス内です。ネットワーク例外による投稿結果不明は自動再送しません。Node再起動をまたぐ継続・重複防止は未対応のため、通話終了後に再起動してください。通知の再試行は新規キーで乱発せず、Slackと状態を確認します。

ローカルfixtureでMCP→Slack投稿→明示返信→元採用Agentを検証。実Slack token・本番往復はr74による設定後の確認が必要です。親によるconnector投稿はこのアダプタの実接続証拠ではありません。

公式: [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)、[conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)、[text object](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/)。
