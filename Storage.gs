/**
 * Drive(ファイル保存フォルダ)・Sheets(トークン管理DB)へのアクセスを担う層。
 * 「tokenやfileIdから実データをどう取得・保存するか」という関心事をここに閉じ込め、
 * Router.gs / UploadService.gs / DownloadService.gs / Maintenance.gs からはこの層の
 * 関数を呼ぶだけで済むようにする。
 */

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
 * 見つからない場合、および token が形式的に不正な場合は null を返す
 * (Sheets APIへの問い合わせ前に resolveActiveRecord_ 側で早期リジェクトされるのが通常だが、
 * この関数単体で呼ばれても安全なように自衛する)。
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

/**
 * token からアクティブな(=存在し、かつ期限切れでない)ファイルレコードを解決する。
 *
 * 「tokenを安全なレコードに変換する」処理を一箇所に集約することで、Router.gs
 * (画面表示・doGet経由)と DownloadService.gs(google.script.run経由)という
 * 2つの呼び出し経路で判定基準がズレるのを防ぐ。
 *
 * @param {string} token
 * @return {{status: string, record: (Object|null)}} status は 'ok' | 'expired' | 'notfound'
 */
function resolveActiveRecord_(token) {
  // generateToken_ が生成する形式(32文字の16進数)に一致しない token は、
  // Sheetsへ問い合わせるまでもなく無効なリンクと確定できるため早期リジェクトする。
  // これによりレート制限のない現状でも無駄なSheets APIアクセスを抑えられる。
  if (!TOKEN_PATTERN.test(token)) {
    return { status: 'notfound', record: null };
  }

  var record = getFileByToken_(token);
  if (!record) {
    return { status: 'notfound', record: null };
  }
  if (isExpired_(record.expiresAt)) {
    return { status: 'expired', record: null };
  }
  return { status: 'ok', record: record };
}
