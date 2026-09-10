var PHOTO_FOLDER_ID = '19pnCmseZGW9Oo5QaiFtsNjliOWdzGFp0';

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

  var headers = ensureHeaders(sheet, rowData);
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
    sheet.appendRow(['sheet', 'rowIndex', 'deletedAt', 'id']);
  }

  var data = postData.data || {};
  var deletedData = {
    sheet: data.sheet || postData.sheet || '',
    rowIndex: data.rowIndex || '',
    deletedAt: new Date().toISOString(),
    id: data.id || ''
  };
  var headers = ensureHeaders(sheet, deletedData);
  var row = headers.map(function (header) {
    return deletedData[header] !== undefined ? deletedData[header] : '';
  });

  sheet.appendRow(row);

  if (data.deletePhotos !== false && data.photoUrls) {
    deletePhotos(data.photoUrls);
  }

  return createJsonResponse({ success: true, message: 'Deleted marker added' });
}

function ensureHeaders(sheet, rowData) {
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (header) {
    return String(header || '').trim();
  });
  var changed = false;

  Object.keys(rowData || {}).forEach(function (key) {
    if (headers.indexOf(key) === -1) {
      headers.push(key);
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return headers;
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

  var urls = [];
  text.replace(/\r/g, '\n').split('\n').forEach(function (line) {
    line.split(',').forEach(function (url) {
      var trimmed = url.trim();
      if (trimmed) urls.push(trimmed);
    });
  });

  return urls;
}

function buildRecordName(rowData) {
  var date = rowData.date || rowData.dueDate || '';
  if (date instanceof Date) {
    date = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  var name = rowData.destination || rowData.name || rowData.task || rowData.memo || unicodeText('unclassified');
  return String((date ? date + ' ' : '') + name).trim();
}

function uploadPhoto(data) {
  if (!PHOTO_FOLDER_ID) {
    throw new Error('PHOTO_FOLDER_ID is empty');
  }

  var parsedImage = parseImageDataUrl(data.dataUrl || '');
  if (!parsedImage) {
    throw new Error('Invalid image data');
  }

  var mimeType = parsedImage.mimeType;
  var bytes = Utilities.base64Decode(parsedImage.base64);
  var extension = imageExtension(mimeType);
  var fileName = sanitizeFileName(data.fileName || ('motolog-' + Date.now() + '.' + extension));
  var rolePrefix = data.role === 'cover' ? 'cover' : (data.role === 'additional' ? 'additional' : 'photo');

  if (!hasImageExtension(fileName)) {
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

function parseImageDataUrl(dataUrl) {
  var value = String(dataUrl || '');
  var marker = ';base64,';
  var markerIndex = value.indexOf(marker);

  if (value.indexOf('data:image/') !== 0 || markerIndex === -1) {
    return null;
  }

  var mimeType = value.substring(5, markerIndex).toLowerCase();
  if (mimeType === 'image/jpg') {
    mimeType = 'image/jpeg';
  }

  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(mimeType) === -1) {
    return null;
  }

  return {
    mimeType: mimeType,
    base64: value.substring(markerIndex + marker.length)
  };
}

function imageExtension(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function hasImageExtension(fileName) {
  var lower = String(fileName || '').toLowerCase();
  return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp');
}

function getPhotoFolder(data) {
  var root = DriveApp.getFolderById(PHOTO_FOLDER_ID);
  var category = sanitizeFolderName(data.category || folderLabelForSheet(data.sheet) || unicodeText('other'));
  var fallbackRecordName = unicodeText('unclassified') + '-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  var recordName = sanitizeFolderName(data.recordName || fallbackRecordName);
  var categoryFolder = getOrCreateFolder(root, category);

  return getOrCreateFolder(categoryFolder, recordName);
}

function folderLabelForSheet(sheetName) {
  var labels = {
    tours: unicodeText('tours'),
    spots: unicodeText('spots'),
    parts: unicodeText('parts'),
    reminders: unicodeText('reminders')
  };

  return labels[sheetName] || sheetName || '';
}

function unicodeText(key) {
  var values = {
    tours: '\u30c4\u30fc\u30ea\u30f3\u30b0\u8a18\u9332',
    spots: '\u30b9\u30dd\u30c3\u30c8',
    parts: '\u30d1\u30fc\u30c4\u7ba1\u7406',
    reminders: '\u30ea\u30de\u30a4\u30f3\u30c0\u30fc',
    other: '\u305d\u306e\u4ed6',
    unclassified: '\u672a\u5206\u985e'
  };

  return values[key] || key;
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

  while (value.indexOf('  ') !== -1) {
    value = value.split('  ').join(' ');
  }

  return value.trim().slice(0, 120);
}

function sanitizeFolderName(folderName) {
  var value = sanitizeFileName(folderName).trim();

  while (value.endsWith('.')) {
    value = value.slice(0, -1).trim();
  }

  return value || unicodeText('unclassified');
}

function createJsonResponse(responseData) {
  var output = ContentService.createTextOutput(JSON.stringify(responseData));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
