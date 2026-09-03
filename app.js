const app = {
    currentTab: 'tours',
    data: [],
    editIndex: null,

    normalizeRecord(item) {
        return Object.fromEntries(
            Object.entries(item || {}).map(([key, value]) => [key.trim(), value])
        );
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

        try {
            const url = new URL(value, window.location.href);
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch {
            return '';
        }
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
        if (CONFIG.GAS_URL === "YOUR_GAS_URL_HERE") {
            document.getElementById('content-area').innerHTML = `
                <div class="col-span-full bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded shadow-sm">
                    <p class="text-yellow-700"><strong>設定待ち:</strong> config.js に GASのデプロイURL を設定してください。</p>
                </div>
            `;
            return;
        }
        this.switchTab(this.currentTab);
    },

    async switchTab(tab) {
        this.currentTab = tab;

        // UI更新
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        const titles = {
            tours: '🛣️ ツーリング記録',
            spots: '📍 スポット・駐輪場',
            parts: '⚙️ パーツ管理',
            reminders: '📅 リマインダー'
        };
        document.getElementById('page-title').textContent = titles[tab];

        await this.fetchData();
    },

    async fetchData() {
        const loading = document.getElementById('loading');
        const contentArea = document.getElementById('content-area');

        loading.classList.remove('hidden');
        contentArea.innerHTML = '';

        try {
            const response = await fetch(`${CONFIG.GAS_URL}?sheet=${this.currentTab}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const json = await response.json();

            if (json.error) throw new Error(json.error);

            this.data = (json.data || []).map(item => this.normalizeRecord(item));
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

    renderCards() {
        const contentArea = document.getElementById('content-area');
        contentArea.innerHTML = '';

        if (this.data.length === 0) {
            contentArea.innerHTML = `<div class="col-span-full text-center text-gray-500 py-10">データがありません</div>`;
            return;
        }

        this.data.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 card-hover relative overflow-hidden pb-14';

            const photoUrl = this.safeUrl(item.photoUrl);
            const mapUrl = this.safeUrl(item.mapUrl);
            let inner = '';
            if (this.currentTab === 'tours') {
                inner = `
                    ${photoUrl ? `<div class="h-32 -mx-5 -mt-5 mb-4 bg-cover bg-center" style="background-image: url('${this.escapeHtml(photoUrl)}')"></div>` : ''}
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
                    ${mapUrl ? `<a href="${this.escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer" class="block text-emerald-500 text-sm hover:underline mt-2">🗺️ マップで見る</a>` : ''}
                `;
            } else if (this.currentTab === 'parts') {
                inner = `
                    <div class="flex justify-between items-start mb-2">
                        <h3 class="text-lg font-bold text-gray-800">${this.escapeHtml(item.name)}</h3>
                        <span class="text-xs px-2 py-1 rounded ${item.status === 'installed' ? 'bg-blue-100 text-blue-700' : (item.status === 'purchased' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700')}">${this.escapeHtml(item.status)}</span>
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
            
            // 編集ボタンを追加
            inner += `
                <button onclick="app.editItem(${index})" class="absolute bottom-4 right-4 text-gray-400 hover:text-emerald-500 transition-colors flex items-center gap-1 text-sm bg-white px-2 py-1 rounded-md shadow-sm border border-gray-100">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                    編集
                </button>
            `;
            
            card.innerHTML = inner;
            contentArea.appendChild(card);
        });
    },

    // モーダル関連
    showModal(isEdit = false) {
        if (!isEdit) {
            this.editIndex = null;
            const titleEl = document.getElementById('modal-title');
            if (titleEl) titleEl.textContent = '新規追加';
        } else {
            const titleEl = document.getElementById('modal-title');
            if (titleEl) titleEl.textContent = '編集';
        }

        const modal = document.getElementById('modal');
        const content = modal.querySelector('div');
        modal.classList.add('modal-show');
        setTimeout(() => {
            modal.classList.add('modal-fade-in');
            content.classList.add('modal-scale-in');
        }, 10);

        let fieldsHTML = '';
        if (this.currentTab === 'tours') {
            fieldsHTML = `
                <div><label class="block text-sm text-gray-600 mb-1">日付</label><input type="date" name="date" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">目的地</label><input type="text" name="destination" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">メモ</label><textarea name="memo" class="w-full border p-2 rounded"></textarea></div>
                <div class="grid grid-cols-2 gap-4">
                    <div><label class="block text-sm text-gray-600 mb-1">走行距離(km)</label><input type="number" name="distance" class="w-full border p-2 rounded"></div>
                    <div><label class="block text-sm text-gray-600 mb-1">燃費</label><input type="number" step="0.1" name="mileage" class="w-full border p-2 rounded"></div>
                </div>
                <div><label class="block text-sm text-gray-600 mb-1">写真URL</label><input type="url" name="photoUrl" class="w-full border p-2 rounded"></div>
            `;
        } else if (this.currentTab === 'spots') {
            fieldsHTML = `
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
        } else if (this.currentTab === 'parts') {
            fieldsHTML = `
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
        } else if (this.currentTab === 'reminders') {
            fieldsHTML = `
                <div><label class="block text-sm text-gray-600 mb-1">タスク内容</label><input type="text" name="task" class="w-full border p-2 rounded" required></div>
                <div><label class="block text-sm text-gray-600 mb-1">期限</label><input type="date" name="dueDate" class="w-full border p-2 rounded"></div>
                <div><label class="block text-sm text-gray-600 mb-1">ステータス</label>
                    <select name="status" class="w-full border p-2 rounded">
                        <option value="">未完了</option>
                        <option value="done">完了</option>
                    </select>
                </div>
            `;
        }
        document.getElementById('form-fields').innerHTML = fieldsHTML;
    },

    editItem(index) {
        this.editIndex = index;
        this.showModal(true);
        
        // フォームが生成されるのを待ってから値をセット
        setTimeout(() => {
            const item = this.data[index];
            const form = document.getElementById('data-form');
            Object.keys(item).forEach(key => {
                const input = form.elements[key];
                if (input) {
                    input.value = input.type === 'date' ? this.toDateInputValue(item[key]) : item[key];
                }
            });
        }, 20);
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

    async submitForm(e) {
        e.preventDefault();
        
        const form = e.target;
        const submitBtn = form.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.textContent;
        
        // フォームデータをオブジェクトに変換
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());
        
        // 送信ペイロード
        const payload = {
            sheet: this.currentTab,
            data: data
        };

        if (this.editIndex !== null) {
            payload.action = 'edit';
            payload.rowIndex = this.editIndex + 2; // ヘッダー行(1) + 0始まりを1始まりに補正(1) = 2
        } else {
            payload.action = 'add';
        }

        try {
            submitBtn.textContent = '保存中...';
            submitBtn.disabled = true;
            submitBtn.classList.add('opacity-50', 'cursor-not-allowed');

            const response = await fetch(CONFIG.GAS_URL, {
                method: 'POST',
                // プリフライト(OPTIONS)リクエストを避けるため、デフォルトのContent-Type等で送信する。
                // GASは text/plain のBodyもパースして e.postData.contents で取得可能。
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            
            if (result.error) {
                throw new Error(result.error);
            }

            // 成功時
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

// 初期化
document.addEventListener('DOMContentLoaded', () => app.init());
