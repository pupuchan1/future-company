# DevDay 活用とエージェントの受入チェック

2026-10-18 時点の公式資料と changelog を確認。過去の AI Catchup の紹介時点と現在の API 提供状況を分ける。

**15:50時点の実測:** GPT Live、Decisions、Agents API、公開MCP、人間回答のWorker保存と元Agentへの返却は実APIで接続済み。HaaSの調査・技能検索・依頼・回答照合も実Agentsで確認した。実ブラウザー試験の入力音声と電話側は模擬であり、実機ベル、人間の通話音声、実Work/dotsからのMCP Events購読は別途確認が必要。担当別の自動音声切替は #35 で修正中。詳細は [VERIFICATION.md](VERIFICATION.md)。

| 機能 | 今回の使い方 | 確認するもの |
| --- | --- | --- |
| GPT Live | 総合受付、日英会話、会話を保った委譲 | WebRTC音声往復、session.started、sideband、終了 |
| Agents API | 採用/HaaS別担当の文脈、面談template読取、MCP相談と回答復帰 | 完了したturnと実際のMCP結果 |
| Decisions API | 言語・用件のchoice分類 | 最新発話との相関、拒否/低confidence時に既存値維持 |
| Live native Decisions（10/15） | transcript triggerから担当・言語の候補を取得 | source_event_idが最新の入力と一致。担当確定は委譲時の全文分類 |
| 日本語音声 | `shida`、起動時に設定 | 実音声。言語は国籍推定ではない |
| MCP 2 | 面談template、人間相談、状態・取消 | 認証、冪等性、実ツール呼出し |
| MCP Events | 人間相談の状態を購読者へ配信 | 検証callback、署名、同じeventIdで再送、解除・失効 |
| Codex | チームの実装、Issue/PRによる共有 | 対象IssueとDraft PR、マージ時の判断 |

採用デモを最初に完成させ、非採用の判断・仕事依頼は共通HaaS担当へ接続する。prompt-to-voice、Computer Use、別の声への切替、業種別の専用画面は追加案。実装していない機能を「使用中」とスライドへ書かない。

- [ ] 総合受付へ「採用面談を受けたい」と話すと採用担当へ切り替わる
- [ ] Englishへの切替で会話文脈を保ち、次の質問を英語で返す
- [ ] 面談テンプレートに沿って一問ずつ聞き、応募者の発言を整理する
- [ ] 人間への相談が必要なとき、MCPが一度だけ呼ばれる
- [ ] 人間の回答本文が元担当へ戻り、利用者の現在の言語で説明される
- [ ] 採用以外の相談はHaaS担当へ渡り、同じMCPで人間に依頼できる
- [ ] 実機未接続なら未接続、simulatorなら模擬と表示される
- [ ] 取消・切断・timeout・終了の後始末を確認
- [ ] マイク→Live→スピーカーの実音声往復を確認
- [ ] バックエンドチームと実ベル・受話器・音声経路を確認
- [ ] 実ChatGPT Work/dotsからMCP Eventsの購読を確認（ローカルWebhook試験とは別）
- [ ] 上記の結果をPR本文に記載し、マージ時に判断

## 出典と時点

- [DevDay 2026 recap](https://openai.com/index/devday-2026-recap/)、[API changelog](https://developers.openai.com/api/docs/changelog)。GPT Live GA・Agents API betaは9/10、DevDayは9/29。すべてが9/29初公開とは表現しない。
- [GPT Live](https://developers.openai.com/api/docs/guides/live)、[delegation](https://developers.openai.com/api/docs/guides/live-delegation)、[session](https://developers.openai.com/api/docs/guides/live-conversations)。APIモデルIDは`gpt-live-1`。未確認の`gpt-live-1.1`を設定しない。
- [Decisionsと音声](https://developers.openai.com/api/docs/guides/decisions-voice)。10/6 beta、10/15 native Live対応。client delegationと独立したtranscript triggerを使える。
- [Agents quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart)、[MCP connections](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)、[events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)。observer切断はturn取消ではない。
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)。MCP2、HTTPS Webhook、署名・購読検証・重複を考慮。Agents APIが自動購読する保証は確認できていない。
- [Custom voices](https://developers.openai.com/api/docs/guides/custom-voices)。10/16 prompt-to-voiceは追加候補。今回の必須経路には不要。

公式の業務音声・ハード連携例は、会話と業務判断・実作業を分ける参考になる：[voice agent evaluation](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation)、[LED display](https://developers.openai.com/blog/bringing-my-led-display-to-life)。黒電話の実回路がこの例だけで動くとは扱わない。
