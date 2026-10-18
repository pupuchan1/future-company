# GitHubの残件とpupu担当の作業（2026-10-18）

> 以下は途中時点の実装記録です。現在の担当・進捗・受入条件は [Issue #94](https://github.com/pupuchan1/future-company/issues/94) が正本です。公開体験は採用に絞り、受付から採用担当へ声・文脈を切り替え、[Slack #aiへの人間確認](https://github.com/pupuchan1/future-company/issues/107)をつなぎます。オーブはpupu、配置はr74tech、結合と検証はLimo/Codexが担当します。

2026-10-18 JSTにOpen Issue・PRと #18/#19/#33/#34 のコメントを確認した記録。IssueがOpenでも、過去の提案・判断記録をすべて未実装タスクとは扱わない。以後の進捗はリンク先を優先する。

## 現在の実装とPR

| 項目 | 状況 | 確認先 |
| --- | --- | --- |
| 単一の音声入口、Worker案件ID、Locale、円形オーブ | PR #28にpush済み。Localeは `a5e04fa` に含まれる | [PR #28](https://github.com/pupuchan1/future-company/pull/28)、[#18](https://github.com/pupuchan1/future-company/issues/18)、[#31](https://github.com/pupuchan1/future-company/issues/31) |
| 元のReact、Worker、音声backend、Agents再送修正、担当別ボイス | #28が元PRの変更を取り込み済み。元PRがOpenでも未着手ではない | [#15](https://github.com/pupuchan1/future-company/pull/15)、[#12](https://github.com/pupuchan1/future-company/pull/12)、[#4](https://github.com/pupuchan1/future-company/pull/4)、[#23](https://github.com/pupuchan1/future-company/pull/23)、[#26](https://github.com/pupuchan1/future-company/pull/26) |
| 本番向けの統合 | Limo / dj-thankがDraft PR #39で進行。#28の後続変更を取り込む必要がある | [PR #39](https://github.com/pupuchan1/future-company/pull/39) |

## 作業順と担当

| 優先 | 作業 | 担当と依存 |
| --- | --- | --- |
| 1 | Worker案件限定の接続証明を取得し、Node開始bodyへ渡す。認証・別case・取消で開始を止める | pupu / Codex。#19のAPI契約に合わせPR #28へ実装 |
| 2 | 依頼中・着信要求の応答・受話器応答・対応終了・回答本文の表示 | pupu / Codex。#18/#34。既存の単一画面を更新。音声説明完了のACKは未提供 |
| 3 | 保存した人間回答を元Agent/Liveへ一度だけ返す | r74techが #19 で実装中。Worker requestId / Node handoff_id、元route、認証・claim・revisionを保持 |
| 4 | 共通受付→Worker→Live→HaaS/採用→模擬回答→元会話を同じcaseで通す | #32。1と3、プロバイダー設定の統合後に実行。実API単体の成功と区別 |
| 5 | 本人限定でReact・Node・Workerを配置し、認証・SSE・結果返却を確認 | r74tech / Limo、#33。権限のあるデプロイ先と常駐Nodeが必要 |
| 6 | 黒電話を鳴らし、応答・回答を元会話へ返す | ハードウェア担当 / GOROman、#34。型番・配線・外部制御方式と実機が必要 |
| 後続 | 自動routingから声交代、HaaS調査・技能検索・適任者への作業依頼 | Limo / dj-thank、#35/#38。PR #39で進行。空き状況や完了を推測しない |

## 今回の対応

- `WorkerCaseClient.prepareVoice(language)` で所有確認と短命証明の取得をまとめ、同時開始を1回にまとめる。証明はUI snapshot・ストレージへ保存しない。
- 新しいcase IDのLive clientがstatusを確認してから開始し、証明取得の拒否・異常応答・取消後の結果で開始しない。
- 依頼状態を日本語・英語で表示。対応終了でも本文がなければ回答未取得と表示し、着信や保存のみで音声説明済みとは表示しない。
- 検証結果とcommitをPR #28へ共有する。判断記録は [#40](https://github.com/pupuchan1/future-company/issues/40)。

FE55テスト、型チェックを含むFE本番build、lintを確認。追加箇所のlint warningはなく、旧画面の既存warning2件のみ。ブラウザーでも新caseのstatus待ち、証明拒否、取消後の証明・status遅延、二重開始、証明をsnapshotへ載せないこと、回答本文未取得の表示を含む10項目を確認した。ブラウザー試験は音声デバイス・APIを模擬しており、実マイクやプロバイダーの通し成功とは扱わない。

## ユーザーの現物操作・判断が必要になること

1. 黒電話と交換機の型番・版、接続・手動鳴動、実機操作担当を確認する（#34）。現物未確認の外部制御やPC直結は進めない。
2. backendの統合・設定後、自分のブラウザーでマイク/スピーカーの往復と本番の操作を確認する（#32/#33）。APIキー本文を公開Issueへ投稿しない。
3. 通し試験後、PR #28/#39と関連PRの最終レビュー・マージ順をチームで決める。現時点ではDraftのまま。

コード実装・試験・PRへのpushはCodexが進められるため、上記の現物確認を待たずに着手する。

## Worker契約の反映追記（#45）

#19のfd07bd3を43fcb18としてPR #28へ取り込み、案件限定証明の発行APIをローカルWorkerへ追加した。新規受付案件はhaas、旧support等の取得も維持。実Worker/DO/D1とFE clientの結合4件、Worker全68件が成功。これによりWorker発行APIの404は解消したが、通常起動のサーバー資格情報は未設定（503）で、Nodeの開始検証と回答復帰は引き続き#19/#39との接続が必要。
