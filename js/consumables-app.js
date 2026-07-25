(function() {
    const STORAGE_KEYS = {
        requests: 'pancreasys_consumable_requests',
        seed: 'pancreasys_consumable_seed_fallback'
    };

    const state = {
        apiEnabled: false,
        currentUser: null,
        selectedItemKey: null,
        isInitialized: false,
        activeConsumablesTab: 'request',
        labHeadEmail: 'umahajan@niper.ac.in',
        summary: {
            catalogItems: 0,
            savedRequests: 0,
            pendingRequests: 0
        },
        items: [],
        requests: []
    };

    function isLabHead(user) {
        if (!user) return false;
        const role = (user.role || '').toLowerCase();
        return user.email === state.labHeadEmail || /lab head|pi|principal investigator|faculty/.test(role);
    }

    function loadJson(key, fallback) {
        try {
            return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
        } catch (error) {
            console.error('Failed to parse local data for', key, error);
            return fallback;
        }
    }

    function saveJson(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function formatDate(value) {
        if (!value) return 'Not recorded';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    }

    function formatDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toISOString();
    }

    function csvCell(value) {
        const text = String(value ?? '');
        return `"${text.replace(/"/g, '""')}"`;
    }

    function downloadTextFile(content, filename) {
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function buildSearchText(item) {
        return [item.name, item.catalogue_number, item.catalogueNumber, item.manufacturer, item.category]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
    }

    function setStatusMessage(message, tone) {
        const el = document.getElementById('consumablesStatusMessage');
        if (!el) return;
        el.textContent = message;
        el.className = 'consumables-status-message';
        if (tone) el.classList.add(`is-${tone}`);
    }

    function uniqueUrls(urls) {
        return [...new Set(urls.filter(Boolean))];
    }

    function buildUrlCandidates(path) {
        const relativePath = path.replace(/^\//, '');
        return uniqueUrls([
            relativePath,
            `./${relativePath}`,
            `/${relativePath}`
        ]);
    }

    async function fetchJson(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) {
            let message = 'Request failed.';
            try {
                const payload = await response.json();
                message = payload.error || message;
            } catch (error) {
                message = `${message} (${response.status})`;
            }
            throw new Error(message);
        }
        return response.json();
    }

    async function fetchJsonFromCandidates(urls, options) {
        let lastError = null;
        for (const url of urls) {
            try {
                return await fetchJson(url, options);
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('Request failed.');
    }

    function getCatalogItems() {
        return state.items;
    }

    function getRequests() {
        return state.requests;
    }

    function syncFallbackState(payload) {
        saveJson(STORAGE_KEYS.seed, {
            items: payload.items || [],
            labHeadEmail: payload.labHeadEmail || state.labHeadEmail,
            summary: payload.summary || state.summary
        });
        saveJson(STORAGE_KEYS.requests, payload.requests || []);
    }

    async function loadBootstrap() {
        try {
            const payload = await fetchJsonFromCandidates(buildUrlCandidates('api/consumables/bootstrap'));
            state.apiEnabled = true;
            state.labHeadEmail = payload.labHeadEmail || state.labHeadEmail;
            state.summary = payload.summary || state.summary;
            state.items = payload.items || [];
            state.requests = payload.requests || [];
            syncFallbackState(payload);
            return;
        } catch (error) {
            console.warn('Flask API unavailable, using local fallback.', error);
        }

        state.apiEnabled = false;
        const seed = loadJson(STORAGE_KEYS.seed, null);
        if (seed) {
            state.items = seed.items || [];
            state.labHeadEmail = seed.labHeadEmail || state.labHeadEmail;
            state.summary = seed.summary || state.summary;
        } else {
            try {
                const fileSeed = await fetchJsonFromCandidates(buildUrlCandidates('data/consumables-seed.json'));
                state.items = fileSeed.items || [];
                state.labHeadEmail = fileSeed.labHeadEmail || state.labHeadEmail;
                state.summary = {
                    catalogItems: (fileSeed.items || []).length,
                    savedRequests: 0,
                    pendingRequests: 0
                };
                saveJson(STORAGE_KEYS.seed, {
                    items: state.items,
                    labHeadEmail: state.labHeadEmail,
                    summary: state.summary
                });
            } catch (error) {
                console.warn('Consumables seed file unavailable, starting with empty local state.', error);
                state.items = [];
                state.summary = {
                    catalogItems: 0,
                    savedRequests: 0,
                    pendingRequests: 0
                };
            }
        }
        state.requests = loadJson(STORAGE_KEYS.requests, []);
        state.summary = {
            catalogItems: state.items.length,
            savedRequests: state.requests.length,
            pendingRequests: state.requests.filter(item => item.status === 'pending_lab_head').length
        };
    }

    function findMatches(query) {
        if (!query) return [];
        const search = query.trim().toLowerCase();
        if (!search) return [];

        return getCatalogItems()
            .map(item => ({ item, haystack: buildSearchText(item) }))
            .filter(entry => entry.haystack.includes(search))
            .slice(0, 8)
            .map(entry => entry.item);
    }

    function getSelectedItem() {
        if (!state.selectedItemKey) return null;
        return getCatalogItems().find(item => item.item_key === state.selectedItemKey) || null;
    }

    function fillFormFromItem(item) {
        const nameInput = document.getElementById('consumableName');
        const catalogueInput = document.getElementById('consumableCatalogue');
        const manufacturerInput = document.getElementById('consumableManufacturer');
        const availabilitySelect = document.getElementById('consumableAvailability');

        if (nameInput) nameInput.value = item.name || '';
        if (catalogueInput) catalogueInput.value = item.catalogue_number || item.catalogueNumber || '';
        if (manufacturerInput) manufacturerInput.value = item.manufacturer || '';
        if (availabilitySelect) {
            availabilitySelect.value = item.stored_at ? 'available' : 'not-available';
        }

        state.selectedItemKey = item.item_key;
        renderSelectedItem();
        renderSuggestions();
    }

    function renderSummary() {
        const summary = document.getElementById('consumablesSummary');
        if (!summary) return;

        summary.innerHTML = `
            <div class="consumables-metric">
                <span class="consumables-metric-value">${state.summary.catalogItems || getCatalogItems().length}</span>
                <span class="consumables-metric-label">Catalogued items</span>
            </div>
            <div class="consumables-metric">
                <span class="consumables-metric-value">${state.summary.savedRequests || getRequests().length}</span>
                <span class="consumables-metric-label">Saved requests</span>
            </div>
            <div class="consumables-metric">
                <span class="consumables-metric-value">${state.summary.pendingRequests || getRequests().filter(request => request.status === 'pending_lab_head').length}</span>
                <span class="consumables-metric-label">Awaiting lab head</span>
            </div>
        `;
    }

    function renderConsumablesTabs() {
        document.querySelectorAll('[data-consumables-tab]').forEach(button => {
            const isActive = button.getAttribute('data-consumables-tab') === state.activeConsumablesTab;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', String(isActive));
        });

        const requestView = document.getElementById('consumablesRequestView');
        const browseView = document.getElementById('consumablesBrowseView');
        if (requestView) requestView.hidden = state.activeConsumablesTab !== 'request';
        if (browseView) browseView.hidden = state.activeConsumablesTab !== 'browse';
    }

    function renderCategoryBrowse() {
        const list = document.getElementById('consumablesCategoryList');
        if (!list) return;

        const items = getCatalogItems()
            .slice()
            .sort((left, right) => (left.name || '').localeCompare(right.name || ''));

        if (!items.length) {
            list.innerHTML = '<p class="consumables-empty">No catalog items are available yet.</p>';
            return;
        }

        list.innerHTML = `
            <div class="consumables-table-wrap">
                <table class="consumables-table">
                    <thead>
                        <tr>
                            <th>Chemical / item</th>
                            <th>Category</th>
                            <th>Catalogue No.</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map(item => `
                            <tr>
                                <td>${escapeHtml(item.name || 'Unnamed item')}</td>
                                <td>${escapeHtml(item.category || 'Uncategorised')}</td>
                                <td>${escapeHtml(item.catalogue_number || item.catalogueNumber || '—')}</td>
                                <td>${escapeHtml(item.status || 'Recorded')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderRecentOrders() {
        const list = document.getElementById('consumablesRecentOrdersList');
        if (!list) return;

        const updates = getRequests()
            .filter(requestItem => requestItem.status === 'ordered_by_lab_head' || requestItem.status === 'stored')
            .slice()
            .sort((left, right) => {
                const leftDate = right.orderedAt || right.receivedAt || right.createdAt || '';
                const rightDate = left.orderedAt || left.receivedAt || left.createdAt || '';
                return leftDate.localeCompare(rightDate);
            });

        if (!updates.length) {
            list.innerHTML = '<p class="consumables-empty">No ordered or stored updates yet.</p>';
            return;
        }

        list.innerHTML = `
            <div class="consumables-table-wrap">
                <table class="consumables-table">
                    <thead>
                        <tr>
                            <th>Item</th>
                            <th>Status</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${updates.slice(0, 8).map(requestItem => `
                            <tr>
                                <td>${escapeHtml(requestItem.itemName)}</td>
                                <td>${escapeHtml(requestItem.statusLabel || requestItem.status)}</td>
                                <td>${escapeHtml(formatDate(requestItem.orderedAt || requestItem.receivedAt || requestItem.createdAt))}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderSuggestions() {
        const list = document.getElementById('consumablesSuggestions');
        const query = [
            document.getElementById('consumableName')?.value,
            document.getElementById('consumableCatalogue')?.value,
            document.getElementById('consumableManufacturer')?.value
        ].filter(Boolean).join(' ');

        if (!list) return;
        const matches = findMatches(query);

        if (!matches.length) {
            list.innerHTML = '<p class="consumables-empty">No catalogue match yet. You can still submit a new request.</p>';
            return;
        }

        list.innerHTML = matches.map(item => `
            <button type="button" class="consumables-suggestion ${state.selectedItemKey === item.item_key ? 'is-active' : ''}" data-item-key="${escapeHtml(item.item_key)}">
                <strong>${escapeHtml(item.name)}</strong>
                <span>${escapeHtml(item.catalogue_number || 'No catalogue no.')} · ${escapeHtml(item.manufacturer || item.category)}</span>
            </button>
        `).join('');
    }

    function renderSelectedItem() {
        const panel = document.getElementById('consumablesLookupResult');
        if (!panel) return;
        const item = getSelectedItem();

        if (!item) {
            panel.innerHTML = `
                <div class="consumables-lookup-empty">
                    <h4>Lookup details</h4>
                    <p>Select a catalogue match or type an item name to see the last ordered date and storage location.</p>
                </div>
            `;
            return;
        }

        panel.innerHTML = `
            <div class="consumables-lookup-card">
                <div>
                    <p class="consumables-kicker">Matched consumable</p>
                    <h4>${escapeHtml(item.name)}</h4>
                </div>
                <dl class="consumables-details-grid">
                    <div>
                        <dt>Category</dt>
                        <dd>${escapeHtml(item.category || 'Not recorded')}</dd>
                    </div>
                    <div>
                        <dt>Catalogue No.</dt>
                        <dd>${escapeHtml(item.catalogue_number || item.catalogueNumber || 'Not recorded')}</dd>
                    </div>
                    <div>
                        <dt>Manufacturer</dt>
                        <dd>${escapeHtml(item.manufacturer || 'Not recorded')}</dd>
                    </div>
                    <div>
                        <dt>Last ordered</dt>
                        <dd>${escapeHtml(formatDate(item.ordered_date || item.date_of_issue))}</dd>
                    </div>
                    <div>
                        <dt>Stored at</dt>
                        <dd>${escapeHtml(item.stored_at || 'Not recorded')}</dd>
                    </div>
                    <div>
                        <dt>Status</dt>
                        <dd>${escapeHtml(item.status || 'Recorded')}</dd>
                    </div>
                </dl>
            </div>
        `;
    }

    function renderRequests() {
        const list = document.getElementById('consumablesRequestList');
        if (!list) return;

        const requests = getRequests().slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        if (!requests.length) {
            list.innerHTML = '<p class="consumables-empty">No consumable requests have been submitted yet.</p>';
            return;
        }

        list.innerHTML = requests.map(requestItem => `
            <article class="consumables-request-card">
                <div class="consumables-request-head">
                    <h4>${escapeHtml(requestItem.itemName)}</h4>
                    <span class="consumables-badge is-${escapeHtml(requestItem.status)}">${escapeHtml(requestItem.statusLabel)}</span>
                </div>
                <p>${escapeHtml(requestItem.catalogueNumber || 'No catalogue no.')} · ${escapeHtml(requestItem.manufacturer || 'Manufacturer not provided')}</p>
                <p>Requested by ${escapeHtml(requestItem.requesterName)} on ${escapeHtml(formatDate(requestItem.createdAt))}</p>
                <p>Availability: ${escapeHtml(requestItem.availabilityLabel)}</p>
                ${requestItem.storedAt ? `<p>Stored at: ${escapeHtml(requestItem.storedAt)}</p>` : ''}
                ${requestItem.notes ? `<p>Notes: ${escapeHtml(requestItem.notes)}</p>` : ''}
            </article>
        `).join('');
    }

    function renderLabHeadPanel() {
        const wrapper = document.getElementById('labHeadQueue');
        const section = document.getElementById('consumablesLabHeadPanel');
        if (!wrapper || !section) return;

        if (!isLabHead(state.currentUser)) {
            section.hidden = true;
            return;
        }

        section.hidden = false;
        const pending = getRequests().filter(requestItem => requestItem.status === 'pending_lab_head' || requestItem.status === 'ordered_by_lab_head');
        if (!pending.length) {
            wrapper.innerHTML = '<p class="consumables-empty">No pending purchase confirmations for the lab head.</p>';
            return;
        }

        wrapper.innerHTML = pending.map(requestItem => `
            <article class="consumables-request-card is-admin">
                <div class="consumables-request-head">
                    <h4>${escapeHtml(requestItem.itemName)}</h4>
                    <span class="consumables-badge is-${escapeHtml(requestItem.status)}">${escapeHtml(requestItem.statusLabel)}</span>
                </div>
                <p>${escapeHtml(requestItem.catalogueNumber || 'No catalogue no.')} · ${escapeHtml(requestItem.manufacturer || 'Manufacturer not provided')}</p>
                <p>${escapeHtml(requestItem.requesterName)} requested ${escapeHtml(requestItem.quantity || '1')} item(s)</p>
                <div class="consumables-admin-actions">
                    ${requestItem.status === 'pending_lab_head' ? `<button type="button" class="btn btn-small" data-order-request="${escapeHtml(requestItem.id)}">Mark Ordered</button>` : ''}
                    <button type="button" class="btn btn-small btn-secondary" data-store-request="${escapeHtml(requestItem.id)}">Mark Stored</button>
                </div>
            </article>
        `).join('');
    }

    function renderAll() {
        renderSummary();
        renderSuggestions();
        renderSelectedItem();
        renderRequests();
        renderLabHeadPanel();
        renderCategoryBrowse();
        renderRecentOrders();
        renderConsumablesTabs();
    }

    async function refreshData() {
        await loadBootstrap();
        renderAll();
    }

    async function saveFallbackRequest(requestItem) {
        const requests = loadJson(STORAGE_KEYS.requests, []);
        requests.push(requestItem);
        saveJson(STORAGE_KEYS.requests, requests);
        state.requests = requests;
        state.summary = {
            catalogItems: state.items.length,
            savedRequests: state.requests.length,
            pendingRequests: state.requests.filter(item => item.status === 'pending_lab_head').length
        };
    }

    async function handleRequestSubmit(event) {
        event.preventDefault();

        if (!state.currentUser) {
            setStatusMessage('Sign in to submit a consumables request.', 'error');
            return;
        }

        const itemName = document.getElementById('consumableName')?.value.trim();
        const catalogueNumber = document.getElementById('consumableCatalogue')?.value.trim();
        const manufacturer = document.getElementById('consumableManufacturer')?.value.trim();
        const quantity = document.getElementById('consumableQuantity')?.value.trim();
        const availability = document.getElementById('consumableAvailability')?.value;
        const notes = document.getElementById('consumableNotes')?.value.trim();
        const selectedItem = getSelectedItem();

        if (!itemName) {
            setStatusMessage('Consumable name is required.', 'error');
            return;
        }

        if (availability === 'not-available') {
            const confirmed = window.confirm('This consumable is marked as not available. Confirm to send a purchase request to the lab head?');
            if (!confirmed) {
                return;
            }
        }

        const payload = {
            requesterName: state.currentUser.name,
            requesterEmail: state.currentUser.email,
            requesterRole: state.currentUser.role || '',
            itemName,
            catalogueNumber,
            manufacturer,
            quantity,
            availability,
            notes,
            matchedItemKey: selectedItem ? selectedItem.item_key : null,
            matchedItemSnapshot: selectedItem ? {
                lastOrderedAt: selectedItem.ordered_date || selectedItem.date_of_issue || null,
                storedAt: selectedItem.stored_at || null,
                status: selectedItem.status || null
            } : null,
            labHeadEmail: state.labHeadEmail
        };

        try {
            let savedRequest;
            if (state.apiEnabled) {
                savedRequest = await fetchJsonFromCandidates(buildUrlCandidates('api/consumables/requests'), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                await refreshData();
            } else {
                savedRequest = {
                    ...payload,
                    id: `req_${Date.now()}`,
                    createdAt: new Date().toISOString(),
                    status: availability === 'not-available' ? 'pending_lab_head' : 'requested_from_stock',
                    statusLabel: availability === 'not-available' ? 'Pending with lab head' : 'Check existing stock',
                    availabilityLabel: availability === 'not-available' ? 'Not available in lab storage' : 'Available / needs stock check'
                };
                await saveFallbackRequest(savedRequest);
                renderAll();
            }

            if (availability === 'not-available') {
                const subject = encodeURIComponent(`Consumable purchase request: ${itemName}`);
                const body = encodeURIComponent(
                    `Consumable request submitted by ${state.currentUser.name} (${state.currentUser.email})\n\n` +
                    `Name: ${itemName}\n` +
                    `Catalogue Number: ${catalogueNumber || 'Not provided'}\n` +
                    `Manufacturer: ${manufacturer || 'Not provided'}\n` +
                    `Quantity: ${quantity || 'Not provided'}\n` +
                    `Last ordered: ${(savedRequest.matchedItemSnapshot && savedRequest.matchedItemSnapshot.lastOrderedAt) || 'Not recorded'}\n` +
                    `Stored at: ${(savedRequest.matchedItemSnapshot && savedRequest.matchedItemSnapshot.storedAt) || 'Not recorded'}\n` +
                    `Notes: ${notes || 'None'}\n`
                );
                window.location.href = `mailto:${state.labHeadEmail}?subject=${subject}&body=${body}`;
                setStatusMessage('Request confirmed and sent to the lab head workflow.', 'success');
            } else {
                setStatusMessage('Request saved. Check the matched storage location before ordering again.', 'success');
            }

            document.getElementById('consumablesRequestForm')?.reset();
            const requester = document.getElementById('requesterIdentity');
            if (requester) {
                requester.textContent = `${state.currentUser.name} (${state.currentUser.email})`;
            }
            state.selectedItemKey = null;
            renderAll();
        } catch (error) {
            console.error(error);
            setStatusMessage(error.message || 'Failed to save request.', 'error');
        }
    }

    async function updateRequestStatus(requestId, action, storedAt) {
        if (state.apiEnabled) {
            await fetchJsonFromCandidates(buildUrlCandidates(`api/consumables/requests/${requestId}`), {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action,
                    storedAt
                })
            });
            await refreshData();
            return;
        }

        const requests = loadJson(STORAGE_KEYS.requests, []);
        const index = requests.findIndex(item => String(item.id) === String(requestId));
        if (index === -1) {
            throw new Error('Request not found.');
        }

        if (action === 'ordered') {
            requests[index] = {
                ...requests[index],
                status: 'ordered_by_lab_head',
                statusLabel: 'Ordered by lab head',
                orderedAt: new Date().toISOString()
            };
        } else {
            requests[index] = {
                ...requests[index],
                status: 'stored',
                statusLabel: 'Stored in lab',
                storedAt: storedAt || 'Not recorded',
                receivedAt: new Date().toISOString()
            };
        }

        saveJson(STORAGE_KEYS.requests, requests);
        state.requests = requests;
        state.summary = {
            catalogItems: state.items.length,
            savedRequests: requests.length,
            pendingRequests: requests.filter(item => item.status === 'pending_lab_head').length
        };
        renderAll();
    }

    async function handlePanelClick(event) {
        const suggestion = event.target.closest('[data-item-key]');
        if (suggestion) {
            const item = getCatalogItems().find(entry => entry.item_key === suggestion.getAttribute('data-item-key'));
            if (item) {
                fillFormFromItem(item);
            }
            return;
        }

        const orderButton = event.target.closest('[data-order-request]');
        if (orderButton) {
            try {
                await updateRequestStatus(orderButton.getAttribute('data-order-request'), 'ordered');
                setStatusMessage('Request marked as ordered.', 'success');
            } catch (error) {
                setStatusMessage(error.message || 'Failed to mark request as ordered.', 'error');
            }
            return;
        }

        const storeButton = event.target.closest('[data-store-request]');
        if (storeButton) {
            const storedAt = window.prompt('Enter the storage location for this consumable:', 'D-302');
            if (storedAt === null) return;
            try {
                await updateRequestStatus(storeButton.getAttribute('data-store-request'), 'stored', storedAt.trim() || 'Not recorded');
                setStatusMessage('Request marked as stored and synced to the catalog.', 'success');
            } catch (error) {
                setStatusMessage(error.message || 'Failed to mark request as stored.', 'error');
            }
        }
    }

    function buildOrderedCsvFromState() {
        const orderedItems = getRequests()
            .filter(item => item.status === 'ordered_by_lab_head' || item.status === 'stored')
            .slice()
            .sort((left, right) => (right.orderedAt || right.createdAt || '').localeCompare(left.orderedAt || left.createdAt || ''));

        const exportTimestamp = new Date().toISOString();
        const headers = [
            'export_generated_at_utc',
            'request_id',
            'item_name',
            'catalogue_number',
            'manufacturer',
            'requested_quantity',
            'requester_name',
            'requester_email',
            'status',
            'status_label',
            'created_at',
            'ordered_at',
            'received_at',
            'stored_at',
            'request_notes'
        ];

        const lines = [headers.map(csvCell).join(',')];
        orderedItems.forEach(item => {
            lines.push(
                [
                    exportTimestamp,
                    item.id,
                    item.itemName,
                    item.catalogueNumber,
                    item.manufacturer,
                    item.quantity,
                    item.requesterName,
                    item.requesterEmail,
                    item.status,
                    item.statusLabel,
                    formatDateTime(item.createdAt),
                    formatDateTime(item.orderedAt),
                    formatDateTime(item.receivedAt),
                    item.storedAt,
                    item.notes
                ].map(csvCell).join(',')
            );
        });

        return lines.join('\n');
    }

    async function handleOrderedCsvDownload() {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        const filename = `ordered-consumables-${timestamp}.csv`;

        if (state.apiEnabled) {
            const response = await fetch('/api/consumables/ordered.csv');
            if (!response.ok) {
                throw new Error('Failed to download ordered CSV.');
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            return;
        }

        const csv = buildOrderedCsvFromState();
        downloadTextFile(csv, filename);
    }

    function bindEvents() {
        if (state.isInitialized) return;
        state.isInitialized = true;

        document.addEventListener('input', function(event) {
            if (!event.target.closest('#consumablesRequestForm')) return;
            renderSuggestions();
        });

        document.addEventListener('submit', function(event) {
            if (event.target.id === 'consumablesRequestForm') {
                handleRequestSubmit(event);
            }
        });

        document.addEventListener('click', function(event) {
            const tabButton = event.target.closest('[data-consumables-tab]');
            if (tabButton) {
                state.activeConsumablesTab = tabButton.getAttribute('data-consumables-tab') || 'request';
                renderConsumablesTabs();
                return;
            }
            handlePanelClick(event);
        });

        const downloadOrderedCsvBtn = document.getElementById('downloadOrderedCsvBtn');
        if (downloadOrderedCsvBtn) {
            downloadOrderedCsvBtn.addEventListener('click', async function() {
                try {
                    await handleOrderedCsvDownload();
                    setStatusMessage('Ordered list CSV downloaded with timestamp details.', 'success');
                } catch (error) {
                    setStatusMessage(error.message || 'Unable to download ordered CSV.', 'error');
                }
            });
        }
    }

    async function renderApp() {
        const app = document.getElementById('consumablesApp');
        if (!app) return;

        try {
            await loadBootstrap();
            bindEvents();
            renderAll();
            if (state.apiEnabled) {
                setStatusMessage('Consumables are now served through the Flask backend and SQLite database.', 'success');
            }
        } catch (error) {
            console.error(error);
            setStatusMessage('Consumables data could not be loaded.', 'error');
        }
    }

    document.addEventListener('sectionsLoaded', function() {
        renderApp();
    });

    document.addEventListener('resourcesShown', function(event) {
        state.currentUser = event.detail && event.detail.user ? event.detail.user : null;
        const requester = document.getElementById('requesterIdentity');
        if (requester && state.currentUser) {
            requester.textContent = `${state.currentUser.name} (${state.currentUser.email})`;
        }
        renderApp();
    });
})();
