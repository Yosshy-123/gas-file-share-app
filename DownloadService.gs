/**
 * ダウンロード処理。
 *
 * 【設計】Apps Script の doGet は HtmlOutput または TextOutput 以外の値を返せない仕様のため、
 * Blob を直接 return することはできない(実行すると「返された値はサポートされている
 * 戻り値の型ではありませんでした」というエラーになる)。
 * そのため、ダウンロードボタン押下時に google.script.run 経由でこのファイルの
 * getFileForDownload() を呼び出し、ファイル本体をbase64文字列として受け取ったうえで、
 * クライアント側のJavaScriptでBlobに変換してダウンロードを発火させる方式を取っている
 * (google.script.run はHtmlOutputの制約を受けないため、プレーンなデータを直接返せる)。
 *
 * ファイル形式を制限していない代わりに、Download.html 側で Blob の Content-Type を必ず
 * application/octet-stream に強制している。これにより、たとえ HTML/SVG/JS 等の
 * アクティブコンテンツがアップロードされていても、ブラウザ上で実行・レンダリングされず
 * 「ダウンロードのみ」となる(実行するかどうかはダウンロードした本人の判断に委ねられる)。
 */

/**
 * クライアント(Download.html)から google.script.run 経由で呼ばれる。
 * ダウンロードボタン押下時に、ページ遷移せずその場でファイル本体を取得するための
 * エントリーポイント。
 *
 * 【重要】doGet と同様、匿名の第三者から直接呼び出される想定の公開エントリーポイントなので、
 * ここでも resolveActiveRecord_() による token 検証・期限切れ判定を必ず行う
 * (呼び出し元であるDownload.html側のチェックだけに依存しない)。
 */
function getFileForDownload(token) {
  try {
    var resolved = resolveActiveRecord_(token);
    if (resolved.status !== 'ok') {
      return { success: false, status: resolved.status };
    }

    var bytes;
    try {
      // ファイルの取得(Drive上に実体が存在するか)と、Blob化・バイト列取得の両方を
      // 同じtry/catchで保護する。ファイルが破損している、直前に削除された等の
      // 予期しない例外がここで発生しても呼び出し元まで無防備に伝播させず、
      // 一律「notfound」として扱う。
      var file = DriveApp.getFileById(resolved.record.fileId);
      bytes = file.getBlob().getBytes();
    } catch (err) {
      return { success: false, status: 'notfound' };
    }

    // base64化するとサイズは約4/3倍になる(MAX_FILE_SIZE=20MBなら最大約27MB相当)。
    // google.script.run のレスポンスサイズには実務上の上限があるため、MAX_FILE_SIZE を
    // 大きく変更する場合はダウンロードが正常に完了するか事前に確認すること。
    return {
      success: true,
      fileName: resolved.record.fileName,
      base64Data: Utilities.base64Encode(bytes)
    };
  } catch (err) {
    console.error('getFileForDownload failed: ' + (err && err.stack ? err.stack : err));
    return { success: false, status: 'error' };
  }
}
