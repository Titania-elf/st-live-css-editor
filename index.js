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
    cssText: '',
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

    return {
        schema: 1,
        module: MODULE_NAME,
        exportedAt: new Date().toISOString(),
        settings: {
            enabled: !!st.enabled,
            cssText: currentCssText,
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
    if (typeof imported.cssText === 'string') st.cssText = imported.cssText;
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
    if (typeof st.debounceMs !== 'number') st.debounceMs = defaultSettings.debounceMs;
    if (!st.ui) st.ui = structuredClone(defaultSettings.ui);

    for (const k of Object.keys(defaultSettings.ui)) {
        if (st.ui[k] === undefined || st.ui[k] === null) {
            st.ui[k] = defaultSettings.ui[k];
        }
    }

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
                <label class="stlce-toggle" title="启用/禁用注入">
                    <input type="checkbox" class="stlce-enabled" ${settings.enabled ? 'checked' : ''} />
                    <span>启用</span>
                </label>
                <button class="stlce-btn stlce-btn-save" title="保存并持久化">
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
                <button class="stlce-btn stlce-btn-revert" title="回滚到上次保存">
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
        settings.cssText = draftCssText;
        saveSettingsDebounced();
        applyCss(settings.cssText);
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
        draftCssText = settings.cssText || '';
        editor.value = draftCssText;
        refreshCodeDecorations(win);
        applyCss(draftCssText);
        setStatus('已回滚到已保存版本');
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

    if (document.querySelector('#stlce-menu-entry')) return;

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
