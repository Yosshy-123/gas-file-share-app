/**
 * doGet エントリーポイントと画面描画(HTML返却)を担当する。
 * 実際のアップロード/ダウンロード処理は UploadService.gs / DownloadService.gs に、
 * token からレコードを引く処理は Storage.gs の resolveActiveRecord_ に委譲している。
 */

function doGet(e) {
  try {
    var token = e.parameter.token;
    if (token) {
      return showDownloadPage_(token);
    }
    return renderUploadPage_();
  } catch (err) {
    // Drive/Sheetsの一時的な障害・クォータ超過等、想定外の例外をここで必ず捕捉する。
    // 捕捉しない場合、GAS標準の生エラー画面(スタック情報等を含みうる)がそのまま
    // 利用者に表示されてしまうため、常に自前の安全な画面にフォールバックさせ、
    // 詳細はサーバー側ログにのみ残す。
    //
    // 「リンクが無効/期限切れ」(notfound/expired)とは意図的にステータスを分けている。
    // 一律 notfound にしてしまうと、実際にはシステム側の一時的な問題であるにも
    // 関わらず「リンクが恒久的に無効」であるかのように利用者に伝わってしまい、
    // 再試行すれば解決する可能性がある状況で利用者が諦めてしまう(UX上の不親切さ)。
    // 逆に notfound/expired 等の正常系の結果と紛れると運用者側もログを見なければ
    // システム障害の発生に気づけなくなるため、区別しておくことは運用面でも重要。
    console.error('doGet failed: ' + (err && err.stack ? err.stack : err));
    return renderDownloadPage_('error');
  }
}

/**
 * アップロード画面(token未指定時)
 */
function renderUploadPage_() {
  var props = PropertiesService.getScriptProperties();
  var siteKey = props.getProperty('TURNSTILE_SITE_KEY');
  // uploadFile() は verifyTurnstile_() 内で TURNSTILE_SECRET_KEY 未設定を
  // フェイルクローズ(エラー)として扱う。そのため画面側の「設定済み」判定も
  // SITE_KEY だけでなく SECRET_KEY の有無まで見て揃えておかないと、
  // 「ウィジェットは表示されCAPTCHAは通過できるのに、送信すると必ず
  // "サーバー側で未設定です" と失敗する」という利用者視点で原因不明の
  // 状態になってしまう。
  var secretKey = props.getProperty('TURNSTILE_SECRET_KEY');
  var turnstileConfigured = !!siteKey && !!secretKey;

  var template = HtmlService.createTemplateFromFile('Index');
  template.expiryOptions = VALID_EXPIRY_HOURS;
  template.defaultExpiry = DEFAULT_EXPIRY_HOURS;
  template.maxSizeMB = MAX_FILE_SIZE / (1024 * 1024);
  template.turnstileSiteKey = turnstileConfigured ? siteKey : '';
  template.turnstileConfigured = turnstileConfigured;
  return template.evaluate()
    .setTitle('ファイル共有')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * ダウンロード情報ページ(token指定時)
 */
function showDownloadPage_(token) {
  var resolved = resolveActiveRecord_(token);
  if (resolved.status !== 'ok') {
    return renderDownloadPage_(resolved.status);
  }
  return renderDownloadPage_('ok', {
    fileName: resolved.record.fileName,
    token: token,
    expiresAt: formatDateTime_(resolved.record.expiresAt)
  });
}

/**
 * Download.html を指定ステータスで描画する共通ヘルパー。
 * fields に渡したプロパティはそのままテンプレート変数として展開される。
 */
function renderDownloadPage_(status, fields) {
  var template = HtmlService.createTemplateFromFile('Download');
  template.status = status;
  for (var key in fields) {
    template[key] = fields[key];
  }
  return template.evaluate()
    .setTitle('ファイルダウンロード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
