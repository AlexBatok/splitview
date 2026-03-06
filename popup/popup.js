const VALID_LAYOUTS = ['50-50', '70-30', '30-70', '33-33-33', 'top-bottom', 'grid'];

// Layout buttons
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const layout = btn.dataset.layout;
    try {
      await chrome.runtime.sendMessage({ action: 'split', layout });
    } catch {}
    window.close();
  });
});

// Undo button
const undoBtn = document.getElementById('btn-undo');
if (undoBtn) {
  chrome.runtime.sendMessage({ action: 'getUndoState' }, (resp) => {
    if (resp?.canUndo) undoBtn.disabled = false;
  });

  undoBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'undo' });
    } catch {}
    window.close();
  });
}

// Highlight last used layout
chrome.storage.local.get('splitview', (data) => {
  const last = data.splitview?.lastLayout;
  if (!last || !VALID_LAYOUTS.includes(last)) return;
  const btn = document.querySelector(`.layout-btn[data-layout="${last}"]`);
  if (btn) btn.classList.add('last-used');
});

// Footer links
document.getElementById('link-rate')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews` });
});
document.getElementById('link-coffee')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://alexbatok.github.io/splitview/#donate' });
});
