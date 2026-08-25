/**
 * アップロード処理。
 */

/**
 * クライアント(Index.html)から google.script.run 経由で呼ばれる。
 * base64Data: "data:application/pdf;base64,xxxx" 形式の文字列
 * turnstileToken: Cloudflare Turnstile ウィジェットが発行した検証トークン
 */
function uploadFile(base64Data, fileName, expiryHours, turnstileToken) {
  try {
    // Turnstile検証は重い処理(外部HTTP)なのでロック取得前に行い、ロック保持時間を最小化する
    if (!verifyTurnstile_(turnstileToken)) {
      throw userError_('ロボットではないことの確認に失敗しました。ページを再読み込みしてから、もう一度お試しください。');
    }

    fileName = sanitizeFileName_(fileName);

    var matches = base64Data.match(/^data:(.*?);base64,(.*)$/);
    if (!matches) {
      throw userError_('ファイル形式が不正です。');
    }
    var mimeType = matches[1];
    var rawBase64 = matches[2];

    // mimeTypeにも長さ上限を設ける(fileNameと違いsanitizeFileName_のような切り詰めが
    // なかったため、ここで巨大な文字列を弾かないとシートへの書き込みでロックを浪費しうる)
    if (mimeType.length > MAX_MIME_TYPE_LENGTH) {
      throw userError_('ファイル形式が不正です。');
    }

    var byteSize = estimateBase64ByteSize_(rawBase64);
    if (byteSize > MAX_FILE_SIZE) {
      throw userError_('ファイルサイズが上限(' + (MAX_FILE_SIZE / (1024 * 1024)) + 'MB)を超えています。');
    }

    expiryHours = Number(expiryHours);
    if (VALID_EXPIRY_HOURS.indexOf(expiryHours) === -1) {
      expiryHours = DEFAULT_EXPIRY_HOURS;
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_WAIT_TIMEOUT_MS);
    try {
      var decoded = Utilities.base64Decode(rawBase64);
      var blob = Utilities.newBlob(decoded, mimeType, fileName);

      var folder = getOrCreateFolder_();
      var file = folder.createFile(blob);

      var token = generateToken_();
      var now = new Date();
      var expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

      // appendRow は列の並び順が COL_TOKEN, COL_FILE_ID, COL_FILE_NAME, COL_MIME_TYPE,
      // COL_EXPIRES_AT (Storage.gs の getOrCreateSheet_ のヘッダー定義) と一致している必要がある
      var sheet = getOrCreateSheet_();
      sheet.appendRow([
        token,
        file.getId(),
        sanitizeForSheet_(fileName),
        sanitizeForSheet_(mimeType),
        expiresAt
      ]);

      var url = ScriptApp.getService().getUrl() + '?token=' + encodeURIComponent(token);

      return {
        success: true,
        url: url,
        fileName: fileName,
        expiresAt: formatDateTime_(expiresAt)
      };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    if (err && err.isUserError) {
      return { success: false, error: err.message };
    }
    // 想定外のエラー(Driveの割り当て超過やネットワーク障害等)は詳細をクライアントに
    // 返さず、サーバー側ログにのみ残す(内部情報の開示を防ぐため)。
    console.error('uploadFile failed: ' + (err && err.stack ? err.stack : err));
    return { success: false, error: 'アップロードに失敗しました。しばらくしてから再度お試しください。' };
  }
}

/**
 * Cloudflare Turnstile のトークンをサーバー側で検証する。
 * シークレットキー未設定の場合は「フェイルクローズ」(アップロードを拒否)する。
 */
function verifyTurnstile_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET_KEY');
  if (!secret) {
    throw userError_('サーバー側でTurnstileが未設定です。管理者に連絡してください。');
  }
  if (!token) {
    return false;
  }

  var res = UrlFetchApp.fetch(TURNSTILE_VERIFY_URL, {
    method: 'post',
    payload: {
      secret: secret,
      response: token
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== HTTP_STATUS_OK) {
    return false;
  }

  var json = JSON.parse(res.getContentText());
  return !!json.success;
}
