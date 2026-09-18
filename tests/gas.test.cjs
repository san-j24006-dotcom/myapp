const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const photo = id => `https://drive.google.com/thumbnail?id=${id}&sz=w1600`;

function fixture(initial = {}) {
    const sheets = {};
    const files = new Map();
    class Sheet {
        constructor(records) {
            const headers = [...new Set(records.flatMap(Object.keys))];
            this.rows = [headers.length ? headers : ['id'], ...records.map(record => headers.map(key => record[key] ?? ''))];
        }
        getLastColumn() { return Math.max(...this.rows.map(row => row.length), 1); }
        getDataRange() { return this.getRange(1, 1, this.rows.length, this.getLastColumn()); }
        getRange(row, column, height, width) {
            return {
                getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => this.rows[row - 1 + i]?.[column - 1 + j] ?? '')),
                setValues: values => {
                    if (this.failWrite) throw new Error('Sheet write failed');
                    values.forEach((cells, i) => {
                        this.rows[row - 1 + i] ||= [];
                        cells.forEach((value, j) => { this.rows[row - 1 + i][column - 1 + j] = value; });
                    });
                }
            };
        }
        appendRow(row) { this.rows.push([...row]); }
        deleteRow(row) {
            if (this.failWrite) throw new Error('Sheet write failed');
            this.rows.splice(row - 1, 1);
        }
    }
    for (const [name, records] of Object.entries(initial)) sheets[name] = new Sheet(records);
    sheets.deleted ||= new Sheet([]);
    const spreadsheet = { getSheetByName: name => sheets[name] || null };
    let locked = false;
    const context = vm.createContext({
        Date, Set, Array, Object,
        SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
        Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
        Utilities: { getUuid: () => 'generated-id', formatDate: date => date.toISOString().slice(0, 10) },
        ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() {} }) },
        LockService: { getScriptLock: () => ({
            waitLock() { assert.equal(locked, false); locked = true; },
            hasLock: () => locked, releaseLock() { locked = false; }
        }) },
        Logger: { log() {} },
        DriveApp: { getFileById: id => { if (!files.has(id)) throw new Error('Photo unavailable'); return files.get(id); } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas-drive-upload.js'), 'utf8'), context);
    function addPhoto(id, options = {}) {
        const file = {
            trashed: Boolean(options.trashed),
            getId: () => id,
            isTrashed() { return this.trashed; },
            setTrashed(value) {
                if (value && options.failTrash) throw new Error('Drive deletion failed');
                this.trashed = value;
            },
            getParents() {
                let consumed = false;
                return {
                    hasNext: () => !consumed,
                    next() {
                        consumed = true;
                        return { getId: () => options.outside ? 'other-folder' : context.PHOTO_FOLDER_ID,
                            getParents: () => ({ hasNext: () => false }) };
                    }
                };
            }
        };
        files.set(id, file);
        return file;
    }
    return {
        sheets, addPhoto, context,
        records: name => context.readRecords(sheets[name]),
        post(payload) {
            const result = JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
            assert.equal(locked, false, 'lock released');
            return result;
        }
    };
}

test('delete removes the actual row, its cover and extra photos, and its marker', () => {
    const f = fixture({ tours: [
        { id: 'first', destination: 'Keep' },
        { id: 'target', destination: 'Delete', photoUrl: photo('cover'), photoUrls: JSON.stringify([photo('extra')]) }
    ], deleted: [{ sheet: 'tours', id: 'target', legacyKey: 'old snapshot' }] });
    const cover = f.addPhoto('cover');
    const extra = f.addPhoto('extra');
    const original = { ...f.records('tours')[1], __rowIndex: 2 };
    const result = f.post({ action: 'deleteRecord', sheet: 'tours', original });
    assert.equal(result.deleted, true);
    assert.equal(f.records('tours').length, 1);
    assert.equal(f.records('tours')[0].id, 'first');
    assert.equal(f.records('deleted').length, 0);
    assert.ok(cover.trashed && extra.trashed);
    assert.equal(f.post({ action: 'deleteRecord', sheet: 'tours', original }).alreadyDeleted, true);
    assert.equal(f.records('tours')[0].id, 'first');
});

test('legacy records use their content and never a reused row number', () => {
    const f = fixture({ spots: [{ name: 'Keep' }, { name: 'Delete' }] });
    const original = { name: 'Delete', __rowIndex: 2 };
    assert.equal(f.post({ action: 'deleteRecord', sheet: 'spots', original }).deleted, true);
    assert.equal(f.records('spots')[0].name, 'Keep');
    assert.equal(f.post({ action: 'deleteRecord', sheet: 'spots', original: { __rowIndex: 2 } }).success, false);
});

test('editing overwrites the same row, keeps its ID and removes only replaced photos', () => {
    const f = fixture({ tours: [{ id: 'stable', destination: 'Before', photoUrl: photo('cover'), photoUrls: JSON.stringify([photo('extra')]), custom: 'keep' }] });
    const cover = f.addPhoto('cover');
    const extra = f.addPhoto('extra');
    const result = f.post({ action: 'saveRecord', sheet: 'tours', original: f.records('tours')[0],
        data: { id: 'different', destination: 'After', photoUrls: '' } });
    assert.equal(result.success, true);
    assert.equal(f.records('tours').length, 1);
    assert.equal(f.records('tours')[0].id, 'stable');
    assert.equal(f.records('tours')[0].custom, 'keep');
    assert.equal(cover.trashed, false);
    assert.equal(extra.trashed, true);
});

test('a photo referenced by another sheet remains until its final record is deleted', () => {
    const f = fixture({ tours: [{ id: 'tour', destination: 'Tour', photoUrl: photo('shared') }], spots: [{ id: 'spot', name: 'Spot', photoUrl: photo('shared') }] });
    const file = f.addPhoto('shared');
    const result = f.post({ action: 'deleteRecord', sheet: 'tours', original: f.records('tours')[0] });
    assert.deepEqual(result.photos.retainedSharedIds, ['shared']);
    assert.equal(file.trashed, false);
    f.post({ action: 'deleteRecord', sheet: 'spots', original: f.records('spots')[0] });
    assert.equal(file.trashed, true);
});

test('Drive failures restore earlier photos and keep the record', () => {
    const f = fixture({ tours: [{ id: 'tour', destination: 'Tour', photoUrl: photo('first'), photoUrls: JSON.stringify([photo('fails')]) }] });
    const first = f.addPhoto('first');
    f.addPhoto('fails', { failTrash: true });
    const result = f.post({ action: 'deleteRecord', sheet: 'tours', original: f.records('tours')[0] });
    assert.equal(result.success, false);
    assert.match(result.error, /Drive deletion failed/);
    assert.equal(f.records('tours').length, 1);
    assert.equal(first.trashed, false);
});

test('a failed sheet deletion restores trashed photos', () => {
    const f = fixture({ tours: [{ id: 'tour', destination: 'Tour', photoUrl: photo('cover') }] });
    const file = f.addPhoto('cover');
    f.sheets.tours.failWrite = true;
    assert.equal(f.post({ action: 'deleteRecord', sheet: 'tours', original: f.records('tours')[0] }).success, false);
    assert.equal(file.trashed, false);
    assert.equal(f.records('tours').length, 1);
});

test('cleanup cannot trash unrelated Drive files or photos used by a saved record', () => {
    const f = fixture({ tours: [{ id: 'tour', destination: 'Tour', photoUrl: photo('saved') }] });
    const saved = f.addPhoto('saved');
    const outside = f.addPhoto('outside', { outside: true });
    const unused = f.addPhoto('unused');
    assert.equal(f.post({ action: 'deletePhotos', data: { photoUrls: [photo('saved'), photo('unused')] } }).success, true);
    assert.equal(saved.trashed, false);
    assert.equal(unused.trashed, true);
    assert.equal(f.post({ action: 'deletePhotos', data: { photoUrls: [photo('outside')] } }).success, false);
    assert.equal(outside.trashed, false);
    assert.equal(f.context.extractDriveFileId('https://example.com/?id=outside'), '');
});

test('stale edits, ambiguous records and embedded images are rejected without appending', () => {
    const f = fixture({ tours: [{ id: 'tour', destination: 'Current' }], spots: [{ name: 'Same' }, { name: 'Same' }] });
    assert.equal(f.post({ action: 'saveRecord', sheet: 'tours', original: { id: 'tour', destination: 'Stale' }, data: { destination: 'Changed' } }).success, false);
    assert.equal(f.post({ action: 'deleteRecord', sheet: 'spots', original: { name: 'Same' } }).success, false);
    for (const photos of [{ photoUrl: 'data:image/png;base64,AAAA' }, { photoUrls: '["data:image/png;base64,AAAA"]' }]) {
        assert.equal(f.post({ action: 'saveRecord', sheet: 'tours', data: { destination: 'New', ...photos } }).success, false);
    }
    assert.equal(f.post({ action: 'add', sheet: 'tours', data: { destination: 'Legacy client' } }).success, false);
    assert.equal(f.records('tours').length, 1);
});

test('new records get required columns and preserve dates and breakdowns', () => {
    const f = fixture({ tours: [] });
    const data = { destination: 'New', date: '2026-09-01', endDate: '2026-09-02', dailyDistances: '[{"date":"2026-09-01","distance":"10"}]', fuelEntries: '[{"date":"2026-09-02","unitPrice":"180","liters":"10"}]' };
    assert.equal(f.post({ action: 'saveRecord', sheet: 'tours', data }).success, true);
    const saved = f.records('tours')[0];
    assert.equal(saved.id, 'generated-id');
    assert.equal(saved.endDate, data.endDate);
    assert.equal(saved.dailyDistances, data.dailyDistances);
    assert.equal(saved.fuelEntries, data.fuelEntries);
});
