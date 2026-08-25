/**
 * 期限切れファイルの自動削除(時間主導型トリガーから実行)・トリガー管理。
 */

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
 *
 * 排他制御について: Drive/Sheetsの応答遅延等により前回の実行が15分を超えて
 * 完了していない状態で次のトリガーが起動すると、同じ行を対象に削除処理が
 * 二重に走る可能性がある(実害は例外がcatchされる程度だが、無駄なAPI呼び出しや
 * ログの混乱を招く)。これを避けるため uploadFile と同じスクリプト全体のロックを
 * 使って多重実行を防止する。ロックが取得できない場合(＝前回の実行がまだ
 * 進行中、またはuploadFileが実行中)は、最大 DELETE_LOCK_WAIT_TIMEOUT_MS(短時間)
 * だけ待って、それでも取得できなければ諦めて何もせず終了する(＝待ち続けて
 * トリガーの実行時間を浪費することはしない)。取りこぼした期限切れファイルは
 * 次回のトリガー(15分後)で処理されるため、安全側に倒した設計となる。
 */
function deleteExpiredFiles_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(DELETE_LOCK_WAIT_TIMEOUT_MS)) {
    // 既に他の実行(前回のdeleteExpiredFiles_、またはuploadFile)がロックを
    // 保持している。無理に待たず、今回はスキップして次回トリガーに委ねる。
    console.log('deleteExpiredFiles_: ロック取得に失敗したためスキップします(次回トリガーで再試行)。');
    return;
  }

  try {
    var sheet = getOrCreateSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < DATA_START_ROW) {
      return; // データ行なし
    }

    var numDataRows = lastRow - HEADER_ROW;
    // 全列をまとめて1回で読み込む。期限切れ行の fileId を行ごとに個別取得すると
    // 同時に多数の行が期限切れになった際に Sheets API 呼び出しが行数分発生してしまうため、
    // ここでまとめて読み込み、以降はメモリ上の値だけで判定・削除を行う。
    var rows = sheet.getRange(DATA_START_ROW, COL_TOKEN, numDataRows, COLUMN_COUNT).getValues();
    var now = new Date();

    // 下から走査して行削除時のインデックスずれを防ぐ
    for (var i = numDataRows - 1; i >= 0; i--) {
      var expiresAt = new Date(rows[i][COL_EXPIRES_AT - 1]);

      if (isExpired_(expiresAt, now)) {
        var rowIndex = i + DATA_START_ROW; // シート上の実際の行番号
        var fileId = rows[i][COL_FILE_ID - 1];
        removeFilePermanently_(fileId);
        sheet.deleteRow(rowIndex);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * ファイルを完全削除する。Drive詳細サービス(Drive API v3)が有効な場合は
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
