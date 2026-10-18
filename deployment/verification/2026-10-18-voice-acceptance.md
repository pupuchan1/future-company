# 本番の声交代と復帰の受入記録

関連は[#32](https://github.com/pupuchan1/future-company/issues/32)、[#35](https://github.com/pupuchan1/future-company/issues/35)、[#34](https://github.com/pupuchan1/future-company/issues/34)。
NodeとWorkerの最新版配備は並行作業で更新されるため、各試験で確認したソースとWorker versionを固定して記録する。

## 2026-10-18 16:37〜16:38 JSTのAPI試験

| 対象 | 値 |
| --- | --- |
| 入口 | `https://future-company-demo.r74.workers.dev` |
| 製品ソース | `617612592fda658304fe87f68d2166ceeac5f9c7` |
| Worker | `66e5c8ad-22ff-491d-a735-d90f9b1aefbe`、100%配信 |
| relay | `https://ellen-grid-entrance-mails.trycloudflare.com` |
| Node | 本番4350、relay4351 |
| 試験機器 | 試験専用ID、`simulated=true`。実機IDのblack-phone-1を占有しない |
| 入力 | 認証付きの実Worker API、公開MCPと公開WSS。Liveセッションは作成しない |

試験後にruntimeのsourceCommitとrelay origin、Cloudflareのdeployment一覧を取得して照合した。
以下の結果は本番Nodeの機器処理とWorker APIの確認であり、元Agentの再開や音声発話の回数を含まない。

| 試験 | 結果 |
| --- | --- |
| 所有者なし | case別voice/statusが401 |
| 別caseの所有者cookie | 対象caseのvoice/statusが404で拒否 |
| 異Origin | voice/statusが403 |
| Nodeの同一依頼再送 | 同じhandoff IDが返り、ring.startは1回 |
| Nodeの取消後に回答が遅着 | cancelledを維持し、event.ack.accepted=false、回答本文なし |
| 受諾後に機器接続を切断 | unavailable、reason=device_disconnected |
| 同じ機器IDで再接続し、旧commandで回答 | accepted=false |
| 再接続後に別caseで新規依頼 | 新handoffで完了。回答を含む同じon_hookの再送はaccepted=false |
| Workerの同一command回答再送 | 200、revision3を維持、request1件、回答内容不変 |
| Workerの別case | request0件を維持 |
| case別SSE | case Aに人間イベント8件、case Bに4件。互いのcase IDを含む人間イベントなし |
| SSEの正常期限終了 | Aは59,856ms、Bは60,016msで終了 |
| 期限終了後のSSE再購読 | 同じ所有者cookieで200、status再取得も200 |
| voice/status連続8回 | 全て200、530は再現しなかった |

Workerへの回答再送試験とNodeの機器試験は独立に実行した。
Nodeの機器回答をWorkerBridge経由で自動保存した通し試験とは扱わない。
SSEはHTTPで再購読した結果であり、ブラウザEventSourceの自動再接続や履歴補完は別途確認する。

### 試験ID

| 対象 | ID |
| --- | --- |
| case A | `case-188189535b515dcc43924074a924fa7d3c72f9a4720352cb74db83a3e4fbd951` |
| case B | `case-f47490ea9a84ff8aad07b090aabd05d348da692b322520a54d83975e157639c2` |
| 取消 | `20d1f261-dd0a-401d-9b4f-06d395cd7b39` |
| 切断 | `54963902-a439-4193-ac7a-174fe1724b4c` |
| 再接続後の新規依頼 | `34ab12f0-dfd7-4ccd-8f96-a289fe96c123` |
| Worker回答再送 | `request-handoff-acceptance-persist-d2506127-79cf-4169-82b2-a65412a730d6` |

連続status取得のCF-Rayは`a4c5e07f2ac02da1-NRT`から`a4c5e0924f712da1-NRT`まで記録した。
初回のvoice/status530は原因未特定のまま。
今回再現しなかったことを恒久解消の根拠にはしない。
再発時は時刻、case、path、status、CF-Ray、WorkerとNodeのログ、トンネル生存を同時に確認する。

### 試験コードの訂正

最初の試行は別case cookieに401を期待したが、実装の秘匿応答は404だった。
期待値を実際の契約へ合わせて新規caseで再試験し、上記の結果を得た。
最初の試行はvoice接続、機器接続や回答保存の成功に数えない。

## 続けて確認する項目

16:41:15 JSTの実Live開始はcase`case-a5e9fe39bdada6aaa4ae048d7e4e0f2c0edafa00e9c2eb09cfae18310e9bd827`で403だった。
bridge-tokenとvoice/status、SSEまでは200。Nodeのerrors.jsonlは`A valid case-scoped bridgeToken is required.`を記録した。
画面は`Provider HTTP 403`と表示したが、失敗箇所はOpenAIへ到達する前のWorkerBridgeの証明検証だった。

独立に新規caseを作り、Worker発行証明を同じSTAFF_API_TOKENで検証した。
HMACとcaseは一致し、ローカル自己発行の証明は検証成功したが、Worker発行証明は残存期限902,173msだった。
共有verifyBridgeProofの上限900,000msを超え、発行元Workerと検証元Nodeの時計差で拒否されることを確認した。
時計差を許容する修正と回帰試験を別PRで進める。
この開始失敗を自動声交代の成功には数えない。

- 最新固定配備での自動声交代と、交代中に返る回答の1回の音声返却。
- HaaSから採用への交代、候補接続失敗時の旧会話と終了操作の維持。
- Live切断と再接続、ブラウザのSSE再購読、回答再送と遅着時の重複発話。
- 実機接続後、新規依頼で実ベル、受諾、実人間回答の保存と音声返却。

本記録作成時、本番Nodeの実機接続は未確認。
試験専用機器は切断して終了した。

## 時計差修正後の本番試験

Nodeはab9cedb、WorkerとFEは試験中にd22bc34、version`268f4a1b-6222-42a0-b5bc-86bd8637a7d2`へ更新された。
配備担当の確認ではd22bc34の差分はOrbのfrontend3ファイルで、NodeとBEはab9cedbと差分なし。
relayは`rep-butter-obligations-vehicles.trycloudflare.com`、同じNode4350を使用した。

### 取消と再購読の再試験

16:48:18〜16:49:21 JSTに前節と同じAPI試験を新規2caseで再実行し、全項目が成功した。
case Aは`case-0e66349cfd21ff7867f187d8698859414477cf9e5179f7e517d45f0f300e75a5`、case Bは`case-b851c33983bb119b4b2b0aa8d78aea9d2164e50823cda5bf4b24caea4be90eed`。
SSEは60,490msと60,412msで正常終了し、再購読200、voice/status8回とも200。
このAPI試験に実機とAgentの発話は含まない。

### 自動声交代と交代中回答の成功

合成した英語入力と`simulated=true`の模擬電話で同じ本番caseを使った。
模擬電話は本番Node4350のloopback bridgeに接続し、公開MCPとWorkerは実接続。
WebRTC入力を継続する無音を供給し、handoff HTTPの応答を人工的に保持しない条件で確認した。

| 項目 | 実測 |
| --- | --- |
| case | `case-58020d0179d44691e9824c49d1a5b165f733aa0b32d42a58cb72b6f38b200d51` |
| 自動振分け | receptionからhaas、言語en |
| 声 | shidaからmarin |
| handoffとactivate | 両方200。有効化はhandoff応答から約811ms後 |
| 元Live | `live_u7_EaFxSp3oN2jNgslaDQfeg4AhhY006YH4` |
| 新Live | `live_u7_EaFyRp3oNRPKfv40huJrU4YmUJ8AQU03` |
| handoff | `7e5c0a89-09d3-4a93-994d-ce4696e1f283` |
| 回答投入 | 候補Liveの作成約37ms後、16:51:57.345 JST相当の07:51:57.345Z |
| 機器ACK | handset.on_hook accepted=true |
| Worker保存 | revision5、answered、delivery=live_submitted、simulated=true、request1件 |
| 元Agent | `sess_059124bd5f9a9d60006ad47a7653b08196a52a9e6bfb7de547`へhuman_eventの再開1回 |
| 回答の字幕 | 新Liveで`The reported answer is React with TypeScript.`を1回確認 |
| 新peerの音声 | connected、受信2,970 packets、energy0.3060847、音声時間61.07秒 |
| 重複 | 人間依頼1件、human_eventのbackend.result1回。元routeはhaas |
| エラー | この成功確認時点でbackend.errorなし |

音声受信と同じLiveの字幕を確認した結果であり、利用者の耳による聴取や実マイク試験は含まない。
会話の引継ぎ案内は元Liveの出力に1回あり、activateで完了済み業務や人間依頼を再実行していない。

### 失敗した試験条件と訂正

先行case`case-4e706aee0751e3a14e69765e2b625a42037b88edb7a02a91f2b39b096fee7e5c`では、handoff応答を約15秒保持してから模擬回答を挿入した。
handoff/activate200、Worker回答保存、元Agentの再開までは通ったが、候補Liveは作成約30秒後にcontext_injection_incomplete、reason=expiredとなり閉じた。
旧peerは既に閉じており、この経過は旧会話維持の成功には数えない。

試験入力を調べたところ、短いAudioBufferの終了後にmedia-sourceの累積時間が18.8秒で止まっていた。
[OpenAIのセッション管理仕様](https://developers.openai.com/api/docs/guides/live-conversations)に従って連続無音を加え、応答の人工保持を除いた上記の再試験では、新peerの継続と音声回答を確認できた。
先行条件の失敗を製品側の原因特定や恒久不具合の再現と断定しない。

### 続く試験の中断

同じ成功caseでHaaSから採用への発話と候補接続故障の試験を開始したが、専用Chromeタブ122898402が操作セッションから消え、再取得でもnot foundとなった。
Nodeログでは採用Agentの作成とLiveの終了を確認した。
候補故障後のUIと採用への有効化を最終確認できなかったため、別の専用タブで新規試験する。
