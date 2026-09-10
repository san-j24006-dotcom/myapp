const PHOTO_FOLDER_ID = '19pnCmseZGW9Oo5QaiFtsNjliOWdzGFp0';

function authorize() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  DriveApp.getFolderById(PHOTO_FOLDER_ID).getName();
}

function organizeExistingPhotos() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheetNames = ['tours', 'spots', 'parts', 'reminders'];
  var movedCount = 0;

  sheetNames.forEach(function (sheetName) {
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) return;

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return;

    var headers = data[0].map(function (header) {
      return String(header || '').trim();
    });

    for (var i = 1; i < data.length; i++) {
      var rowData = rowToObject(headers, data[i]);
      var urls = getRowPhotoUrls(rowData);
      if (!urls.length) continue;

      var folder = getPhotoFolder({
        sheet: sheetName,
        category: folderLabelForSheet(sheetName),
        recordName: buildRecordName(rowData)
      });

      urls.forEach(function (url) {
        var fileId = extractDriveFileId(url);
        if (!fileId) return;

        try {
          DriveApp.getFileById(fileId).moveTo(folder);
          movedCount += 1;
        } catch (error) {
          Logger.log('Move failed: ' + fileId + ' / ' + error.message);
        }
      });
    }
  });

  Logger.log('Moved photos: ' + movedCount);
}

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

    if (postData.action === 'deletePhotos') {
      return deletePhotos((postData.data || {}).photoUrls || []);
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

  if (data.deletePhotos !== false && data.photoUrls) {
    deletePhotos(data.photoUrls);
  }

  return createJsonResponse({ success: true, message: 'Deleted marker added' });
}

function deletePhotos(photoUrls) {
  var urls = Array.isArray(photoUrls) ? photoUrls : [photoUrls];
  var deletedIds = [];
  var errors = [];

  urls.forEach(function (url) {
    var fileId = extractDriveFileId(url);
    if (!fileId) return;

    try {
      DriveApp.getFileById(fileId).setTrashed(true);
      deletedIds.push(fileId);
    } catch (error) {
      errors.push({ id: fileId, message: error.message });
    }
  });

  return createJsonResponse({
    success: errors.length === 0,
    deletedIds: deletedIds,
    errors: errors
  });
}

function extractDriveFileId(url) {
  var value = String(url || '');

  if (value.indexOf('id=') !== -1) {
    return value.split('id=')[1].split('&')[0];
  }

  if (value.indexOf('/file/d/') !== -1) {
    return value.split('/file/d/')[1].split('/')[0];
  }

  if (value.indexOf('/d/') !== -1) {
    return value.split('/d/')[1].split('/')[0];
  }

  return '';
}

function rowToObject(headers, row) {
  var obj = {};

  for (var i = 0; i < headers.length; i++) {
    if (headers[i]) {
      obj[headers[i]] = row[i];
    }
  }

  return obj;
}

function getRowPhotoUrls(rowData) {
  return [].concat(
    parsePhotoUrlList(rowData.photoUrl),
    parsePhotoUrlList(rowData.photoUrls)
  );
}

function parsePhotoUrlList(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value;
  }

  var text = String(value);

  try {
    var parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
  }

  return text.split(/\n|,/).map(function (url) {
    return url.trim();
  }).filter(Boolean);
}

function buildRecordName(rowData) {
  var date = rowData.date || rowData.dueDate || '';
  if (date instanceof Date) {
    date = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  var name = rowData.destination || rowData.name || rowData.task || rowData.memo || '未分類';
  return String((date ? date + ' ' : '') + name).trim();
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
  var rolePrefix = data.role === 'cover' ? 'cover' : (data.role === 'additional' ? 'additional' : 'photo');

  if (!/\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
    fileName += '.' + extension;
  }

  var folder = getPhotoFolder(data);
  var blob = Utilities.newBlob(bytes, mimeType, rolePrefix + '-' + Date.now() + '-' + fileName);
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

function getPhotoFolder(data) {
  var root = DriveApp.getFolderById(PHOTO_FOLDER_ID);
  var category = sanitizeFolderName(data.category || folderLabelForSheet(data.sheet) || 'その他');
  var recordName = sanitizeFolderName(data.recordName || ('未分類-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss')));
  var categoryFolder = getOrCreateFolder(root, category);

  return getOrCreateFolder(categoryFolder, recordName);
}

function folderLabelForSheet(sheetName) {
  var labels = {
    tours: 'ツーリング記録',
    spots: 'スポット',
    parts: 'パーツ管理',
    reminders: 'リマインダー'
  };

  return labels[sheetName] || sheetName || '';
}

function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }

  return parent.createFolder(name);
}

function sanitizeFileName(fileName) {
  var value = String(fileName || '');
  var invalidChars = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '#', '%', '{', '}', '~', '&'];

  invalidChars.forEach(function (char) {
    value = value.split(char).join('-');
  });

  return value.split(/\s+/).join(' ').trim().slice(0, 120);
}

function sanitizeFolderName(folderName) {
  var value = sanitizeFileName(folderName).trim();

  while (value.endsWith('.')) {
    value = value.slice(0, -1).trim();
  }

  return value || '未分類';
}

function createJsonResponse(responseData) {
  var output = ContentService.createTextOutput(JSON.stringify(responseData));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
