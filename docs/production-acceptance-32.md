# Issue #32 本番受入記録

対象は[Issue #32](https://github.com/pupuchan1/future-company/issues/32)。採用とHaaSをそれぞれ同一caseで通し、実マイク・人間回答・元Agentの音声返却を確認する。2026-10-18の実測を追記する。実会話の全文、録音、認証情報は保存しない。

## 試験対象と版

- 入口: https://future-company-demo.r74.workers.dev/
- 試験時刻は2026-10-18 16:32〜16:35 JST。既存の本人限定本番で試験した。PR作成元は統合ブランチ6176125で、本番の配備版を表すものではない。
- 直前の配備報告は[Issue #33の記録](https://github.com/pupuchan1/future-company/issues/33#issuecomment-6247048799)。その過去結果を今回の成功には加算しない。

## 今回の実測

| 項目 | 観測 | 判定 |
| --- | --- | --- |
| 本番画面 | 通常のChromeからトップを表示し、日本語を選択して開始 | 確認済み |
| 実マイク | 合成入力を設定せず開始。利用者の日本語発話が画面に文字起こしされた | 入力確認済み |
| 日本語応答 | 同じ画面に日本語のAI応答と業務結果が表示。利用者が「はっきり聞こえる」と回答 | 字幕・利用者による聴取確認済み |
| 接続中のcase | `case-10e641892639cf221d009ce5c983571d733e9fba43a938b0b88887175d3396ef` | 画面で照合 |
| 開始時の異常 | 同じcaseの音声sessionが存在する旨のHTTP 409が一度表示。その後、同じcaseで文字起こしとAI応答を表示 | 回復を観測。原因・重複発話の有無は未確定 |
| イベント | 接続情報がconnectingからconnectedへ変化 | 表示確認済み。SSE再接続試験は未実施 |
| 採用担当への振分け | 新規caseを開始して実入力を観測した段階で中断 | 未確認 |
| HaaS英語応答 | 利用者の指示で後日再開 | 未確認 |
| 人間への依頼 | 本番Nodeのstatusを読み、機器一覧とこのcaseの依頼一覧は空 | 未確認。実機接続済みとは扱わない |
| 社員claim・回答保存 | 今回のcaseでは未実施 | 未確認 |
| 元Agent・音声返却 | 今回のcaseでは未実施 | 未確認 |
| 終了と再接続 | 最初のcaseで終了表示と新規準備を確認。Nodeの資源ログで今回の3つのLive sessionのclosed・transport closedと、受付Agentのdeletedを確認 | 試験session終了を確認。終了API応答・SSE再接続は未確認 |

## 案件の保存状態の再取得

16:35 JSTに本番の`GET /api/v1/staff/cases/:id`をサーバー用Access認証と社員認証で読み直した。2件ともHTTP 200。以下はWorker案件のkindであり、担当Agentのrouteを意味しない。

| case | revision | kind | locale | requests |
| --- | --- | --- | --- | --- |
| `case-10e641892639cf221d009ce5c983571d733e9fba43a938b0b88887175d3396ef` | 0 | haas | ja | 0件 |
| `case-ae3fdf0b3208891186ab20b9014381f29b17d32c10e4db1988ec9f949c0b7e28` | 0 | haas | ja | 0件 |

最初のcaseはNode資源ログの受付Agentのroleが`reception`だった。2件目はLiveとマイク入力を確認したが、採用Agentの起動は確認できていない。今回のcaseには人間回答がなく、保存済み回答の返却成功には数えない。D1の直接照合は今回は実施していない。

ブラウザ一覧から試験タブが無くなった後、利用者から「ここまでを保存し、実マイク試験は後で再開する」と指定された。以後、新しい通話は開始していない。最後の試験Liveは16:34:53にfinalizedとclosed、16:34:54にtransport closedをNode資源ログで確認した。開始時409の原因は調査未完了。

## 残る受入

採用とHaaSについて、route、case、handoff、request、Worker revision、保存回答、delivery、元Agentの応答を同じ試験として照合する。日英の字幕と実際の聞こえ方を分ける。端末から実人間が回答した結果と、社員APIを試験者が操作した結果、simulated回答は区別する。

再開時は配備commit・Worker version・Nodeの組合せを再取得し、新規caseで採用日本語とHaaS英語を試す。本記録の未確認項目が残っている間、Issue #32を完了にはしない。
