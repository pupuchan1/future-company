# 音声オーブ

共通受付の VoiceOrb は青白い円形を保ち、短い状態だけを表示します。凡例・サンプル会話・追加の入口は設けません。

- ユーザー入力: 実音量と平滑化したPCMに応じて、円形の輪郭と表面がなめらかに歪む。
- AI音声: 実際に再生できているリモート音声の音量で円形の球が膨らみ、内部の流れと外向きのグレーの点線円が強まる。出力波・出力単独の球は歪ませず、入力の輪郭だけを歪ませる。
- 同時発話: 両方を表示。無音では発話エフェクトを消す。
- ミュート・無効/終了トラック・中断中のAudioContextは入力を表示しない。AI側のミュート・停止・音量0・再生拒否・play()未完了は出力を表示しない。
- 担当切替・会話終了では状態を消し、古い接続からの更新を無視する。
- スクロールでオーブが隠れると、同じ状態を右下の小さな円で表示する。クリックは元の場所に戻るだけで、新規接続を作らない。
- 動きを減らす設定では連続変形を止め、静止した球と短い状態テキストで区別する。

PR #26 の createAudioMeter を拡張し、既存のマイクとWebRTC受信ストリームを使います。通常接続ではAudioContextは1つ、各ストリームのAnalyserNodeも1つです。追加のgetUserMediaや、マイクからスピーカーへの接続はありません。30Hzの波形はVoiceActivityStore経由でオーブだけを更新し、会話スナップショットへの音量更新は約10Hzを保ちます。担当の声を切り替える間の候補接続の管理はPR #26の仕様を維持します。

描画はCanvas 2Dです。実音量で変形量・膨らみ・流れの速度を決め、円周方向の低域フィルターと時間方向の補間でPCMのギザギザを抑えます。球体内部に大きなグラデーションを重ねます。球体の外側にはグラデーションを出さず、以前の点線円をCanvasでグレーに描きます。録画済みGIFは使いません。無音では発話の歪み・外波を消し、球の中の緩やかな待機時の流れだけを残します。輪郭の変形量には上限を設け、丸い印象を保ちます。ユーザーの追加希望により、入力の輪郭の歪みは初版の2倍です。AI出力は追加指示でグレーの点線の正円に固定しています。周囲の柔らかいグラデーションは撤去し、球体の青白と周りのグレーを分けています。

描画はrequestAnimationFrameで補間し、画面外・タブ非表示で止めます。動きを減らす設定、リサイズ、再表示にも追従し、unmountでフレーム・監視・タイマーを解放します。Canvas非対応時のフォールバックも円形です。

## 確認

`npm run test:frontend` / `npm run typecheck:frontend` / `npm run build:frontend`

Vite開発サーバーの `/voice-effects.html` は検証専用です。2つの合成音声をMediaStream化して同じ解析処理に渡し、入力・出力・同時・無音・ミュート・再生拒否・終了と常駐表示を切り替えられます。音量スライダーは合成音声のGainNodeを変更します。「自分のマイクで試す」を押した場合だけ、許可されたマイクを同じメーターに接続して端末内で解析します。切替・終了・画面破棄で停止し、許可待ちの遅い応答も破棄します。AI API・スピーカー出力・音声保存は使用しません。メイン画面の操作導線には出さず、本番ビルドのentryにも含めません。

自動テストはPCMからの波形生成、ノイズ除外、入出力の独立性、ミュート・再生拒否・終了後の無効化、単一グラフでの取得、ノード解放を確認します。合成信号による表示検証と、実際のAIとの通話検証は別です。

参照: [Web Audioによる可視化（MDN）](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Visualizations_with_Web_Audio_API)
見た目の参照: [ChatGPT Voice公式デモ](https://chatgpt.com/features/voice/)の球の内部を流れる色と、[ElevenLabs Orb公式デモ](https://ui.elevenlabs.io/docs/components/orb)の待機/入力/発話の違いを実際に確認。ElevenLabsの公開APIは入力/出力音量を個別に受け取り、WebGLで描画する仕様です。本実装は見た目と音量連動の考え方を参考にした独自のCanvas描画で、公式コード・映像は転載していません。ChatGPT内部の描画アルゴリズムは公開ページからは確認できません。

判断記録: [#29](https://github.com/pupuchan1/future-company/issues/29)、[#37](https://github.com/pupuchan1/future-company/issues/37)、[#42](https://github.com/pupuchan1/future-company/issues/42)、[#46](https://github.com/pupuchan1/future-company/issues/46)、[#47](https://github.com/pupuchan1/future-company/issues/47)、[#48](https://github.com/pupuchan1/future-company/issues/48)
