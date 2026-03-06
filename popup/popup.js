// Layout buttons
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const layout = btn.dataset.layout;
    chrome.runtime.sendMessage({ action: 'split', layout });
    window.close();
  });
});

// Undo button
const undoBtn = document.getElementById('btn-undo');
if (undoBtn) {
  chrome.runtime.sendMessage({ action: 'getUndoState' }, (resp) => {
    if (resp?.canUndo) undoBtn.disabled = false;
  });

  undoBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'undo' });
    window.close();
  });
}

// Highlight last used layout
chrome.storage.local.get('splitview', (data) => {
  const last = data.splitview?.lastLayout;
  if (!last) return;
  const btn = document.querySelector(`.layout-btn[data-layout="${last}"]`);
  if (btn) btn.classList.add('last-used');
});
