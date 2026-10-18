# 配備候補と受入状況

2026-10-18 16:47 JSTまでのGitHub・配備記録の確認をまとめる。配備前に[PR #39](https://github.com/pupuchan1/future-company/pull/39)のHEADと[全体管理 #94](https://github.com/pupuchan1/future-company/issues/94)を読み直す。

## 実配備版

実配備commitは`ab9cedb9d9fe2fea5abd245bdf9da90bc0ee4c47`。[PR #113](https://github.com/pupuchan1/future-company/pull/113)で共有されている。
前の実配備版[PR #110の`73eb9ba`](https://github.com/pupuchan1/future-company/pull/110)へ、WorkerとNodeの時計差でLive開始が403になる問題の修正を加えた版である。
Git差分は`src/backend/bridge-proof.ts`と`src/backend/bridge.test.ts`の2ファイル。FEはPR #28の`3e036ab`を維持し、BEは`6176125`基点の構成にこの修正を加えている。
PR #113は署名・case一致・期限切れ拒否を維持し、期限上限に30秒の時計差許容を追加する。約2.2秒の時計差という原因の根拠と回帰試験は同PRにある。
以下の#39候補と#76/#87/#101の統合条件は、実配備版の記録と分けて扱う。

## #39の統合候補

Limoが配備基準として指定したcommitは`617612592fda658304fe87f68d2166ceeac5f9c7`。これは会話画面・全文字幕・TXT・MP3・自動声交代を含む中間候補であり、#76の最新差分と#87を揃えた最終版ではない。
指定と検証報告は[#99の引継ぎコメント](https://github.com/pupuchan1/future-company/issues/99#issuecomment-6247174890)を参照する。

| 対象 | この候補に含む範囲 | 配備前の確認 |
| --- | --- | --- |
| 会話画面 #76 | `5fe608ffe4b48fe1a909f640859a90d03441f5e1`までを通常merge | 最新HEAD`f0572a563f8b2660076871e084bf1470980a841c`のOrb中央配置修正は未統合 |
| Orb #87 | 未統合。確認時のHEADは`d2f208b69fd3af40a71f4f27f414ff21c480b65c` | pupuが重複イベントの修正・仕上げを行い、そのcommitと受入結果を確認してから合流 |
| 自動声交代 #81 | Limoの比較では必須修正は#39に実装済み | 並立する実装を丸ごとmergeしない。音量計測不能時の制限を残件として扱う |
| 本番Worker型検査 #101 | `319ffc1`の試験コード除外はこの候補に未統合。配備担当の型検査は失敗 | PR #101を合流し、最終配備commitで型検査を通す |

#81の字幕fallbackは、後続deltaでタイマーを延長せず発話中に交代する懸念があるため、Limoが未採用とした差分。
判断の根拠は[#81の比較結果](https://github.com/pupuchan1/future-company/pull/81#issuecomment-6247136638)。

Orbは同じ`backend.result`を再受信すると、音声応答終了後に`listening`から`waiting`へ戻る不具合が報告されている。
ローカルscratchでの修正成功と、PRへの修正取り込みは別に確認する。
根拠は[#59の再現・引継ぎ](https://github.com/pupuchan1/future-company/issues/59#issuecomment-6247127846)。

## 検証の範囲

`6176125`について、LimoからFE92件・Worker/relay/Node結合27件、型検査・build・lint、本番configのdry-run成功が報告されている。
一方、[配備担当の#104](https://github.com/pupuchan1/future-company/pull/104)では同じ候補のFE92件・Node接続関連40件・FE build・22 assets dry-runが成功したが、配備用`tsc --noEmit -p deployment/tsconfig.json`はtest経由でfrontendを取り込んで失敗している。#101の除外設定は未統合であり、型検査成功とは扱わない。
同担当の`npm run lint`は既存Orb・LegacyPrototypeのReact規則9 warningで終了1。Limoの成功報告と区別し、最終合流commitでコマンドと終了コードを確認する。外部CLIレビューも未完了。
内部ブラウザーの録音・MP3再生・保存は合成した入力とAI音声による確認である。
この記録は別担当の報告を整理したもので、ここで実AI・実マイク・本番を再試験した結果ではない。

最終合流commitで確認する項目は次のとおり。

- `/conversation`への移動・ホーム往復・日英変更で、同じcase・接続・履歴を維持し、音声hookとrecordingを二重に作らない。
- 採用とHaaSの実マイク通しで、人間回答を同じcaseへ保存し、元Agentから音声へ一度だけ返す。
- 自動声交代中の回答返却、HaaSから採用への交代、候補接続失敗時の旧会話維持を確認する。
- 取消・終了・切断・再接続・SSE再購読後に、二重依頼・重複発話・別案件への漏れがないことを確認する。
- 専用画面で会話終了後の全文履歴、TXT保存、MP3再生・保存と、実音声でのOrb状態を確認する。

受入の正本は[#32](https://github.com/pupuchan1/future-company/issues/32)、担当別の残件は[#99](https://github.com/pupuchan1/future-company/issues/99)。
黒電話の実ベル・受話器・実人間回答は[#34](https://github.com/pupuchan1/future-company/issues/34)、実Work/dotsのMCP Events購読・通知後処理は[#43](https://github.com/pupuchan1/future-company/issues/43)で確認する。
通常MCPの模擬回答成功を、実機や実購読の成功に読み替えない。

## 本番への受渡し

16:47 JSTのGitHub再確認で#39は`6176125`、#87は`d2f208b`。16:41 JSTに確認した#76は`f0572a5`、#101は未マージ。
[#87のレビュー指摘](https://github.com/pupuchan1/future-company/pull/87#discussion_r4306171872)は未解決で、修正後の最終配備commitはまだ確定していない。
候補と受入範囲は[PR #103](https://github.com/pupuchan1/future-company/pull/103)、Node・Workerの配備記録は[PR #104](https://github.com/pupuchan1/future-company/pull/104)で扱う。別チャット「PR #39を本番デプロイ」で実際の切替と追加統合が進行しているため、この文書の値を固定した現在状態として扱わない。

### 16:47 JSTに確認した配備状態とsmoke

- 配備担当が16:47 JSTに取得したCloudflare API記録を読み、Worker version `cb9d228d-56cd-48a3-8682-0f2213d8147a`の100%配信とpreview無効を確認した。取得記録は手元の`bridge-skew-after.json`。本チャットからAPIを再実行した結果ではない。
- ローカルの`.local/production-runtime/state.json`は`sourceCommit=ab9cedb9d9fe2fea5abd245bdf9da90bc0ee4c47`、relay `https://rep-butter-obligations-vehicles.trycloudflare.com`、Node4350・relay4351を記録している。Node4350の待受PID42397も確認した。
- 配備担当の`bridge-skew-proof-check.json`は新規本番証明で旧検証false・修正後true、別case・署名改ざん・期限切れ拒否を記録している。これは証明検証の確認であり、Live開始成功の実測ではない。
- 同担当の16:47 JSTの`bridge-skew-smoke.json`は`source=ab9cedb`。採用・HaaSとも案件作成201、証明・status・SSE200、所有者なし401・別Origin403、社員引受・回答と再送200、revision3・answered・simulated=trueを記録している。
- 同smokeの`liveSessionsCreated=0`。実Live往復・全文字幕/TXT/MP3・自動声交代・実マイク・黒電話の本番受入はこの試験に含まれない。

`ab9cedb`への配備更新、#76最新差分・#87修正・#101を揃えた統合版の確定、実音声の受入成功はそれぞれ別に記録する。

配備担当はr74tech。Worker・Node・relayの版を一組として記録し、次のNode更新は稼働中の通話を終了してから行う。
stateDir・D1・CaseRoom・Access・secretを保持し、再配置前に実際のrelay originとWorker設定を照合する。以前のjamie URLへ記録だけを根拠に戻さない。
秘密値をPR・Issue・ビルド成果物へ転記しない。

以前の配備元は`319ffc17ddecea0d3b9ff3a0a98efa65af42f818`、Worker versionは`c27057a9-c69b-4d7e-9ba6-dcb69cc383b9`。
これは[#33の本番実測報告](https://github.com/pupuchan1/future-company/issues/33#issuecomment-6247048799)に記録された値であり、現在の配信版を再取得した値ではない。
同報告では実Live・Agents・MCPと合成マイク・模擬電話のHaaS往復が成功している。実機・実マイクと、今回の最新候補の本番成功は未確認。

配備後は#33へ採用commit・Worker version・Node/relay接続先・戻り先を、#32へその版で実際に通した受入結果と未検証項目を記録する。
