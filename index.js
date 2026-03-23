/**
 * st-live-css-editor - 实时CSS编辑器
 *
 * 功能：浮动窗口编辑 CSS，实时预览（500ms 防抖），保存后持久化并在下次加载自动注入。
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'st-live-css-editor';
const STYLE_ELEMENT_ID = 'st-live-css-editor-style';
const WINDOW_ELEMENT_ID = 'st-live-css-editor-window';

const defaultSettings = {
    enabled: true,
    // legacy 单方案字段：保留用于兼容旧数据/旧导入结构
    cssText: '',
    // 多方案：每个方案保存一份 CSS，并支持命名/切换
    schemes: [],
    activeSchemeId: '',
    debounceMs: 500,
    ui: {
        x: 40,
        y: 80,
        w: 520,
        h: 420,
        collapsed: false,
    },
};

let isInitialized = false;

// 运行态（不持久化草稿）
let draftCssText = '';
let debounceTimer = null;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function generateSchemeId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch { /* ignore */ }

    // fallback：尽量低碰撞
    return `stlce_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeScheme(candidate, index = 0) {
    if (!candidate || typeof candidate !== 'object') return null;

    const id = (typeof candidate.id === 'string' && candidate.id.trim()) ? candidate.id.trim() : generateSchemeId();
    const name = (typeof candidate.name === 'string' && candidate.name.trim())
        ? candidate.name.trim()
        : (index === 0 ? '默认方案' : `方案${index + 1}`);
    const cssText = (typeof candidate.cssText === 'string') ? candidate.cssText : String(candidate.cssText ?? '');

    return { id, name, cssText };
}

function ensureSchemes(settings) {
    const st = settings;

    // 兼容旧版本：仅有 cssText 的单方案数据
    const legacyCssText = (typeof st.cssText === 'string') ? st.cssText : '';

    if (!Array.isArray(st.schemes) || st.schemes.length === 0) {
        const id = generateSchemeId();
        st.schemes = [{ id, name: '默认方案', cssText: legacyCssText }];
        st.activeSchemeId = id;
    }

    st.schemes = st.schemes
        .map((s, i) => normalizeScheme(s, i))
        .filter(Boolean);

    if (st.schemes.length === 0) {
        const id = generateSchemeId();
        st.schemes = [{ id, name: '默认方案', cssText: '' }];
        st.activeSchemeId = id;
    }

    if (typeof st.activeSchemeId !== 'string' || !st.schemes.some(s => s.id === st.activeSchemeId)) {
        st.activeSchemeId = st.schemes[0].id;
    }

    // 保持 legacy 字段与当前方案同步，减少其它逻辑改动
    const active = st.schemes.find(s => s.id === st.activeSchemeId) || st.schemes[0];
    st.cssText = active?.cssText || '';

    return st;
}

function getActiveScheme(settings) {
    const st = ensureSchemes(settings);
    return st.schemes.find(s => s.id === st.activeSchemeId) || st.schemes[0];
}

function populateSchemeSelect(selectEl, settings) {
    if (!selectEl) return;
    const st = ensureSchemes(settings);

    const prevValue = selectEl.value;
    selectEl.innerHTML = '';

    for (const scheme of st.schemes) {
        const opt = document.createElement('option');
        opt.value = scheme.id;
        opt.textContent = scheme.name;
        selectEl.appendChild(opt);
    }

    // 尽量保持之前选择；否则选中 active
    if (prevValue && st.schemes.some(s => s.id === prevValue)) {
        selectEl.value = prevValue;
    } else {
        selectEl.value = st.activeSchemeId;
    }
}

function syncOpenWindowToActiveScheme() {
    const win = document.getElementById(WINDOW_ELEMENT_ID);
    if (!win) return;

    const st = ensureSettings();
    const active = getActiveScheme(st);

    const editor = win.querySelector('.stlce-editor');
    draftCssText = active?.cssText || '';
    if (editor) editor.value = draftCssText;

    const schemeSelect = win.querySelector('.stlce-scheme-select');
    if (schemeSelect) {
        populateSchemeSelect(schemeSelect, st);
        schemeSelect.value = active?.id || st.activeSchemeId;
    }

    const schemeName = win.querySelector('.stlce-scheme-name');
    if (schemeName) schemeName.value = active?.name || '';

    refreshCodeDecorations(win);
}

function downloadTextAsFile(filename, text, mimeType = 'text/plain') {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // 延迟 revoke，避免某些浏览器还未开始下载就释放
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildExportPayload() {
    const st = ensureSettings();

    // 如果窗口打开，优先导出当前编辑草稿（更符合用户预期）；否则导出已保存版本
    const hasWindow = !!document.getElementById(WINDOW_ELEMENT_ID);
    const currentCssText = hasWindow
        ? (draftCssText || '')
        : (typeof st.cssText === 'string' ? st.cssText : '');

    const exportedSchemes = (Array.isArray(st.schemes) ? st.schemes : [])
        .map((s, i) => {
            const ns = normalizeScheme(s, i);
            if (!ns) return null;
            const cssText = (ns.id === st.activeSchemeId) ? currentCssText : ns.cssText;
            return { id: ns.id, name: ns.name, cssText };
        })
        .filter(Boolean);

    return {
        schema: 1,
        module: MODULE_NAME,
        exportedAt: new Date().toISOString(),
        settings: {
            enabled: !!st.enabled,
            // legacy：保持兼容（导出“当前方案”的 cssText）
            cssText: currentCssText,
            // 多方案
            schemes: exportedSchemes,
            activeSchemeId: String(st.activeSchemeId || ''),
            debounceMs: Number.isFinite(Number(st.debounceMs)) ? Number(st.debounceMs) : defaultSettings.debounceMs,
            ui: {
                x: Number(st.ui?.x ?? defaultSettings.ui.x),
                y: Number(st.ui?.y ?? defaultSettings.ui.y),
                w: Number(st.ui?.w ?? defaultSettings.ui.w),
                h: Number(st.ui?.h ?? defaultSettings.ui.h),
                collapsed: !!(st.ui?.collapsed ?? defaultSettings.ui.collapsed),
            },
        },
    };
}

function exportSettingsToJson() {
    const payload = buildExportPayload();
    const jsonText = JSON.stringify(payload, null, 2);
    downloadTextAsFile('st-live-css-editor.json', jsonText, 'application/json');
    setStatus('已导出 JSON');
}

function normalizeImportedSettings(candidate) {
    // 允许两种格式：
    // 1) { schema, module, settings: {...} }
    // 2) 直接就是 settings 对象 { enabled, cssText, ... }
    const s = (candidate && typeof candidate === 'object' && candidate.settings && typeof candidate.settings === 'object')
        ? candidate.settings
        : candidate;

    if (!s || typeof s !== 'object') return null;

    const out = {};

    if ('enabled' in s) out.enabled = !!s.enabled;
    if ('cssText' in s) out.cssText = typeof s.cssText === 'string' ? s.cssText : String(s.cssText ?? '');

    // 多方案导入
    if (Array.isArray(s.schemes)) {
        const schemes = s.schemes
            .map((it, i) => normalizeScheme(it, i))
            .filter(Boolean);
        if (schemes.length > 0) out.schemes = schemes;
    }

    if ('activeSchemeId' in s && typeof s.activeSchemeId === 'string') {
        out.activeSchemeId = s.activeSchemeId;
    }

    if ('debounceMs' in s) {
        const n = Number(s.debounceMs);
        if (Number.isFinite(n) && n >= 0) out.debounceMs = n;
    }

    if (s.ui && typeof s.ui === 'object') {
        out.ui = {
            x: Number.isFinite(Number(s.ui.x)) ? Math.round(Number(s.ui.x)) : undefined,
            y: Number.isFinite(Number(s.ui.y)) ? Math.round(Number(s.ui.y)) : undefined,
            w: Number.isFinite(Number(s.ui.w)) ? Math.round(Number(s.ui.w)) : undefined,
            h: Number.isFinite(Number(s.ui.h)) ? Math.round(Number(s.ui.h)) : undefined,
            collapsed: ('collapsed' in s.ui) ? !!s.ui.collapsed : undefined,
        };
    }

    return out;
}

function applyImportedSettings(imported) {
    const st = ensureSettings();

    if (typeof imported.enabled === 'boolean') st.enabled = imported.enabled;

    if (Array.isArray(imported.schemes) && imported.schemes.length > 0) {
        st.schemes = imported.schemes.map((s, i) => normalizeScheme(s, i)).filter(Boolean);
        if (typeof imported.activeSchemeId === 'string') st.activeSchemeId = imported.activeSchemeId;
        ensureSchemes(st);
    } else if (typeof imported.cssText === 'string') {
        // 兼容旧导入：把 cssText 写入“当前方案”
        ensureSchemes(st);
        const active = getActiveScheme(st);
        if (active) {
            active.cssText = imported.cssText;
            st.cssText = imported.cssText;
        }
    }

    if (typeof imported.debounceMs === 'number') st.debounceMs = imported.debounceMs;

    if (imported.ui) {
        st.ui = st.ui || structuredClone(defaultSettings.ui);
        for (const k of ['x', 'y', 'w', 'h', 'collapsed']) {
            if (imported.ui[k] !== undefined) st.ui[k] = imported.ui[k];
        }
    }

    clampWindowIntoViewport(st.ui);

    // 导入属于“持久化操作”，直接覆盖已保存版本
    saveSettingsDebounced();

    // 同步运行态草稿与当前窗口 UI（若窗口已打开）
    draftCssText = st.cssText || '';

    const win = document.getElementById(WINDOW_ELEMENT_ID);
    if (win) {
        const editor = win.querySelector('.stlce-editor');
        if (editor) editor.value = draftCssText;

        const enabledCheckbox = win.querySelector('.stlce-enabled');
        if (enabledCheckbox) enabledCheckbox.checked = !!st.enabled;

        // 方案控件
        const schemeSelect = win.querySelector('.stlce-scheme-select');
        const schemeName = win.querySelector('.stlce-scheme-name');
        if (schemeSelect) {
            populateSchemeSelect(schemeSelect, st);
            schemeSelect.value = String(st.activeSchemeId || '');
        }
        if (schemeName) {
            schemeName.value = String(getActiveScheme(st)?.name || '');
        }

        // 同步窗口位置/尺寸
        win.style.left = `${st.ui.x}px`;
        win.style.top = `${st.ui.y}px`;
        win.style.width = `${st.ui.w}px`;
        win.style.height = `${st.ui.h}px`;

        applyCollapsedState(win, !!st.ui?.collapsed);
        refreshCodeDecorations(win);
    }

    if (st.enabled) {
        applyCss(draftCssText);
    } else {
        applyCss('');
    }

    setStatus('已导入并应用');
}

async function importSettingsFromJsonFile(file) {
    if (!file) return;

    if (!/\.json$/i.test(file.name) && file.type && file.type !== 'application/json') {
        // 仅提示，不阻止（有些浏览器 type 为空）
        setStatus('提示：请选择 .json 文件');
    }

    let text;
    if (typeof file.text === 'function') {
        text = await file.text();
    } else {
        text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.readAsText(file);
        });
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        console.warn(`[${MODULE_NAME}] JSON parse failed`, err);
        setStatus('导入失败：JSON 解析错误');
        return;
    }

    const normalized = normalizeImportedSettings(parsed);
    if (!normalized) {
        setStatus('导入失败：JSON 结构不正确');
        return;
    }

    applyImportedSettings(normalized);
}

function ensureSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const st = extension_settings[MODULE_NAME];

    // 首次安装/空对象：填充默认
    if (Object.keys(st).length === 0) {
        Object.assign(st, structuredClone(defaultSettings));
    }

    // 兼容升级：补齐缺省字段
    if (typeof st.enabled !== 'boolean') st.enabled = defaultSettings.enabled;
    if (typeof st.cssText !== 'string') st.cssText = defaultSettings.cssText;

    // 多方案字段（允许旧版本没有这些字段）
    if (!('schemes' in st)) st.schemes = structuredClone(defaultSettings.schemes);
    if (!('activeSchemeId' in st)) st.activeSchemeId = defaultSettings.activeSchemeId;

    if (typeof st.debounceMs !== 'number') st.debounceMs = defaultSettings.debounceMs;
    if (!st.ui) st.ui = structuredClone(defaultSettings.ui);

    for (const k of Object.keys(defaultSettings.ui)) {
        if (st.ui[k] === undefined || st.ui[k] === null) {
            st.ui[k] = defaultSettings.ui[k];
        }
    }

    // 方案数据修复/迁移，并同步 legacy cssText
    ensureSchemes(st);

    return st;
}

function ensureStyleElement() {
    let styleEl = document.getElementById(STYLE_ELEMENT_ID);
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ELEMENT_ID;
        styleEl.type = 'text/css';
        document.head.appendChild(styleEl);
    }
    return styleEl;
}

function applyCss(cssText) {
    const settings = ensureSettings();
    const styleEl = ensureStyleElement();

    if (!settings.enabled) {
        styleEl.textContent = '';
        return;
    }

    styleEl.textContent = cssText || '';
}

function setStatus(text) {
    const el = document.querySelector(`#${WINDOW_ELEMENT_ID} .stlce-status`);
    if (el) el.textContent = text;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildLineNumbersText(text) {
    const src = String(text ?? '');
    const lineCount = (src.match(/\n/g) || []).length + 1;

    let out = '';
    for (let i = 1; i <= lineCount; i++) {
        out += i + (i === lineCount ? '' : '\n');
    }

    return out;
}

function syncScrollFromEditor(win) {
    const editor = win?.querySelector?.('.stlce-editor');
    if (!editor) return;

    const linenos = win.querySelector('.stlce-linenos');
    if (linenos) {
        linenos.scrollTop = editor.scrollTop;
    }
}

function refreshCodeDecorations(win) {
    const editor = win?.querySelector?.('.stlce-editor');
    if (!editor) return;

    const linenos = win.querySelector('.stlce-linenos');
    if (linenos) {
        linenos.textContent = buildLineNumbersText(editor.value);
    }

    syncScrollFromEditor(win);
}

function applyCollapsedState(win, collapsed) {
    if (!win) return;

    win.classList.toggle('collapsed', !!collapsed);

    const icon = win.querySelector('.stlce-btn-minimize i');
    if (icon) {
        icon.classList.toggle('fa-window-minimize', !collapsed);
        icon.classList.toggle('fa-window-maximize', !!collapsed);
    }

    if (collapsed) {
        win.style.height = 'auto';
        win.style.resize = 'none';
    } else {
        const s = ensureSettings();
        win.style.height = `${s.ui.h}px`;
        win.style.resize = 'both';
    }
}

function clampWindowIntoViewport(ui) {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    ui.w = Math.max(320, Math.min(ui.w, vw - margin * 2));
    ui.h = Math.max(220, Math.min(ui.h, vh - margin * 2));

    ui.x = Math.max(margin, Math.min(ui.x, vw - ui.w - margin));
    ui.y = Math.max(margin, Math.min(ui.y, vh - ui.h - margin));
}

function persistUi() {
    const settings = ensureSettings();
    saveSettingsDebounced();
    setStatus('窗口位置已保存');
}

function openWindow() {
    const settings = ensureSettings();

    let win = document.getElementById(WINDOW_ELEMENT_ID);
    if (win) {
        win.classList.add('open');
        bringToFront(win);
        return;
    }

    // 初始化草稿为已保存内容（不持久化）
    draftCssText = settings.cssText || '';

    win = document.createElement('div');
    win.id = WINDOW_ELEMENT_ID;
    win.className = 'stlce-window open';
    win.innerHTML = `
        <div class="stlce-header" data-drag-handle="true">
            <div class="stlce-title">
                <i class="fa-solid fa-paintbrush"></i>
                <span>实时CSS编辑器</span>
            </div>
            <div class="stlce-window-controls">
                <button class="stlce-btn stlce-btn-icon stlce-btn-minimize" title="缩小/展开">
                    <i class="fa-solid fa-window-minimize"></i>
                </button>
                <button class="stlce-btn stlce-btn-icon stlce-btn-close" title="关闭窗口">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div class="stlce-toolbar">
            <div class="stlce-actions">
                <div class="stlce-scheme" title="方案：切换/命名（名称在保存时写入）">
                    <i class="fa-solid fa-layer-group"></i>
                    <select class="stlce-scheme-select" aria-label="方案选择"></select>
                    <input class="stlce-scheme-name" type="text" spellcheck="false" placeholder="方案名" aria-label="方案名称" />
                    <button class="stlce-btn stlce-btn-icon stlce-scheme-new" title="新建方案（复制当前草稿并切换）">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button class="stlce-btn stlce-btn-icon stlce-scheme-delete" title="删除当前方案">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>

                <label class="stlce-toggle" title="启用/禁用注入">
                    <input type="checkbox" class="stlce-enabled" ${settings.enabled ? 'checked' : ''} />
                    <span>启用</span>
                </label>
                <button class="stlce-btn stlce-btn-save" title="保存并持久化（会同时保存方案名称）">
                    <i class="fa-solid fa-floppy-disk"></i>
                    保存
                </button>
                <button class="stlce-btn stlce-btn-export" title="导出为 JSON">
                    <i class="fa-solid fa-file-export"></i>
                    导出
                </button>
                <button class="stlce-btn stlce-btn-import" title="从 JSON 导入（会覆盖当前已保存版本）">
                    <i class="fa-solid fa-file-import"></i>
                    导入
                </button>
                <input type="file" class="stlce-file-input" accept=".json,application/json" style="display:none" />
                <button class="stlce-btn stlce-btn-revert" title="回滚到当前方案上次保存">
                    <i class="fa-solid fa-rotate-left"></i>
                    回滚
                </button>
                <button class="stlce-btn stlce-btn-clear" title="清空编辑区">
                    <i class="fa-solid fa-eraser"></i>
                    清空
                </button>
            </div>
        </div>
        <div class="stlce-body">
            <div class="stlce-editor-frame">
                <pre class="stlce-linenos" aria-hidden="true"></pre>
                <textarea class="stlce-editor" spellcheck="false" wrap="off" placeholder="/* 在这里输入 CSS，将在 500ms 防抖后实时注入 */"></textarea>
            </div>
        </div>
        <div class="stlce-footer">
            <div class="stlce-status">就绪</div>
            <div class="stlce-hint">提示：未点击“保存”的内容刷新后不会保留</div>
        </div>
    `;

    // 尺寸/位置
    clampWindowIntoViewport(settings.ui);
    win.style.left = `${settings.ui.x}px`;
    win.style.top = `${settings.ui.y}px`;
    win.style.width = `${settings.ui.w}px`;
    win.style.height = `${settings.ui.h}px`;

    document.body.appendChild(win);
    bringToFront(win);

    // 填充文本
    const editor = win.querySelector('.stlce-editor');
    editor.value = draftCssText;
    refreshCodeDecorations(win);

    applyCollapsedState(win, !!settings.ui?.collapsed);

    // 立即应用一次（保证打开时可见）
    applyCss(settings.cssText);

    bindWindowEvents(win);

    // ResizeObserver 记录尺寸
    const ro = new ResizeObserver(() => {
        if (!win.isConnected) {
            ro.disconnect();
            return;
        }
        const s = ensureSettings();
        if (s.ui?.collapsed) return;
        s.ui.w = Math.round(win.getBoundingClientRect().width);
        s.ui.h = Math.round(win.getBoundingClientRect().height);
        saveSettingsDebounced();
    });
    ro.observe(win);
}

function closeWindow() {
    const win = document.getElementById(WINDOW_ELEMENT_ID);
    if (win) win.remove();
}

function bringToFront(win) {
    // 简单策略：找到当前最高 z-index（在可控范围内），然后+1
    const base = 10000;
    let maxZ = base;
    document.querySelectorAll('.stlce-window').forEach(el => {
        const z = parseInt(window.getComputedStyle(el).zIndex || '0', 10);
        if (z > maxZ) maxZ = z;
    });
    win.style.zIndex = String(maxZ + 1);
}

function schedulePreviewApply() {
    const settings = ensureSettings();

    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }

    debounceTimer = setTimeout(() => {
        applyCss(draftCssText);
        setStatus('预览已应用（未保存）');
    }, settings.debounceMs);
}

function bindWindowEvents(win) {
    // 聚焦置顶
    win.addEventListener('pointerdown', () => bringToFront(win));

    const settings = ensureSettings();

    // 方案控件：切换/命名/新建/删除
    const schemeSelect = win.querySelector('.stlce-scheme-select');
    const schemeNameInput = win.querySelector('.stlce-scheme-name');
    const schemeNewBtn = win.querySelector('.stlce-scheme-new');
    const schemeDeleteBtn = win.querySelector('.stlce-scheme-delete');

    if (schemeSelect) {
        populateSchemeSelect(schemeSelect, settings);
        schemeSelect.value = String(settings.activeSchemeId || '');
    }

    if (schemeNameInput) {
        schemeNameInput.value = String(getActiveScheme(settings)?.name || '');
        schemeNameInput.addEventListener('input', () => {
            setStatus('方案名称已修改（保存后生效）');
        });
    }

    if (schemeSelect) {
        schemeSelect.addEventListener('change', () => {
            const nextId = String(schemeSelect.value || '');
            if (!nextId || nextId === settings.activeSchemeId) return;

            const active = getActiveScheme(settings);
            const lastSavedCss = active?.cssText || '';
            const hasUnsaved = String(draftCssText || '') !== String(lastSavedCss || '');

            if (hasUnsaved) {
                const ok = confirm('切换方案会丢失当前未保存的草稿，是否继续？');
                if (!ok) {
                    schemeSelect.value = settings.activeSchemeId;
                    return;
                }
            }

            settings.activeSchemeId = nextId;
            ensureSchemes(settings);

            // 切换后：用“已保存版本”初始化草稿
            draftCssText = settings.cssText || '';
            const editor = win.querySelector('.stlce-editor');
            if (editor) editor.value = draftCssText;

            if (schemeNameInput) schemeNameInput.value = String(getActiveScheme(settings)?.name || '');

            refreshCodeDecorations(win);
            if (settings.enabled) applyCss(draftCssText);

            saveSettingsDebounced();
            setStatus(`已切换方案：${getActiveScheme(settings)?.name || ''}`);
        });
    }

    if (schemeNewBtn) {
        schemeNewBtn.addEventListener('click', () => {
            const defaultName = `方案${(settings.schemes?.length || 0) + 1}`;
            const name = prompt('新建方案名称：', defaultName);
            if (name === null) return;
            const trimmed = String(name).trim();
            if (!trimmed) {
                setStatus('新建失败：方案名不能为空');
                return;
            }

            ensureSchemes(settings);
            const id = generateSchemeId();
            settings.schemes.push({ id, name: trimmed, cssText: String(draftCssText || '') });
            settings.activeSchemeId = id;
            ensureSchemes(settings);

            if (schemeSelect) {
                populateSchemeSelect(schemeSelect, settings);
                schemeSelect.value = id;
            }
            if (schemeNameInput) schemeNameInput.value = trimmed;

            saveSettingsDebounced();
            setStatus(`已新建并切换方案：${trimmed}`);
        });
    }

    if (schemeDeleteBtn) {
        schemeDeleteBtn.addEventListener('click', () => {
            ensureSchemes(settings);
            if ((settings.schemes?.length || 0) <= 1) {
                setStatus('无法删除：至少需要保留一个方案');
                return;
            }

            const active = getActiveScheme(settings);
            const ok = confirm(`确定删除方案“${active?.name || ''}”吗？此操作不可撤销。`);
            if (!ok) return;

            const activeId = settings.activeSchemeId;
            settings.schemes = settings.schemes.filter(s => s.id !== activeId);

            // 选中一个新的 active
            const next = settings.schemes[0];
            settings.activeSchemeId = next?.id || '';
            ensureSchemes(settings);

            draftCssText = settings.cssText || '';
            const editor = win.querySelector('.stlce-editor');
            if (editor) editor.value = draftCssText;

            if (schemeSelect) {
                populateSchemeSelect(schemeSelect, settings);
                schemeSelect.value = settings.activeSchemeId;
            }
            if (schemeNameInput) schemeNameInput.value = String(getActiveScheme(settings)?.name || '');

            refreshCodeDecorations(win);
            if (settings.enabled) applyCss(draftCssText);

            saveSettingsDebounced();
            setStatus('已删除方案并切换');
        });
    }

    const enabledCheckbox = win.querySelector('.stlce-enabled');
    enabledCheckbox.addEventListener('change', () => {
        settings.enabled = !!enabledCheckbox.checked;
        // 启用时应用“当前草稿”（更符合用户预期的预览状态）
        if (settings.enabled) {
            applyCss(draftCssText);
            setStatus('已启用（应用当前预览）');
        } else {
            applyCss('');
            setStatus('已禁用（样式已移除）');
        }
        saveSettingsDebounced();
    });

    const editor = win.querySelector('.stlce-editor');
    editor.addEventListener('input', () => {
        draftCssText = editor.value;
        schedulePreviewApply();
        refreshCodeDecorations(win);
    });

    editor.addEventListener('scroll', () => {
        syncScrollFromEditor(win);
    });

    win.querySelector('.stlce-btn-save').addEventListener('click', () => {
        ensureSchemes(settings);
        const active = getActiveScheme(settings);

        if (active) {
            active.cssText = String(draftCssText || '');

            // 保存时允许重命名
            const newName = schemeNameInput ? String(schemeNameInput.value || '').trim() : '';
            if (newName) active.name = newName;

            // legacy 同步
            settings.cssText = active.cssText;
        } else {
            settings.cssText = String(draftCssText || '');
        }

        saveSettingsDebounced();
        if (settings.enabled) applyCss(settings.cssText);

        if (schemeSelect) {
            populateSchemeSelect(schemeSelect, settings);
            schemeSelect.value = settings.activeSchemeId;
        }
        if (schemeNameInput) schemeNameInput.value = String(getActiveScheme(settings)?.name || '');

        setStatus('已保存并应用');
    });

    const exportBtn = win.querySelector('.stlce-btn-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            try {
                exportSettingsToJson();
            } catch (err) {
                console.warn(`[${MODULE_NAME}] export failed`, err);
                setStatus('导出失败');
            }
        });
    }

    const importBtn = win.querySelector('.stlce-btn-import');
    const fileInput = win.querySelector('.stlce-file-input');
    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => {
            // 部分浏览器对 display:none 的 input 也允许 click；并且此处属于用户手势回调
            fileInput.click();
        });

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files && fileInput.files[0];
            // 允许重复选择同一文件：先清空 value
            fileInput.value = '';

            try {
                await importSettingsFromJsonFile(file);
            } catch (err) {
                console.warn(`[${MODULE_NAME}] import failed`, err);
                setStatus('导入失败');
            }
        });
    }

    win.querySelector('.stlce-btn-revert').addEventListener('click', () => {
        ensureSchemes(settings);
        const active = getActiveScheme(settings);
        draftCssText = active?.cssText || '';
        editor.value = draftCssText;
        refreshCodeDecorations(win);
        if (settings.enabled) applyCss(draftCssText);
        setStatus('已回滚到当前方案已保存版本');
    });

    win.querySelector('.stlce-btn-clear').addEventListener('click', () => {
        draftCssText = '';
        editor.value = '';
        refreshCodeDecorations(win);
        applyCss('');
        setStatus('已清空（未保存）');
    });

    const minimizeBtn = win.querySelector('.stlce-btn-minimize');
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            const s = ensureSettings();
            s.ui.collapsed = !s.ui.collapsed;
            applyCollapsedState(win, s.ui.collapsed);
            saveSettingsDebounced();
            setStatus(s.ui.collapsed ? '已缩小' : '已展开');
        });
    }

    win.querySelector('.stlce-btn-close').addEventListener('click', () => {
        closeWindow();
    });

    // 拖拽：header 为拖拽区
    const header = win.querySelector('.stlce-header');
    header.addEventListener('pointerdown', (e) => {
        const target = e.target;
        // 如果点在按钮/输入框上，不触发拖拽
        if (target.closest('button') || target.closest('input') || target.closest('label')) return;

        isDragging = true;
        header.setPointerCapture(e.pointerId);

        const rect = win.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;

        win.classList.add('dragging');
    });

    header.addEventListener('pointermove', (e) => {
        if (!isDragging) return;

        const s = ensureSettings();
        s.ui.x = Math.round(e.clientX - dragOffsetX);
        s.ui.y = Math.round(e.clientY - dragOffsetY);
        clampWindowIntoViewport(s.ui);

        win.style.left = `${s.ui.x}px`;
        win.style.top = `${s.ui.y}px`;
    });

    header.addEventListener('pointerup', (e) => {
        if (!isDragging) return;
        isDragging = false;
        win.classList.remove('dragging');

        const s = ensureSettings();
        // left/top 已更新，这里只保存
        saveSettingsDebounced();
        setStatus('窗口位置已保存');

        try {
            header.releasePointerCapture(e.pointerId);
        } catch { /* ignore */ }
    });

    // 浏览器尺寸变化时 clamp
    window.addEventListener('resize', () => {
        const s = ensureSettings();
        clampWindowIntoViewport(s.ui);
        win.style.left = `${s.ui.x}px`;
        win.style.top = `${s.ui.y}px`;
        win.style.width = `${s.ui.w}px`;
        if (!s.ui?.collapsed) {
            win.style.height = `${s.ui.h}px`;
        }
    });
}

function addMenuEntry() {
    const extensionsMenu = document.querySelector('#extensionsMenu');
    if (!extensionsMenu) {
        console.warn(`[${MODULE_NAME}] Extensions menu not found`);
        return;
    }

    if (!document.querySelector('#stlce-menu-entry')) {
        const menuItem = document.createElement('div');
        menuItem.id = 'stlce-menu-entry';
        menuItem.className = 'list-group-item flex-container flexGap5';
        menuItem.title = '实时CSS编辑器 - 浮动窗口编辑 CSS，并实时注入预览';
        menuItem.innerHTML = `
            <i class="fa-solid fa-paintbrush extensionsMenuExtensionButton"></i>
            <span>实时CSS编辑器</span>
        `;

        menuItem.addEventListener('click', () => openWindow());
        extensionsMenu.appendChild(menuItem);
    }

    // 方案切换入口：从菜单直接切换方案（无需打开窗口）
    if (!document.querySelector('#stlce-menu-entry-scheme')) {
        const menuItem = document.createElement('div');
        menuItem.id = 'stlce-menu-entry-scheme';
        menuItem.className = 'list-group-item flex-container flexGap5';
        menuItem.title = '实时CSS编辑器 - 切换 CSS 方案';
        menuItem.innerHTML = `
            <i class="fa-solid fa-layer-group extensionsMenuExtensionButton"></i>
            <span>CSS方案：切换</span>
        `;

        menuItem.addEventListener('click', () => {
            const st = ensureSettings();
            ensureSchemes(st);

            const schemes = Array.isArray(st.schemes) ? st.schemes : [];
            if (schemes.length <= 1) {
                console.log(`[${MODULE_NAME}] only one scheme`);
                setStatus('仅有一个方案');
                return;
            }

            const currentIndex = Math.max(0, schemes.findIndex(s => s.id === st.activeSchemeId));
            const listText = schemes.map((s, i) => `${i + 1}) ${s.name}`).join('\n');
            const input = prompt(`选择要切换的方案序号（1-${schemes.length}），或直接输入方案名：\n${listText}`, String(currentIndex + 1));
            if (input === null) return;

            const trimmed = String(input).trim();
            let next = null;

            const n = Number(trimmed);
            if (Number.isFinite(n)) {
                const idx = Math.floor(n) - 1;
                if (idx >= 0 && idx < schemes.length) next = schemes[idx];
            }

            if (!next) {
                next = schemes.find(s => String(s.name).trim() === trimmed) || null;
            }

            if (!next) {
                setStatus('切换失败：未找到对应方案');
                return;
            }

            st.activeSchemeId = next.id;
            ensureSchemes(st);

            saveSettingsDebounced();
            // applyCss 内部会检查 enabled
            applyCss(st.cssText);

            // 若窗口已打开，同步 UI/编辑器
            syncOpenWindowToActiveScheme();

            console.log(`[${MODULE_NAME}] scheme switched to: ${next.name}`);
            setStatus(`已切换方案：${next.name}`);
        });

        extensionsMenu.appendChild(menuItem);
    }
}

async function init() {
    if (isInitialized) return;

    console.log(`[${MODULE_NAME}] Initializing...`);

    const settings = ensureSettings();

    // 首次加载时应用已保存 CSS
    applyCss(settings.cssText);

    addMenuEntry();

    eventSource.on(event_types.SETTINGS_LOADED, () => {
        const st = ensureSettings();
        applyCss(st.cssText);
    });

    isInitialized = true;
    console.log(`[${MODULE_NAME}] Initialized`);
}

jQuery(async () => {
    await init();
});
