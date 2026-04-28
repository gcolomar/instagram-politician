/* global zip, API_URL */
const BATCH_SIZE = 15;

function getApiKey() {
  const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('igaudit_session='));
  return match ? match.slice('igaudit_session='.length) : '';
}

// DOM
const dropZone      = document.getElementById('dropZone');
const fileInput     = document.getElementById('fileInput');
const analyzeBtn    = document.getElementById('analyzeBtn');
const uploadSection = document.getElementById('uploadSection');
const analysisSec   = document.getElementById('analysisSection');
const analysisStatus = document.getElementById('analysisStatus');
const reportSection = document.getElementById('reportSection');

let groups = [];

// ─── Helpers ──────────────────────────────────────────────────────────────
const totalItems   = gs => gs.reduce((n, g) => n + g.items.length, 0);
const totalFlagged = gs => gs.reduce((n, g) => n + g.results.filter(r => r.analysis?.flagged).length, 0);
const makeItem     = (id, type, text, timestamp, sender = '') => ({ id, type, text, timestamp, sender });

// Pre-filter: skip content with no text value — short messages like "hola" are kept
// intentionally, as even unanswered openers reveal contact history worth reviewing
function isTrivial(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^https?:\/\/\S+$/.test(t)) return true;
  const noEmoji = t.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
  return noEmoji.length === 0;
}

// ─── Upload ───────────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); loadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', e => loadFile(e.target.files[0]));

async function loadFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.zip')) {
    alert('Please upload the .zip file downloaded from Instagram.');
    return;
  }

  document.getElementById('dropTitle').textContent = 'Reading file index...';

  let zipReader;
  try {
    // zip.js reads only the central directory first — no media loaded into memory
    zipReader = new zip.ZipReader(new zip.BlobReader(file));
    const entries = await zipReader.getEntries();

    document.getElementById('dropTitle').textContent = 'Extracting text content...';
    groups = await parseEntries(entries);
    await zipReader.close();

    if (groups.length === 0) {
      document.getElementById('dropTitle').textContent = '❌ No content found. Is this the right file?';
      return;
    }

    const total = totalItems(groups);
    dropZone.classList.add('loaded');
    document.getElementById('dropIcon').textContent = '✅';
    document.getElementById('dropTitle').textContent = file.name;
    document.getElementById('dropHint').textContent = `${total.toLocaleString()} items found across ${groups.length} groups`;
    showCostEstimate(groups);
    analyzeBtn.disabled = false;
  } catch (err) {
    if (zipReader) await zipReader.close().catch(() => {});
    document.getElementById('dropTitle').textContent = `❌ Error: ${err.message}`;
  }
}

// ─── ZIP Parsing (streaming — media files never loaded into memory) ───────
async function parseEntries(entries) {
  const result = [];
  let id = 0;

  // Build a filename → entry map for JSON files only, skipping media
  const jsonEntries = {};
  for (const entry of entries) {
    if (entry.filename.endsWith('.json')) jsonEntries[entry.filename] = entry;
  }

  async function readJson(path) {
    const entry = jsonEntries[path];
    if (!entry) return null;
    try {
      const text = await entry.getData(new zip.TextWriter());
      return JSON.parse(fixEncoding(text));
    } catch { return null; }
  }

  // Posts
  const postItems = [];
  for (let i = 1; i <= 20; i++) {
    const data = await readJson(`content/posts_${i}.json`)
               ?? await readJson(`your_instagram_activity/content/posts_${i}.json`)
               ?? await readJson(`media/posts_${i}.json`);
    if (!data) break;
    const posts = Array.isArray(data) ? data : [data];
    for (const post of posts) {
      const caption = fixEncoding(post.title ?? post.media?.[0]?.title ?? '');
      const ts      = post.creation_timestamp ?? post.media?.[0]?.creation_timestamp;
      if (caption.trim() && !isTrivial(caption)) postItems.push(makeItem(`p${id++}`, 'post', caption, ts));
    }
  }

  // Reels (single file in some exports)
  const reelsData = await readJson('media/reels.json') ?? await readJson('your_instagram_activity/media/reels.json');
  if (reelsData) {
    const arr = Array.isArray(reelsData) ? reelsData : (reelsData.ig_reels_media ?? []);
    for (const reel of arr) {
      const caption = reel.media?.[0]?.title ?? reel.title ?? '';
      const ts      = reel.media?.[0]?.creation_timestamp ?? reel.creation_timestamp;
      if (caption.trim() && !isTrivial(caption)) postItems.push(makeItem(`p${id++}`, 'reel', caption, ts));
    }
  }

  if (postItems.length) result.push({ id: 'posts', name: 'Posts & Reels', icon: '📸', items: postItems, results: [], done: 0 });

  // Own comments
  const commentItems = [];
  for (let i = 1; i <= 10; i++) {
    const data = await readJson(`comments/post_comments_${i}.json`)
               ?? (i === 1 ? await readJson(`comments/post_comments.json`) : null)
               ?? await readJson(`your_instagram_activity/comments/post_comments_${i}.json`);
    if (!data) break;
    const arr = Array.isArray(data) ? data : (data.comments_media_comments ?? []);
    for (const c of arr) {
      const text = c.string_map_data?.Comment?.value ?? c.value ?? '';
      if (text.trim() && !isTrivial(text)) commentItems.push(makeItem(`c${id++}`, 'comment', text, c.string_map_data?.Comment?.timestamp));
    }
    if (!Array.isArray(data)) break;
  }
  if (commentItems.length) result.push({ id: 'comments', name: 'Your Comments', icon: '💬', items: commentItems, results: [], done: 0 });

  // DMs — group by conversation participant name
  const conversations = {};
  const msgEntryNames = Object.keys(jsonEntries).filter(p => /messages\/inbox\/[^/]+\/message_\d+\.json$/.test(p));

  for (const msgPath of msgEntryNames) {
    const data = await readJson(msgPath);
    if (!data?.messages) continue;

    const allParticipants = (data.participants ?? []).map(p => fixEncoding(p.name)).filter(Boolean);
    const title    = fixEncoding(data.title ?? '');
    const convName = title
      || allParticipants.slice(0, 10).join(', ') + (allParticipants.length > 10 ? ` +${allParticipants.length - 10}` : '')
      || 'Conversation';

    if (!conversations[convName]) conversations[convName] = [];
    for (const m of data.messages) {
      const text = fixEncoding(m.content ?? '');
      const sender = fixEncoding(m.sender_name ?? '');
      if (text.trim() && !isTrivial(text)) conversations[convName].push(makeItem(`m${id++}`, 'direct message', text, m.timestamp_ms ? Math.floor(m.timestamp_ms / 1000) : null, sender));
    }
  }

  for (const [name, items] of Object.entries(conversations)) {
    if (!items.length) continue;

    const senders = new Set(items.map(i => i.sender).filter(Boolean));
    const group = { id: `dm_${name}`, name, icon: '📩', items, results: [], done: 0, preFlagged: null };

    // Client-side pre-detection: all messages from one sender = no reply ever
    // Stored separately — used as fallback only if AI finds nothing in this conversation
    if (senders.size === 1 && items.length >= 2) {
      const count = items.length;
      const severity = count >= 5 ? 'high' : count >= 3 ? 'medium' : 'low';
      group.preFlagged = {
        id: `pre_${name}`,
        type: 'direct message',
        group: name,
        text: items[0].text,
        timestamp: items[0].timestamp,
        analysis: {
          flagged: true,
          severity,
          categories: ['unanswered contact'],
          reason: `Sent ${count} message${count > 1 ? 's' : ''} with no reply from the other party.`,
          recommendation: 'review',
        },
      };
    }

    result.push(group);
  }

  return result.filter(g => g.items.length > 0);
}

function fixEncoding(str) {
  if (!str) return str;
  try { return new TextDecoder().decode(Uint8Array.from(str, c => c.charCodeAt(0))); } catch { return str; }
}

// ─── Cost estimate ────────────────────────────────────────────────────────
const WINDOW_SIZE_COST = 1000; // same as WINDOW_SIZE below — defined before it

function estimateCost(gs) {
  const dms    = gs.filter(g => g.id.startsWith('dm_'));
  const nonDMs = gs.filter(g => !g.id.startsWith('dm_'));
  const nonDMItems = nonDMs.reduce((n, g) => n + g.items.length, 0);
  const nonDMCalls = Math.ceil(nonDMItems / BATCH_SIZE);
  const dmCalls    = dms.reduce((n, g) => n + Math.ceil(g.items.length / WINDOW_SIZE_COST), 0);
  const allItems   = nonDMItems + dms.reduce((n, g) => n + g.items.length, 0);
  const totalCalls = nonDMCalls + dmCalls;
  // ~30 tokens per item body + 350 tokens cached system prompt per call (paid once at launch)
  const inputTokens  = allItems * 30 + totalCalls * 350;
  const outputTokens = totalCalls * 180;
  // Haiku pricing: $0.25/M input, $1.25/M output (prompt cache saves ~90% on system prompt)
  const cost = (inputTokens * 0.00025 + outputTokens * 0.00125) / 1000;
  return { cost, allItems, totalCalls };
}

function showCostEstimate(gs) {
  const { cost, allItems, totalCalls } = estimateCost(gs);
  const el = document.getElementById('costEstimate');
  el.innerHTML = `
    <div class="cost-row"><span>Items to analyze</span><span>${allItems.toLocaleString()}</span></div>
    <div class="cost-row"><span>Bedrock API calls</span><span>${totalCalls.toLocaleString()}</span></div>
    <div class="cost-total"><span>Estimated cost</span><span>~$${cost.toFixed(2)}</span></div>
  `;
  el.classList.remove('hidden');
}

// ─── Analysis ─────────────────────────────────────────────────────────────
analyzeBtn.addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  uploadSection.classList.add('hidden');
  analysisSec.classList.remove('hidden');

  if (Notification.permission === 'default') Notification.requestPermission();

  renderGroupProgress();

  analysisStatus.textContent = `Analyzing ${totalItems(groups).toLocaleString()} items with AI...`;

  for (const group of groups) {
    await analyzeGroup(group);
  }

  const flaggedCount = totalFlagged(groups);
  analysisStatus.textContent = `Analysis complete — ${flaggedCount} item${flaggedCount !== 1 ? 's' : ''} flagged`;

  notifyDone(flaggedCount);
  renderReport();
  reportSection.classList.remove('hidden');
  reportSection.scrollIntoView({ behavior: 'smooth' });
});

function playDoneSound() {
  try {
    const ctx  = new AudioContext();
    const times = [0, 0.18, 0.36];
    const freqs = [660, 880, 1100];
    times.forEach((t, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freqs[i];
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.3);
    });
  } catch {}
}

function notifyDone(flaggedCount) {
  playDoneSound();
  if (Notification.permission === 'granted') {
    new Notification('Instagram Audit complete', {
      body: `${flaggedCount} item${flaggedCount !== 1 ? 's' : ''} flagged — review your report.`,
    });
  }
}

const WINDOW_SIZE = 1000;

async function analyzeGroup(group) {
  if (group.id.startsWith('dm_')) {
    await analyzeConversation(group);
  } else {
    await analyzeBatch(group);
  }
}

async function analyzeBatch(group) {
  for (let i = 0; i < group.items.length; i += BATCH_SIZE) {
    const batch = group.items.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': getApiKey() },
        body: JSON.stringify({ items: batch.map(item => ({ ...item, group: group.name })) }),
      });
      if (!res.ok) console.warn(`Batch ${group.name} ${i}: HTTP ${res.status}`);
      const data = await res.json();
      group.results.push(...(data.results ?? []));
    } catch (err) {
      console.warn(`Batch ${group.name} ${i} failed:`, err.message);
    }
    group.done = Math.min(i + BATCH_SIZE, group.items.length);
    updateGroupProgress(group);
  }
}

async function analyzeConversation(group) {
  let windowSummary = null;

  for (let i = 0; i < group.items.length; i += WINDOW_SIZE) {
    const window = group.items.slice(i, i + WINDOW_SIZE).map(item => ({ ...item, group: group.name }));
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': getApiKey() },
        body: JSON.stringify({ conversation: { messages: window, window_summary: windowSummary } }),
      });
      const data = await res.json();
      windowSummary = data.window_summary ?? windowSummary;
      group.results.push(...(data.results ?? []));
    } catch {
      // continue silently on network errors
    }
    group.done = Math.min(i + WINDOW_SIZE, group.items.length);
    updateGroupProgress(group);
  }

  // If AI found nothing but we detected an unanswered pattern, use it as fallback
  if (group.results.length === 0 && group.preFlagged) {
    group.results.push(group.preFlagged);
    updateGroupProgress(group);
  }
}

// ─── Progress UI ──────────────────────────────────────────────────────────
function renderGroupProgress() {
  const nonDM = groups.filter(g => !g.id.startsWith('dm_'));
  const dms   = groups.filter(g => g.id.startsWith('dm_'));

  const nonDMHtml = nonDM.map(g => `
    <div class="group-item">
      <div class="group-header">
        <span>${g.icon} ${g.name}</span>
        <span class="group-count" id="count_${g.id}">0 / ${g.items.length.toLocaleString()}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="fill_${g.id}" style="width:0%"></div></div>
      <div class="group-flagged" id="gflag_${g.id}"></div>
    </div>
  `).join('');

  const dmTotal = dms.reduce((n, g) => n + g.items.length, 0);
  const dmRows  = dms.map(g => `
    <div class="dm-row">
      <span class="dm-name" id="dmname_${g.id}">📩 ${escHtml(g.name)}</span>
      <span class="dm-count" id="count_${g.id}">0 / ${g.items.length}</span>
      <span class="dm-flag"  id="gflag_${g.id}"></span>
    </div>
  `).join('');

  const dmHtml = dms.length === 0 ? '' : `
    <div class="group-item">
      <div class="group-header">
        <span>📩 Direct Messages <span class="dm-total">${dms.length} conversations</span></span>
        <span class="group-count" id="count_dm_all">0 / ${dmTotal.toLocaleString()}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="fill_dm_all" style="width:0%"></div></div>
      <div class="group-flagged" id="gflag_dm_all"></div>
      <div class="dm-list">${dmRows}</div>
    </div>
  `;

  document.getElementById('groupProgress').innerHTML = nonDMHtml + dmHtml;
}

function updateGroupProgress(group) {
  const pct = Math.round((group.done / group.items.length) * 100);
  const countEl = document.getElementById(`count_${group.id}`);
  const fillEl  = document.getElementById(`fill_${group.id}`);

  if (countEl) countEl.textContent = `${group.done.toLocaleString()} / ${group.items.length.toLocaleString()}`;
  if (fillEl)  fillEl.style.width = `${pct}%`;
  if (fillEl && group.done >= group.items.length) fillEl.classList.add('complete');

  const flagged = group.results.filter(r => r.analysis?.flagged).length;
  const flagEl  = document.getElementById(`gflag_${group.id}`);
  if (flagEl) {
    flagEl.textContent = flagged > 0 ? `${flagged} flagged` : '';
    flagEl.style.color = 'var(--high)';
  }

  // Update the combined DM progress bar
  if (group.id.startsWith('dm_')) {
    const dms      = groups.filter(g => g.id.startsWith('dm_'));
    const dmDone   = dms.reduce((n, g) => n + g.done, 0);
    const dmTotal  = dms.reduce((n, g) => n + g.items.length, 0);
    const dmPct    = Math.round((dmDone / dmTotal) * 100);
    const dmFlag   = dms.reduce((n, g) => n + g.results.filter(r => r.analysis?.flagged).length, 0);

    const allFill  = document.getElementById('fill_dm_all');
    const allCount = document.getElementById('count_dm_all');
    const allFlag  = document.getElementById('gflag_dm_all');

    if (allFill)  { allFill.style.width = `${dmPct}%`; if (dmDone >= dmTotal) allFill.classList.add('complete'); }
    if (allCount) allCount.textContent = `${dmDone.toLocaleString()} / ${dmTotal.toLocaleString()}`;
    if (allFlag)  { allFlag.textContent = dmFlag > 0 ? `${dmFlag} flagged` : ''; allFlag.style.color = 'var(--high)'; }

    // Mark individual conversation done
    const nameEl = document.getElementById(`dmname_${group.id}`);
    if (nameEl && group.done >= group.items.length) nameEl.style.opacity = '0.5';
  }
}

// ─── Report ───────────────────────────────────────────────────────────────
function renderReport() {
  const all = groups.flatMap(g => g.results);
  const flagged = all.filter(r => r.analysis?.flagged);

  document.getElementById('reportSummary').innerHTML = `
    <div class="stat"><div class="number">${all.length.toLocaleString()}</div><div class="label">Analyzed</div></div>
    <div class="stat flagged"><div class="number">${flagged.length.toLocaleString()}</div><div class="label">Flagged</div></div>
    <div class="stat clean"><div class="number">${(all.length - flagged.length).toLocaleString()}</div><div class="label">Clean</div></div>
  `;

  let activeType = 'all';
  let activeSeverity = 'all';

  document.querySelectorAll('#typeFilters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#typeFilters .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      renderList(flagged, activeType, activeSeverity);
    });
  });

  document.querySelectorAll('#severityFilters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#severityFilters .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSeverity = btn.dataset.severity;
      renderList(flagged, activeType, activeSeverity);
    });
  });

  renderList(flagged, 'all', 'all');
}

function renderList(flagged, type, severity) {
  let items = flagged;
  if (type === 'post')    items = items.filter(r => r.type === 'post' || r.type === 'reel');
  else if (type !== 'all') items = items.filter(r => r.type === type);
  if (severity !== 'all') items = items.filter(r => r.analysis?.severity === severity);
  const list = document.getElementById('reportList');

  if (items.length === 0) {
    list.innerHTML = '<p class="empty">No items in this category</p>';
    return;
  }

  list.innerHTML = items.map(r => {
    const a = r.analysis;
    const date = r.timestamp ? new Date(r.timestamp * 1000).toLocaleDateString('es-ES') : '';
    return `
      <div class="result-card ${a.severity}">
        <div class="result-header">
          <span class="result-meta">${r.type}${date ? ` · ${date}` : ''}${r.group ? ` · ${escHtml(r.group)}` : ''}</span>
          <span class="badge-severity ${a.severity}">${severityLabel(a.severity)}</span>
        </div>
        <p class="result-text">"${escHtml(r.text)}"</p>
        ${a.reason ? `<p class="result-reason">${escHtml(a.reason)}</p>` : ''}
        ${a.categories?.length ? `<p class="result-categories">${a.categories.map(escHtml).join(' · ')}</p>` : ''}
      </div>
    `;
  }).join('');
}

function severityLabel(s) {
  return { high: 'Critical', medium: 'Medium', low: 'Low' }[s] ?? s;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Exports ──────────────────────────────────────────────────────────────
document.getElementById('exportPdf').addEventListener('click', exportPdf);
document.getElementById('exportCsv').addEventListener('click', exportCsv);

function flaggedItems() {
  return groups.flatMap(g => g.results).filter(r => r.analysis?.flagged);
}

function exportCsv() {
  const items = flaggedItems();
  const header = ['Type', 'Date', 'Conversation/Group', 'Severity', 'Text', 'Reason', 'Categories'];
  const rows = items.map(r => {
    const date = r.timestamp ? new Date(r.timestamp * 1000).toLocaleDateString('es-ES') : '';
    return [
      r.type,
      date,
      r.group ?? '',
      r.analysis.severity,
      r.text.replace(/"/g, '""'),
      (r.analysis.reason ?? '').replace(/"/g, '""'),
      (r.analysis.categories ?? []).join(', '),
    ].map(v => `"${v}"`).join(',');
  });
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `instagram-audit-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function exportPdf() {
  const btn = document.getElementById('exportPdf');
  btn.textContent = 'Loading…';
  btn.disabled = true;
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
  } catch {
    btn.textContent = 'Download PDF';
    btn.disabled = false;
    alert('Could not load PDF library. Check your internet connection.');
    return;
  }
  btn.textContent = 'Download PDF';
  btn.disabled = false;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape' });
  const items = flaggedItems();
  const dateStr = new Date().toLocaleDateString('es-ES');

  doc.setFontSize(18);
  doc.text('Instagram Content Audit', 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${dateStr} · ${items.length} flagged items`, 14, 26);

  const severityColor = { high: [220, 53, 69], medium: [255, 140, 0], low: [100, 149, 237] };

  doc.autoTable({
    startY: 32,
    head: [['Type', 'Date', 'Conversation', 'Severity', 'Text', 'Reason']],
    body: items.map(r => {
      const date = r.timestamp ? new Date(r.timestamp * 1000).toLocaleDateString('es-ES') : '';
      return [r.type, date, r.group ?? '', severityLabel(r.analysis.severity), r.text.slice(0, 120), r.analysis.reason ?? ''];
    }),
    styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [30, 30, 46], textColor: 255 },
    columnStyles: { 3: { fontStyle: 'bold' }, 4: { cellWidth: 80 }, 5: { cellWidth: 70 } },
    didDrawCell(data) {
      if (data.section === 'body' && data.column.index === 3) {
        const sev = items[data.row.index]?.analysis?.severity;
        const col = severityColor[sev];
        if (col) doc.setTextColor(...col);
      } else {
        doc.setTextColor(0);
      }
    },
  });

  doc.save(`instagram-audit-${new Date().toISOString().slice(0,10)}.pdf`);
}
