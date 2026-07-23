const app = {
    currentTab: 'tours',
    data: [],

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
            const json = await response.json();

            if (json.error) throw new Error(json.error);

            this.data = json.data || [];
            this.renderCards();
        } catch (error) {
            contentArea.innerHTML = `
                <div class="col-span-full bg-red-50 text-red-600 p-4 rounded border-l-4 border-red-500">
                    エラーが発生しました: ${error.message}
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

        this.data.forEach(item => {
            const card = document.createElement('div');
            card.className = 'bg-white rounded-xl shadow-sm border border-gray-100 p-5 card-hover relative overflow-hidden';

            // タブごとに表示を変える
            if (this.currentTab === 'tours') {
                card.innerHTML = `
                    ${item.photoUrl ? `<div class="h-32 -mx-5 -mt-5 mb-4 bg-cover bg-center" style="background-image: url('${item.photoUrl}')"></div>` : ''}
                    <div class="text-xs text-gray-400 mb-1">${item.date || '日付未定'}</div>
                    <h3 class="text-lg font-bold text-gray-800 mb-2">${item.destination || '目的地なし'}</h3>
                    <p class="text-gray-600 text-sm mb-3 line-clamp-2">${item.memo || ''}</p>
                    <div class="flex gap-2 text-xs">
                        <span class="bg-gray-100 text-gray-600 px-2 py-1 rounded">走行: ${item.distance || 0}km</span>
                        <span class="bg-gray-100 text-gray-600 px-2 py-1 rounded">燃費: ${item.mileage || '-'}</span>
                    </div>
                `;
            } else if (this.currentTab === 'spots') {
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-2">
                        <h3 class="text-lg font-bold text-gray-800">${item.name}</h3>
                        <span class="text-xs px-2 py-1 rounded ${item.status === 'visited' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">${item.status === 'visited' ? '訪問済' : '行きたい'}</span>
                    </div>
                    <span class="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded mb-3 inline-block">${item.type === 'parking' ? '駐輪場' : 'スポット'}</span>
                    ${item.mapUrl ? `<a href="${item.mapUrl}" target="_blank" class="block text-emerald-500 text-sm hover:underline mt-2">🗺️ マップで見る</a>` : ''}
                `;
            } else if (this.currentTab === 'parts') {
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-2">
                        <h3 class="text-lg font-bold text-gray-800">${item.name}</h3>
                        <span class="text-xs px-2 py-1 rounded ${item.status === 'installed' ? 'bg-blue-100 text-blue-700' : (item.status === 'purchased' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700')}">${item.status}</span>
                    </div>
                    <div class="text-sm text-gray-500 mb-1">分類: ${item.category}</div>
                    <div class="font-semibold text-gray-700">¥${item.price || 0}</div>
                `;
            } else if (this.currentTab === 'reminders') {
                card.innerHTML = `
                    <div class="flex items-center gap-3 mb-2">
                        <input type="checkbox" ${item.status === 'done' ? 'checked' : ''} disabled class="w-5 h-5 text-emerald-500 rounded border-gray-300">
                        <h3 class="text-lg font-bold ${item.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-800'}">${item.task}</h3>
                    </div>
                    <div class="text-sm text-red-500 font-medium ml-8">期限: ${item.dueDate || '未定'}</div>
                `;
            }
            contentArea.appendChild(card);
        });
    },

    // モーダル関連 (表示用のみ・送信処理はステップ3で実装)
    showModal() {
        const modal = document.getElementById('modal');
        const content = modal.querySelector('div');
        modal.classList.add('modal-show');
        setTimeout(() => {
            modal.classList.add('modal-fade-in');
            content.classList.add('modal-scale-in');
        }, 10);

        // 簡易的なフォーム生成 (ステップ3で本格実装)
        document.getElementById('form-fields').innerHTML = `<p class="text-sm text-gray-500">※登録・編集機能は次のステップで実装します。</p>`;
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

    submitForm(e) {
        e.preventDefault();
        alert("保存機能は現在準備中です");
        this.closeModal();
    }
};

// 初期化
document.addEventListener('DOMContentLoaded', () => app.init());
