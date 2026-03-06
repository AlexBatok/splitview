/**
 * SplitView — Service Worker
 * Splits browser tabs into positioned windows using chrome.windows API.
 * No iframes, works with every website.
 *
 * Behavior: current tab stays in place, other cells get fresh empty windows.
 * This is predictable and matches what users actually want (per CWS reviews).
 */

// ── Layout definitions ──

const LAYOUTS = {
  '50-50':     { rows: 1, cols: 2 },
  '70-30':     { rows: 1, cols: 2, ratio: [0.7, 0.3] },
  '30-70':     { rows: 1, cols: 2, ratio: [0.3, 0.7] },
  '33-33-33':  { rows: 1, cols: 3 },
  'top-bottom': { rows: 2, cols: 1 },
  'grid':      { rows: 2, cols: 2 },
};

// Windows 10/11 invisible DWM shadow border compensation
const isWindows = navigator.userAgent.includes('Windows');
const SHADOW = isWindows ? { x: 7, bottom: 7 } : { x: 0, bottom: 0 };

// ── Undo state (persisted to storage to survive service worker restarts) ──

async function getUndo() {
  try {
    const data = await chrome.storage.session.get('undo');
    return data.undo || null;
  } catch {
    // session storage may not be available, fall back to local
    try {
      const data = await chrome.storage.local.get('undo');
      return data.undo || null;
    } catch { return null; }
  }
}

async function setUndo(state) {
  try {
    await chrome.storage.session.set({ undo: state });
  } catch {
    try { await chrome.storage.local.set({ undo: state }); } catch {}
  }
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'split') {
    splitTabs(msg.layout)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.action === 'undo') {
    undoSplit()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.action === 'getUndoState') {
    getUndo().then(u => sendResponse({ canUndo: !!u }));
    return true;
  }
});

// ── Keyboard shortcuts ──

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'split-undo') {
    await undoSplit();
    return;
  }
  if (command === 'split-50-50') {
    // Alt+S: use last chosen layout, not always 50-50
    const data = await chrome.storage.local.get('splitview');
    const lastLayout = data.splitview?.lastLayout || '50-50';
    await splitTabs(lastLayout);
    return;
  }
  const layoutMap = {
    'split-70-30': '70-30',
    'split-30-70': '30-70',
    'split-grid': 'grid',
  };
  if (layoutMap[command]) {
    await splitTabs(layoutMap[command]);
  }
});

// ── Context menus ──

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'split-page',
    title: 'Split this tab (50/50)',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'split-link',
    title: 'Open link in split view',
    contexts: ['link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'split-page') {
    await splitTabs('50-50');
  } else if (info.menuItemId === 'split-link' && info.linkUrl) {
    await splitWithLink(info.linkUrl, tab);
  }
});

// ── Core split logic ──

async function splitTabs(layoutName) {
  const layout = LAYOUTS[layoutName];
  if (!layout) return;

  // Get current window (must NOT be minimized)
  const currentWindow = await chrome.windows.getCurrent({ populate: true });
  if (!currentWindow) return;

  // Un-maximize first so we can set precise bounds
  if (currentWindow.state !== 'normal') {
    await chrome.windows.update(currentWindow.id, { state: 'normal' });
    // Small delay for the OS to process the state change
    await sleep(100);
  }

  const display = await getDisplayForWindow(currentWindow);
  const area = display?.workArea || {
    left: 0, top: 0,
    width: 1920, height: 1080,
  };

  const totalCells = layout.rows * layout.cols;

  // Save undo state BEFORE doing anything
  await setUndo({
    windowId: currentWindow.id,
    windowBounds: {
      left: currentWindow.left,
      top: currentWindow.top,
      width: currentWindow.width,
      height: currentWindow.height,
      state: currentWindow.state,
    },
    createdWindowIds: [], // will be filled as we create windows
  });

  // Compute cell positions
  const cellWidths = computeSizes(area.width, layout.cols, layout.ratio);
  const cellHeights = computeSizes(area.height, layout.rows, null);

  const cells = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      let left = area.left;
      for (let cc = 0; cc < c; cc++) left += cellWidths[cc];

      let top = area.top;
      for (let rr = 0; rr < r; rr++) top += cellHeights[rr];

      cells.push(compensateShadow(
        { left, top, width: cellWidths[c], height: cellHeights[r] },
        r, c, layout.rows, layout.cols
      ));
    }
  }

  // Cell 0: resize current window
  await chrome.windows.update(currentWindow.id, {
    left: cells[0].left,
    top: cells[0].top,
    width: cells[0].width,
    height: cells[0].height,
    state: 'normal',
  });

  // Cells 1..N: create new empty windows (always fresh — no tab grabbing)
  const createdIds = [];
  for (let i = 1; i < totalCells; i++) {
    const cell = cells[i];
    try {
      const win = await chrome.windows.create({
        url: 'chrome://newtab',
        left: cell.left,
        top: cell.top,
        width: cell.width,
        height: cell.height,
        focused: false,
        type: 'normal',
      });
      if (win?.id) createdIds.push(win.id);
    } catch (err) {
      console.error(`SplitView: failed to create window for cell ${i}:`, err);
    }
  }

  // Update undo with created window IDs
  const undo = await getUndo();
  if (undo) {
    undo.createdWindowIds = createdIds;
    await setUndo(undo);
  }

  // Focus the original window last
  await chrome.windows.update(currentWindow.id, { focused: true });

  // Save last layout
  await chrome.storage.local.set({
    splitview: { lastLayout: layoutName, timestamp: Date.now() },
  });
}

// ── Split with a specific link ──

async function splitWithLink(linkUrl, sourceTab) {
  const currentWindow = await chrome.windows.getCurrent();
  if (!currentWindow) return;

  if (currentWindow.state !== 'normal') {
    await chrome.windows.update(currentWindow.id, { state: 'normal' });
    await sleep(100);
  }

  const display = await getDisplayForWindow(currentWindow);
  const area = display?.workArea || {
    left: 0, top: 0, width: 1920, height: 1080,
  };

  const halfW = Math.round(area.width / 2);
  const leftCell = compensateShadow(
    { left: area.left, top: area.top, width: halfW, height: area.height },
    0, 0, 1, 2
  );
  const rightCell = compensateShadow(
    { left: area.left + halfW, top: area.top, width: area.width - halfW, height: area.height },
    0, 1, 1, 2
  );

  await setUndo({
    windowId: currentWindow.id,
    windowBounds: {
      left: currentWindow.left,
      top: currentWindow.top,
      width: currentWindow.width,
      height: currentWindow.height,
      state: currentWindow.state,
    },
    createdWindowIds: [],
  });

  await chrome.windows.update(currentWindow.id, { ...leftCell, state: 'normal' });

  try {
    const win = await chrome.windows.create({
      url: linkUrl,
      ...rightCell,
      focused: true,
      type: 'normal',
    });

    const undo = await getUndo();
    if (undo && win?.id) {
      undo.createdWindowIds = [win.id];
      await setUndo(undo);
    }
  } catch (err) {
    console.error('SplitView: failed to create link window:', err);
  }
}

// ── Undo ──

async function undoSplit() {
  const undo = await getUndo();
  if (!undo) return;

  // Close all windows we created
  for (const wid of (undo.createdWindowIds || [])) {
    try {
      await chrome.windows.remove(wid);
    } catch {} // already closed by user — fine
  }

  // Restore original window bounds
  try {
    await chrome.windows.update(undo.windowId, {
      left: undo.windowBounds.left,
      top: undo.windowBounds.top,
      width: undo.windowBounds.width,
      height: undo.windowBounds.height,
      state: 'normal',
      focused: true,
    });
  } catch (err) {
    console.error('SplitView: undo window restore failed:', err);
  }

  // If original window was maximized, re-maximize after setting bounds
  if (undo.windowBounds.state === 'maximized') {
    try {
      await chrome.windows.update(undo.windowId, { state: 'maximized' });
    } catch {}
  }

  await setUndo(null);
}

// ── Helpers ──

function computeSizes(totalSize, count, ratio) {
  const sizes = [];
  if (ratio && ratio.length === count) {
    let used = 0;
    for (let i = 0; i < count; i++) {
      const s = i < count - 1 ? Math.round(totalSize * ratio[i]) : totalSize - used;
      sizes.push(s);
      used += s;
    }
  } else {
    const base = Math.round(totalSize / count);
    for (let i = 0; i < count; i++) sizes.push(base);
    sizes[count - 1] = totalSize - base * (count - 1);
  }
  return sizes;
}

function compensateShadow(cell, row, col, rows, cols) {
  let { left, top, width, height } = cell;

  if (col > 0) {
    left -= SHADOW.x;
    width += SHADOW.x;
  }
  if (col < cols - 1) {
    width += SHADOW.x;
  }
  if (row < rows - 1) {
    height += SHADOW.bottom;
  }

  return { left, top, width, height };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getDisplayForWindow(win) {
  try {
    const displays = await chrome.system.display.getInfo();
    if (!displays || displays.length === 0) return null;

    const cx = (win.left || 0) + (win.width || 0) / 2;
    const cy = (win.top || 0) + (win.height || 0) / 2;

    for (const d of displays) {
      const a = d.workArea;
      if (cx >= a.left && cx < a.left + a.width &&
          cy >= a.top && cy < a.top + a.height) {
        return d;
      }
    }
    return displays.find(d => d.isPrimary) || displays[0];
  } catch {
    return null;
  }
}
