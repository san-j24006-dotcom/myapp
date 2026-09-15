const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
    const nodes = new Map();
    const storage = new Map();
    const document = {
        addEventListener() {},
        getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, {
                textContent: '', innerHTML: '',
                classList: { add() {}, toggle() {} }
            });
            return nodes.get(id);
        }
    };
    const context = vm.createContext({
        document, URL, console, Date,
        window: { location: { href: 'https://example.test/' } },
        CONFIG: { GAS_URL: 'https://example.test/api' },
        sessionStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8') + '\nthis.app = app;', context);
    context.app.renderCards = () => {};
    return { app: context.app, context, nodes, storage };
}

test('multi-day distances and dated fuel entries survive JSON round trips', () => {
    const { app } = setup();
    const dailyDistances = JSON.stringify([
        { date: '2026-09-06', distance: '100.1' },
        { date: '2026-09-07', distance: '150.2' },
        { date: '2026-09-08', distance: '50' }
    ]);
    const entries = app.parseFuelEntries(JSON.stringify([
        { date: '2026-09-06', unitPrice: '170', liters: '10.5' },
        { date: '2026-09-07', unitPrice: '175', liters: '8' },
        { date: '2026-09-07', unitPrice: '180', liters: '2' }
    ]));
    assert.equal(app.formatDistance(app.dailyDistanceTotal(dailyDistances)), '300.3');
    assert.equal(app.dailyDistancesForItem({ dailyDistances }).length, 3);
    assert.equal(entries[1].date, '2026-09-07');
    assert.equal(app.fuelEntriesTotal(entries), 3545);
    assert.equal(app.fuelLitersTotal(entries), 20.5);
    assert.match(app.formatDateRange({ date: '2026-09-06', endDate: '2026-09-08' }), /2026-09-06.*2026-09-08/);
});

test('legacy totals do not invent a daily breakdown or fuel date', () => {
    const { app } = setup();
    assert.equal(app.dailyDistancesForItem({ date: '2026-09-06', distance: 300 }).length, 0);
    const entries = app.parseFuelEntries('[{"unitPrice":170,"liters":10}]');
    assert.equal(entries[0].date, '');
    assert.equal(app.fuelEntriesTotal(entries), 1700);
});

test('loading starts both requests together and reuses fresh cache', async () => {
    const { app } = setup();
    const calls = [];
    const pending = {};
    app.fetchSheet = tab => {
        calls.push(tab);
        return new Promise(resolve => { pending[tab] = resolve; });
    };
    const loading = app.fetchData();
    assert.deepEqual(calls, ['tours', 'deleted']);
    pending.tours([{ id: 'current', destination: 'Tour', __rowIndex: 8 }]);
    pending.deleted([{ sheet: 'tours', id: 'previous' }]);
    await loading;
    assert.equal(app.data[0].__rowIndex, 8);
    await app.fetchData();
    assert.equal(calls.length, 2);
    app.invalidateCache('tours');
    assert.equal(app.readCachedRecords('tours'), null);
});

test('late responses cannot overwrite the selected tab', async () => {
    const { app } = setup();
    const pending = [];
    app.fetchSheet = tab => new Promise(resolve => pending.push({ tab, resolve }));
    const first = app.fetchData();
    app.currentTab = 'spots';
    const second = app.fetchData();
    pending[2].resolve([{ id: 'spot', name: 'Spot' }]);
    pending[3].resolve([]);
    await second;
    pending[0].resolve([{ id: 'tour', destination: 'Tour' }]);
    pending[1].resolve([]);
    await first;
    assert.equal(app.data[0].id, 'spot');
});

test('failed background refresh retains cached records with a status', async () => {
    const { app, nodes } = setup();
    app.cacheRecords('tours', [{ id: 'cached', destination: 'Tour' }]);
    app.recordCache.get('tours').savedAt = 1;
    app.fetchSheet = async () => { throw new Error('Offline'); };
    await app.fetchData();
    assert.equal(app.data[0].id, 'cached');
    assert.ok(nodes.get('load-status').textContent);
});

test('failed deletion lookup does not display previously deleted rows', async () => {
    const { app, nodes } = setup();
    app.fetchSheet = async tab => {
        if (tab === 'deleted') throw new Error('Unavailable');
        return [{ id: 'deleted', destination: 'Old tour' }];
    };
    await app.fetchData();
    assert.equal(app.data.length, 0);
    assert.match(nodes.get('content-area').innerHTML, /Unavailable/);
});

test('only the previous revision is hidden and thumbnails keep the original URL', () => {
    const { app } = setup();
    app.setDeletedRows([{ sheet: 'tours', id: 'old' }], 'tours');
    assert.equal(app.isDeletedRecord({ id: 'old' }), true);
    assert.equal(app.isDeletedRecord({ id: 'new' }), false);
    const original = 'https://drive.google.com/thumbnail?id=photo&sz=w1600';
    assert.match(app.thumbnailUrl(original), /sz=w640/);
    assert.match(original, /sz=w1600/);
});
