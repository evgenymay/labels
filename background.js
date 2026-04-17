const REMOVE_LABEL_MENU_ID = 'labels-remove-from-grid';
const EXTENSION_NEW_TAB_URL = chrome.runtime.getURL('newtab.html');
const CHROME_NEW_TAB_URL = 'chrome://newtab/';
let lastContextDomain = null;

function isManagedNewTabUrl(url) {
  return typeof url === 'string'
    && (url === EXTENSION_NEW_TAB_URL || url === CHROME_NEW_TAB_URL);
}

function logRuntimeError(contextLabel) {
  const err = chrome.runtime.lastError;
  if (!err) return;
  console.warn(`[LabelS] ${contextLabel}:`, err.message);
}

function initContextMenus() {
  if (!chrome.contextMenus) return;

  chrome.contextMenus.removeAll(() => {
    logRuntimeError('contextMenus.removeAll');
    chrome.contextMenus.create({
      id: REMOVE_LABEL_MENU_ID,
      title: 'Убрать метку с экрана',
      contexts: ['link'],
      visible: false
    }, () => logRuntimeError('contextMenus.create'));
  });
}

function updateContextMenuVisibility(tab) {
  if (!chrome.contextMenus) return;

  const isVisible = isManagedNewTabUrl(tab?.url);
  chrome.contextMenus.update(REMOVE_LABEL_MENU_ID, { visible: isVisible }, () => {
    logRuntimeError('contextMenus.update');
  });
}

function refreshContextMenuForActiveTab() {
  if (!chrome.tabs?.query) return;

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    logRuntimeError('tabs.query');
    updateContextMenuVisibility(tabs?.[0]);
  });
}

function extractDomain(urlString) {
  try {
    return new URL(urlString).hostname.replace(/^www\./, '');
  } catch (err) {
    return null;
  }
}

if (chrome.contextMenus) {
  initContextMenus();
  refreshContextMenuForActiveTab();

  chrome.runtime.onInstalled?.addListener(() => {
    initContextMenus();
    refreshContextMenuForActiveTab();
  });

  chrome.runtime.onStartup?.addListener(() => {
    initContextMenus();
    refreshContextMenuForActiveTab();
  });

  chrome.tabs?.onActivated?.addListener(() => {
    refreshContextMenuForActiveTab();
  });

  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.url !== undefined) {
      updateContextMenuVisibility(tab);
    }
  });

  chrome.windows?.onFocusChanged?.addListener(() => {
    refreshContextMenuForActiveTab();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== REMOVE_LABEL_MENU_ID) return;
    const pageUrl = info.pageUrl || tab?.url || '';
    if (!isManagedNewTabUrl(pageUrl)) return;
    const domain = lastContextDomain || extractDomain(info.linkUrl);
    if (!domain) return;
    chrome.runtime.sendMessage({ type: 'hideDomain', domain }, () => void chrome.runtime.lastError);
    lastContextDomain = null;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'setContextDomain') {
    lastContextDomain = typeof message.domain === 'string' && message.domain
      ? message.domain
      : null;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'addDomain' && message.domain) {
    const domain = message.domain;
    chrome.storage.local.remove('pendingAddDomain', () => {
      chrome.storage.local.set({ pendingAddDomain: domain }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type !== 'suggest') return;

  const query = message.query;
  if (!query || query.trim() === '') {
    sendResponse({ suggestions: [] });
    return true;
  }

  const engine = message.engine || 'google';
  const url = engine === 'yandex'
    ? `https://yandex.com/suggest/suggest-ff.cgi?part=${encodeURIComponent(query)}&uil=ru`
    : `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;

  fetch(url)
    .then(r => r.text())
    .then(text => {
      console.log('[LabelS suggest] raw:', text.slice(0, 200));
      const data = JSON.parse(text);
      const suggestions = Array.isArray(data[1]) ? data[1].slice(0, 8) : [];
      sendResponse({ suggestions });
    })
    .catch(err => {
      console.error('[LabelS suggest] error:', err);
      sendResponse({ suggestions: [] });
    });

  return true;
});
