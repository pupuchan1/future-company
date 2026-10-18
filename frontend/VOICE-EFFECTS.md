# 音声オーブ

共通受付の VoiceOrb は青白い円形を保ち、短い状態だけを表示します。凡例・サンプル会話・追加の入口は設けません。

- ユーザー入力: マイクのPCM波形を円周に描く実線。
- AI音声: 実際に再生できているリモート音声の音量に連動する、外向きの点線リング。
- 同時発話: 両方を表示。無音では発話エフェクトを消す。
- ミュート・無効/終了トラック・中断中のAudioContextは入力を表示しない。AI側のミュート・停止・音量0・再生拒否・play()未完了は出力を表示しない。
- 担当切替・会話終了では状態を消し、古い接続からの更新を無視する。
- スクロールでオーブが隠れると、同じ状態を右下の小さな円で表示する。クリックは元の場所に戻るだけで、新規接続を作らない。
- 動きを減らす設定では連続変形を止め、実線/点線の静的リングと状態テキストで区別する。

PR #26 の createAudioMeter を拡張し、既存のマイクとWebRTC受信ストリームを使います。通常接続ではAudioContextは1つ、各ストリームのAnalyserNodeも1つです。追加のgetUserMediaや、マイクからスピーカーへの接続はありません。30Hzの波形はVoiceActivityStore経由でオーブだけを更新し、会話スナップショットへの音量更新は約10Hzを保ちます。担当の声を切り替える間の候補接続の管理はPR #26の仕様を維持します。

全体の角丸禁止CSSよりオーブの円形を優先します。これは装飾的なカードの角丸ではなく、音声を示す図形の形状です。

## 確認

`npm run test:frontend` / `npm run typecheck:frontend` / `npm run build:frontend`

Vite開発サーバーの `/voice-effects.html` は検証専用です。2つの合成音声をMediaStream化して同じ解析処理に渡し、入力・出力・同時・無音・ミュート・再生拒否・終了と常駐表示を切り替えられます。マイク・AI API・スピーカー出力は使用しません。メイン画面の操作導線には出さず、本番ビルドのentryにも含めません。

自動テストはPCMからの波形生成、ノイズ除外、入出力の独立性、ミュート・再生拒否・終了後の無効化、単一グラフでの取得、ノード解放を確認します。合成信号による表示検証と、実際のAIとの通話検証は別です。

参照: [Web Audioによる可視化（MDN）](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Visualizations_with_Web_Audio_API)
判断記録: [#29](https://github.com/pupuchan1/future-company/issues/29)、[#37](https://github.com/pupuchan1/future-company/issues/37)
