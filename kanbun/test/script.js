function getGraphemeCount(str) {
  const segmenter = new Intl.Segmenter("ja-JP", { granularity: "grapheme" });

  // ここで使用されている Segments オブジェクトのイテレーターは、文字を書記素で反復処理します。
  // 文字は複数の Unicode 文字で構成されている場合があります。
  return [...segmenter.segment(str)].length;
}
