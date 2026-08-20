/**
 * GAS ファイル共有アプリ
 * 仕様書: アップロード → 期限付きURL発行 → URLからダウンロード → 期限切れ後は自動削除
 *
 * セキュリティ対策(初回セットアップ必須):
 *   スクリプトエディタ左メニュー「プロジェクトの設定」→「スクリプト プロパティ」で以下を設定してください。
 *     TURNSTILE_SITE_KEY   : Cloudflare Turnstile のサイトキー(公開してよい値)
 *     TURNSTILE_SECRET_KEY : Cloudflare Turnstile のシークレットキー(絶対に公開しない)
 *   取得方法は README.md を参照してください。
 */

// ==== 設定値 ====
var MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
var MAX_MIME_TYPE_LENGTH = 255; // data:URLのMIMEタイプ部分の長さ上限(不正な巨大文字列の混入防止)
var FOLDER_NAME = 'FileShareApp_Storage';
var SHEET_NAME = 'FileShareApp_DB';
var DEFAULT_EXPIRY_HOURS = 24; // 1日
var VALID_EXPIRY_HOURS = [1, 3, 6, 12, 24, 72, 168]; // 1h,3h,6h,12h,1d,3d,7d
var TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
var DELETE_TRIGGER_HANDLER = 'deleteExpiredFiles_';
var DELETE_TRIGGER_INTERVAL_MINUTES = 15;

// 管理用スプレッドシート(DBシート)の列レイアウト。マジックナンバー撲滅のため一元管理する。
var COL_TOKEN = 1;
var COL_FILE_ID = 2;
var COL_FILE_NAME = 3;
var COL_MIME_TYPE = 4;
var COL_EXPIRES_AT = 5;
var COLUMN_COUNT = 5;
var HEADER_ROW = 1;
var DATA_START_ROW = 2; // ヘッダー行の次の行
// 列順は COL_TOKEN, COL_FILE_ID, COL_FILE_NAME, COL_MIME_TYPE, COL_EXPIRES_AT と一致させる
var SHEET_HEADERS = ['token', 'fileId', 'fileName', 'mimeType', 'expiresAt'];

// ファイル形式は原則すべて許可する(拡張子・MIMEタイプによる制限は行わない)。
// 代わりに、配信時に必ず application/octet-stream として返す「強制ダウンロード」方式で、
// HTML/SVG/JS等がブラウザ上で実行・レンダリングされることを防いでいる(serveFile_ 参照)。

// ==== エントリーポイント ====

function doGet(e) {
  var token = e.parameter.token;
  var action = e.parameter.action;

  if (token) {
    if (action === 'download') {
      return serveFile_(token);
    }
    return showDownloadPage_(token);
  }

  var siteKey = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SITE_KEY');

  var template = HtmlService.createTemplateFromFile('Index');
  template.expiryOptions = VALID_EXPIRY_HOURS;
  template.defaultExpiry = DEFAULT_EXPIRY_HOURS;
  template.maxSizeMB = MAX_FILE_SIZE / (1024 * 1024);
  template.turnstileSiteKey = siteKey || '';
  template.turnstileConfigured = !!siteKey;
  return template.evaluate()
    .setTitle('ファイル共有')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * クライアント(Index.html)から google.script.run 経由で呼ばれる
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
    lock.waitLock(30000);
    try {
      var decoded = Utilities.base64Decode(rawBase64);
      var blob = Utilities.newBlob(decoded, mimeType, fileName);

      var folder = getOrCreateFolder_();
      var file = folder.createFile(blob);

      var token = generateToken_();
      var now = new Date();
      var expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

      // appendRow は列の並び順が COL_TOKEN, COL_FILE_ID, COL_FILE_NAME, COL_MIME_TYPE,
      // COL_EXPIRES_AT (getOrCreateSheet_ のヘッダー定義) と一致している必要がある
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

  if (res.getResponseCode() !== 200) {
    return false;
  }

  var json = JSON.parse(res.getContentText());
  return !!json.success;
}

/**
 * ファイル名の最低限の安全化。拡張子や形式による制限はしない(全形式許可の方針)が、
 * パス区切り文字や制御文字を除去し、空/過長なファイル名を弾く。
 * (実際にDriveへ保存するファイル名・ダウンロード時のファイル名として使われる値)
 */
function sanitizeFileName_(fileName) {
  if (!fileName) {
    throw userError_('ファイル名が不正です。');
  }
  // パス区切り・制御文字を除去(Driveのファイル名として不正な文字の混入防止)
  var cleaned = fileName.replace(/[\/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
  if (!cleaned) {
    throw userError_('ファイル名が不正です。');
  }
  if (cleaned.length > 200) {
    cleaned = cleaned.substring(0, 200);
  }
  return cleaned;
}

/**
 * 管理用スプレッドシートのセルに書き込む文字列を「数式インジェクション(CSVインジェクション)」から保護する。
 * 拡張子/形式の制限を撤廃したことで fileName・mimeType には任意の文字列が入り得るため、
 * = / + / - / @ で始まる値をそのままセルに書き込むと、シートを開いた際にGoogle Sheetsが
 * これを数式として評価してしまう(外部URLへの自動アクセス等につながる恐れがある)。
 * 先頭にアポストロフィを付与することで、Sheets側に「これは文字列である」ことを明示させ、
 * 数式として評価されないようにする。
 * (アポストロフィはSheetsの書式指定として扱われ、getValues()で読み出した際の文字列値には含まれない)
 *
 * 呼び出し元(uploadFile)では常に検証済みの文字列を渡すため、null/undefined は考慮しない。
 */
function sanitizeForSheet_(str) {
  // 念のため制御文字(タブ・改行等)も除去しておく
  str = str.replace(/[\x00-\x1f]/g, '');
  return /^[=+\-@]/.test(str) ? "'" + str : str;
}

/**
 * base64文字列(パディング "=" を含む)からデコード後のバイト数を見積もる。
 * 末尾のパディングを考慮しないと実際のバイト数より大きく見積もってしまうため、
 * その分を差し引いて正確な値に近づけている。
 */
function estimateBase64ByteSize_(rawBase64) {
  var padding = (rawBase64.match(/=+$/) || [''])[0].length;
  return Math.floor(rawBase64.length * 3 / 4) - padding;
}

/**
 * ダウンロード情報ページ(token指定・action未指定時)
 */
function showDownloadPage_(token) {
  var record = getFileByToken_(token);

  if (!record) {
    return renderDownloadPage_('notfound');
  }
  if (new Date() > record.expiresAt) {
    return renderDownloadPage_('expired');
  }
  return renderDownloadPage_('ok', {
    fileName: record.fileName,
    token: token,
    expiresAt: formatDateTime_(record.expiresAt)
  });
}

/**
 * 実ファイル配信(token指定・action=download)
 * 有効な場合は Blob を直接返却してブラウザにダウンロードさせる。
 *
 * ファイル形式を制限していない代わりに、ここで必ず Content-Type を
 * application/octet-stream に強制している。これにより、たとえ HTML/SVG/JS 等の
 * アクティブコンテンツがアップロードされていても、ブラウザ上で実行・レンダリングされず
 * 「ダウンロードのみ」となる(実行するかどうかはダウンロードした本人の判断に委ねられる)。
 */
function serveFile_(token) {
  var record = getFileByToken_(token);

  if (!record || new Date() > record.expiresAt) {
    return renderDownloadPage_(record ? 'expired' : 'notfound');
  }

  var file;
  try {
    file = DriveApp.getFileById(record.fileId);
  } catch (err) {
    return renderDownloadPage_('notfound');
  }

  // 元のファイル名(拡張子含む)は維持しつつ、Content-Typeだけ octet-stream に差し替えて
  // ブラウザに「開く」ではなく必ず「ダウンロード」させる
  var bytes = file.getBlob().getBytes();
  return Utilities.newBlob(bytes, 'application/octet-stream', record.fileName);
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
  return template.evaluate().setTitle('ファイルダウンロード');
}

// ==== 期限切れファイルの自動削除(時間主導型トリガーから実行) ====

/**
 * 期限切れファイルを削除する。時間主導型トリガー(setupTrigger が登録)からのみ
 * 呼び出される想定の管理用関数。
 *
 * セキュリティ上の注意: 末尾のアンダースコアは単なる命名規則ではなく、Apps Script の
 * 仕様上 google.script.run からのクライアント呼び出しを遮断する効果を持つ。この関数は
 * デプロイ設定上「オーナー権限で実行」されるため、アンダースコアを外して公開してしまうと
 * 匿名の第三者がこの関数を任意のタイミングで実行できてしまう(最小権限の原則違反)。
 * 今後この関数を分割・追加する場合も、クライアントに公開する意図がない限り
 * 末尾に "_" を付けること。
 */
function deleteExpiredFiles_() {
  var sheet = getOrCreateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) {
    return; // データ行なし
  }

  var numDataRows = lastRow - HEADER_ROW;
  // 判定に使う expiresAt 列だけを読み込む。token/fileId/fileName/mimeType は
  // 期限切れと判明した行についてのみ後述で個別に取得するため、ここでは取得しない。
  var expiresAtValues = sheet.getRange(DATA_START_ROW, COL_EXPIRES_AT, numDataRows, 1).getValues();
  var now = new Date();

  // 下から走査して行削除時のインデックスずれを防ぐ
  for (var i = numDataRows - 1; i >= 0; i--) {
    var expiresAt = new Date(expiresAtValues[i][0]);

    if (now > expiresAt) {
      var rowIndex = i + DATA_START_ROW; // シート上の実際の行番号
      var fileId = sheet.getRange(rowIndex, COL_FILE_ID, 1, 1).getValue();
      removeFilePermanently_(fileId);
      sheet.deleteRow(rowIndex);
    }
  }
}

/**
 * ファイルを完全削除する。Drive詳細サービス(Drive API v2)が有効な場合は
 * ゴミ箱を経由せず完全削除し、無効/失敗時のみゴミ箱への移動にフォールバックする。
 * 詳細サービスの有効化方法は README.md を参照。
 */
function removeFilePermanently_(fileId) {
  try {
    if (typeof Drive !== 'undefined' && Drive.Files && Drive.Files.remove) {
      Drive.Files.remove(fileId);
      return;
    }
  } catch (e) {
    // 詳細サービス未有効 or 対象ファイルが既に存在しない等 → ゴミ箱へフォールバック
  }
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (e2) {
    // ファイルが既に存在しない場合はスキップ
  }
}

/**
 * トリガーのセットアップ。Apps Script エディタの関数選択プルダウンで "setupTrigger" を
 * 選んで手動で一度だけ実行する(README参照)。15分ごとに deleteExpiredFiles_ を実行し、
 * 期限切れ後にファイル実体が残る時間を最短化する。
 *
 * セキュリティ上の注意: この関数は "_" を付けていないため、理論上は google.script.run
 * からも呼び出せてしまう。そのため冒頭で isAuthorizedOwner_() により「実行者がこの
 * スクリプトのオーナー本人かどうか」を検証し、オーナー以外(匿名の第三者を含む)からの
 * 呼び出しは例外を投げて拒否する。
 */
function setupTrigger() {
  if (!isAuthorizedOwner_()) {
    throw new Error('この操作はスクリプトのオーナーのみ実行できます。');
  }

  // 既存の同名トリガーを削除してから再作成(重複防止)
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === DELETE_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger(DELETE_TRIGGER_HANDLER)
    .timeBased()
    .everyMinutes(DELETE_TRIGGER_INTERVAL_MINUTES)
    .create();
}

/**
 * 実行者がこのスクリプトのオーナー本人かどうかを判定する。
 *
 * Session.getActiveUser().getEmail() で「今この関数を呼んでいる人」のメールアドレスを取得し、
 * ScriptApp.getScriptId() が指すスクリプトファイル自体のDrive上のオーナーと比較する。
 * (このプロジェクトは既に DriveApp を使用しているため、追加の権限承認は発生しない)
 *
 * 注意点:
 *  - Session.getActiveUser().getEmail() は、ドメイン設定等により空文字を返す場合がある。
 *    その場合は「本人と確認できない」としてフェイルクローズ(拒否)する。
 *  - エディタから直接実行した場合は、実行者=あなた自身のアカウントが active user になるため、
 *    通常はオーナー本人であれば問題なく true が返る。
 */
function isAuthorizedOwner_() {
  var activeEmail = Session.getActiveUser().getEmail();
  if (!activeEmail) {
    return false;
  }
  try {
    var ownerEmail = DriveApp.getFileById(ScriptApp.getScriptId()).getOwner().getEmail();
    return activeEmail === ownerEmail;
  } catch (e) {
    // オーナー情報が取得できない場合も安全側に倒して拒否する
    return false;
  }
}

// ==== ユーティリティ ====

/**
 * ユーザーにそのまま見せてよい「想定内のエラー」であることを示すマーカーを付与する。
 * uploadFile() の catch でこのマーカーの有無を見て、想定外のシステムエラー(Driveの
 * 割り当て超過等の内部情報)をクライアントに漏らさないようにするために使う。
 */
function userError_(message) {
  var err = new Error(message);
  err.isUserError = true;
  return err;
}

/**
 * 日時を画面表示用の "yyyy/MM/dd HH:mm" 形式(スクリプトのタイムゾーン基準)に整形する。
 */
function formatDateTime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
}

function generateToken_() {
  // UUID v4(ハイフン除去で32文字の16進数、約122ビットのランダム性)は
  // 推測不可能なURLトークンとして十分な強度を持つ。
  return Utilities.getUuid().replace(/-/g, '');
}

function getOrCreateFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FOLDER_ID');

  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // フォルダが見つからない場合は再作成
    }
  }

  var folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateSheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  var ss;

  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      ss = null;
    }
  }

  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    props.setProperty('SHEET_ID', ss.getId());
  }

  var sheet = ss.getSheetByName('DB');
  if (!sheet) {
    // 新規作成直後のスプレッドシートには既定シートが1枚だけ存在するので、それをリネームして使う
    sheet = ss.getSheets()[0];
    sheet.setName('DB');
  }

  if (sheet.getLastRow() === 0) {
    // 列順は COL_TOKEN, COL_FILE_ID, COL_FILE_NAME, COL_MIME_TYPE, COL_EXPIRES_AT と一致させる
    sheet.appendRow(SHEET_HEADERS);
  }

  return sheet;
}

/**
 * token に一致する行を TextFinder で検索する。シート全件を読み込まずに検索できるため、
 * 登録件数が増えても性能が悪化しにくい。
 */
function getFileByToken_(token) {
  var sheet = getOrCreateSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) {
    return null;
  }

  var found = sheet.getRange(DATA_START_ROW, COL_TOKEN, lastRow - HEADER_ROW, 1)
    .createTextFinder(token)
    .matchEntireCell(true)
    .matchCase(true)
    .findNext();
  if (!found) {
    return null;
  }

  var rowIndex = found.getRow();
  var row = sheet.getRange(rowIndex, COL_TOKEN, 1, COLUMN_COUNT).getValues()[0];

  return {
    token: row[COL_TOKEN - 1],
    fileId: row[COL_FILE_ID - 1],
    fileName: row[COL_FILE_NAME - 1],
    mimeType: row[COL_MIME_TYPE - 1],
    expiresAt: new Date(row[COL_EXPIRES_AT - 1])
  };
}
