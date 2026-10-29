export const WORK_SCENES = Object.freeze([
  { id: 'overlapping', title: '問い合わせが重なる', description: 'メールとチャットの相談が重なったとき、何に困っているかと急ぎ度を確かめ、対応の順番や引き継ぎ先を整理します。すべてにすぐ答えることが前提ではありません。' },
  { id: 'first-use', title: '初めて使う人を支援する', description: 'B2Bサービスを初めて使う担当者に、今見えている画面や試したことを聞き、小さな手順に分けて案内します。分かったことと、まだ難しいところを一緒に確かめます。' },
  { id: 'need-help', title: '自分では答えられない時', description: '技術や契約など自分だけでは判断できない相談は、確認できた事実と未確認の点を分けて専門担当へ渡します。返事の目安が決まらない場合は、その状況も伝えます。' }
]);
export function sceneById(id) { return WORK_SCENES.find(s => s.id === id) ?? null; }
export function sceneText(id, legacyText = '') {
  if (id === undefined || id === 'legacy') return legacyText || 'ジュニア CS：困っているお客さまの話を整理し、解決に必要な人へ引き継ぐ場面';
  const scene=sceneById(id);
  return scene ? `${scene.title}：${scene.description}` : '仕事の場面との結び付けは選んでいません。';
}
