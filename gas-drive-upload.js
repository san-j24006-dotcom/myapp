var PHOTO_FOLDER_ID = '19pnCmseZGW9Oo5QaiFtsNjliOWdzGFp0';
var API_VERSION = 2;
var DEFAULT_HEADERS = {
  tours: ['id', 'date', 'endDate', 'destination', 'memo', 'distance', 'dailyDistances', 'fuelEntries', 'fuelTotal', 'photoUrl', 'photoUrls'],
  spots: ['id', 'name', 'status', 'type', 'mapUrl'],
  parts: ['id', 'name', 'category', 'price', 'status'],
  reminders: ['id', 'task', 'dueDate', 'status'],
  deleted: ['sheet', 'rowIndex', 'deletedAt', 'id', 'legacyKey']
};

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
  if (e && e.parameter && e.parameter.action === 'status') {
    return createJsonResponse({ success: true, apiVersion: API_VERSION });
  }
  var sheetName = (e && e.parameter && e.parameter.sheet) || 'tours';
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return createJsonResponse({ error: 'Sheet not found: ' + sheetName });
  }

  return createJsonResponse({ data: readRecords(sheet), apiVersion: API_VERSION });
}

function readRecords(sheet) {
  var data = sheet.getDataRange().getValues();
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
    if (Object.keys(obj).some(function (key) {
      return key !== '__rowIndex' && key !== 'id' && String(obj[key] || '').trim();
    })) result.push(obj);
  }
  return result;
}

function doPost(e) {
  var lock;
  try {
    var postData = JSON.parse(e.postData.contents || '{}');
    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    if (postData.action === 'uploadPhoto') {
      return uploadPhoto(postData.data || {});
    }

    if (postData.action === 'saveRecord') {
      return saveRecord(postData);
    }

    if (postData.action === 'deleteRecord') {
      return deleteRecord(postData);
    }

    if (postData.action === 'deletePhotos') {
      return deletePhotos((postData.data || {}).photoUrls || []);
    }

    throw new Error('Please reload the app before saving or deleting.');
  } catch (error) {
    return createJsonResponse({ success: false, error: error.message });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function recordSheet(spreadsheet, sheetName) {
  if (!DEFAULT_HEADERS[sheetName] || sheetName === 'deleted') throw new Error('Invalid record sheet');
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  return sheet;
}

function matchingRecord(records, original) {
  if (!original || (!original.id && !Object.keys(original).some(function (key) {
    return key !== '__rowIndex' && String(original[key] || '').trim();
  }))) throw new Error('Record identity is required');
  var matches = records.filter(function (record) {
    if (original.id) return String(record.id) === String(original.id);
    return !record.id && sameRecord(record, original);
  });
  if (matches.length > 1) throw new Error('Record is ambiguous. Reload the app.');
  return matches[0] || null;
}

function sameRecord(record, original) {
  return Object.keys(original).filter(function (key) { return key !== '__rowIndex'; }).every(function (key) {
    return String(record[key] === undefined ? '' : record[key]) === String(original[key] === undefined ? '' : original[key]);
  });
}

function saveRecord(postData) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = recordSheet(spreadsheet, postData.sheet);
  var rowData = postData.data || {};
  var records = readRecords(sheet);
  var original = postData.original ? matchingRecord(records, postData.original) : null;
  if (postData.original && (!original || !sameRecord(original, postData.original))) {
    throw new Error('This record has changed or was deleted. Reload before editing.');
  }
  if (!postData.original && records.some(function (record) { return rowData.id && record.id === rowData.id; })) {
    throw new Error('Record already saved. Reload the app.');
  }
  var merged = Object.assign({}, original || {}, rowData);
  delete merged.__rowIndex;
  merged.id = (original && original.id) || rowData.id || Utilities.getUuid();
  if (getRowPhotoUrls(merged).some(function (url) { return /^data:/i.test(String(url)); })) {
    throw new Error('Upload photos to Google Drive before saving.');
  }
  var headers = ensureHeaders(sheet, merged, postData.sheet);
  var newRow = headers.map(function (header) { return merged[header] !== undefined ? merged[header] : ''; });
  var keptIds = getRowPhotoUrls(merged).map(extractDriveFileId);
  var removedUrls = original ? getRowPhotoUrls(original).filter(function (url) {
    return keptIds.indexOf(extractDriveFileId(url)) === -1;
  }) : [];
  var cleanup = withPhotoCleanup(removedUrls, spreadsheet, postData.sheet, original, function () {
    if (original) sheet.getRange(original.__rowIndex, 1, 1, headers.length).setValues([newRow]);
    else sheet.appendRow(newRow);
    SpreadsheetApp.flush();
  });
  return createJsonResponse({ success: true, id: merged.id, updated: Boolean(original), photos: cleanup });
}

function deleteRecord(postData) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = recordSheet(spreadsheet, postData.sheet);
  var original = matchingRecord(readRecords(sheet), postData.original);
  if (!original) return createJsonResponse({ success: true, deleted: true, alreadyDeleted: true });
  var cleanup = withPhotoCleanup(getRowPhotoUrls(original), spreadsheet, postData.sheet, original, function () {
    sheet.deleteRow(original.__rowIndex);
    SpreadsheetApp.flush();
  });
  removeDeletionMarkers(spreadsheet, postData.sheet, original);
  return createJsonResponse({ success: true, deleted: true, photos: cleanup });
}

function removeDeletionMarkers(spreadsheet, sheetName, original) {
  var sheet = spreadsheet.getSheetByName('deleted');
  if (!sheet) return;
  var legacyKey = ['date', 'endDate', 'destination', 'memo', 'distance', 'dailyDistances', 'mileage', 'fuelEntries', 'fuelTotal', 'photoUrl', 'photoUrls']
    .map(function (key) { return String(original[key] === undefined ? '' : original[key]).trim(); }).join('|');
  readRecords(sheet).reverse().forEach(function (marker) {
    if (marker.sheet !== sheetName) return;
    if ((original.id && marker.id === original.id) || (!marker.id && marker.legacyKey === legacyKey)) {
      sheet.deleteRow(marker.__rowIndex);
    }
  });
}

function referencedPhotoIds(spreadsheet, excludedSheet, excludedRecord) {
  var ids = {};
  Object.keys(DEFAULT_HEADERS).filter(function (name) { return name !== 'deleted'; }).forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) return;
    readRecords(sheet).forEach(function (record) {
      if (name === excludedSheet && excludedRecord && record.__rowIndex === excludedRecord.__rowIndex) return;
      getRowPhotoUrls(record).forEach(function (url) {
        var id = extractDriveFileId(url);
        if (id) ids[id] = true;
      });
    });
  });
  return ids;
}

function isInPhotoFolder(file) {
  var pending = [file];
  var visited = {};
  while (pending.length) {
    var item = pending.pop();
    if (item.getId() === PHOTO_FOLDER_ID) return true;
    if (visited[item.getId()]) continue;
    visited[item.getId()] = true;
    var parents = item.getParents();
    while (parents.hasNext()) pending.push(parents.next());
  }
  return false;
}

function withPhotoCleanup(urls, spreadsheet, excludedSheet, excludedRecord, writeRecord) {
  var referenced = referencedPhotoIds(spreadsheet, excludedSheet, excludedRecord);
  var ids = Array.from(new Set(urls.map(extractDriveFileId).filter(Boolean)));
  var retainedIds = ids.filter(function (id) { return referenced[id]; });
  var files = ids.filter(function (id) { return !referenced[id]; }).map(function (id) {
    var file = DriveApp.getFileById(id);
    if (!file.isTrashed() && !isInPhotoFolder(file)) throw new Error('Photo is outside the MotoLog folder: ' + id);
    return file;
  });
  var trashed = [];
  try {
    files.forEach(function (file) {
      if (!file.isTrashed()) {
        file.setTrashed(true);
        trashed.push(file);
      }
    });
    writeRecord();
  } catch (error) {
    // Keep the existing record usable when either service rejects the operation.
    trashed.forEach(function (file) {
      try { file.setTrashed(false); } catch (restoreError) { Logger.log(restoreError.message); }
    });
    throw error;
  }
  return { deletedIds: files.map(function (file) { return file.getId(); }), retainedSharedIds: retainedIds };
}

function ensureHeaders(sheet, rowData, sheetName) {
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (header) {
    return String(header || '').trim();
  });
  var changed = false;
  var requiredHeaders = (DEFAULT_HEADERS[sheetName] || []).slice();

  Object.keys(rowData || {}).forEach(function (key) {
    if (requiredHeaders.indexOf(key) === -1) {
      requiredHeaders.push(key);
    }
  });

  requiredHeaders.forEach(function (key) {
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
  var result = withPhotoCleanup(urls, SpreadsheetApp.getActiveSpreadsheet(), '', null, function () {});
  return createJsonResponse(Object.assign({ success: true }, result));
}

function extractDriveFileId(url) {
  var value = String(url || '');
  if (!/^https:\/\/drive\.google\.com\//i.test(value)) return '';
  var match = value.match(/[?&]id=([a-zA-Z0-9_-]+)/) || value.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : '';
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
  if (/^data:/i.test(text)) return [text];

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
  var endDate = rowData.endDate || '';
  if (date instanceof Date) {
    date = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (endDate instanceof Date) {
    endDate = Utilities.formatDate(endDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  var dateLabel = date || endDate;
  if (date && endDate && date !== endDate) {
    dateLabel = date + '-' + endDate;
  }

  var name = rowData.destination || rowData.name || rowData.task || rowData.memo || unicodeText('unclassified');
  return String((dateLabel ? dateLabel + ' ' : '') + name).trim();
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
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (error) {
    file.setTrashed(true);
    throw error;
  }

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
