# ローカル音声受付の結合確認

2026-10-18、feature/19-voice-demoで、共通受付画面から実gpt-live-1・Agents・認証付きMCP・Worker回答保存を同じ案件で結合した。
ブラウザー入力はmacOSの合成音声であり、実マイクや実人間の音声ではない。
人間側は明示的な電話シミュレーターを使った。

## 確認した経路

1. 実React画面でEnglishを選び、共通の開始ボタンを押した。
2. Worker案件作成201、所有者cookieでcase限定bridge-token取得200、認可voice relayでLive開始200。
3. 合成音声で、共有電話のバックエンド担当者へ開発言語とフロントエンドframeworkの確認を依頼した。
4. 実HaaS Agentが同じNodeの認証付きMCPへ人間依頼を送り、シミュレーターが架空のTypeScript/React回答を返した。
5. Node/Workerの社員認証・claim・revisionを通して保存した回答が元のHaaS Agentへ戻り、Liveの音声と字幕へ反映された。
6. 画面の終了ボタンからDELETE 200、`closed=true`、`live_finalized=true`、`cleanup_pending=[]`を受領。私有resource記録でもAgent削除とLive終了を確認した。

保存案件の再取得はHTTP200、revision 5、依頼はanswered・simulated=true、元routeはhaas、deliveryはlive_submittedだった。
65秒時点でWebRTC/ICEはconnected、受信音声2,931packets、totalAudioEnergy 0.3613773466594886。
回答前55秒のenergy 0.18480116720732012から増加し、同時に字幕へ「the team uses TypeScript and React」が出た。
最終字幕は実人間に確認した情報ではなく、デモの模擬回答だと明示した。
`live_submitted`自体は音声説明完了のACKではない。

## 起動と検証の範囲

Node/Worker専用の設定を[README](../README.md#ローカル起動)に記載した。
許可済みの一時トンネルは`npm run dev -- --mcp-tunnel`で同じNode relayへ接続する。
画面5173・Worker8787・Node4320・relay4330はいずれもloopbackで待ち受ける。
MCPのトンネル越し未認証アクセスは401、Bearer認証付きの技能検索は成功した。
社員キー・MCPキー・連携署名・case証明は証跡やソースに保存していない。

差分に絞ったFE21テスト、配送前の応答紛失・Agent待ち中取消の2テスト、FE/Worker/relay型検査とFEbuildが成功。
lintはエラーなし、既存OrbとLegacyPrototypeのwarningが残る。
全試験や単独モデルの成功済みsmokeは繰り返していない。

実マイク・スピーカーでの聞き取り、黒電話実機、手動の担当ボイス切替、本番Cloudflareへの配置はこの試験では確認していない。
公開deploy・main merge・既存Access変更は行っていない。
ブラウザー証跡、入力WAV、Worker再取得と私有ログは実行環境のワークフローメモリに保存した。
