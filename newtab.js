// ============================================================
// НАСТРОЙКИ ПО УМОЛЧАНИЮ (легко редактировать вручную)
// ============================================================
const FACTORY_SETTINGS = {
  history_days: 90,
  label_count: 14,
  icon_width: 7,
  columns_num: 7
};
let DEFAULT_SETTINGS = { ...FACTORY_SETTINGS };

// ============================================================
// ГРАНИЦЫ ДЛЯ ПОЛЗУНКОВ (мин/макс)
// ============================================================
const LIMITS = {
  days: { min: 1, max: 365 },
  label_count: { min: 0, max: 100 },
  icon_width: { min: 5, max: 16 },
  columns_num: { min: 2, max: 24 }
};
// ============================================================

// Кэш качественных иконок в памяти
const highQualityCache = new Map();
const SETTINGS_KEY = 'settings';
const SEARCH_ENGINE_KEY = 'search_engine';
const SYNCED_CONFIG_KEYS = [
  SETTINGS_KEY,
  SEARCH_ENGINE_KEY,
  'saved_domains',
  'manualLayout',
  'autoLayout',
  'savedProfileSnapshot'
];

function toKeyArray(keys) {
  return Array.isArray(keys) ? keys : [keys];
}

function hasOwn(data, key) {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function getSyncedConfig(keys, cb) {
  const keyList = toKeyArray(keys);
  chrome.storage.sync.get(keyList, (syncData) => {
    const missingKeys = keyList.filter((key) => !hasOwn(syncData, key));
    if (!missingKeys.length) {
      cb(syncData);
      return;
    }

    chrome.storage.local.get(missingKeys, (localData) => {
      const merged = { ...syncData };
      const migrated = {};
      const removable = [];

      missingKeys.forEach((key) => {
        if (!hasOwn(localData, key)) return;
        merged[key] = localData[key];
        migrated[key] = localData[key];
        removable.push(key);
      });

      if (!removable.length) {
        cb(merged);
        return;
      }

      chrome.storage.sync.set(migrated, () => {
        chrome.storage.local.remove(removable, () => cb(merged));
      });
    });
  });
}

function setSyncedConfig(values, cb) {
  chrome.storage.sync.set(values, () => {
    const keys = Object.keys(values);
    if (!keys.length) {
      if (typeof cb === 'function') cb();
      return;
    }
    chrome.storage.local.remove(keys, () => {
      if (typeof cb === 'function') cb();
    });
  });
}

function removeSyncedConfig(keys, cb) {
  const keyList = toKeyArray(keys);
  chrome.storage.sync.remove(keyList, () => {
    chrome.storage.local.remove(keyList, () => {
      if (typeof cb === 'function') cb();
    });
  });
}

function getStoredSettings(cb) {
  getSyncedConfig(SETTINGS_KEY, ({ settings }) => cb(settings ?? null));
}

function setStoredSettings(nextSettings, cb) {
  setSyncedConfig({ [SETTINGS_KEY]: nextSettings }, () => {
    settingsCache = nextSettings || {};
    if (typeof cb === 'function') cb();
  });
}

function getStoredSearchEngine(cb) {
  getSyncedConfig(SEARCH_ENGINE_KEY, ({ search_engine }) => cb(search_engine ?? null));
}

function setStoredSearchEngine(engine, cb) {
  setSyncedConfig({ [SEARCH_ENGINE_KEY]: engine }, cb);
}

function getStoredSavedDomains(cb) {
  getSyncedConfig('saved_domains', ({ saved_domains }) => cb(saved_domains ?? null));
}

function setStoredSavedDomains(savedDomains, cb) {
  setSyncedConfig({ saved_domains: savedDomains }, cb);
}

function getStoredLayoutState(cb) {
  getSyncedConfig(['manualLayout', 'autoLayout'], ({ manualLayout, autoLayout }) => {
    cb({
      manualLayout: !!manualLayout,
      autoLayout: !!autoLayout
    });
  });
}

function setStoredLayoutState(layoutState, cb) {
  setSyncedConfig(layoutState, cb);
}

function getStoredProfileSnapshot(cb) {
  getSyncedConfig('savedProfileSnapshot', ({ savedProfileSnapshot }) => cb(savedProfileSnapshot ?? null));
}

function setStoredProfileSnapshot(snapshot, cb) {
  setSyncedConfig({ savedProfileSnapshot: snapshot }, cb);
}

function removeStoredProfileSnapshot(cb) {
  removeSyncedConfig('savedProfileSnapshot', cb);
}

// === Вычисление размеров сетки ===
function computeGrid(iconW) {
  const cellVw = iconW;
  const cellPx = window.innerWidth * cellVw / 100;
  const cols = Math.max(1, Math.floor(window.innerWidth / Math.max(cellPx, 1)));
  const rows = Math.max(1, Math.ceil(window.innerHeight / Math.max(cellPx, 1)) + 1);
  return { cols, rows, cellVw, cellPx };
}

/** Как в renderGrid: опускаем форму поиска, затем пересчитываем резерв (нужен и при addNewDomain). */
function prepareGridLayoutForPlacement(iconWidth) {
  const { cols, rows, cellVw, cellPx } = computeGrid(iconWidth);
  const searchForm = document.querySelector('.search-form');
  if (searchForm) {
    searchForm.style.top = (cellPx + 8) + 'px';
    void searchForm.offsetHeight;
  }
  const reservedSet = computeReservedCells(cols, cellPx);
  return { cols, rows, cellVw, cellPx, reservedSet };
}

function computeReservedCells(cols, cellPx) {
  const form = document.querySelector('.search-form');
  if (!form) return new Set();
  const rect = form.getBoundingClientRect();
  const reserved = new Set();
  const startCol = Math.floor(rect.left / cellPx);
  const endCol   = Math.ceil(rect.right / cellPx) - 1;
  const startRow = Math.floor(rect.top / cellPx);
  const endRow   = Math.ceil(rect.bottom / cellPx) - 1;
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      if (c >= 0 && c < cols) reserved.add(r * cols + c);
    }
  }
  return reserved;
}

function findNearestFreeCell(targetCol, targetRow, usedSet, reservedSet, cols, rows) {
  const visited = new Set();
  const queue = [[targetCol, targetRow]];
  while (queue.length) {
    const [c, r] = queue.shift();
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const idx = r * cols + c;
    if (visited.has(idx)) continue;
    visited.add(idx);
    if (!usedSet.has(idx) && !reservedSet.has(idx)) {
      return { gridCol: c, gridRow: r };
    }
    queue.push([c-1, r], [c+1, r], [c, r-1], [c, r+1]);
  }
  return null;
}

/** Индексы занятых ячеек только с координатами внутри текущей сетки (устаревшие col/row не портят размещение). */
function occupiedCellIndices(domains, cols, rows) {
  const used = new Set();
  for (const d of domains) {
    if (d.gridCol === undefined || d.gridRow === undefined) continue;
    const c = d.gridCol;
    const r = d.gridRow;
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    used.add(r * cols + c);
  }
  return used;
}

/** Первая свободная ячейка: слева направо, сверху вниз; если в ряду r нет ни одной свободной — переходим к r+1. */
function findFirstFreeCellRowMajor(cols, rows, usedSet, reservedSet) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!usedSet.has(idx) && !reservedSet.has(idx)) {
        return { gridCol: c, gridRow: r };
      }
    }
  }
  return null;
}

let _maxLabels = 999;
let _maxCols = 24;
let _noSpaceTimer = null;
let _noticeTimer = null;
const DEBUG_LAYOUT = true;
const INTERNAL_DRAG_TYPE = 'application/x-labels-internal-drag';

function debugLog(label, payload) {
  if (!DEBUG_LAYOUT) return;
  try {
    console.log(`[LabelS debug] ${label}`, payload);
    console.log(`[LabelS debug json] ${label}: ${JSON.stringify(payload)}`);
  } catch (e) {}
}

function snapshotDomains(domains) {
  return (domains || []).map(d => ({
    domain: d.domain,
    visible: !!d.visible,
    gridCol: d.gridCol,
    gridRow: d.gridRow
  }));
}

function showNoSpacePopup(anchorEl) {
  let popup = document.getElementById('no-space-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'no-space-popup';
    popup.style.cssText = `
      position: fixed; background: rgba(30,41,59,0.85); color: white;
      font-size: 12px; padding: 6px 12px; border-radius: 8px;
      pointer-events: none; z-index: 9999; white-space: nowrap;
    `;
    popup.textContent = '🚫 Нет места на экране';
    document.body.appendChild(popup);
  }
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = rect.left + 'px';
  popup.style.top = (rect.top - 36) + 'px';
  popup.style.display = 'block';
  clearTimeout(_noSpaceTimer);
  _noSpaceTimer = setTimeout(() => { popup.style.display = 'none'; }, 2000);
}

function showLightNotice(message, point = null) {
  let popup = document.getElementById('labels-light-notice');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'labels-light-notice';
    popup.style.cssText = `
      position: fixed;
      background: rgba(255,255,255,0.72);
      color: #0f172a;
      border: 1px solid rgba(148,163,184,0.45);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 10px 30px rgba(15,23,42,0.10);
      font-size: 13px;
      padding: 9px 14px;
      border-radius: 12px;
      pointer-events: none;
      z-index: 10000;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 0.18s ease;
    `;
    document.body.appendChild(popup);
  }

  popup.textContent = message;
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    const offsetY = 18;
    popup.style.left = `${Math.max(12, point.x)}px`;
    popup.style.top = `${Math.max(12, point.y - offsetY)}px`;
    popup.style.transform = 'translate(-50%, -100%)';
  } else {
    popup.style.left = '50%';
    popup.style.top = '18px';
    popup.style.transform = 'translateX(-50%)';
  }
  popup.style.opacity = '1';
  clearTimeout(_noticeTimer);
  _noticeTimer = setTimeout(() => {
    popup.style.opacity = '0';
  }, 1800);
}

function highlightExistingDomain(domain) {
  const escapedDomain = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(domain)
    : domain.replace(/["\\]/g, '\\$&');
  const anchor = document.querySelector(`#grid .cell[data-domain="${escapedDomain}"]`);
  if (!anchor) return false;
  anchor.classList.remove('duplicate-hit');
  void anchor.offsetWidth;
  anchor.classList.add('duplicate-hit');
  setTimeout(() => {
    anchor.classList.remove('duplicate-hit');
  }, 2100);
  return true;
}

function highlightExistingDomainWithRetry(domain, attemptsLeft = 10) {
  if (highlightExistingDomain(domain) || attemptsLeft <= 0) return;
  setTimeout(() => {
    highlightExistingDomainWithRetry(domain, attemptsLeft - 1);
  }, 120);
}

function recalcMaxValues(iconW, colsNum) {
  const cellPx = window.innerWidth * Math.max(1, iconW) / 100;
  const cols = Math.floor(window.innerWidth / cellPx);
  _maxCols = Math.min(cols, LIMITS.columns_num.max);
  const colsRange = document.getElementById('cols');
  const colsNumInput = document.getElementById('cols-num');
  if (colsRange) colsRange.max = _maxCols;
  if (colsNumInput) colsNumInput.max = _maxCols;
  if (colsRange && parseInt(colsRange.value) > _maxCols) {
    colsRange.value = _maxCols;
    if (colsNumInput) colsNumInput.value = _maxCols;
    saveSettingsNow();
    showNoSpacePopup(colsRange);
  }
  const effectiveCols = Math.min(colsNum, cols);
  const searchBlockHeight = cellPx + 8 + 52;
  const availableRows = Math.max(0, Math.floor((window.innerHeight - searchBlockHeight) / cellPx));
  _maxLabels = Math.min(availableRows * effectiveCols, LIMITS.label_count.max);
  const topRange = document.getElementById('top');
  const topNum = document.getElementById('top-num');
  if (topRange) topRange.max = _maxLabels;
  if (topNum) topNum.max = _maxLabels;
  if (topRange && parseInt(topRange.value) > _maxLabels) {
    topRange.value = _maxLabels;
    if (topNum) topNum.value = _maxLabels;
    saveSettingsNow();
    showNoSpacePopup(topRange);
  }
  return _maxLabels;
}

function trimVisibleToFit(maxLabels, domains, isManualLayout) {
  if (isManualLayout) return false;
  const visible = domains.filter(d => d.visible);
  if (visible.length <= maxLabels) return false;
  visible.sort((a,b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (b.date_added || 0) - (a.date_added || 0);
  });
  const toKeep = visible.slice(0, maxLabels);
  const toKeepSet = new Set(toKeep.map(d => d.domain));
  for (const d of domains) {
    if (d.visible && !toKeepSet.has(d.domain)) {
      d.visible = false;
      d.gridCol = undefined;
      d.gridRow = undefined;
    }
  }
  return true;
}

function addNewDomain(domain, fromPopup = true, onComplete, preferredCell = null, noticePoint = null) {
  const done = typeof onComplete === 'function' ? onComplete : () => {};
  getStoredSavedDomains((saved_domains) => {
    getStoredSettings((settings) => {
      let list = saved_domains || [];
      const existing = list.find(d => d.domain === domain);
      const currentVisibleCount = list.filter(d => d.visible).length;
      let willBeVisible = false;
      if (existing && !existing.visible) willBeVisible = true;
      if (!existing) willBeVisible = true;
      if (willBeVisible && currentVisibleCount >= _maxLabels) {
        showNoSpacePopup(document.getElementById('add-btn') || document.body);
        done();
        return;
      }
      if (existing && existing.visible) {
        if (!highlightExistingDomain(domain)) {
          renderGrid();
          highlightExistingDomainWithRetry(domain);
        }
        if (!fromPopup) {
          showLightNotice('Этот сайт уже есть на вкладке', noticePoint);
        }
        scheduleActiveProfileSync();
        done();
        return;
      }
      const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
      const { cols, rows, reservedSet } = prepareGridLayoutForPlacement(cfg.icon_width);
      const usedSet = occupiedCellIndices(list.filter(d => d.visible), cols, rows);
      const targetCell = preferredCell
        ? findNearestFreeCell(preferredCell.gridCol, preferredCell.gridRow, usedSet, reservedSet, cols, rows)
        : findFirstFreeCellRowMajor(cols, rows, usedSet, reservedSet);
      if (!targetCell) {
        showNoSpacePopup(document.getElementById('add-btn') || document.body);
        done();
        return;
      }
      if (existing) {
        existing.visible = true;
        existing.gridCol = targetCell.gridCol;
        existing.gridRow = targetCell.gridRow;
        existing.count = existing.count || 0;
        existing.date_added = existing.date_added || Date.now();
      } else {
        list.push({
          domain,
          count: 0,
          visible: true,
          gridCol: targetCell.gridCol,
          gridRow: targetCell.gridRow,
          date_added: Date.now()
        });
      }
      const newLabelCount = Math.min(
        cfg.label_count + 1,
        LIMITS.label_count.max,
        _maxLabels
      );
      const updatedSettings = Object.assign({}, cfg, { label_count: newLabelCount });
      Object.assign(settingsCache, updatedSettings);
      setSlider('top', newLabelCount);
      setStoredSettings(updatedSettings, () => {
        setSyncedConfig({ saved_domains: list, manualLayout: true, autoLayout: false }, () => {
          updateSliderLockState(true);
          updateDefaultBtnState();
          renderGrid();
          if (fromPopup) renderList(list);
          scheduleActiveProfileSync();
          done();
        });
      });
    });
  });
}

function updateSliderLockState(manualLayout) {
  const allSliders = ['days', 'top', 'iconw', 'cols'];
  allSliders.forEach(id => {
    const range = document.getElementById(id);
    const num = document.getElementById(id + '-num');
    if (range) {
      range.disabled = !!manualLayout;
      range.style.opacity = manualLayout ? '0.4' : '1';
    }
    if (num) {
      num.disabled = !!manualLayout;
      num.style.opacity = manualLayout ? '0.4' : '1';
    }
  });
}

function updateDefaultBtnState() {
  const selectedProfile = profileSelect ? profileSelect.value : DEFAULT_PROFILE_VALUE;
  updateProfileActionButton(selectedProfile);
}

const panel = document.getElementById('settings-panel');
document.getElementById('settings-trigger').addEventListener('click', () => {
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) {
    scheduleActiveProfileSync(0);
  } else {
    clearTimeout(profileMatchTimer);
  }
});
document.getElementById('panel-close').addEventListener('click', () => {
  panel.classList.remove('open');
  clearTimeout(profileMatchTimer);
});

function setSliderLimits() {
  const daysRange = document.getElementById('days');
  const daysNum = document.getElementById('days-num');
  if (daysRange) { daysRange.min = LIMITS.days.min; daysRange.max = LIMITS.days.max; }
  if (daysNum) { daysNum.min = LIMITS.days.min; daysNum.max = LIMITS.days.max; }
  const iconwRange = document.getElementById('iconw');
  const iconwNum = document.getElementById('iconw-num');
  if (iconwRange) { iconwRange.min = LIMITS.icon_width.min; iconwRange.max = LIMITS.icon_width.max; }
  if (iconwNum) { iconwNum.min = LIMITS.icon_width.min; iconwNum.max = LIMITS.icon_width.max; }
  const colsRange = document.getElementById('cols');
  const colsNum = document.getElementById('cols-num');
  if (colsRange) { colsRange.min = LIMITS.columns_num.min; colsRange.max = LIMITS.columns_num.max; }
  if (colsNum) { colsNum.min = LIMITS.columns_num.min; colsNum.max = LIMITS.columns_num.max; }
  const topRange = document.getElementById('top');
  const topNum = document.getElementById('top-num');
  if (topRange) topRange.min = LIMITS.label_count.min;
  if (topNum) topNum.min = LIMITS.label_count.min;
}

getStoredSettings((settings) => {
  const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
  setSlider('days', cfg.history_days);
  setSlider('top', cfg.label_count);
  setSlider('iconw', cfg.icon_width);
  setSlider('cols', cfg.columns_num);
  recalcMaxValues(cfg.icon_width, cfg.columns_num);
});

getStoredLayoutState(({ manualLayout }) => {
  updateSliderLockState(manualLayout);
});

function setSlider(id, val) {
  const range = document.getElementById(id);
  const num = document.getElementById(id + '-num');
  if (range) range.value = val;
  if (num) num.value = val;
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 400); }
function saveSettings() {
  const v = id => parseInt(document.getElementById(id).value, 10);
  setStoredSettings({
    history_days: v("days"),
    label_count: v("top"),
    icon_width: v("iconw"),
    columns_num: v("cols")
  });
}
function saveSettingsNow() {
  return new Promise((resolve) => {
    const v = id => parseInt(document.getElementById(id).value, 10);
    setStoredSettings({
      history_days: v("days"),
      label_count: v("top"),
      icon_width: v("iconw"),
      columns_num: v("cols")
    }, resolve);
  });
}

// Двусторонняя синхронизация ползунков
["days", "top", "iconw", "cols"].forEach(id => {
  const range = document.getElementById(id);
  const num = document.getElementById(id + '-num');
  const onChange = () => {
    if (id === 'iconw' || id === 'cols') {
      const iconW = parseInt(document.getElementById('iconw').value);
      const colsNum = parseInt(document.getElementById('cols').value);
      const newMax = recalcMaxValues(iconW, colsNum);
      if (!manualLayoutCache) {
        getSyncedConfig(['saved_domains', 'manualLayout'], ({ saved_domains, manualLayout }) => {
          if (saved_domains && !manualLayout) {
            const changed = trimVisibleToFit(newMax, saved_domains, manualLayout);
            if (changed) {
              const newCount = saved_domains.filter(d => d.visible).length;
              setSlider('top', newCount);
              const nextSettings = { ...DEFAULT_SETTINGS, ...settingsCache, label_count: newCount };
              setStoredSettings(nextSettings, () => {
                setStoredSavedDomains(saved_domains, () => {
                  renderList(saved_domains);
                  renderGrid();
                });
              });
            }
          }
        });
      }
    }
    if (id === 'top') {
      const newVal = parseInt(range.value);
      if (newVal > _maxLabels) {
        range.value = _maxLabels;
        num.value = _maxLabels;
        showNoSpacePopup(range);
        return;
      }
    }
    if (id === 'cols') {
      const newVal = parseInt(range.value);
      if (newVal > _maxCols) {
        range.value = _maxCols;
        num.value = _maxCols;
        showNoSpacePopup(range);
        return;
      }
    }
    scheduleSave();
    if (id === 'days') {
      getStoredLayoutState(async ({ manualLayout }) => {
        if (!manualLayout) {
          await saveSettingsNow();
          scanHistory(true, true);
        }
      });
    } else if (id === 'iconw' || id === 'cols' || id === 'top') {
      getStoredLayoutState(({ manualLayout }) => {
        if (!manualLayout) {
          saveSettings();
          scanHistory(true, true);
        }
      });
    }
  };
  range.addEventListener("input", () => { num.value = range.value; onChange(); updateDefaultBtnState(); scheduleActiveProfileSync(); });
  num.addEventListener("input", () => { range.value = num.value; onChange(); updateDefaultBtnState(); scheduleActiveProfileSync(); });
});

let manualLayoutCache = false;
getStoredLayoutState(({ manualLayout }) => { manualLayoutCache = manualLayout; });

// === Обработчик storage.onChanged только для синхронизации между вкладками (без перерисовки сетки) ===
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    if (changes.manualLayout) {
      updateSliderLockState(changes.manualLayout.newValue);
      manualLayoutCache = changes.manualLayout.newValue;
    }
  }
  if (area === 'local') {
    if (changes.pendingAddDomain) {
      checkPendingAdd();
    }
  }
});

let settingsCache = {};
getStoredSettings((settings) => {
  settingsCache = settings || {};
});

function loadDefaultProfile() {
  setSlider('days', DEFAULT_SETTINGS.history_days);
  setSlider('top', DEFAULT_SETTINGS.label_count);
  setSlider('iconw', DEFAULT_SETTINGS.icon_width);
  setSlider('cols', DEFAULT_SETTINGS.columns_num);
  saveSettingsNow().then(() => {
    recalcMaxValues(DEFAULT_SETTINGS.icon_width, DEFAULT_SETTINGS.columns_num);
    removeStoredProfileSnapshot(() => {
      setStoredLayoutState({ manualLayout: false, autoLayout: true }, () => {
        manualLayoutCache = false;
        updateSliderLockState(false);
        refreshProfileSelect(DEFAULT_PROFILE_VALUE);
        scanHistory(true, true);
        scheduleActiveProfileSync();
      });
    });
  });
}

// === Попап сохранения профиля ===
const profilePopup = document.getElementById('profile-popup-overlay');
const profileNameInput = document.getElementById('profile-name-input');
const profileConfirmBtn = document.getElementById('profile-confirm-btn');
const profileCloseBtn = document.getElementById('profile-close-btn');
const profileSelect = document.getElementById('profile-select');
const profilePopupTitle = profilePopup ? profilePopup.querySelector('h3') : null;
const DEFAULT_PROFILE_VALUE = '__default__';
const CUSTOM_PROFILE_VALUE = '__custom__';
const LAST_PROFILE_KEY = 'profile_last';
const LAST_PROFILE_NAME = 'Авто-сохранённый';
let isProfileSelectSyncing = false;
let profileMatchTimer = null;
let profileMatchRequestId = 0;
let profilePopupMode = 'create'; // 'create' | 'rename'
let profileRenameKey = null;

function getProfileIndex(cb) {
  chrome.storage.sync.get('profile_index', ({ profile_index }) => cb(profile_index || []));
}

function normalizeProfileDomains(domains) {
  return (domains || [])
    .filter(d => d && d.visible !== false && d.domain)
    .map(d => ({
      domain: d.domain,
      gridCol: d.gridCol === undefined ? null : d.gridCol,
      gridRow: d.gridRow === undefined ? null : d.gridRow
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

function areSettingsEqual(a, b) {
  const left = Object.assign({}, DEFAULT_SETTINGS, a || {});
  const right = Object.assign({}, DEFAULT_SETTINGS, b || {});
  return left.history_days === right.history_days
    && left.label_count === right.label_count
    && left.icon_width === right.icon_width
    && left.columns_num === right.columns_num;
}

function areDomainLayoutsEqual(a, b) {
  const left = normalizeProfileDomains(a);
  const right = normalizeProfileDomains(b);
  if (left.length !== right.length) return false;
  return left.every((item, index) =>
    item.domain === right[index].domain
    && item.gridCol === right[index].gridCol
    && item.gridRow === right[index].gridRow
  );
}

function setProfilePopupTitle(text, isAlert = false) {
  if (!profilePopupTitle) return;
  profilePopupTitle.textContent = text;
  profilePopupTitle.style.color = isAlert ? '#dc2626' : '#1e293b';
}

function resetProfilePopupTitle() {
  setProfilePopupTitle('Имя профиля', false);
}

function showDuplicateProfileAlert(profileName) {
  setProfilePopupTitle(`Такой профиль уже есть: ${profileName}`, true);
  profileConfirmBtn.disabled = true;
  setTimeout(() => {
    if (profilePopup.classList.contains('open')) {
      resetProfilePopupTitle();
      profileConfirmBtn.disabled = !profileNameInput.value.trim();
    }
  }, 2500);
}

function readCurrentSettingsFromUI() {
  const v = id => parseInt(document.getElementById(id).value, 10);
  return {
    history_days: v('days'),
    label_count: v('top'),
    icon_width: v('iconw'),
    columns_num: v('cols')
  };
}

function extractVisibleDomains(domains) {
  return (domains || []).filter(d => d && d.visible).map(d => ({
    domain: d.domain,
    count: d.count || 0,
    visible: true,
    gridCol: d.gridCol,
    gridRow: d.gridRow
  }));
}

function getCurrentProfileState(cb) {
  getSyncedConfig(['saved_domains', 'manualLayout'], ({ saved_domains, manualLayout }) => {
    cb({
      settings: readCurrentSettingsFromUI(),
      domains: extractVisibleDomains(saved_domains),
      manualLayout: !!manualLayout
    });
  });
}

function getDefaultProfileState(cb) {
  const cfg = { ...DEFAULT_SETTINGS };
  const startTime = Date.now() - cfg.history_days * 24 * 60 * 60 * 1000;
  const limit = cfg.label_count;
  const { cols, cellPx } = computeGrid(cfg.icon_width);
  cfg.columns_num = Math.min(cfg.columns_num, cols);
  const searchFormEl = document.querySelector('.search-form');
  const formHeight = searchFormEl ? searchFormEl.offsetHeight : 52;
  const startRow = Math.ceil((cellPx + 8 + formHeight) / cellPx);

  chrome.history.search({ text: "", startTime, maxResults: 100000 }, (items) => {
    const counts = {};
    for (const item of items) {
      if (!item.url) continue;
      try {
        const domain = new URL(item.url).hostname.replace(/^www\./, "");
        if (!domain) continue;
        counts[domain] = (counts[domain] || 0) + 1;
      } catch (e) {}
    }

    const domains = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([domain, count], index) => {
        const relCol = index % cfg.columns_num;
        const relRow = Math.floor(index / cfg.columns_num);
        const colOffset = Math.max(0, Math.floor((cols - cfg.columns_num) / 2));
        return {
          domain,
          count,
          visible: true,
          gridCol: colOffset + relCol,
          gridRow: startRow + relRow
        };
      });

    cb({
      settings: cfg,
      domains,
      manualLayout: false
    });
  });
}

function findMatchingProfileValue(cb) {
  getCurrentProfileState((currentState) => {
    const compareSavedProfiles = () => {
      getProfileIndex((index) => {
        const keys = index.map(p => p.key);
        chrome.storage.sync.get(keys, (profilesMap) => {
          const matchedProfile = index.find((profile) => {
            const savedProfile = profilesMap ? profilesMap[profile.key] : null;
            if (!savedProfile) return false;
            return areSettingsEqual(savedProfile.settings, currentState.settings)
              && areDomainLayoutsEqual(savedProfile.domains, currentState.domains);
          });
          cb(matchedProfile ? matchedProfile.key : CUSTOM_PROFILE_VALUE);
        });
      });
    };

    if (!currentState.manualLayout && areSettingsEqual(currentState.settings, DEFAULT_SETTINGS)) {
      getDefaultProfileState((defaultState) => {
        if (
          areSettingsEqual(defaultState.settings, currentState.settings) &&
          areDomainLayoutsEqual(defaultState.domains, currentState.domains)
        ) {
          cb(DEFAULT_PROFILE_VALUE);
          return;
        }
        compareSavedProfiles();
      });
      return;
    }

    compareSavedProfiles();
  });
}

function autoSaveLastProfile(cb) {
  getCurrentProfileState((state) => {
    const profileData = {
      name: LAST_PROFILE_NAME,
      settings: state.settings,
      domains: state.domains,
      created: Date.now()
    };
    getProfileIndex((index) => {
      const hasLast = index.some(p => p.key === LAST_PROFILE_KEY);
      if (!hasLast) {
        index.push({ name: LAST_PROFILE_NAME, key: LAST_PROFILE_KEY });
      }
      chrome.storage.sync.set({
        [LAST_PROFILE_KEY]: profileData,
        profile_index: index
      }, () => {
        const snapshot = {
          name: LAST_PROFILE_NAME,
          settings: state.settings,
          defaultVisibleDomains: state.domains.filter(d => d.visible).map(d => d.domain),
          syncProfileKey: LAST_PROFILE_KEY,
          updatedAt: Date.now()
        };
        setStoredProfileSnapshot(snapshot, () => {
          if (typeof cb === 'function') cb();
        });
      });
    });
  });
}

function scheduleActiveProfileSync(delay = 800) {
  clearTimeout(profileMatchTimer);
  profileMatchTimer = setTimeout(() => {
    const requestId = ++profileMatchRequestId;
    findMatchingProfileValue((matchedValue) => {
      if (requestId !== profileMatchRequestId) return;
      if (matchedValue === CUSTOM_PROFILE_VALUE) {
        autoSaveLastProfile(() => {
          if (panel && panel.classList.contains('open')) {
            refreshProfileSelect(LAST_PROFILE_KEY);
            updateDefaultBtnState();
          }
        });
      } else {
        if (panel && panel.classList.contains('open')) {
          refreshProfileSelect(matchedValue);
          updateDefaultBtnState();
        }
      }
    });
  }, delay);
}

function updateProfileActionButton(selectedValue) {
  const actionBtn = document.getElementById('save-default-btn');
  if (!actionBtn) return;
  const isSavedProfile = selectedValue && selectedValue !== DEFAULT_PROFILE_VALUE;
  actionBtn.textContent = 'Удалить';
  actionBtn.style.background = isSavedProfile ? '#dc2626' : '#94a3b8';
  actionBtn.disabled = !isSavedProfile;
  actionBtn.style.cursor = isSavedProfile ? '' : 'default';
}

function refreshProfileSelect(selectedValue) {
  if (!profileSelect) return;
  getStoredProfileSnapshot((savedProfileSnapshot) => {
    getProfileIndex((index) => {
      const desiredValue =
        selectedValue !== undefined
          ? selectedValue
          : ((savedProfileSnapshot && savedProfileSnapshot.syncProfileKey) || DEFAULT_PROFILE_VALUE);
      isProfileSelectSyncing = true;
      profileSelect.innerHTML = '';

      const defaultOption = document.createElement('option');
      defaultOption.value = DEFAULT_PROFILE_VALUE;
      defaultOption.textContent = 'По умолчанию';
      profileSelect.appendChild(defaultOption);

      index.forEach((profile) => {
        const option = document.createElement('option');
        option.value = profile.key;
        option.textContent = profile.name;
        profileSelect.appendChild(option);
      });

      const hasDesiredValue = [...profileSelect.options].some(option => option.value === desiredValue);
      profileSelect.value = hasDesiredValue ? desiredValue : DEFAULT_PROFILE_VALUE;
      updateProfileActionButton(profileSelect.value);
      isProfileSelectSyncing = false;
    });
  });
}

function applyProfileSettings(settings) {
  const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
  setSlider('days', cfg.history_days);
  setSlider('top', cfg.label_count);
  setSlider('iconw', cfg.icon_width);
  setSlider('cols', cfg.columns_num);
  Object.assign(settingsCache, cfg);
  recalcMaxValues(cfg.icon_width, cfg.columns_num);
}

function loadSavedProfile(profileKey) {
  chrome.storage.sync.get(profileKey, (result) => {
    const profileData = result && result[profileKey];
    if (!profileData) {
      refreshProfileSelect(DEFAULT_PROFILE_VALUE);
      return;
    }

    const settings = Object.assign({}, DEFAULT_SETTINGS, profileData.settings || {});
    const domains = Array.isArray(profileData.domains) ? profileData.domains : [];
    const savedDomains = domains.map((item, index) => ({
      domain: item.domain,
      count: item.count || 0,
      visible: item.visible !== false,
      gridCol: item.gridCol,
      gridRow: item.gridRow,
      date_added: Date.now() + index
    }));
    const snapshot = {
      name: profileData.name,
      settings,
      defaultVisibleDomains: savedDomains.filter(d => d.visible).map(d => d.domain),
      syncProfileKey: profileKey,
      updatedAt: Date.now()
    };
    const hasCoords = savedDomains.some(d => d.gridCol !== undefined && d.gridRow !== undefined);

    applyProfileSettings(settings);
    setStoredSettings(settings, () => {
      setSyncedConfig({
        saved_domains: savedDomains,
        savedProfileSnapshot: snapshot,
        manualLayout: hasCoords,
        autoLayout: !hasCoords
      }, () => {
        manualLayoutCache = hasCoords;
        updateSliderLockState(hasCoords);
        renderList(savedDomains);
        renderGrid();
        updateDefaultBtnState();
        refreshProfileSelect(profileKey);
        scheduleActiveProfileSync();
      });
    });
  });
}

function deleteSavedProfile(profileKey) {
  getProfileIndex((index) => {
    const nextIndex = index.filter(profile => profile.key !== profileKey);
    chrome.storage.sync.remove(profileKey, () => {
      chrome.storage.sync.set({ profile_index: nextIndex }, () => {
        refreshProfileSelect(DEFAULT_PROFILE_VALUE);
        loadDefaultProfile();
      });
    });
  });
}

if (profileSelect) {
  profileSelect.addEventListener('change', () => {
    if (isProfileSelectSyncing) return;
    const selected = profileSelect.value;
    if (selected === CUSTOM_PROFILE_VALUE) return;
    if (selected === DEFAULT_PROFILE_VALUE) {
      loadDefaultProfile();
      return;
    }
    loadSavedProfile(selected);
  });
}

const saveDefaultBtn = document.getElementById('save-default-btn');
if (saveDefaultBtn) {
  saveDefaultBtn.addEventListener('click', () => {
    const selectedProfile = profileSelect ? profileSelect.value : DEFAULT_PROFILE_VALUE;
    if (selectedProfile && selectedProfile !== DEFAULT_PROFILE_VALUE) {
      deleteSavedProfile(selectedProfile);
    }
  });
}

profileNameInput.addEventListener('input', () => {
  resetProfilePopupTitle();
  const name = profileNameInput.value.trim();
  if (!name) { profileConfirmBtn.disabled = true; return; }
  getProfileIndex((index) => {
    profileConfirmBtn.disabled = index.some(p => p.name === name && p.key !== profileRenameKey);
  });
});

profileCloseBtn.addEventListener('click', () => {
  resetProfilePopupTitle();
  profilePopupMode = 'create';
  profileRenameKey = null;
  profilePopup.classList.remove('open');
});

function startRename(profileKey) {
  getProfileIndex((index) => {
    const profile = index.find(p => p.key === profileKey);
    if (!profile) return;
    profilePopupMode = 'rename';
    profileRenameKey = profileKey;
    if (profilePopupTitle) {
      profilePopupTitle.textContent = 'Переименовать';
      profilePopupTitle.style.color = '#1e293b';
    }
    profileNameInput.value = profile.name;
    profileConfirmBtn.disabled = false;
    profilePopup.classList.add('open');
    profileNameInput.focus();
    profileNameInput.select();
  });
}

function submitProfileRename() {
  const name = profileNameInput.value.trim();
  if (!name || profileConfirmBtn.disabled) return;
  const key = profileRenameKey;
  getProfileIndex((index) => {
    const profile = index.find(p => p.key === key);
    if (!profile) return;
    profile.name = name;
    chrome.storage.sync.get(key, (result) => {
      const profileData = result[key];
      if (profileData) profileData.name = name;
      chrome.storage.sync.set({
        profile_index: index,
        ...(profileData ? { [key]: profileData } : {})
      }, () => {
        getStoredProfileSnapshot((savedProfileSnapshot) => {
          if (savedProfileSnapshot && savedProfileSnapshot.syncProfileKey === key) {
            savedProfileSnapshot.name = name;
            setStoredProfileSnapshot(savedProfileSnapshot);
          }
        });
        profilePopupMode = 'create';
        profileRenameKey = null;
        profileConfirmBtn.classList.add('saved');
        setTimeout(() => {
          profilePopup.classList.remove('open');
          resetProfilePopupTitle();
          refreshProfileSelect(key);
          setTimeout(() => profileConfirmBtn.classList.remove('saved'), 600);
        }, 800);
      });
    });
  });
}

function submitProfileSave() {
  if (profilePopupMode === 'rename') { submitProfileRename(); return; }
  const name = profileNameInput.value.trim();
  if (!name || profileConfirmBtn.disabled) return;

  const v = id => parseInt(document.getElementById(id).value, 10);
  const settings = {
    history_days: v('days'),
    label_count: v('top'),
    icon_width: v('iconw'),
    columns_num: v('cols')
  };

  getStoredSavedDomains((saved_domains) => {
    const profileData = {
      name,
      settings,
      domains: (saved_domains || []).filter(d => d.visible).map(d => ({
        domain: d.domain,
        count: d.count,
        visible: d.visible,
        gridCol: d.gridCol,
        gridRow: d.gridRow
      })),
      created: Date.now()
    };

    const profileSize = new Blob([JSON.stringify(profileData)]).size;
    const SYNC_LIMIT = 102400;
    getProfileIndex((index) => {
      const keys = index.map(p => p.key);
      chrome.storage.sync.get(keys, (profilesMap) => {
        const duplicate = index.find((profile) => {
          const savedProfile = profilesMap ? profilesMap[profile.key] : null;
          if (!savedProfile) return false;
          return areSettingsEqual(savedProfile.settings, profileData.settings)
            && areDomainLayoutsEqual(savedProfile.domains, profileData.domains);
        });
        if (duplicate) {
          showDuplicateProfileAlert(duplicate.name);
          return;
        }

        chrome.storage.sync.getBytesInUse(null, (usedBytes) => {
          if (usedBytes + profileSize + 200 > SYNC_LIMIT) {
            profilePopup.classList.remove('open');
            showNoSpaceAlert(SYNC_LIMIT, usedBytes, profileSize);
            return;
          }

          const id = Date.now();
          const key = 'profile_' + id;
          index.push({ name, key });
          chrome.storage.sync.set({ [key]: profileData, profile_index: index }, () => {
            if (chrome.runtime.lastError) {
              profilePopup.classList.remove('open');
              showNoSpaceAlert(SYNC_LIMIT, usedBytes, profileSize);
              return;
            }
            const defaultVisible = (saved_domains || [])
              .filter(d => d.visible)
              .map(d => d.domain);
            const snapshot = {
              name,
              settings,
              defaultVisibleDomains: defaultVisible,
              syncProfileKey: key,
              updatedAt: Date.now()
            };
            chrome.storage.local.remove(['customDefaults', 'defaultVisibleDomains'], () => {
              setStoredProfileSnapshot(snapshot, () => {
                refreshProfileSelect(key);
                profileConfirmBtn.classList.add('saved');
                setTimeout(() => {
                  profilePopup.classList.remove('open');
                  setTimeout(() => {
                    profileConfirmBtn.classList.remove('saved');
                    updateDefaultBtnState();
                  }, 600);
                }, 1333);
              });
            });
          });
        });
      });
    });
  });
}

profileNameInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  submitProfileSave();
});

profileConfirmBtn.addEventListener('click', () => {
  submitProfileSave();
});

// === Экспорт / Импорт ===
function getBrowserLabel() {
  const ua = navigator.userAgent || '';

  if (ua.includes('YaBrowser/')) return 'Yandex';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera/')) return 'Opera';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/')) return 'Safari';

  return 'Browser';
}

function exportData() {
  Promise.all([
    new Promise(r => chrome.storage.local.get(null, r)),
    new Promise(r => chrome.storage.sync.get(null, r))
  ]).then(([local, sync]) => {
    const data = JSON.stringify({ local, sync }, null, 2);
    const a = document.createElement('a');
    a.href = 'data:application/json,' + encodeURIComponent(data);
    a.download = `${getBrowserLabel()}_LabelS.json`;
    a.click();
  });
}

function applyImportedBackup(backupText, onDone) {
  let backup;
  try {
    backup = JSON.parse(backupText);
  } catch {
    alert('Ошибка: неверный формат файла');
    if (typeof onDone === 'function') onDone(false);
    return;
  }
  if (!backup.local || !backup.sync) {
    alert('Ошибка: файл не содержит данных local/sync');
    if (typeof onDone === 'function') onDone(false);
    return;
  }

  const importedIndex = Array.isArray(backup.sync.profile_index) ? backup.sync.profile_index : [];
  const firstProfileMeta = importedIndex.find((item) => item && item.key && backup.sync[item.key]);
  if (firstProfileMeta) {
    const firstProfile = backup.sync[firstProfileMeta.key];
    const settings = Object.assign({}, DEFAULT_SETTINGS, firstProfile.settings || {});
    const profileDomains = Array.isArray(firstProfile.domains) ? firstProfile.domains : [];
    const savedDomains = profileDomains
      .filter((item) => item && item.domain)
      .map((item, index) => ({
        domain: item.domain,
        count: item.count || 0,
        visible: item.visible !== false,
        gridCol: item.gridCol,
        gridRow: item.gridRow,
        date_added: Date.now() + index
      }));
    const hasCoords = savedDomains.some((item) => item.gridCol !== undefined && item.gridRow !== undefined);
    const snapshot = {
      name: firstProfile.name || firstProfileMeta.name || 'Профиль',
      settings,
      defaultVisibleDomains: savedDomains.filter((item) => item.visible).map((item) => item.domain),
      syncProfileKey: firstProfileMeta.key,
      updatedAt: Date.now()
    };

    backup.sync.settings = settings;
    backup.sync.saved_domains = savedDomains;
    backup.sync.savedProfileSnapshot = snapshot;
    backup.sync.manualLayout = hasCoords;
    backup.sync.autoLayout = !hasCoords;
  }

  chrome.storage.local.set(backup.local, () => {
    chrome.storage.sync.set(backup.sync, () => {
      if (typeof onDone === 'function') onDone(true);
      location.reload();
    });
  });
}

async function importData() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        id: 'labels-import',
        startIn: 'downloads',
        multiple: false,
        types: [{
          description: 'LabelS backup',
          accept: { 'application/json': ['.json'] }
        }]
      });
      if (!fileHandle) return;
      const file = await fileHandle.getFile();
      const text = await file.text();
      applyImportedBackup(text);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // fallback below
    }
  }
  document.getElementById('import-file-input').click();
}

document.getElementById('import-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    applyImportedBackup(ev.target.result, () => {
      e.target.value = '';
    });
  };
  reader.readAsText(file);
});

// === Контекстное меню профилей ===
const profileContextMenu = document.getElementById('profile-context-menu');
const ctxRename = document.getElementById('ctx-rename');
const ctxDelete = document.getElementById('ctx-delete');
const ctxExport = document.getElementById('ctx-export');

function showProfileContextMenu(x, y, isSavedProfile) {
  ctxRename.classList.toggle('disabled', !isSavedProfile);
  ctxDelete.classList.toggle('disabled', !isSavedProfile);
  ctxExport.classList.toggle('disabled', !isSavedProfile);

  profileContextMenu.style.left = x + 'px';
  profileContextMenu.style.top  = y + 'px';
  profileContextMenu.classList.add('open');

  // Скорректировать если выходит за правый/нижний край
  requestAnimationFrame(() => {
    const rect = profileContextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth)
      profileContextMenu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight)
      profileContextMenu.style.top  = (y - rect.height) + 'px';
  });
}

function hideProfileContextMenu() {
  profileContextMenu.classList.remove('open');
  document.getElementById('ctx-normal').style.display = '';
  document.getElementById('ctx-confirm').style.display = 'none';
}

if (profileSelect) {
  profileSelect.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const isSaved = profileSelect.value !== DEFAULT_PROFILE_VALUE;
    showProfileContextMenu(e.clientX, e.clientY, isSaved);
  });
}

ctxRename.addEventListener('click', () => {
  hideProfileContextMenu();
  startRename(profileSelect.value);
});

ctxDelete.addEventListener('click', () => {
  document.getElementById('ctx-normal').style.display = 'none';
  document.getElementById('ctx-confirm').style.display = '';
});

document.getElementById('ctx-confirm-yes').addEventListener('click', () => {
  hideProfileContextMenu();
  deleteSavedProfile(profileSelect.value);
});

document.getElementById('ctx-confirm-no').addEventListener('click', () => {
  document.getElementById('ctx-normal').style.display = '';
  document.getElementById('ctx-confirm').style.display = 'none';
});

document.getElementById('ctx-export').addEventListener('click', () => {
  hideProfileContextMenu();
  exportData();
});

document.getElementById('ctx-import').addEventListener('click', () => {
  hideProfileContextMenu();
  importData();
});

document.addEventListener('click', (e) => {
  if (!profileContextMenu.contains(e.target)) hideProfileContextMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideProfileContextMenu();
});

function showNoSpaceAlert(totalBytes, usedBytes, profileBytes) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.3);z-index:10001;display:flex;justify-content:center;align-items:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:white;border-radius:12px;padding:20px 28px;box-shadow:0 8px 32px rgba(0,0,0,0.2);text-align:center;font-size:14px;color:#1e293b;min-width:240px;';
  const freeBytes = totalBytes - usedBytes;
  box.innerHTML = `<div style="font-size:16px;font-weight:600;color:#dc2626;margin-bottom:10px">Мало места</div>`
    + `<div style="text-align:left;line-height:1.8">`
    + `Всего: <b>${(totalBytes / 1024).toFixed(1)} KB</b><br>`
    + `Занято: <b>${(usedBytes / 1024).toFixed(1)} KB</b><br>`
    + `Свободно: <b>${(freeBytes / 1024).toFixed(1)} KB</b><br>`
    + `Профиль: <b>${(profileBytes / 1024).toFixed(1)} KB</b>`
    + `</div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', () => overlay.remove());
  setTimeout(() => overlay.remove(), 5000);
}

function sortDomains(domains) {
  domains.sort((a, b) => {
    if ((b.visible ? 1 : 0) !== (a.visible ? 1 : 0)) return (b.visible ? 1 : 0) - (a.visible ? 1 : 0);
    if (b.count !== a.count) return b.count - a.count;
    return (b.date_added || 0) - (a.date_added || 0);
  });
}

function scanHistory(resetCoords = false, autoLayout = false) {
  getStoredSettings((settings) => {
    const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
    const startTime = Date.now() - cfg.history_days * 24 * 60 * 60 * 1000;
    const limit = cfg.label_count * 2;

    const applySorted = (sorted) => {
      sortDomains(sorted);
      setSyncedConfig({ saved_domains: sorted, autoLayout }, () => {
        renderList(sorted);
        renderGrid();
        scheduleActiveProfileSync();
      });
    };

    chrome.history.search({ text: "", startTime, maxResults: 100000 }, (items) => {
      const counts = {};
      for (const item of items) {
        if (!item.url) continue;
        try {
          const domain = new URL(item.url).hostname.replace(/^www\./, "");
          if (!domain) continue;
          counts[domain] = (counts[domain] || 0) + 1;
        } catch (e) {}
      }

      if (resetCoords) {
        const sorted = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([domain, count], index) => ({
            domain,
            count,
            visible: index < cfg.label_count,
            gridCol: undefined,
            gridRow: undefined,
            date_added: Date.now()
          }));
        applySorted(sorted);
        return;
      }

      getStoredSavedDomains((saved_domains) => {
        const oldMap = {};
        for (const d of (saved_domains || [])) oldMap[d.domain] = d;

        const sorted = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([domain, count], index) => {
            const old = oldMap[domain];
            return {
              domain,
              count,
              visible: old !== undefined ? old.visible : index < cfg.label_count,
              gridCol: old ? old.gridCol : undefined,
              gridRow: old ? old.gridRow : undefined,
              date_added: (old && old.date_added) || Date.now()
            };
          });

        // Повторно читаем storage: добавление из popup могло произойти пока шёл history.search —
        // иначе scanHistory перезапишет список и выкинет домены вне выборки истории.
        getStoredSavedDomains((latest) => {
          const inSorted = new Set(sorted.map(d => d.domain));
          for (const d of (latest || [])) {
            if (inSorted.has(d.domain)) continue;
            sorted.push({
              domain: d.domain,
              count: d.count || 0,
              visible: !!d.visible,
              gridCol: d.gridCol !== undefined ? d.gridCol : undefined,
              gridRow: d.gridRow !== undefined ? d.gridRow : undefined,
              date_added: d.date_added || Date.now()
            });
            inSorted.add(d.domain);
          }
          applySorted(sorted);
        });
      });
    });
  });
}

function renderList(domains) {
  const out = document.getElementById("output");
  if (!domains || domains.length === 0) {
    out.innerHTML = "<p style='padding:12px;color:#64748b'>Нажмите По умолчанию чтобы загрузить метки из истории.</p>";
    return;
  }
  out.innerHTML = "";
  const table = document.createElement("table");
  const thead = document.createElement("tr");
  thead.innerHTML = "<th>показать</th><th>Домен</th><th>Визиты</th>";
  table.appendChild(thead);

  for (const item of domains) {
    const tr = document.createElement("tr");
    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.visible;
    cb.addEventListener("change", () => {
      getSyncedConfig(['saved_domains', 'manualLayout'], ({ saved_domains, manualLayout }) => {
        getStoredSettings((settings) => {
          const latestDomains = Array.isArray(saved_domains) ? saved_domains : domains;
          const currentItem = latestDomains.find(d => d.domain === item.domain);
          if (!currentItem) return;

          if (cb.checked) {
            const currentVisible = latestDomains.filter(d => d.visible).length;
            if (currentVisible >= _maxLabels) {
              showNoSpacePopup(cb);
              cb.checked = false;
              return;
            }
            currentItem.visible = true;
          if (!manualLayout || currentItem.gridCol === undefined || currentItem.gridRow === undefined) {
            currentItem.gridCol = undefined;
            currentItem.gridRow = undefined;
          }
        } else {
          currentItem.visible = false;
          if (!manualLayout) {
            currentItem.gridCol = undefined;
              currentItem.gridRow = undefined;
            }
          }

          debugLog('checkbox-change:start', {
            targetDomain: item.domain,
            checked: cb.checked,
            domainsBefore: snapshotDomains(latestDomains)
          });

          sortDomains(latestDomains);
          const newCount = latestDomains.filter(d => d.visible).length;
          setSlider('top', newCount);
          const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
          cfg.label_count = newCount;
          debugLog('checkbox-change:before-save', {
            targetDomain: item.domain,
            manualLayout,
            newCount,
            settings: cfg,
            domainsAfterToggle: snapshotDomains(latestDomains)
          });
          setStoredSettings(cfg, () => {
            setStoredSavedDomains(latestDomains, () => {
              debugLog('checkbox-change:after-save', {
                targetDomain: item.domain,
                manualLayout,
                domainsPersisted: snapshotDomains(latestDomains)
              });
              if (!manualLayout) {
                scanHistory(true, true);
              } else {
                renderList(latestDomains);
                renderGrid();
                scheduleActiveProfileSync();
              }
            });
          });
        });
      });
    });
    tdCheck.appendChild(cb);
    const tdName = document.createElement("td");
    tdName.textContent = item.domain;
    tdName.title = item.domain;
    const tdCount = document.createElement("td");
    tdCount.textContent = item.count || 0;
    tr.appendChild(tdCheck);
    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    table.appendChild(tr);
  }
  out.appendChild(table);
  updateDefaultBtnState();
}

function hideDomainFromGrid(domainToHide, onComplete) {
  getSyncedConfig(['saved_domains', 'manualLayout'], ({ saved_domains, manualLayout }) => {
    getStoredSettings((settings) => {
      const latestDomains = Array.isArray(saved_domains) ? saved_domains : [];
      const currentItem = latestDomains.find(d => d.domain === domainToHide);
      if (!currentItem || !currentItem.visible) {
        if (typeof onComplete === 'function') onComplete(false);
        return;
      }

      currentItem.visible = false;
      if (!manualLayout) {
        currentItem.gridCol = undefined;
        currentItem.gridRow = undefined;
      }

      sortDomains(latestDomains);
      const newCount = latestDomains.filter(d => d.visible).length;
      setSlider('top', newCount);
      const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
      cfg.label_count = newCount;

      setStoredSettings(cfg, () => {
        setStoredSavedDomains(latestDomains, () => {
          if (!manualLayout) {
            scanHistory(true, true);
          } else {
            renderList(latestDomains);
            renderGrid();
            scheduleActiveProfileSync();
          }
          if (typeof onComplete === 'function') onComplete(true);
        });
      });
    });
  });
}

let dragSourceCellIndex = null;

let renderGridTimer = null;
let isRendering = false;

function renderGrid() {
  if (isRendering) {
    if (renderGridTimer) clearTimeout(renderGridTimer);
    renderGridTimer = setTimeout(() => renderGrid(), 50);
    return;
  }
  isRendering = true;
  if (renderGridTimer) clearTimeout(renderGridTimer);
  
  getSyncedConfig(['saved_domains', 'autoLayout', 'manualLayout'], 
    ({ saved_domains, autoLayout, manualLayout }) => {
    getStoredSettings((settings) => {
      if (!saved_domains) {
        isRendering = false;
        return;
      }
      if (manualLayout && autoLayout) {
        setStoredLayoutState({ autoLayout: false });
        autoLayout = false;
      }
      debugLog('renderGrid:start', {
        autoLayout,
        manualLayout,
        settings,
        savedDomains: snapshotDomains(saved_domains)
      });
      const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
      let visibleDomains = (saved_domains || []).filter(d => d.visible);
      const maxAllowed = Math.min(cfg.label_count, _maxLabels);
      visibleDomains = visibleDomains.slice(0, maxAllowed);
      const { cols, rows, cellVw, cellPx, reservedSet } = prepareGridLayoutForPlacement(cfg.icon_width);
      cfg.columns_num = Math.min(cfg.columns_num, cols);
      const usedSet = occupiedCellIndices(visibleDomains, cols, rows);
      let autoIndex = 0;
      let domainsChanged = false;
      for (const d of visibleDomains) {
        if (d.gridCol === undefined) {
          if (autoLayout && !manualLayout) {
            const pos = findAutoLayoutCell(autoIndex, cols, cellPx, cfg);
            d.gridCol = pos.gridCol;
            d.gridRow = pos.gridRow;
            usedSet.add(pos.gridRow * cols + pos.gridCol);
            autoIndex++;
            domainsChanged = true;
          } else {
            const pos = findFirstFreeCellRowMajor(cols, rows, usedSet, reservedSet);
            if (pos) {
              d.gridCol = pos.gridCol;
              d.gridRow = pos.gridRow;
              usedSet.add(pos.gridRow * cols + pos.gridCol);
              domainsChanged = true;
            } else {
              if (!d._noRoom) {
                d._noRoom = true;
                domainsChanged = true;
              }
            }
          }
        }
      }
      if (saved_domains) {
        const coordMap = {};
        for (const d of visibleDomains) {
          if (!d._noRoom) coordMap[d.domain] = { gridCol: d.gridCol, gridRow: d.gridRow };
        }
        for (const d of saved_domains) {
          if (coordMap[d.domain]) {
            if (d.gridCol !== coordMap[d.domain].gridCol || d.gridRow !== coordMap[d.domain].gridRow) {
              d.gridCol = coordMap[d.domain].gridCol;
              d.gridRow = coordMap[d.domain].gridRow;
              domainsChanged = true;
            }
          }
          if (d._noRoom !== undefined) {
            delete d._noRoom;
            domainsChanged = true;
          }
        }
        if (domainsChanged) {
          setStoredSavedDomains(saved_domains);
        }
      }
      debugLog('renderGrid:before-dom', {
        cfg,
        cols,
        rows,
        reserved: [...reservedSet],
        visibleDomains: snapshotDomains(visibleDomains),
        savedDomains: snapshotDomains(saved_domains)
      });
      const posMap = {};
      for (const d of visibleDomains) {
        if (d.gridCol !== undefined && !d._noRoom) {
          posMap[d.gridRow * cols + d.gridCol] = d;
        }
      }
      renderGridDOM(posMap, cols, rows, cellVw, reservedSet);
      isRendering = false;
    });
  });
}

function renderGridDOM(posMap, cols, rows, cellVw, reservedSet) {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  grid.style.gridTemplateColumns = `repeat(${cols}, ${cellVw}vw)`;
  grid.style.gridAutoRows = `${cellVw}vw`;
  const faviconCount = {};
  for (const d of Object.values(posMap)) {
    const parts = d.domain.split(".");
    const fd = parts.length > 2 ? parts.slice(-2).join(".") : d.domain;
    faviconCount[fd] = (faviconCount[fd] || 0) + 1;
  }
  const total = cols * rows;
  for (let i = 0; i < total; i++) {
    const cell = document.createElement("div");
    cell.className = "grid-cell";
    cell.dataset.index = i;
    const domain = posMap[i];
    if (domain) {
      const anchor = document.createElement("a");
      anchor.className = "cell";
      anchor.dataset.domain = domain.domain;
      anchor.href = `https://${domain.domain}`;
      anchor.title = domain.domain;
      anchor.draggable = true;
      anchor.addEventListener("click", (e) => {
        if (anchor._wasDragged) { e.preventDefault(); anchor._wasDragged = false; }
      });
      anchor.addEventListener("dragstart", (e) => {
        if (panel) panel.classList.remove("open");
        dragSourceCellIndex = i;
        anchor.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(INTERNAL_DRAG_TYPE, domain.domain);
        anchor._wasDragged = true;
      });
      anchor.addEventListener("dragend", () => anchor.classList.remove("dragging"));
      const parts = domain.domain.split(".");
      const faviconDomain = parts.length > 2 ? parts.slice(-2).join(".") : domain.domain;
      const needsLabel = faviconCount[faviconDomain] > 1;

      const img = document.createElement("img");
      img.alt = domain.domain;
      img.draggable = false;

      function replaceWithLabel() {
        img.remove();
        if (!anchor.querySelector('.label')) {
          anchor.appendChild(makeLabel(domain.domain));
        }
      }

      img.onerror = replaceWithLabel;
      // Проверяем Google-заглушку (глобус 16x16) — если иконка слишком маленькая, заменяем текстом
      img.onload = () => {
        if (img.naturalWidth < 20) replaceWithLabel();
      };
      anchor.appendChild(img);

      // Быстрая иконка (Google, маленькая)
      const quickIconUrl = `https://www.google.com/s2/favicons?domain=${faviconDomain}&sz=32`;
      img.src = quickIconUrl;

      // Фоновая загрузка качественной иконки (с кэшированием)
      loadFavicon(faviconDomain).then(highQualityUrl => {
        if (highQualityUrl) {
          // Восстанавливаем img если был заменён на label
          if (!anchor.contains(img)) {
            const existingLabel = anchor.querySelector('.label');
            if (existingLabel) existingLabel.remove();
            anchor.prepend(img);
          }
          img.onload = null;
          img.src = highQualityUrl;
        } else if (!anchor.contains(img)) {
          // HQ тоже нет — оставляем label
        } else {
          // HQ нет, но быстрая иконка была заглушкой — заменяем
          if (img.naturalWidth < 20) replaceWithLabel();
        }
      });

      // Подпись домена при дублировании иконок
      if (needsLabel && !anchor.querySelector('.label')) {
        anchor.appendChild(makeLabel(domain.domain));
      }

      cell.appendChild(anchor);
    }
    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = dragSourceCellIndex !== null ? "move" : "copy";
      cell.classList.add("drag-over");
    });
    cell.addEventListener("dragleave", () => cell.classList.remove("drag-over"));
    cell.addEventListener("drop", (e) => {
      e.preventDefault();
      cell.classList.remove("drag-over");
      const targetIndex = parseInt(cell.dataset.index);
      if (dragSourceCellIndex === null) {
        handleExternalDrop(e);
        return;
      }
      e.stopPropagation();
      if (dragSourceCellIndex === targetIndex) {
        dragSourceCellIndex = null;
        return;
      }
      moveIcon(dragSourceCellIndex, targetIndex, reservedSet);
      dragSourceCellIndex = null;
    });
    grid.appendChild(cell);
  }
  const iconW = parseInt(document.getElementById('iconw')?.value || DEFAULT_SETTINGS.icon_width);
  const colsNum = parseInt(document.getElementById('cols')?.value || DEFAULT_SETTINGS.columns_num);
  recalcMaxValues(iconW, colsNum);
}

// === Загрузка качественной иконки (с кэшированием) ===
async function loadFavicon(faviconDomain) {
  if (highQualityCache.has(faviconDomain)) {
    return highQualityCache.get(faviconDomain);
  }
  const cacheKey = "fav:" + faviconDomain;
  const cached = await new Promise(resolve => chrome.storage.local.get(cacheKey, resolve));
  if (cached[cacheKey]) {
    highQualityCache.set(faviconDomain, cached[cacheKey]);
    return cached[cacheKey];
  }
  const sources = [
    `https://favicon.categorization.dev/${faviconDomain}/128`,
    `https://www.google.com/s2/favicons?domain=${faviconDomain}&sz=64`
  ];
  for (const url of sources) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const ok = await new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth >= 32);
        img.onerror = () => resolve(false);
        img.src = dataUrl;
      });
      if (ok) {
        chrome.storage.local.set({ [cacheKey]: dataUrl });
        highQualityCache.set(faviconDomain, dataUrl);
        return dataUrl;
      }
    } catch (e) {}
  }
  highQualityCache.set(faviconDomain, null);
  return null;
}

function moveIcon(fromIndex, toIndex, reservedSet) {
  getStoredSavedDomains((saved_domains) => {
    getStoredSettings((settings) => {
      if (!saved_domains) return;
      const cfg = Object.assign({}, DEFAULT_SETTINGS, settings);
      const { cols, rows, cellPx } = computeGrid(cfg.icon_width);
      const fromCol = fromIndex % cols;
      const fromRow = Math.floor(fromIndex / cols);
      let toCol = toIndex % cols;
      let toRow = Math.floor(toIndex / cols);
      if (reservedSet.has(toIndex)) {
        const usedSet = new Set(
          saved_domains.filter(d => d.visible && d.gridCol !== undefined)
            .map(d => d.gridRow * cols + d.gridCol)
        );
        const nearest = findNearestFreeCell(toCol, toRow, usedSet, reservedSet, cols, rows);
        if (!nearest) return;
        toCol = nearest.gridCol;
        toRow = nearest.gridRow;
      }
      const src = saved_domains.find(d => d.visible && d.gridCol === fromCol && d.gridRow === fromRow);
      const dst = saved_domains.find(d => d.visible && d.gridCol === toCol && d.gridRow === toRow);
      if (!src) return;
      debugLog('moveIcon', {
        fromIndex,
        toIndex,
        from: src ? { domain: src.domain, gridCol: src.gridCol, gridRow: src.gridRow } : null,
        to: dst ? { domain: dst.domain, gridCol: dst.gridCol, gridRow: dst.gridRow } : { gridCol: toCol, gridRow: toRow },
        reserved: reservedSet.has(toIndex)
      });
      if (dst) { dst.gridCol = fromCol; dst.gridRow = fromRow; }
      src.gridCol = toCol;
      src.gridRow = toRow;
      setSyncedConfig({ saved_domains: saved_domains, manualLayout: true, autoLayout: false }, () => {
        updateSliderLockState(true);
        updateDefaultBtnState();
        renderGrid();
        scheduleActiveProfileSync();
      });
    });
  });
}

function makeLabel(domain) {
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = domain;
  label.style.cssText = "font-size:0.7vw;text-align:center;word-break:break-all;padding:2px;pointer-events:none;";
  return label;
}

function findAutoLayoutCell(index, cols, cellPx, cfg) {
  const colOffset = Math.max(0, Math.floor((cols - cfg.columns_num) / 2));
  const searchForm = document.querySelector('.search-form');
  let startRow = 1;
  if (searchForm) {
    const rect = searchForm.getBoundingClientRect();
    startRow = Math.ceil(rect.bottom / cellPx);
  }
  const relCol = index % cfg.columns_num;
  const relRow = Math.floor(index / cfg.columns_num);
  const absCol = colOffset + relCol;
  const absRow = startRow + relRow;
  return { gridCol: absCol, gridRow: absRow };
}

function parseDroppedUrl(dataTransfer) {
  if (!dataTransfer) return null;
  const dragTypes = Array.from(dataTransfer.types || []);
  if (dragTypes.includes(INTERNAL_DRAG_TYPE)) return null;
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    const firstUrl = uriList
      .split('\n')
      .map(line => line.trim())
      .find(line => line && !line.startsWith('#'));
    if (firstUrl) return firstUrl;
  }
  const plainText = dataTransfer.getData('text/plain');
  if (plainText) {
    const trimmed = plainText.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return null;
}

function cellFromDropPoint(clientX, clientY) {
  const iconWidth = parseInt(document.getElementById('iconw')?.value || DEFAULT_SETTINGS.icon_width, 10);
  const { cols, rows, cellPx } = prepareGridLayoutForPlacement(iconWidth);
  const gridCol = Math.max(0, Math.min(cols - 1, Math.floor(clientX / cellPx)));
  const gridRow = Math.max(0, Math.min(rows - 1, Math.floor(clientY / cellPx)));
  return { gridCol, gridRow };
}

function handleExternalDrop(e) {
  if (dragSourceCellIndex !== null) return;
  const droppedUrl = parseDroppedUrl(e.dataTransfer);
  if (!droppedUrl) return;
  let parsed;
  try {
    parsed = new URL(droppedUrl);
  } catch (err) {
    return;
  }
  if (!parsed.hostname) return;
  const domain = parsed.hostname.replace(/^www\./, '');
  if (!domain) return;
  e.preventDefault();
  addNewDomain(
    domain,
    false,
    null,
    cellFromDropPoint(e.clientX, e.clientY),
    { x: e.clientX, y: e.clientY }
  );
}

document.addEventListener('contextmenu', (e) => {
  const cellAnchor = e.target instanceof Element
    ? e.target.closest('.cell[data-domain]')
    : null;
  const domain = cellAnchor?.dataset?.domain || null;
  chrome.runtime.sendMessage({ type: 'setContextDomain', domain }, () => void chrome.runtime.lastError);
});

function checkPendingAdd(onDone) {
  chrome.storage.local.get(['pendingAddDomain'], ({ pendingAddDomain }) => {
    if (!pendingAddDomain) {
      if (typeof onDone === 'function') onDone();
      return;
    }
    const pending = pendingAddDomain;
    chrome.storage.local.remove('pendingAddDomain', () => {
      addNewDomain(pending, true, onDone);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'hideDomain' || !message.domain) return;

  hideDomainFromGrid(message.domain, (ok) => {
    sendResponse({ ok });
  });
  return true;
});

setSliderLimits();
refreshProfileSelect();
getStoredSavedDomains((saved_domains) => {
  if (saved_domains && saved_domains.length > 0) {
    renderGrid();
    renderList(saved_domains);
    checkPendingAdd();
  } else {
    setStoredLayoutState({ autoLayout: true, manualLayout: false }, () => {
      updateSliderLockState(false);
      checkPendingAdd(() => {
        scanHistory(false, true);
      });
    });
  }
});

window.addEventListener('resize', () => {
  clearTimeout(window._resizeTimer);
  window._resizeTimer = setTimeout(() => {
    const iconW = parseInt(document.getElementById('iconw')?.value || DEFAULT_SETTINGS.icon_width);
    const colsNum = parseInt(document.getElementById('cols')?.value || DEFAULT_SETTINGS.columns_num);
    recalcMaxValues(iconW, colsNum);
    renderGrid();
  }, 200);
});

document.addEventListener('dragover', (e) => {
  if (dragSourceCellIndex !== null) return;
  const droppedUrl = parseDroppedUrl(e.dataTransfer);
  if (!droppedUrl) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('drop', (e) => {
  handleExternalDrop(e);
});

// === Живой поиск ===
const searchInput = document.getElementById('search-input');
const suggestionsBox = document.getElementById('suggestions');
const searchForm = document.getElementById('search-form');
const searchEngineSelect = document.getElementById('search-engine');
let suggestTimer = null;
let activeIndex = -1;
let currentSuggestions = [];

const ENGINES = {
  google: { action: 'https://www.google.com/search', param: 'q',    placeholder: 'Поиск в Google…' },
  yandex: { action: 'https://yandex.ru/search/',     param: 'text', placeholder: 'Поиск в Яндексе…' }
};

function applySearchEngine(engine, persist = true) {
  const cfg = ENGINES[engine] || ENGINES.google;
  searchForm.action = cfg.action;
  searchInput.name  = cfg.param;
  searchInput.placeholder = cfg.placeholder;
  searchEngineSelect.value = engine;
  if (persist) {
    setStoredSearchEngine(engine);
  }
}

searchEngineSelect.addEventListener('change', () => {
  hideSuggestions();
  applySearchEngine(searchEngineSelect.value);
  searchInput.focus();
});

// Восстанавливаем сохранённый движок при загрузке
getStoredSearchEngine((search_engine) => {
  applySearchEngine(search_engine || 'google', false);
});

searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (!q) { hideSuggestions(); return; }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 200);
});

searchInput.addEventListener('keydown', (e) => {
  if (!suggestionsBox.classList.contains('visible')) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIndex + 1, currentSuggestions.length - 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIndex - 1, -1)); }
  else if (e.key === 'Escape') { hideSuggestions(); }
  else if (e.key === 'Enter' && activeIndex >= 0) {
    e.preventDefault();
    searchInput.value = currentSuggestions[activeIndex];
    hideSuggestions();
    searchForm.submit();
  }
});

document.addEventListener('click', (e) => {
  if (!searchForm.contains(e.target)) hideSuggestions();
});

function fetchSuggestions(query) {
  const engine = searchEngineSelect.value || 'google';
  chrome.runtime.sendMessage({ type: 'suggest', query, engine }, (response) => {
    if (chrome.runtime.lastError || !response) return;
    showSuggestions(response.suggestions);
  });
}

function showSuggestions(suggestions) {
  currentSuggestions = suggestions;
  activeIndex = -1;
  suggestionsBox.innerHTML = '';
  if (!suggestions.length) { hideSuggestions(); return; }
  suggestions.forEach((text) => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.textContent = text;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      searchInput.value = text;
      hideSuggestions();
      searchForm.submit();
    });
    suggestionsBox.appendChild(item);
  });
  suggestionsBox.classList.add('visible');
  searchInput.classList.add('has-suggestions');
}

function hideSuggestions() {
  suggestionsBox.classList.remove('visible');
  searchInput.classList.remove('has-suggestions');
  activeIndex = -1;
}

function setActive(index) {
  const items = suggestionsBox.querySelectorAll('.suggestion-item');
  items.forEach(el => el.classList.remove('active'));
  activeIndex = index;
  if (index >= 0) {
    items[index].classList.add('active');
    searchInput.value = currentSuggestions[index];
  }
}
