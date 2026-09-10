const PHOTO_FOLDER_ID = '19pnCmseZGW9Oo5QaiFtsNjliOWdzGFp0';

function doGet(e) {
  var sheetName = (e && e.parameter && e.parameter.sheet) || 'tours';
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return createJsonResponse({ error: 'Sheet not found: ' + sheetName });
  }

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return createJsonResponse({ data: [] });
  }

  var headers = data[0].map(function (header) {
    return String(header || '').trim();
  });
  var result = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var obj = {};

    for (var j = 0; j < headers.length; j++) {
      var key = headers[j];
      var val = row[j];

      if (!key) continue;

      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }

      obj[key] = val;
    }

    obj.__rowIndex = i + 1;
    result.push(obj);
  }

  return createJsonResponse({ data: result });
}

function doPost(e) {
  try {
    var postData = JSON.parse(e.postData.contents || '{}');

    if (postData.action === 'uploadPhoto') {
      return uploadPhoto(postData.data || {});
    }

    if (postData.action === 'delete') {
      return markDeleted(postData);
    }

    return addRow(postData);
  } catch (error) {
    return createJsonResponse({ error: error.message });
  }
}

function addRow(postData) {
  var sheetName = postData.sheet;
  var rowData = postData.data || {};
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return createJsonResponse({ error: 'Sheet not found: ' + sheetName });
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (header) {
    return String(header || '').trim();
  });
  var newRow = headers.map(function (header) {
    return rowData[header] !== undefined ? rowData[header] : '';
  });

  sheet.appendRow(newRow);
  return createJsonResponse({ success: true, message: 'Data added successfully' });
}

function markDeleted(postData) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName('deleted');

  if (!sheet) {
    sheet = spreadsheet.insertSheet('deleted');
    sheet.appendRow(['sheet', 'rowIndex', 'deletedAt']);
  }

  var data = postData.data || {};
  sheet.appendRow([data.sheet || postData.sheet || '', data.rowIndex || '', new Date().toISOString()]);
  return createJsonResponse({ success: true, message: 'Deleted marker added' });
}

function uploadPhoto(data) {
  if (!PHOTO_FOLDER_ID) {
    throw new Error('PHOTO_FOLDER_ID is empty');
  }

  var dataUrl = data.dataUrl || '';
  var match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);

  if (!match) {
    throw new Error('Invalid image data');
  }

  var mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  var bytes = Utilities.base64Decode(match[2]);
  var extension = mimeType.split('/')[1].replace('jpeg', 'jpg');
  var fileName = sanitizeFileName(data.fileName || ('motolog-' + Date.now() + '.' + extension));

  if (!/\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
    fileName += '.' + extension;
  }

  var folder = DriveApp.getFolderById(PHOTO_FOLDER_ID);
  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var fileId = file.getId();
  return createJsonResponse({
    success: true,
    id: fileId,
    url: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1600',
    webViewUrl: file.getUrl()
  });
}

function sanitizeFileName(fileName) {
  return String(fileName)
    .replace(/[\\/:*?"<>|#%{}~&]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function createJsonResponse(responseData) {
  var output = ContentService.createTextOutput(JSON.stringify(responseData));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
