const app = {
    currentTab: 'tours',
    data: [],
    editIndex: null,
    deletedRows: new Set(),

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
            .filter(([key]) => key !== '__rowIndex')
            .every(([, value]) => String(value ?? '').trim() === '');
    },

    emptyRecordForCurrentTab() {
        const fields = {
            tours: ['date', 'destination', 'memo', 'distance', 'mileage', 'photoUrl', 'photoUrls'],
            spots: ['name', 'status', 'type', 'mapUrl'],
            parts: ['name', 'category', 'price', 'status'],
            reminders: ['task', 'dueDate', 'status']
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

    async uploadPhotoFile(file) {
        const driveDataUrl = await this.fileToDriveDataUrl(file);

        try {
            const result = await this.sendPayload({
                action: 'uploadPhoto',
                data: {
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

    async fetchData() {
        const loading = document.getElementById('loading');
        const contentArea = document.getElementById('content-area');

        loading.classList.remove('hidden');
        contentArea.innerHTML = '';

        try {
            await this.fetchDeletedRows();

            const response = await fetch(`${CONFIG.GAS_URL}?sheet=${this.currentTab}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const json = await response.json();
            if (json.error) throw new Error(json.error);

            this.data = (json.data || [])
                .map((item, index) => ({
                    ...this.normalizeRecord(item),
                    __rowIndex: index + 2
                }))
                .filter(item => !this.isEmptyRecord(item))
                .filter(item => !this.deletedRows.has(item.__rowIndex));
            this.renderCards();
        } catch (error) {
            contentArea.innerHTML = `
                <div class="col-span-full bg-red-50 text-red-600 p-4 rounded border-l-4 border-red-500">
                    エラーが発生しました: ${this.escapeHtml(error.message)}
                </div>
            `;
        } finally {
            loading.classList.add('hidden');
        }
    },

    async fetchDeletedRows() {
        this.deletedRows = new Set();

        try {
            const response = await fetch(`${CONFIG.GAS_URL}?sheet=deleted`);
            if (!response.ok) return;

            const json = await response.json();
            const deletedRows = (json.data || [])
                .map(item => this.normalizeRecord(item))
                .filter(item => item.sheet === this.currentTab)
                .map(item => Number(item.rowIndex))
                .filter(Number.isInteger);

            this.deletedRows = new Set(deletedRows);
        } catch {
            this.deletedRows = new Set();
        }
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
            card.className = 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 card-hover relative overflow-hidden pb-16';

            const photoUrl = this.safeUrl(item.photoUrl);
            const photoUrls = this.parsePhotoUrls(item.photoUrls);
            const mapUrl = this.safeUrl(item.mapUrl);
            let inner = '';

            if (this.currentTab === 'tours') {
                inner = `
                    ${photoUrl ? `<div class="h-32 -mx-5 -mt-5 mb-4 bg-cover bg-center" style="background-image: url('${this.escapeHtml(photoUrl)}')"></div>` : ''}
                    ${photoUrls.length ? `<div class="flex gap-2 mb-4 overflow-x-auto">${photoUrls.map(url => `<div class="h-16 w-20 shrink-0 rounded bg-cover bg-center border border-gray-200" style="background-image: url('${this.escapeHtml(url)}')"></div>`).join('')}</div>` : ''}
                    <div class="text-xs text-gray-400 mb-1">${this.formatDate(item.date)}</div>
                    <h3 class="text-lg font-bold text-gray-800 mb-2">${this.escapeHtml(item.destination || '目的地なし')}</h3>
                    <p class="text-gray-600 text-sm mb-3 line-clamp-2">${this.escapeHtml(item.memo)}</p>
                    <div class="flex gap-2 text-xs">
                        <span class="bg-gray-100 text-gray-600 px-2 py-1 rounded">走行: ${this.escapeHtml(item.distance || 0)}km</span>
                        <span class="bg-gray-100 text-gray-600 px-2 py-1 rounded">燃費: ${this.escapeHtml(item.mileage || '-')}</span>
                    </div>
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
                <div class="absolute bottom-4 right-4 flex gap-2">
                    <button onclick="app.editItem(${index})" class="text-gray-500 hover:text-emerald-600 transition-colors flex items-center gap-1 text-sm bg-white px-2 py-1 rounded-md shadow-sm border border-gray-100">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                        編集
                    </button>
                    <button onclick="app.deleteItem(${index})" class="text-gray-500 hover:text-red-600 transition-colors flex items-center gap-1 text-sm bg-white px-2 py-1 rounded-md shadow-sm border border-gray-100">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m-9 0h12"></path></svg>
                        削除
                    </button>
                </div>
            `;

            card.innerHTML = inner;
            contentArea.appendChild(card);
        });
    },

    showModal(isEdit = false) {
        this.editIndex = isEdit ? this.editIndex : null;
        const titleEl = document.getElementById('modal-title');
        if (titleEl) titleEl.textContent = isEdit ? '編集' : '新規追加';

        const modal = document.getElementById('modal');
        const content = modal.querySelector('div');
        modal.classList.add('modal-show');
        setTimeout(() => {
            modal.classList.add('modal-fade-in');
            content.classList.add('modal-scale-in');
        }, 10);

        document.getElementById('form-fields').innerHTML = this.getFormFields();
        this.updatePhotoPreview('');
        this.updateExtraPhotoPreview('');
    },

    getFormFields() {
        if (this.currentTab === 'tours') {
            return `
                <div><label class="block text-sm text-gray-600 mb-1">日付</label><input type="date" name="date" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">目的地</label><input type="text" name="destination" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">メモ</label><textarea name="memo" class="w-full border p-2 rounded"></textarea></div>
                <div class="grid grid-cols-2 gap-4">
                    <div><label class="block text-sm text-gray-600 mb-1">走行距離(km)</label><input type="number" name="distance" class="w-full border p-2 rounded"></div>
                    <div><label class="block text-sm text-gray-600 mb-1">燃費</label><input type="number" step="0.1" name="mileage" class="w-full border p-2 rounded"></div>
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
                    <label class="block text-sm text-gray-600 mb-1">Additional photos</label>
                    <input type="file" name="extraPhotoFiles" accept="image/*" capture="environment" multiple onchange="app.handleExtraPhotoChange(this)" class="w-full border p-2 rounded bg-white">
                    <input type="hidden" name="photoUrls">
                    <div id="extra-photo-preview" class="hidden mt-3 flex gap-2 overflow-x-auto"></div>
                    <button type="button" onclick="app.clearExtraPhotos()" class="mt-2 text-sm text-red-600 hover:underline">Clear additional photos</button>
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

    editItem(index) {
        this.editIndex = index;
        this.showModal(true);

        setTimeout(() => {
            const item = this.data[index];
            const form = document.getElementById('data-form');

            Object.keys(item).forEach(key => {
                const input = form.elements[key];
                if (input) {
                    input.value = input.type === 'date' ? this.toDateInputValue(item[key]) : item[key];
                }
            });

            this.updatePhotoPreview(item.photoUrl || '');
            this.updateExtraPhotoPreview(item.photoUrls || '');
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
            const photoValue = await this.uploadPhotoFile(file);
            hiddenInput.value = photoValue;
            this.updatePhotoPreview(photoValue);
        } catch (error) {
            input.value = '';
            alert(error.message);
        }
    },

    clearPhoto() {
        const form = document.getElementById('data-form');
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
            const urls = [];
            for (const file of files) {
                urls.push(await this.uploadPhotoFile(file));
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
        if (form.elements.extraPhotoFiles) form.elements.extraPhotoFiles.value = '';
        if (form.elements.photoUrls) form.elements.photoUrls.value = '';
        this.updateExtraPhotoPreview('');
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
        preview.innerHTML = urls.map(url => (
            `<div class="h-16 w-20 shrink-0 rounded bg-cover bg-center border border-gray-200" style="background-image: url('${this.escapeHtml(url)}')"></div>`
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

    async deleteItem(index) {
        const item = this.data[index];
        const label = item.destination || item.name || item.task || this.labels[this.currentTab];

        if (!confirm(`「${label}」を削除しますか？`)) return;

        try {
            const rowIndex = item.__rowIndex || index + 2;
            await this.sendPayload({
                action: 'add',
                sheet: 'deleted',
                data: {
                    sheet: this.currentTab,
                    rowIndex,
                    deletedAt: new Date().toISOString()
                }
            });
            await this.fetchData();
        } catch (error) {
            alert('削除に失敗しました: ' + error.message);
        }
    },

    async submitForm(e) {
        e.preventDefault();

        const form = e.target;
        const submitBtn = form.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.textContent;

        try {
            submitBtn.textContent = '保存中...';
            submitBtn.disabled = true;
            submitBtn.classList.add('opacity-50', 'cursor-not-allowed');

            const formData = new FormData(form);
            const data = Object.fromEntries(formData.entries());
            delete data.photoFile;
            delete data.extraPhotoFiles;

            const photoFile = form.elements.photoFile?.files?.[0];
            if (photoFile && !data.photoUrl) {
                data.photoUrl = await this.uploadPhotoFile(photoFile);
            }

            const extraPhotoFiles = Array.from(form.elements.extraPhotoFiles?.files || []);
            if (extraPhotoFiles.length && !data.photoUrls) {
                const urls = [];
                for (const file of extraPhotoFiles) {
                    urls.push(await this.uploadPhotoFile(file));
                }
                data.photoUrls = JSON.stringify(urls);
            }

            const payload = {
                sheet: this.currentTab,
                data
            };

            if (this.editIndex !== null) {
                const rowIndex = this.data[this.editIndex]?.__rowIndex || this.editIndex + 2;

                await this.sendPayload({
                    action: 'add',
                    sheet: 'deleted',
                    data: {
                        sheet: this.currentTab,
                        rowIndex,
                        deletedAt: new Date().toISOString()
                    }
                });

                payload.action = 'add';
            } else {
                payload.action = 'add';
            }

            await this.sendPayload(payload);

            this.closeModal();
            form.reset();
            this.editIndex = null;
            await this.fetchData();
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
