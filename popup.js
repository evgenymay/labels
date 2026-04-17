let currentDomain = null;

function getStoredSavedDomains(cb) {
  chrome.storage.sync.get('saved_domains', ({ saved_domains }) => {
    if (saved_domains !== undefined) {
      cb(saved_domains);
      return;
    }

    chrome.storage.local.get('saved_domains', ({ saved_domains: localSavedDomains }) => {
      if (localSavedDomains === undefined) {
        cb(null);
        return;
      }

      chrome.storage.sync.set({ saved_domains: localSavedDomains }, () => {
        chrome.storage.local.remove('saved_domains', () => cb(localSavedDomains));
      });
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab || !tab.url) { showError('Не удалось получить страницу'); return; }

  try {
    const url = new URL(tab.url);
    if (!url.hostname || url.protocol === 'chrome:' || url.protocol === 'moz-extension:' || url.protocol === 'about:') {
      showError('Системная страница');
      return;
    }
    currentDomain = url.hostname.replace(/^www\./, '');
    document.getElementById('domain').textContent = currentDomain;
    document.getElementById('domain').classList.remove('empty');

    getStoredSavedDomains((saved_domains) => {
      const existing = (saved_domains || []).find(d => d.domain === currentDomain);
      const btn = document.getElementById('add-btn');
      btn.disabled = false;
      if (existing && existing.visible) {
        btn.textContent = 'уже добавлено';
        btn.style.background = '#94a3b8';
        btn.disabled = true;
      }
    });
  } catch (e) {
    showError('Неверный URL');
  }
});

document.getElementById('add-btn').addEventListener('click', () => {
  if (!currentDomain) return;
  const btn = document.getElementById('add-btn');
  btn.disabled = true;

  chrome.storage.local.remove('pendingAddDomain', () => {
    chrome.storage.local.set({ pendingAddDomain: currentDomain }, () => {
      if (chrome.runtime.lastError) {
        btn.disabled = false;
        return;
      }

      btn.textContent = '✓ Добавлено';
      btn.style.background = '#16a34a';
    });
  });
});

function showError(msg) {
  document.getElementById('domain').textContent = msg;
  document.getElementById('domain').classList.add('empty');
}
