const app = {
    currentTab: 'tours',
    data: [],
    editIndex: null,
    editRecord: null,
    requestVersion: 0,
    recordCache: new Map(),
    cacheMaxAge: 30000,
    deletedRows: new Map(),
    deletedIds: new Set(),
    deletedRecordKeys: new Set(),
    removedPhotoUrls: new Set(),
    pendingCoverPhotoFile: null,
    pendingExtraPhotoFiles: [],
    legacyRowDeleteCutoff: Date.parse('2026-09-10T03:00:00Z'),

    labels: {
        tours: 'ツーリング記録',
        spots: 'スポット・駐輪場',
        parts: 'パーツ管理',
        reminders: 'リマインダー'
    },

    normalizeRecord(item) {
        return Object.fromEntries(
            Object.entries(item || {}).map(([key, value]) => [key.trim(), value])
        );
    },

    isEmptyRecord(item) {
        return Object.entries(item || {})
            .filter(([key]) => key !== '__rowIndex' && key !== 'id')
            .every(([, value]) => String(value ?? '').trim() === '');
    },

    emptyRecordForCurrentTab() {
        const fields = {
            tours: ['id', 'date', 'endDate', 'destination', 'memo', 'distance', 'dailyDistances', 'fuelEntries', 'fuelTotal', 'photoUrl', 'photoUrls'],
            spots: ['id', 'name', 'status', 'type', 'mapUrl'],
            parts: ['id', 'name', 'category', 'price', 'status'],
            reminders: ['id', 'task', 'dueDate', 'status']
        };

        return Object.fromEntries(fields[this.currentTab].map(field => [field, '']));
    },

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]);
    },

    safeUrl(value) {
        if (!value) return '';

        if (/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(value)) {
            return value;
        }

        try {
            const url = new URL(value, window.location.href);
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch {
            return '';
        }
    },

    parsePhotoUrls(value) {
        if (!value) return [];

        try {
            const urls = JSON.parse(value);
            if (Array.isArray(urls)) {
                return urls.map(url => this.safeUrl(url)).filter(Boolean);
            }
        } catch {
            return String(value)
                .split(/\n|,/)
                .map(url => this.safeUrl(url.trim()))
                .filter(Boolean);
        }

        return [];
    },

    allPhotoUrls(item) {
        return [
            this.safeUrl(item?.photoUrl),
            ...this.parsePhotoUrls(item?.photoUrls)
        ].filter(Boolean);
    },

    isDrivePhotoUrl(url) {
        return /drive\.google\.com\/(?:thumbnail|uc|file\/d\/|open)/i.test(url);
    },

    thumbnailUrl(value) {
        const url = new URL(value, window.location.href);
        if (url.hostname === 'drive.google.com' && url.pathname === '/thumbnail') {
            url.searchParams.set('sz', 'w640');
        }
        return url.href;
    },

    createRecordId() {
        if (window.crypto?.randomUUID) {
            return window.crypto.randomUUID();
        }

        return `motolog-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    },

    recordKey(item = {}) {
        return [
            this.toDateInputValue(item.date),
            this.toDateInputValue(item.endDate),
            item.destination,
            item.memo,
            item.distance,
            item.dailyDistances,
            item.mileage,
            item.fuelEntries,
            item.fuelTotal,
            item.photoUrl,
            item.photoUrls
        ].map(value => String(value ?? '').trim()).join('|');
    },

    categoryLabel(tab = this.currentTab) {
        return {
            tours: 'ツーリング記録',
            spots: 'スポット',
            parts: 'パーツ管理',
            reminders: 'リマインダー'
        }[tab] || tab || 'その他';
    },

    uploadContext(data = {}) {
        const name = data.destination || data.name || data.task || data.memo || '未分類';
        const date = this.formatDateRange(data) || data.dueDate || new Date().toISOString().slice(0, 10);

        return {
            sheet: this.currentTab,
            category: this.categoryLabel(this.currentTab),
            recordName: `${date} ${name}`.trim()
        };
    },

    async fileToImageDataUrl(file, options = {}) {
        if (!file || !file.type.startsWith('image/')) return '';

        const maxBytes = options.maxBytes || 45000;
        const objectUrl = URL.createObjectURL(file);

        try {
            const image = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('画像を読み込めませんでした'));
                img.src = objectUrl;
            });

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            let maxSize = options.maxSize || 900;
            let quality = options.quality || 0.72;
            let dataUrl = '';

            for (let attempt = 0; attempt < 8; attempt += 1) {
                const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                dataUrl = canvas.toDataURL('image/jpeg', quality);

                if (dataUrl.length <= maxBytes) break;
                if (quality > 0.42) {
                    quality -= 0.1;
                } else {
                    maxSize = Math.round(maxSize * 0.75);
                }
            }

            if (dataUrl.length > maxBytes) {
                throw new Error('画像が大きすぎます。別の画像を選んでください。');
            }

            return dataUrl;
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    },

    async fileToDriveDataUrl(file) {
        return this.fileToImageDataUrl(file, {
            maxBytes: 2500000,
            maxSize: 1800,
            quality: 0.82
        });
    },

    async uploadPhotoFile(file, context = {}) {
        const driveDataUrl = await this.fileToDriveDataUrl(file);

        try {
            const result = await this.sendPayload({
                action: 'uploadPhoto',
                data: {
                    ...context,
                    fileName: file.name || `motolog-${Date.now()}.jpg`,
                    mimeType: 'image/jpeg',
                    dataUrl: driveDataUrl
                }
            });

            if (result.url) return result.url;
        } catch {
            // GASがDriveアップロード未対応の場合は、従来通り軽量化した画像を保存する。
        }

        return this.fileToImageDataUrl(file);
    },

    formatDate(value) {
        const inputValue = this.toDateInputValue(value);
        return inputValue || this.escapeHtml(value || '日付未定');
    },

    hasValue(value) {
        return String(value ?? '').trim() !== '';
    },

    formatDateRange(item) {
        const startDate = this.toDateInputValue(item.date);
        const endDate = this.toDateInputValue(item.endDate);
        const dailyDates = this.parseDailyDistances(item.dailyDistances)
            .map(entry => this.toDateInputValue(entry.date))
            .filter(Boolean);
        const firstDailyDate = dailyDates[0] || '';
        const lastDailyDate = dailyDates[dailyDates.length - 1] || '';
        const displayStart = startDate || firstDailyDate;
        const displayEnd = endDate || lastDailyDate || displayStart;

        if (displayStart && displayEnd && displayStart !== displayEnd) {
            return `${displayStart} ～ ${displayEnd}`;
        }

        return displayStart || displayEnd || '日付未定';
    },

    dateRange(startValue, endValue) {
        const startDate = this.toDateInputValue(startValue);
        const endDate = this.toDateInputValue(endValue);
        const firstDate = startDate || endDate;
        const lastDate = endDate || startDate;

        if (!firstDate) return [];

        const start = new Date(`${firstDate}T00:00:00`);
        const end = new Date(`${lastDate}T00:00:00`);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

        const from = start <= end ? start : end;
        const to = start <= end ? end : start;
        const dates = [];

        for (let date = new Date(from); date <= to && dates.length < 45; date.setDate(date.getDate() + 1)) {
            dates.push(this.toDateInputValue(date));
        }

        return dates;
    },

    formatShortDate(value) {
        const date = new Date(`${this.toDateInputValue(value)}T00:00:00`);
        if (Number.isNaN(date.getTime())) return '';
        return `${date.getMonth() + 1}/${date.getDate()}`;
    },

    parseDailyDistances(value) {
        if (!value) return [];

        try {
            const items = Array.isArray(value) ? value : JSON.parse(value);
            if (Array.isArray(items)) {
                return items.map(item => ({
                    date: this.toDateInputValue(item.date),
                    distance: String(item.distance ?? '').trim()
                })).filter(item => item.date || item.distance);
            }
        } catch {
            return String(value).split(/\n/).map(line => {
                const [date, distance] = line.split(':');
                return {
                    date: this.toDateInputValue(date?.trim()),
                    distance: String(distance ?? date ?? '').replace(/[^\d.]/g, '').trim()
                };
            }).filter(item => item.date || item.distance);
        }

        return [];
    },

    dailyDistanceTotal(value) {
        return this.parseDailyDistances(value).reduce((total, item) => (
            total + (Number(item.distance) || 0)
        ), 0);
    },

    dailyDistancesForItem(item) {
        const entries = this.parseDailyDistances(item.dailyDistances);
        if (entries.length) return entries;

        const distance = String(item.distance ?? '').trim();
        if (!distance || !this.hasValue(item.endDate)) return [];

        const dates = this.dateRange(item.date, item.endDate);
        if (dates.length <= 1) {
            return [{ date: dates[0] || this.toDateInputValue(item.date) || this.toDateInputValue(item.endDate), distance }];
        }

        return [];
    },

    dailyDistanceEntriesTotal(entries) {
        return (entries || []).reduce((total, entry) => total + (Number(entry.distance) || 0), 0);
    },

    formatDistance(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return String(value ?? '');
        return (Math.round(number * 10) / 10).toLocaleString('ja-JP');
    },

    parseFuelEntries(value) {
        if (!value) return [];

        try {
            const items = Array.isArray(value) ? value : JSON.parse(value);
            if (Array.isArray(items)) {
                return items.map(item => ({
                    date: this.toDateInputValue(item.date),
                    unitPrice: String(item.unitPrice ?? '').trim(),
                    liters: String(item.liters ?? '').trim()
                })).filter(item => item.unitPrice || item.liters);
            }
        } catch {
        }

        return [];
    },

    fuelEntryTotal(entry) {
        return Math.round((Number(entry.unitPrice) || 0) * (Number(entry.liters) || 0));
    },

    fuelEntriesForItem(item) {
        return this.parseFuelEntries(item.fuelEntries);
    },

    fuelTotal(value) {
        return this.parseFuelEntries(value).reduce((total, entry) => total + this.fuelEntryTotal(entry), 0);
    },

    fuelEntriesTotal(entries) {
        return (entries || []).reduce((total, entry) => total + this.fuelEntryTotal(entry), 0);
    },

    fuelLitersTotal(entries) {
        return (entries || []).reduce((total, entry) => total + (Number(entry.liters) || 0), 0);
    },

    formatLiters(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return String(value ?? '');
        return (Math.round(number * 100) / 100).toLocaleString('ja-JP');
    },

    formatCurrency(value) {
        return `¥${Math.round(Number(value) || 0).toLocaleString('ja-JP')}`;
    },

    toDateInputValue(value) {
        if (!value) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';

        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    init() {
        if (CONFIG.GAS_URL === 'YOUR_GAS_URL_HERE') {
            document.getElementById('content-area').innerHTML = `
                <div class="col-span-full bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded shadow-sm">
                    <p class="text-yellow-700"><strong>設定待ち:</strong> config.js に GAS のデプロイ URL を設定してください。</p>
                </div>
            `;
            return;
        }

        this.switchTab(this.currentTab);
    },

    async switchTab(tab) {
        this.currentTab = tab;

        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        document.getElementById('page-title').textContent = this.labels[tab];
        await this.fetchData();
    },

    cacheKey(tab) {
        return `motolog:records:v1:${CONFIG.GAS_URL}:${tab}`;
    },

    readCachedRecords(tab) {
        try {
            const cached = this.recordCache.get(tab) || JSON.parse(sessionStorage.getItem(this.cacheKey(tab)));
            if (Array.isArray(cached?.data) && Number.isFinite(cached.savedAt)) return cached;
        } catch {
            // Storage may be disabled or full; network loading still works.
        }
        return null;
    },

    cacheRecords(tab, data) {
        const cached = { data, savedAt: Date.now() };
        this.recordCache.set(tab, cached);
        try {
            const serialized = JSON.stringify(cached);
            if (serialized.length < 1000000) {
                sessionStorage.setItem(this.cacheKey(tab), serialized);
            } else {
                sessionStorage.removeItem(this.cacheKey(tab));
            }
        } catch {
        }
    },

    invalidateCache(tab) {
        this.recordCache.delete(tab);
        try {
            sessionStorage.removeItem(this.cacheKey(tab));
        } catch {
        }
    },

    async fetchSheet(tab) {
        const response = await fetch(`${CONFIG.GAS_URL}?sheet=${encodeURIComponent(tab)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (json.error) {
            if (tab === 'deleted' && json.error === 'Sheet not found: deleted') return [];
            throw new Error(json.error);
        }
        if (!Array.isArray(json.data)) throw new Error('データの形式を確認できませんでした');
        return json.data;
    },

    async fetchData(force = false) {
        const tab = this.currentTab;
        const version = ++this.requestVersion;
        const loading = document.getElementById('loading');
        const contentArea = document.getElementById('content-area');
        const status = document.getElementById('load-status');
        const cached = force ? null : this.readCachedRecords(tab);

        status.textContent = '';
        loading.classList.toggle('hidden', Boolean(cached));
        if (cached) {
            this.data = cached.data;
            this.renderCards();
            if (Date.now() - cached.savedAt < this.cacheMaxAge) return;
            status.textContent = '更新中...';
        } else {
            this.data = [];
            contentArea.innerHTML = '';
        }

        try {
            const [items, deletedItems] = await Promise.all([
                this.fetchSheet(tab),
                this.fetchSheet('deleted')
            ]);
            if (version !== this.requestVersion) return;
            this.setDeletedRows(deletedItems, tab);
            const records = items
                .map((item, index) => ({
                    ...this.normalizeRecord(item),
                    __rowIndex: Number(item.__rowIndex) || index + 2
                }))
                .filter(item => !this.isEmptyRecord(item));
            this.data = records.filter(item => !this.isDeletedRecord(item));
            this.cacheRecords(tab, this.data);
            this.renderCards();
            status.textContent = '';
        } catch (error) {
            if (version !== this.requestVersion) return;
            if (cached) {
                status.textContent = '更新できませんでした。前回のデータを表示しています。';
                return;
            }
            contentArea.innerHTML = `
                <div class="col-span-full bg-red-50 text-red-600 p-4 rounded border-l-4 border-red-500">
                    エラーが発生しました: ${this.escapeHtml(error.message)}
                </div>
            `;
        } finally {
            if (version === this.requestVersion) loading.classList.add('hidden');
        }
    },

    setDeletedRows(items, tab) {
        const deletedItems = items
            .map(item => this.normalizeRecord(item))
            .filter(item => item.sheet === tab);
        const deletedRows = deletedItems
            .map(item => ({
                rowIndex: Number(item.rowIndex),
                deletedAt: Date.parse(item.deletedAt || '')
            }))
            .filter(item => Number.isInteger(item.rowIndex));
        const deletedIds = deletedItems
            .map(item => String(item.id || '').trim())
            .filter(Boolean);
        const deletedRecordKeys = deletedItems
            .map(item => String(item.legacyKey || '').trim())
            .filter(Boolean);

        this.deletedRows = new Map(deletedRows.map(item => [
            item.rowIndex,
            Number.isFinite(item.deletedAt) ? item.deletedAt : 0
        ]));
        this.deletedIds = new Set(deletedIds);
        this.deletedRecordKeys = new Set(deletedRecordKeys);
    },

    isDeletedRecord(item) {
        if (item.id) {
            return this.deletedIds.has(String(item.id));
        }

        const legacyKey = this.recordKey(item);
        if (legacyKey && this.deletedRecordKeys.has(legacyKey)) {
            return true;
        }

        return false;
    },

    renderCards() {
        const contentArea = document.getElementById('content-area');
        contentArea.innerHTML = '';

        if (this.data.length === 0) {
            contentArea.innerHTML = '<div class="col-span-full text-center text-gray-500 py-10">データがありません</div>';
            return;
        }

        this.data.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 card-hover relative overflow-hidden pb-20';
            if (this.currentTab === 'tours') {
                card.classList.add('cursor-pointer');
                card.onclick = () => this.showRecord(index);
            }

            const photoUrl = this.safeUrl(item.photoUrl);
            const mapUrl = this.safeUrl(item.mapUrl);
            let inner = '';

            if (this.currentTab === 'tours') {
                const dailyDistances = this.dailyDistancesForItem(item);
                const fuelEntries = this.fuelEntriesForItem(item);
                const totalDistance = this.hasValue(item.distance) ? Number(item.distance) : this.dailyDistanceEntriesTotal(dailyDistances);
                const totalFuel = this.hasValue(item.fuelTotal) ? Number(item.fuelTotal) : this.fuelEntriesTotal(fuelEntries);
                const totalLiters = this.fuelLitersTotal(fuelEntries);
                const dailyPreview = dailyDistances.slice(0, 3).map(entry => (
                    `<div class="flex justify-between gap-2"><span>${this.escapeHtml(this.formatShortDate(entry.date) || entry.date || '-')}</span><span>${this.escapeHtml(this.formatDistance(entry.distance))}km</span></div>`
                )).join('');
                const fuelPreview = fuelEntries.slice(0, 2).map((entry, fuelIndex) => (
                    `<div class="flex justify-between gap-2"><span>${this.escapeHtml(this.formatShortDate(entry.date) || '日付未登録')}・${fuelIndex + 1}回目 ${this.escapeHtml(this.formatLiters(entry.liters))}L</span><span>${this.escapeHtml(this.formatCurrency(this.fuelEntryTotal(entry)))}</span></div>`
                )).join('');
                const chips = [
                    totalDistance ? `<span class="bg-gray-100 text-gray-600 px-2 py-1 rounded">走行合計: ${this.escapeHtml(this.formatDistance(totalDistance))}km</span>` : '',
                    totalFuel ? `<span class="bg-gray-100 text-gray-600 px-2 py-1 rounded">給油合計: ${this.escapeHtml(this.formatCurrency(totalFuel))}</span>` : ''
                ].filter(Boolean).join('');

                inner = `
                    ${photoUrl ? `<div class="h-32 -mx-5 -mt-5 mb-4"><img src="${this.escapeHtml(this.thumbnailUrl(photoUrl))}" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover"></div>` : ''}
                    <div class="text-xs text-gray-400 mb-1">${this.escapeHtml(this.formatDateRange(item))}</div>
                    <h3 class="text-lg font-bold text-gray-800 mb-2">${this.escapeHtml(item.destination || '目的地なし')}</h3>
                    <p class="text-gray-600 text-sm mb-3 line-clamp-2">${this.escapeHtml(item.memo)}</p>
                    ${chips ? `<div class="flex flex-wrap gap-2 text-xs">${chips}</div>` : ''}
                    ${dailyPreview ? `<div class="mt-3 rounded bg-gray-50 p-2 text-xs text-gray-600"><div class="mb-1 font-medium text-gray-700">日別走行距離</div>${dailyPreview}${dailyDistances.length > 3 ? `<div class="pt-1 text-gray-400">ほか${dailyDistances.length - 3}日</div>` : ''}</div>` : ''}
                    ${fuelPreview ? `<div class="mt-2 rounded bg-gray-50 p-2 text-xs text-gray-600"><div class="mb-1 flex justify-between gap-2 font-medium text-gray-700"><span>給油</span><span>${this.escapeHtml(this.formatLiters(totalLiters))}L</span></div>${fuelPreview}${fuelEntries.length > 2 ? `<div class="pt-1 text-gray-400">ほか${fuelEntries.length - 2}回</div>` : ''}</div>` : ''}
                `;
            } else if (this.currentTab === 'spots') {
                inner = `
                    <div class="flex justify-between items-start mb-2">
                        <h3 class="text-lg font-bold text-gray-800">${this.escapeHtml(item.name)}</h3>
                        <span class="text-xs px-2 py-1 rounded ${item.status === 'visited' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">${item.status === 'visited' ? '訪問済' : '行きたい'}</span>
                    </div>
                    <span class="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded mb-3 inline-block">${item.type === 'parking' ? '駐輪場' : 'スポット'}</span>
                    ${mapUrl ? `<a href="${this.escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer" class="block text-emerald-500 text-sm hover:underline mt-2">マップで見る</a>` : ''}
                `;
            } else if (this.currentTab === 'parts') {
                inner = `
                    <div class="flex justify-between items-start mb-2">
                        <h3 class="text-lg font-bold text-gray-800">${this.escapeHtml(item.name)}</h3>
                        <span class="text-xs px-2 py-1 rounded ${item.status === 'installed' ? 'bg-blue-100 text-blue-700' : (item.status === 'purchased' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700')}">${this.escapeHtml(item.status || '検討中')}</span>
                    </div>
                    <div class="text-sm text-gray-500 mb-1">分類: ${this.escapeHtml(item.category)}</div>
                    <div class="font-semibold text-gray-700">¥${this.escapeHtml(item.price || 0)}</div>
                `;
            } else if (this.currentTab === 'reminders') {
                inner = `
                    <div class="flex items-center gap-3 mb-2">
                        <input type="checkbox" ${item.status === 'done' ? 'checked' : ''} disabled class="w-5 h-5 text-emerald-500 rounded border-gray-300">
                        <h3 class="text-lg font-bold ${item.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-800'}">${this.escapeHtml(item.task)}</h3>
                    </div>
                    <div class="text-sm text-red-500 font-medium ml-8">期限: ${this.formatDate(item.dueDate) || '未定'}</div>
                `;
            }

            inner += `
                <div class="absolute bottom-4 right-4 left-4 flex flex-wrap justify-end gap-2">
                    <button onclick="event.stopPropagation(); app.editItem(${index})" class="text-gray-500 hover:text-emerald-600 transition-colors flex items-center gap-1 text-sm bg-white px-2 py-1 rounded-md shadow-sm border border-gray-100">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                        編集
                    </button>
                    <button onclick="event.stopPropagation(); app.deleteItem(${index})" class="text-gray-500 hover:text-red-600 transition-colors flex items-center gap-1 text-sm bg-white px-2 py-1 rounded-md shadow-sm border border-gray-100">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m-9 0h12"></path></svg>
                        削除
                    </button>
                </div>
            `;

            card.innerHTML = inner;
            contentArea.appendChild(card);
        });
    },

    showRecord(index) {
        const item = this.data[index];
        if (!item) return;

        const photoUrl = this.safeUrl(item.photoUrl);
        const photoUrls = this.parsePhotoUrls(item.photoUrls);
        const dailyDistances = this.dailyDistancesForItem(item);
        const totalDistance = this.hasValue(item.distance) ? Number(item.distance) : this.dailyDistanceEntriesTotal(dailyDistances);
        const fuelEntries = this.fuelEntriesForItem(item);
        const totalFuel = this.hasValue(item.fuelTotal) ? Number(item.fuelTotal) : this.fuelEntriesTotal(fuelEntries);
        const totalLiters = this.fuelLitersTotal(fuelEntries);
        const dailyDistanceHtml = dailyDistances.map(entry => (
            `<div class="flex justify-between border-b border-gray-100 py-1"><span>${this.escapeHtml(this.formatShortDate(entry.date) || entry.date || '-')}</span><span>${this.escapeHtml(this.formatDistance(entry.distance))}km</span></div>`
        )).join('');
        const dailyDistanceSection = dailyDistances.length || totalDistance ? `
            <div>
                <div class="text-sm text-gray-400 mb-1">日別走行距離</div>
                <div class="text-sm text-gray-700">
                    ${dailyDistanceHtml}
                    <div class="flex justify-between pt-2 font-semibold text-gray-800"><span>合計</span><span>${this.escapeHtml(this.formatDistance(totalDistance))}km</span></div>
                </div>
            </div>
        ` : '';
        const fuelEntriesHtml = fuelEntries.map((entry, index) => (
            `<div class="border-b border-gray-100 py-2"><div class="flex flex-wrap justify-between gap-2"><span>${this.escapeHtml(entry.date ? this.formatDate(entry.date) : '日付未登録')}・${index + 1}回目</span><span class="font-medium">${this.escapeHtml(this.formatCurrency(this.fuelEntryTotal(entry)))}</span></div><div class="mt-1 text-gray-500">${this.escapeHtml(this.formatLiters(entry.liters))}L × ${this.escapeHtml(entry.unitPrice || 0)}円/L</div></div>`
        )).join('');
        const fuelEntriesSection = fuelEntries.length || totalFuel ? `
            <div>
                <div class="text-sm text-gray-400 mb-1">給油</div>
                <div class="text-sm text-gray-700">
                    ${fuelEntriesHtml}
                    <div class="flex flex-wrap justify-between gap-2 pt-2 font-semibold text-gray-800"><span>合計${fuelEntries.length ? `（${fuelEntries.length}回）` : ''}</span><span>${this.escapeHtml(this.formatLiters(totalLiters))}L / ${this.escapeHtml(this.formatCurrency(totalFuel))}</span></div>
                </div>
            </div>
        ` : '';
        const details = [
            `<div><span class="text-gray-400">日付</span><div class="font-medium">${this.escapeHtml(this.formatDateRange(item))}</div></div>`,
            `<div><span class="text-gray-400">目的地</span><div class="font-medium">${this.escapeHtml(item.destination || '-')}</div></div>`
        ].filter(Boolean).join('');
        let modal = document.getElementById('record-modal');

        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'record-modal';
            modal.className = 'fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center z-50 p-4 opacity-0 transition-opacity';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div class="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-hidden transform scale-95 transition-transform flex flex-col">
                <div class="p-6 border-b border-gray-100 flex justify-between items-center">
                    <h3 class="text-lg font-bold">${this.escapeHtml(item.destination || '記録')}</h3>
                    <button onclick="app.closeRecordModal()" class="text-gray-400 hover:text-gray-700">閉じる</button>
                </div>
                <div class="p-6 overflow-y-auto space-y-5">
                    ${photoUrl ? `<div class="h-48 rounded bg-cover bg-center border border-gray-200" style="background-image: url('${this.escapeHtml(photoUrl)}')"></div>` : ''}
                    <div class="grid grid-cols-2 gap-3 text-sm">
                        ${details}
                    </div>
                    ${dailyDistanceSection}
                    ${fuelEntriesSection}
                    ${item.memo ? `<div><div class="text-sm text-gray-400 mb-1">メモ</div><p class="text-sm text-gray-700 whitespace-pre-wrap">${this.escapeHtml(item.memo)}</p></div>` : ''}
                    ${photoUrls.length ? `<div><div class="text-sm text-gray-400 mb-2">追加写真</div><div class="grid grid-cols-2 gap-3">${photoUrls.map(url => `<a href="${this.escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="block h-32 rounded bg-cover bg-center border border-gray-200" style="background-image: url('${this.escapeHtml(url)}')"></a>`).join('')}</div></div>` : ''}
                </div>
            </div>
        `;

        const content = modal.querySelector('div');
        modal.classList.add('modal-show');
        setTimeout(() => {
            modal.classList.add('modal-fade-in');
            content.classList.add('modal-scale-in');
        }, 10);
    },

    closeRecordModal() {
        const modal = document.getElementById('record-modal');
        if (!modal) return;

        const content = modal.querySelector('div');
        modal.classList.remove('modal-fade-in');
        content.classList.remove('modal-scale-in');
        setTimeout(() => {
            modal.classList.remove('modal-show');
        }, 300);
    },

    showModal(isEdit = false) {
        this.editIndex = isEdit ? this.editIndex : null;
        this.editRecord = isEdit ? this.editRecord : null;
        this.removedPhotoUrls = new Set();
        this.pendingCoverPhotoFile = null;
        this.pendingExtraPhotoFiles = [];
        const titleEl = document.getElementById('modal-title');
        if (titleEl) titleEl.textContent = isEdit ? '編集' : '新規追加';

        const modal = document.getElementById('modal');
        const content = modal.querySelector('div');
        modal.classList.add('modal-show');
        setTimeout(() => {
            modal.classList.add('modal-fade-in');
            content.classList.add('modal-scale-in');
        }, 10);

        document.getElementById('data-form').reset();
        document.getElementById('form-fields').innerHTML = this.getFormFields();
        this.updatePhotoPreview('');
        this.updateExtraPhotoPreview('');
        if (this.currentTab === 'tours') {
            this.updateDailyDistanceFields();
            this.renderFuelEntries();
        }
    },

    getFormFields() {
        if (this.currentTab === 'tours') {
            return `
                <div class="grid grid-cols-2 gap-4">
                    <div class="min-w-0"><label class="block text-sm text-gray-600 mb-1">開始日</label><input type="date" name="date" onchange="app.updateTourDates()" class="w-full min-w-0 border p-2 rounded"></div>
                    <div class="min-w-0"><label class="block text-sm text-gray-600 mb-1">終了日</label><input type="date" name="endDate" onchange="app.updateTourDates()" class="w-full min-w-0 border p-2 rounded"></div>
                </div>
                <div><label class="block text-sm text-gray-600 mb-1">目的地</label><input type="text" name="destination" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">メモ</label><textarea name="memo" class="w-full border p-2 rounded"></textarea></div>
                <input type="hidden" name="distance">
                <input type="hidden" name="dailyDistances">
                <input type="hidden" name="fuelEntries">
                <input type="hidden" name="fuelTotal">
                <div class="rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <div class="mb-2 flex items-center justify-between gap-2">
                        <label class="block text-sm font-medium text-gray-700">日別走行距離</label>
                        <div id="daily-distance-total" class="text-sm font-medium text-emerald-700"></div>
                    </div>
                    <div id="daily-distance-fields" class="space-y-2"></div>
                </div>
                <div class="rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <div class="mb-2 flex items-center justify-between gap-2">
                        <label class="block text-sm font-medium text-gray-700">給油</label>
                        <div id="fuel-entry-total" class="text-sm font-medium text-emerald-700"></div>
                    </div>
                    <div id="fuel-entry-fields" class="space-y-2"></div>
                    <button type="button" onclick="app.addFuelEntry()" class="mt-3 w-full rounded border border-emerald-200 bg-white px-3 py-2 text-sm text-emerald-700">給油を追加</button>
                </div>
                <div>
                    <label class="block text-sm text-gray-600 mb-1">写真</label>
                    <input type="file" name="photoFile" accept="image/*" capture="environment" onchange="app.handlePhotoChange(this)" class="w-full border p-2 rounded bg-white">
                    <input type="hidden" name="photoUrl">
                    <div id="photo-preview" class="hidden mt-3">
                        <div class="h-32 rounded bg-cover bg-center border border-gray-200"></div>
                        <button type="button" onclick="app.clearPhoto()" class="mt-2 text-sm text-red-600 hover:underline">写真を削除</button>
                    </div>
                    <p class="text-xs text-gray-500 mt-1">選択した画像は軽く圧縮して保存します。</p>
                </div>
                <div>
                    <label class="block text-sm text-gray-600 mb-1">追加写真</label>
                    <input type="file" name="extraPhotoFiles" accept="image/*" capture="environment" multiple onchange="app.handleExtraPhotoChange(this)" class="w-full border p-2 rounded bg-white">
                    <input type="hidden" name="photoUrls">
                    <div id="extra-photo-preview" class="hidden mt-3 flex gap-2 overflow-x-auto"></div>
                    <button type="button" onclick="app.clearExtraPhotos()" class="mt-2 text-sm text-red-600 hover:underline">追加写真をすべて削除</button>
                </div>
            `;
        }

        if (this.currentTab === 'spots') {
            return `
                <div><label class="block text-sm text-gray-600 mb-1">スポット名</label><input type="text" name="name" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">ステータス</label>
                    <select name="status" class="w-full border p-2 rounded">
                        <option value="">行きたい</option>
                        <option value="visited">訪問済</option>
                    </select>
                </div>
                <div><label class="block text-sm text-gray-600 mb-1">種類</label>
                    <select name="type" class="w-full border p-2 rounded">
                        <option value="spot">スポット</option>
                        <option value="parking">駐輪場</option>
                    </select>
                </div>
                <div><label class="block text-sm text-gray-600 mb-1">マップURL</label><input type="url" name="mapUrl" class="w-full border p-2 rounded"></div>
            `;
        }

        if (this.currentTab === 'parts') {
            return `
                <div><label class="block text-sm text-gray-600 mb-1">パーツ名</label><input type="text" name="name" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">分類</label><input type="text" name="category" class="w-full border p-2 rounded" placeholder="例: 電装系"></div>
                <div><label class="block text-sm text-gray-600 mb-1">価格</label><input type="number" name="price" class="w-full border p-2 rounded"></div>
                <div><label class="block text-sm text-gray-600 mb-1">ステータス</label>
                    <select name="status" class="w-full border p-2 rounded">
                        <option value="検討中">検討中</option>
                        <option value="purchased">購入済</option>
                        <option value="installed">取付済</option>
                    </select>
                </div>
            `;
        }

        return `
            <div><label class="block text-sm text-gray-600 mb-1">タスク内容</label><input type="text" name="task" class="w-full border p-2 rounded" required></div>
            <div><label class="block text-sm text-gray-600 mb-1">期限</label><input type="date" name="dueDate" class="w-full border p-2 rounded"></div>
            <div><label class="block text-sm text-gray-600 mb-1">ステータス</label>
                <select name="status" class="w-full border p-2 rounded">
                    <option value="">未完了</option>
                    <option value="done">完了</option>
                </select>
            </div>
        `;
    },

    updateDailyDistanceFields(existingValue = null) {
        const form = document.getElementById('data-form');
        const container = document.getElementById('daily-distance-fields');
        if (!form || !container) return;

        const storedValue = existingValue ?? form.elements.dailyDistances?.value ?? '';
        const storedEntries = this.parseDailyDistances(storedValue);
        const storedByDate = new Map(storedEntries.map(entry => [entry.date, entry.distance]));
        let dates = this.dateRange(form.elements.date?.value, form.elements.endDate?.value);

        if (!dates.length) {
            dates = storedEntries.map(entry => entry.date).filter(Boolean);
        }

        if (!dates.length) {
            container.innerHTML = '<div class="text-sm text-gray-400">日付を選ぶと入力欄が表示されます。</div>';
            this.syncDailyDistances();
            return;
        }

        container.innerHTML = dates.map(date => `
            <div class="flex items-center gap-2 rounded border border-white bg-white p-2">
                <span class="w-16 shrink-0 text-sm text-gray-600">${this.escapeHtml(this.formatShortDate(date) || date)}</span>
                <input type="number" min="0" step="0.1" inputmode="decimal" data-daily-distance-date="${this.escapeHtml(date)}" value="${this.escapeHtml(storedByDate.get(date) || '')}" oninput="app.syncDailyDistances()" class="min-w-0 flex-1 border p-2 rounded" placeholder="走行距離">
                <span class="shrink-0 text-sm text-gray-400">km</span>
            </div>
        `).join('');

        this.syncDailyDistances();
    },

    syncDailyDistances() {
        const form = document.getElementById('data-form');
        const totalEl = document.getElementById('daily-distance-total');
        if (!form) return;

        const inputs = Array.from(document.querySelectorAll('[data-daily-distance-date]'));
        const entries = inputs.map(input => ({
            date: input.dataset.dailyDistanceDate || '',
            distance: String(input.value || '').trim()
        })).filter(entry => entry.distance);
        const total = entries.reduce((sum, entry) => sum + (Number(entry.distance) || 0), 0);
        const roundedTotal = Math.round(total * 10) / 10;

        if (form.elements.dailyDistances) {
            form.elements.dailyDistances.value = entries.length ? JSON.stringify(entries) : '';
        }
        const legacyTotal = this.editRecord && !this.hasValue(this.editRecord.dailyDistances) ? this.editRecord.distance : '';
        const displayTotal = entries.length ? roundedTotal : legacyTotal;
        if (form.elements.distance) {
            form.elements.distance.value = this.hasValue(displayTotal) ? String(displayTotal) : '';
        }
        if (totalEl) {
            totalEl.textContent = this.hasValue(displayTotal) ? `合計 ${this.formatDistance(displayTotal)}km` : '';
        }
    },

    updateTourDates() {
        this.updateDailyDistanceFields();
        const form = document.getElementById('data-form');
        const defaultDate = form.elements.date.value || form.elements.endDate.value;
        document.querySelectorAll('[data-fuel-date]').forEach(input => {
            if (!input.value) input.value = defaultDate;
        });
        this.syncFuelEntries();
    },

    readFuelEntriesFromForm() {
        return Array.from(document.querySelectorAll('[data-fuel-row]')).map(row => ({
            date: String(row.querySelector('[data-fuel-date]')?.value || '').trim(),
            unitPrice: String(row.querySelector('[data-fuel-unit-price]')?.value || '').trim(),
            liters: String(row.querySelector('[data-fuel-liters]')?.value || '').trim()
        }));
    },

    renderFuelEntries(value = null) {
        const form = document.getElementById('data-form');
        const container = document.getElementById('fuel-entry-fields');
        if (!form || !container) return;

        const storedValue = value ?? form.elements.fuelEntries?.value ?? '';
        const entries = Array.isArray(storedValue) ? storedValue : this.parseFuelEntries(storedValue);
        const defaultDate = form.elements.date?.value || form.elements.endDate?.value || '';
        const rows = entries.length ? entries : [{ date: defaultDate, unitPrice: '', liters: '' }];

        container.innerHTML = rows.map((entry, index) => `
            <div data-fuel-row class="rounded border border-white bg-white p-3">
                <label class="block text-xs text-gray-500 mb-1">${index + 1}回目 給油日</label>
                <input type="date" data-fuel-date value="${this.escapeHtml(entry.date || '')}" oninput="app.syncFuelEntries()" class="w-full min-w-0 border p-2 rounded mb-2">
                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="block text-xs text-gray-500 mb-1">単価</label>
                        <input type="number" min="0" step="1" inputmode="numeric" data-fuel-unit-price value="${this.escapeHtml(entry.unitPrice || '')}" oninput="app.syncFuelEntries()" class="w-full border p-2 rounded" placeholder="円/L">
                    </div>
                    <div>
                        <label class="block text-xs text-gray-500 mb-1">給油量</label>
                        <input type="number" min="0" step="0.01" inputmode="decimal" data-fuel-liters value="${this.escapeHtml(entry.liters || '')}" oninput="app.syncFuelEntries()" class="w-full border p-2 rounded" placeholder="L">
                    </div>
                </div>
                <div class="mt-2 flex items-center justify-between gap-2">
                    <span class="text-sm text-gray-500" data-fuel-row-total></span>
                    <button type="button" onclick="app.removeFuelEntry(${index})" class="rounded border border-red-100 px-3 py-1.5 text-sm text-red-600">削除</button>
                </div>
            </div>
        `).join('');

        this.syncFuelEntries();
    },

    addFuelEntry() {
        const entries = this.readFuelEntriesFromForm();
        const form = document.getElementById('data-form');
        entries.push({ date: entries.at(-1)?.date || form.elements.date.value || form.elements.endDate.value || '', unitPrice: '', liters: '' });
        this.renderFuelEntries(entries);
    },

    removeFuelEntry(index) {
        const entries = this.readFuelEntriesFromForm();
        entries.splice(index, 1);
        this.renderFuelEntries(entries);
    },

    syncFuelEntries() {
        const form = document.getElementById('data-form');
        const totalEl = document.getElementById('fuel-entry-total');
        if (!form) return;

        const rows = Array.from(document.querySelectorAll('[data-fuel-row]'));
        const entries = this.readFuelEntriesFromForm();
        let total = 0;

        rows.forEach((row, index) => {
            const rowTotal = this.fuelEntryTotal(entries[index]);
            total += rowTotal;
            const rowTotalEl = row.querySelector('[data-fuel-row-total]');
            if (rowTotalEl) {
                rowTotalEl.textContent = rowTotal ? `${this.formatCurrency(rowTotal)}` : '';
            }
        });

        const filledEntries = entries.filter(entry => entry.unitPrice || entry.liters);
        if (form.elements.fuelEntries) {
            form.elements.fuelEntries.value = filledEntries.length ? JSON.stringify(filledEntries) : '';
        }
        if (form.elements.fuelTotal) {
            form.elements.fuelTotal.value = total ? String(total) : '';
        }
        if (totalEl) {
            totalEl.textContent = filledEntries.length ? `合計 ${this.formatLiters(this.fuelLitersTotal(filledEntries))}L / ${this.formatCurrency(total)}` : '';
        }
    },

    editItem(index) {
        this.editIndex = index;
        this.editRecord = { ...this.data[index] };
        this.showModal(true);

        setTimeout(() => {
            const item = this.editRecord;
            const form = document.getElementById('data-form');

            Object.keys(item).forEach(key => {
                const input = form.elements[key];
                if (input) {
                    input.value = input.type === 'date' ? this.toDateInputValue(item[key]) : item[key];
                }
            });

            this.updatePhotoPreview(item.photoUrl || '');
            this.updateExtraPhotoPreview(item.photoUrls || '');
            if (this.currentTab === 'tours') {
                this.updateDailyDistanceFields(item.dailyDistances || '');
                this.renderFuelEntries(item.fuelEntries || '');
            }
        }, 20);
    },

    async handlePhotoChange(input) {
        const form = document.getElementById('data-form');
        const hiddenInput = form.elements.photoUrl;
        const file = input.files?.[0];

        if (!file) {
            this.updatePhotoPreview(hiddenInput.value);
            return;
        }

        try {
            const previewValue = await this.fileToImageDataUrl(file);
            this.pendingCoverPhotoFile = file;
            hiddenInput.value = previewValue;
            this.updatePhotoPreview(previewValue);
        } catch (error) {
            input.value = '';
            alert(error.message);
        }
    },

    clearPhoto() {
        const form = document.getElementById('data-form');
        const oldPhotoUrl = this.safeUrl(form.elements.photoUrl?.value);
        if (oldPhotoUrl && this.isDrivePhotoUrl(oldPhotoUrl)) {
            this.removedPhotoUrls.add(oldPhotoUrl);
        }
        this.pendingCoverPhotoFile = null;
        if (form.elements.photoFile) form.elements.photoFile.value = '';
        if (form.elements.photoUrl) form.elements.photoUrl.value = '';
        this.updatePhotoPreview('');
    },

    async handleExtraPhotoChange(input) {
        const form = document.getElementById('data-form');
        const hiddenInput = form.elements.photoUrls;
        const files = Array.from(input.files || []);

        if (!files.length) {
            this.updateExtraPhotoPreview(hiddenInput.value);
            return;
        }

        try {
            const urls = this.parsePhotoUrls(hiddenInput.value);
            for (const file of files) {
                const previewUrl = await this.fileToImageDataUrl(file);
                this.pendingExtraPhotoFiles.push({ file, previewUrl });
                urls.push(previewUrl);
            }
            hiddenInput.value = JSON.stringify(urls);
            this.updateExtraPhotoPreview(hiddenInput.value);
        } catch (error) {
            input.value = '';
            alert(error.message);
        }
    },

    clearExtraPhotos() {
        const form = document.getElementById('data-form');
        const urls = this.parsePhotoUrls(form.elements.photoUrls?.value);
        urls.forEach(url => this.removedPhotoUrls.add(url));
        this.pendingExtraPhotoFiles = [];
        if (form.elements.extraPhotoFiles) form.elements.extraPhotoFiles.value = '';
        if (form.elements.photoUrls) form.elements.photoUrls.value = '';
        this.updateExtraPhotoPreview('');
    },

    removeExtraPhoto(index) {
        const form = document.getElementById('data-form');
        const hiddenInput = form.elements.photoUrls;
        const urls = this.parsePhotoUrls(hiddenInput.value);
        const [removedUrl] = urls.splice(index, 1);

        if (removedUrl) {
            this.removedPhotoUrls.add(removedUrl);
            this.pendingExtraPhotoFiles = this.pendingExtraPhotoFiles
                .filter(photo => photo.previewUrl !== removedUrl);
        }

        hiddenInput.value = JSON.stringify(urls);
        this.updateExtraPhotoPreview(hiddenInput.value);
    },

    updatePhotoPreview(photoUrl) {
        const preview = document.getElementById('photo-preview');
        if (!preview) return;

        const image = preview.querySelector('div');
        const safePhotoUrl = this.safeUrl(photoUrl);
        preview.classList.toggle('hidden', !safePhotoUrl);
        image.style.backgroundImage = safePhotoUrl ? `url("${safePhotoUrl.replace(/"/g, '\\"')}")` : '';
    },

    updateExtraPhotoPreview(photoUrls) {
        const preview = document.getElementById('extra-photo-preview');
        if (!preview) return;

        const urls = this.parsePhotoUrls(photoUrls);
        preview.classList.toggle('hidden', !urls.length);
        preview.innerHTML = urls.map((url, index) => (
            `<div class="relative h-16 w-20 shrink-0 rounded bg-cover bg-center border border-gray-200" style="background-image: url('${this.escapeHtml(url)}')"><button type="button" onclick="app.removeExtraPhoto(${index})" class="absolute right-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-xs text-red-600 shadow">削除</button></div>`
        )).join('');
    },

    closeModal() {
        const modal = document.getElementById('modal');
        const content = modal.querySelector('div');
        modal.classList.remove('modal-fade-in');
        content.classList.remove('modal-scale-in');
        setTimeout(() => {
            modal.classList.remove('modal-show');
        }, 300);
    },

    async sendPayload(payload) {
        const response = await fetch(CONFIG.GAS_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();
        if (result.error) throw new Error(result.error);
        return result;
    },

    async deleteDrivePhotos(urls) {
        const driveUrls = [...new Set((urls || []).filter(url => this.isDrivePhotoUrl(url)))];
        if (!driveUrls.length) return;

        try {
            await this.sendPayload({
                action: 'deletePhotos',
                data: {
                    photoUrls: driveUrls
                }
            });
        } catch (error) {
            console.warn('Drive photo deletion failed:', error);
        }
    },

    changedDrivePhotos(oldItem, newData) {
        const oldCover = this.safeUrl(oldItem?.photoUrl);
        const newCover = this.safeUrl(newData?.photoUrl);
        const removed = [...this.removedPhotoUrls];

        if (oldCover && oldCover !== newCover) {
            removed.push(oldCover);
        }

        return removed.filter(url => this.isDrivePhotoUrl(url));
    },

    async deleteItem(index) {
        const item = this.data[index];
        const tab = this.currentTab;
        const label = item.destination || item.name || item.task || this.labels[this.currentTab];

        if (!confirm(`「${label}」を削除しますか？`)) return;

        try {
            const rowIndex = item.__rowIndex || index + 2;
            await this.sendPayload({
                // Older delete handlers discard IDs; the generic writer keeps them.
                action: 'add',
                sheet: 'deleted',
                data: {
                    sheet: tab,
                    rowIndex,
                    id: item.id || '',
                    legacyKey: this.recordKey(item),
                    deletedAt: new Date().toISOString()
                }
            });
            this.invalidateCache(tab);
            await this.deleteDrivePhotos(this.allPhotoUrls(item));
            if (this.currentTab === tab) await this.fetchData(true);
        } catch (error) {
            alert('削除に失敗しました: ' + error.message);
        }
    },

    async submitForm(e) {
        e.preventDefault();

        const form = e.target;
        const submitBtn = form.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.textContent;
        const tab = this.currentTab;

        try {
            submitBtn.textContent = '保存中...';
            submitBtn.disabled = true;
            submitBtn.classList.add('opacity-50', 'cursor-not-allowed');

            if (this.currentTab === 'tours') {
                this.syncDailyDistances();
                this.syncFuelEntries();
            }

            const formData = new FormData(form);
            const data = Object.fromEntries(formData.entries());
            delete data.photoFile;
            delete data.extraPhotoFiles;
            delete data.mileage;
            if (this.currentTab === 'tours') {
                if (!data.date && data.endDate) data.date = data.endDate;
                if (!data.endDate && data.date) data.endDate = data.date;
                if (data.date > data.endDate) [data.date, data.endDate] = [data.endDate, data.date];
            }
            const oldItem = this.editRecord;
            // The deployed API appends revisions; each revision needs its own ID.
            data.id = this.createRecordId();
            const context = this.uploadContext(data);

            if (this.pendingCoverPhotoFile) {
                data.photoUrl = await this.uploadPhotoFile(this.pendingCoverPhotoFile, {
                    ...context,
                    role: 'cover'
                });
            }

            if (this.pendingExtraPhotoFiles.length) {
                const existingUrls = this.parsePhotoUrls(data.photoUrls)
                    .filter(url => !url.startsWith('data:image/'));
                const uploadedUrls = [];

                for (const photo of this.pendingExtraPhotoFiles) {
                    uploadedUrls.push(await this.uploadPhotoFile(photo.file, {
                        ...context,
                        role: 'additional'
                    }));
                }

                data.photoUrls = JSON.stringify([...existingUrls, ...uploadedUrls]);
            }

            const payload = {
                action: 'add',
                sheet: tab,
                data
            };
            await this.sendPayload(payload);
            this.invalidateCache(tab);

            if (oldItem) {
                const rowIndex = oldItem.__rowIndex || this.editIndex + 2;

                await this.sendPayload({
                    action: 'add',
                    sheet: 'deleted',
                    data: {
                        sheet: tab,
                        rowIndex,
                        id: oldItem?.id || '',
                        legacyKey: this.recordKey(oldItem),
                        deletedAt: new Date().toISOString()
                    }
                });
            }

            if (oldItem) {
                await this.deleteDrivePhotos(this.changedDrivePhotos(oldItem, data));
            }

            this.closeModal();
            form.reset();
            this.editIndex = null;
            this.editRecord = null;
            if (this.currentTab === tab) await this.fetchData(true);
        } catch (error) {
            alert('保存に失敗しました: ' + error.message);
        } finally {
            submitBtn.textContent = originalBtnText;
            submitBtn.disabled = false;
            submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());
