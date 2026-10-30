'use strict';

const SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const STATUS = {
  queued: 'Sırada', analyzing: 'Analiz ediliyor', high_confidence: 'Yüksek güven',
  medium_confidence: 'Orta güven', low_confidence: 'İncele', undetected: 'Tespit edilemedi',
  error: 'Hata', confirmed: 'Onaylandı', renamed: 'Adlandırıldı'
};
const $ = id => document.getElementById(id);
const audio = $('originalAudio');

let snapshot = null;
let selectedId = null;
let activeFilter = 'all';
let showAllCandidates = false;
let selectedKeyTag = null;
let selectedNotePc = null;
let audioSourceKey = null;
let pianoSampler = null;
let pianoLoading = null;
let pollingTimer = null;
let refreshBusy = false;
let abActive = false;
let stopWaiter = null;

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function wait(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }
function timeText(value) { if (!Number.isFinite(Number(value))) return '—'; const s = Math.max(0, Math.floor(Number(value))); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2,'0')}`; }
function num(value, digits=2) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits); }
function toast(message, type='info', timeout=4000) { const el = document.createElement('div'); el.className = `toast ${type === 'success' ? '' : type}`; el.textContent = message; $('toastRegion').appendChild(el); window.setTimeout(() => el.remove(), timeout); }
async function api(url, options={}) {
  const init = {...options, headers:{...(options.headers || {})}};
  if (init.body && typeof init.body !== 'string') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(init.body); }
  let response;
  try { response = await fetch(url, init); }
  catch (_) { throw new Error('Yerel backend bağlantısı kurulamadı. Uygulamayı README içindeki komutla başlat.'); }
  const type = response.headers.get('content-type') || '';
  const data = await (type.includes('application/json') ? response.json() : response.text()).catch(() => ({}));
  if (!response.ok) throw new Error(typeof data === 'object' ? (data.detail || data.message || `HTTP ${response.status}`) : data || `HTTP ${response.status}`);
  return data;
}
function files() { return snapshot?.files || []; }
function selected() { return files().find(f => f.id === selectedId) || null; }
function currentKey() { return $('manualKeyInput').value.trim() || selectedKeyTag || selected()?.manual_key || selected()?.analysis?.tag || ''; }
function validKey(tag) { return /^[A-G](?:#|b)?m?(?:-?\d{1,2})?$/.test(String(tag || '').trim()); }
function rootName(root) { if (!root) return 'Yerel dosyalar'; return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root; }
function safeStatus(file) { if (file.renamed) return 'renamed'; if (file.confirmed) return 'confirmed'; return file.status || 'queued'; }

async function refreshState(silent=false) {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const next = await api('/api/state');
    snapshot = next;
    if (selectedId && !files().some(f => f.id === selectedId)) selectedId = null;
    if (!selectedId && files().length) selectedId = files()[0].id;
    if (document.activeElement !== $('folderPath')) $('folderPath').value = snapshot.root || $('folderPath').value;
    $('recursive').checked = !!snapshot.recursive;
    $('sidebarRootLabel').textContent = snapshot.root || 'Yerel dosyalar';
    $('sessionFolderName').textContent = snapshot.root ? rootName(snapshot.root).toUpperCase() : 'NO FOLDER SELECTED';
    renderStats(); renderProgress(); renderFileList(); renderSelected();
    if (snapshot.job?.status === 'running') startPolling();
    else stopPolling();
  } catch (error) { if (!silent) toast(error.message, 'error', 5000); }
  finally { refreshBusy = false; }
}
function startPolling() { if (pollingTimer) return; pollingTimer = window.setInterval(() => refreshState(true), 850); }
function stopPolling() { if (pollingTimer) { window.clearInterval(pollingTimer); pollingTimer = null; } }

function renderStats() {
  const s = snapshot?.summary || {};
  $('statTotal').textContent = s.total_files ?? '—';
  $('statAudio').textContent = s.audio_files ?? '—';
  $('statAnalyzed').textContent = s.analyzed ?? 0;
  $('statLow').textContent = s.low_confidence ?? 0;
  $('statConfirmed').textContent = s.confirmed ?? 0;
  $('statProgressText').textContent = `${s.detected ?? 0} sonuç bulundu`;
  $('statRenamedText').textContent = `${s.renamed ?? 0} dosya adlandırıldı`;
  $('fileCount').textContent = s.audio_files ?? 0;
}
function renderProgress() {
  const job = snapshot?.job || {};
  const total = Number(job.total || 0), processed = Number(job.processed || 0);
  const pct = total ? Math.min(100, processed / total * 100) : (job.status === 'completed' ? 100 : 0);
  $('progressBar').style.width = `${pct}%`;
  $('progressCount').textContent = `${processed} / ${total}`;
  $('progressTitle').textContent = job.status === 'running' ? 'Ses dosyaları analiz ediliyor' : job.status === 'completed' ? 'Tarama tamamlandı' : 'Klasör taraması bekleniyor';
  $('progressDetail').textContent = job.message || 'Klasör seçip “Klasörü tara” düğmesine bas.';
  document.querySelector('.progress-orb')?.classList.toggle('running', job.status === 'running');
  $('scanButton').disabled = job.status === 'running';
  $('scanButton').innerHTML = job.status === 'running' ? '<span class="button-icon">…</span> Analiz ediliyor' : '<span class="button-icon">↻</span> Klasörü tara';
}
function matchesFilter(file) {
  const q = $('fileSearch').value.trim().toLowerCase();
  if (q && !`${file.name} ${file.relative_path}`.toLowerCase().includes(q)) return false;
  if (activeFilter === 'review') return ['low_confidence','medium_confidence','undetected'].includes(file.status);
  if (activeFilter === 'confirmed') return file.confirmed || file.renamed;
  if (activeFilter === 'errors') return file.status === 'error';
  return true;
}
function renderFileList() {
  const all = files();
  const visible = all.filter(matchesFilter);
  const host = $('fileList');
  if (!visible.length) {
    host.innerHTML = `<div class="empty-list"><div class="empty-icon">${all.length ? '⌕' : '♪'}</div><strong>${all.length ? 'Eşleşen dosya yok' : 'Henüz dosya yok'}</strong><span>${all.length ? 'Arama veya filtreyi değiştir.' : 'Bir sample klasörü seçerek başla.'}</span></div>`;
    return;
  }
  host.innerHTML = visible.map(f => {
    const tag = f.manual_key || f.analysis?.tag;
    const secondary = f.analysis?.duration != null ? timeText(f.analysis.duration) : f.status === 'error' ? 'Hata' : (STATUS[f.status] || 'Bekliyor');
    return `<button class="file-row ${f.id === selectedId ? 'selected' : ''}" data-file-id="${esc(f.id)}" title="${esc(f.relative_path)}">
      <span class="file-icon">♫</span><span class="file-row-main"><span class="file-name">${esc(f.name)}</span><span class="file-sub"><span>${esc(secondary)}</span><span class="file-key">${esc(tag || '')}</span></span></span><span class="file-indicator ${esc(safeStatus(f))}" title="${esc(STATUS[safeStatus(f)] || 'Bekliyor')}"></span>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-file-id]').forEach(btn => btn.addEventListener('click', () => selectFile(btn.dataset.fileId)));
}
function selectFile(id) {
  if (abActive) stopAllAudio();
  selectedId = id; selectedKeyTag = null; selectedNotePc = null;
  renderFileList(); renderSelected();
}
function statusPill(file) {
  const status = safeStatus(file);
  $('selectedStatus').className = `status-pill ${status}`;
  $('selectedStatus').innerHTML = `<span class="status-dot"></span><span>${esc(STATUS[status] || 'Bekliyor')}</span>`;
}
function renderSelected() {
  const file = selected();
  const sourceKey = file ? `${file.id}:${file.name}` : null;
  if (sourceKey !== audioSourceKey) {
    audioSourceKey = sourceKey;
    if (file?.audio_url) { audio.src = `${file.audio_url}?v=${encodeURIComponent(file.name)}`; audio.load(); }
    else { audio.removeAttribute('src'); audio.load(); }
  }
  if (!file) {
    $('selectedFileName').textContent = 'Bir dosya seç';
    $('selectedFileMeta').textContent = 'Klasör seçildiğinde dosyalar burada görünür.';
    $('selectedStatus').className = 'status-pill'; $('selectedStatus').innerHTML = '<span class="status-dot"></span><span>Bekliyor</span>';
    $('analysisResult').innerHTML = '<div class="result-placeholder"><div class="placeholder-wave">▂ ▅ ▃ ▆ ▄ ▇ ▂ ▄ ▅</div><strong>Analiz sonucu burada görünür</strong><span>Soldaki listeden bir sample seç.</span></div>';
    $('candidateGrid').innerHTML = '<div class="candidates-empty">Analiz sonuçları bekleniyor.</div>'; $('candidateCount').textContent = '—'; $('toggleAllCandidates').hidden = true;
    if (document.activeElement !== $('manualKeyInput')) $('manualKeyInput').value = '';
    $('oldNamePreview').textContent = '—'; $('newNamePreview').textContent = '—';
    $('confirmKeyButton').disabled = true; $('renameCurrentButton').disabled = true;
    $('playReferenceButton').disabled = true; $('playOriginalButton').disabled = true; $('abButton').disabled = true;
    $('compareHint').textContent = 'Önce bir klasör tara ve sample seç.';
    renderNotes(null); updateReferenceLabel(); return;
  }
  $('selectedFileName').textContent = file.name;
  const a = file.analysis;
  $('selectedFileMeta').innerHTML = `<span>${esc(file.relative_path)}</span><span>${timeText(a?.duration ?? file.duration)}</span><span>${a?.sample_rate ? `${(a.sample_rate / 1000).toFixed(1)} kHz` : 'Sample rate —'}</span>`;
  statusPill(file);
  renderAnalysis(file); renderCandidates(file); renderNotes(a);
  if (document.activeElement !== $('manualKeyInput')) $('manualKeyInput').value = file.manual_key || selectedKeyTag || a?.tag || '';
  updateRenamePreview();
  const ready = !!a && !file.error;
  $('confirmKeyButton').disabled = !ready || !validKey($('manualKeyInput').value.trim());
  $('renameCurrentButton').disabled = !ready || !file.confirmed || !file.manual_key || file.renamed || $('manualKeyInput').value.trim() !== file.manual_key;
  $('playReferenceButton').disabled = !ready;
  $('playOriginalButton').disabled = false;
  $('abButton').disabled = !ready;
  $('compareHint').textContent = file.status === 'low_confidence' ? 'Bu sonuç belirsiz. En iyi adayları dinle ve tonaliteyi kendi kulağınla doğrula.' : 'Piyano referansını ve orijinal sample’ı ayrı ayrı dinleyebilir veya sırayla karşılaştırabilirsin.';
  updateReferenceLabel();
}
function renderAnalysis(file) {
  const a = file.analysis;
  if (file.error) { $('analysisResult').innerHTML = `<div class="result-message error"><strong>Analiz hatası</strong><br>${esc(file.error)}</div>`; return; }
  if (!a) {
    $('analysisResult').innerHTML = `<div class="result-placeholder"><div class="placeholder-wave">▂ ▅ ▃ ▆ ▄ ▇ ▂ ▄ ▅</div><strong>${file.status === 'analyzing' ? 'Dosya analiz ediliyor' : 'Analiz bekleniyor'}</strong><span>Sonuç hazır olduğunda burada görünür.</span></div>`; return;
  }
  const isPitch = a.kind === 'pitch';
  const scoreName = isPitch ? 'Spektral tepe belirginliği' : 'Pearson korelasyonu';
  const scoreValue = isPitch ? (a.pitch_peak_db == null ? '—' : `${num(a.pitch_peak_db,1)} dB`) : num(a.correlation,3);
  const marginValue = isPitch ? (a.frequency_hz == null ? '—' : `${num(a.frequency_hz,1)} Hz`) : num(a.margin,3);
  const headline = isPitch ? 'Tek nota tahmini' : a.tag ? `${a.tonic || ''} ${a.key_mode === 'minor' ? 'Minor' : 'Major'}` : 'Tonalite tespit edilemedi';
  const warning = ['low_confidence','undetected'].includes(a.status);
  $('analysisResult').innerHTML = `<div class="result-topline"><div class="key-hero">${esc(a.tag || '—')}</div><div class="result-copy"><strong>${esc(headline)}</strong><span>${esc(STATUS[a.status] || 'Belirsiz')} · ${isPitch ? 'Pitch analizi' : 'Tonalite analizi'}</span></div></div>
    <div class="result-metrics"><div class="result-metric"><span>${scoreName}</span><strong>${scoreValue}</strong></div><div class="result-metric"><span>${isPitch ? 'Temel frekans' : 'İlk 2 aday farkı'}</span><strong>${marginValue}</strong></div><div class="result-metric"><span>Analiz modu</span><strong>${esc(a.mode?.toUpperCase() || '—')}</strong></div></div>
    <div class="result-message ${warning ? 'warning' : ''}">${esc(a.message || '')} Skorlar kalibre edilmiş doğruluk yüzdesi değildir.</div>`;
}
function rankClass(index, total) {
  const r = total <= 1 ? 0 : index / (total - 1);
  return r < .12 ? 'rank-green' : r < .3 ? 'rank-yellow' : r < .58 ? 'rank-orange' : 'rank-red';
}
function renderCandidates(file) {
  const a = file?.analysis; const list = a?.candidates || []; const host = $('candidateGrid');
  if (!list.length) {
    host.innerHTML = `<div class="candidates-empty">${file?.error ? 'Analiz hatası nedeniyle aday yok.' : 'Tonal aday üretilemedi. 12 nota referansını dinleyerek manuel değerlendirme yapabilirsin.'}</div>`;
    $('candidateCount').textContent = '0'; $('toggleAllCandidates').hidden = true; return;
  }
  const shown = showAllCandidates ? list : list.slice(0, Math.min(a.kind === 'pitch' ? 5 : 6, list.length));
  $('candidateCount').textContent = a.kind === 'pitch' ? `${list.length} nota` : '24';
  $('toggleAllCandidates').hidden = list.length <= Math.min(a.kind === 'pitch' ? 5 : 6, list.length);
  $('toggleAllCandidates').textContent = showAllCandidates ? 'Daha az göster ↑' : `Tüm ${a.kind === 'pitch' ? 'notaları' : '24 adayı'} göster ↗`;
  host.innerHTML = shown.map((c, i) => {
    const selected = (selectedKeyTag || $('manualKeyInput').value.trim() || file.manual_key) === c.tag;
    const pitch = a.kind === 'pitch';
    const score = pitch ? `${Math.round(Number(c.score || 0) * 100)}%` : num(c.score,3);
    return `<button class="candidate-button ${rankClass(i,list.length)} ${selected ? 'selected' : ''}" data-candidate-tag="${esc(c.tag)}" title="${esc(c.label || c.tag)} adayını seç ve referansını dinle"><span class="rank-dot"></span><span class="candidate-labels"><strong>${esc(c.tag)}</strong><span>${esc(c.label || c.tag)}</span></span><span class="candidate-score">${score}<small>${pitch ? 'Göreli enerji' : 'Korelasyon'}</small></span></button>`;
  }).join('');
  host.querySelectorAll('[data-candidate-tag]').forEach(btn => btn.addEventListener('click', async () => {
    selectedKeyTag = btn.dataset.candidateTag;
    $('manualKeyInput').value = selectedKeyTag;
    updateRenamePreview(); renderCandidates(selected()); updateReferenceLabel();
    $('confirmKeyButton').disabled = !selected()?.analysis || !validKey(selectedKeyTag);
    try { await playReference(selectedKeyTag); } catch (error) { toast(error.message, 'error', 5000); }
  }));
}
function renderNotes(analysis) {
  const names = $('flatsToggle').checked ? FLAT : SHARP;
  const rank = new Map((analysis?.note_candidates || []).map((c, i) => [SHARP.indexOf(c.tag), i]));
  $('noteGrid').innerHTML = names.map((name, pc) => {
    const r = rank.get(pc);
    const isBlack = SHARP[pc].includes('#');
    return `<button class="note-button ${isBlack ? 'black-note' : ''} ${r != null && r < 3 ? 'top-note' : ''} ${selectedNotePc === pc ? 'selected' : ''}" data-note-pc="${pc}" title="${name}${$('referenceOctave').value} piyano notasını dinle"><span>${name}</span><span class="note-dot"></span></button>`;
  }).join('');
  $('noteGrid').querySelectorAll('[data-note-pc]').forEach(btn => btn.addEventListener('click', async () => {
    selectedNotePc = Number(btn.dataset.notePc);
    renderNotes(selected()?.analysis);
    const chosenName = names[selectedNotePc];
    $('referenceLabel').textContent = `${chosenName}${$('referenceOctave').value} · tek nota`;
    try { await playPianoNote(selectedNotePc, Number($('referenceOctave').value)); } catch (error) { toast(error.message, 'error', 5000); }
  }));
}
function stripTag(stem) {
  const bracket = stem.replace(/\s*\[[A-G](?:#|b)?(?:m|-?\d{1,2})?\]$/, '');
  if (bracket !== stem) return bracket;
  return stem.replace(/(?:^|[_\-\s(])([A-G](?:#|b)?(?:m|min|maj|minor|major)?-?\d?\)?)$/i, '').replace(/[_\-\s.]+$/, '');
}
function updateRenamePreview() {
  const file = selected(); const key = $('manualKeyInput').value.trim();
  $('oldNamePreview').textContent = file?.name || '—';
  if (!file || !key || !validKey(key)) { $('newNamePreview').textContent = file ? 'Key etiketi bekleniyor' : '—'; }
  else {
    const dot = file.name.lastIndexOf('.');
    let stem = dot > 0 ? file.name.slice(0,dot) : file.name;
    const ext = dot > 0 ? file.name.slice(dot) : '';
    if ($('forceRename').checked) stem = stripTag(stem) || stem;
    $('newNamePreview').textContent = `${stem} [${key}]${ext}`;
  }
  $('confirmKeyButton').disabled = !file?.analysis || !validKey(key);
  $('renameCurrentButton').disabled = !file?.analysis || !file.confirmed || !file.manual_key || file.renamed || key !== file.manual_key;
}
function updateReferenceLabel() {
  const file = selected();
  const tag = $('manualKeyInput').value.trim() || selectedKeyTag || file?.analysis?.tag || 'Seçilen key';
  $('referenceLabel').textContent = `${tag} · ${$('referenceOctave').value}. oktav`;
}

async function chooseFolder() {
  $('browseButton').disabled = true;
  try {
    const result = await api('/api/browse-folder', {method:'POST', body:{initial_folder:$('folderPath').value.trim() || null}});
    if (result.folder) $('folderPath').value = result.folder;
  } catch (error) { toast(error.message, 'error', 5000); }
  finally { $('browseButton').disabled = false; }
}
async function scanFolder() {
  const folder = $('folderPath').value.trim();
  if (!folder) { toast('Önce klasör yolu gir veya “Klasör seç” düğmesini kullan.', 'error'); return; }
  stopAllAudio();
  $('scanButton').disabled = true;
  try {
    const result = await api('/api/scan', {method:'POST', body:{
      folder, recursive:$('recursive').checked, mode:$('modeSelect').value,
      oneshot_max:Number($('oneshotMax').value || 4), min_key_corr:Number($('minKeyCorr').value || .6),
      min_key_margin:Number($('minKeyMargin').value || .025), min_pitch_db:25,
      flats:$('flatsToggle').checked, octave:false
    }});
    selectedId = null; selectedKeyTag = null; selectedNotePc = null; audioSourceKey = null;
    await refreshState(true);
    toast(`${result.audio_files} ses dosyası bulundu; toplam ${result.total_files} dosya tarandı.`, 'success');
    if (result.audio_files === 0) toast('Seçili klasörde desteklenen ses dosyası yok.', 'info');
  } catch (error) { toast(error.message, 'error', 5000); }
  finally { $('scanButton').disabled = false; await refreshState(true); }
}
async function confirmSelectedKey() {
  const file = selected(); if (!file) return;
  const key = $('manualKeyInput').value.trim();
  if (!validKey(key)) { toast('Key biçimi tanınmadı. Ör. D, Dm, F# veya F#1 kullan.', 'error'); return; }
  try {
    await api(`/api/files/${encodeURIComponent(file.id)}/review`, {method:'PATCH', body:{key, confirmed:true}});
    selectedKeyTag = key;
    await refreshState(true);
    toast(`${file.name}: ${key} etiketi onaylandı.`, 'success');
  } catch (error) { toast(error.message, 'error', 5000); }
}
async function renameSelected() {
  const file = selected(); if (!file) return;
  const key = $('manualKeyInput').value.trim();
  if (!file.confirmed || key !== file.manual_key) { toast('Önce mevcut key değerini onayla.', 'error'); return; }
  const preview = $('newNamePreview').textContent;
  if (!window.confirm(`Dosya yeniden adlandırılsın mı?\n\n${file.name}\n→ ${preview}`)) return;
  try {
    const result = await api(`/api/files/${encodeURIComponent(file.id)}/rename`, {method:'POST', body:{force:$('forceRename').checked}});
    audioSourceKey = null; await refreshState(true);
    toast(`Yeniden adlandırıldı: ${String(result.new).split(/[\\/]/).pop()}`, 'success');
  } catch (error) { toast(error.message, 'error', 5000); }
}
async function renameConfirmed() {
  const count = files().filter(f => f.confirmed && f.manual_key && !f.renamed).length;
  if (!count) { toast('Önce en az bir key etiketini onayla.', 'error'); return; }
  if (!window.confirm(`${count} onaylı dosya yeniden adlandırılacak. Hedef dosyaların üzerine yazılmaz. Devam edilsin mi?`)) return;
  try {
    const result = await api('/api/rename/bulk', {method:'POST', body:{force:$('forceRename').checked}});
    audioSourceKey = null; await refreshState(true);
    toast(`${result.count} dosya adlandırıldı; ${result.skipped.length} dosya atlandı.`, result.skipped.length ? 'info' : 'success', 5500);
    if (result.skipped.length) console.warn('Atlanan dosyalar:', result.skipped);
  } catch (error) { toast(error.message, 'error', 5000); }
}
async function undoRenames() {
  if (!window.confirm('İşlem günlüğündeki geri alınabilir yeniden adlandırmaları geri almak istiyor musun? Çakışma varsa işlem atlanır.')) return;
  try {
    const result = await api('/api/undo', {method:'POST', body:{}});
    audioSourceKey = null; await refreshState(true);
    toast(`${result.count} işlem geri alındı; ${result.skipped.length} işlem atlandı.`, result.skipped.length ? 'info' : 'success', 5500);
    if (result.skipped.length) console.warn('Geri alınamayan işlemler:', result.skipped);
  } catch (error) { toast(error.message, 'error', 5000); }
}

function pitchClass(name) {
  const simple = String(name || '').replace(/-?\d+$/, '').replace(/m$/, '');
  const lookup = {'C':0,'B#':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'Fb':4,'E#':5,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11,'Cb':11};
  return lookup[simple] ?? 0;
}
function parseTag(tag) {
  const m = String(tag || '').match(/^([A-G](?:#|b)?)(m?)(-?\d{1,2})?$/);
  if (!m) return null;
  return {root:m[1], minor:m[2] === 'm', octave:m[3] == null ? null : Number(m[3]), pc:pitchClass(m[1])};
}
function midiName(midi) { return `${SHARP[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`; }
function tagNotes(tag, forceType=null) {
  const p = parseTag(tag); if (!p) return null;
  const octave = p.octave == null ? Number($('referenceOctave').value || 4) : p.octave;
  const rootMidi = (octave + 1) * 12 + p.pc;
  let type = forceType || $('referenceType').value;
  if (type === 'auto') type = selected()?.analysis?.kind === 'pitch' ? 'note' : 'chord';
  if (type === 'note') return [midiName(rootMidi)];
  const intervals = p.minor ? [0,3,7] : [0,4,7];
  return intervals.map(n => midiName(rootMidi + n));
}
async function ensurePiano() {
  if (pianoSampler) return pianoSampler;
  if (pianoLoading) return pianoLoading;
  pianoLoading = (async () => {
    if (!window.Tone) throw new Error('Tone.js yüklenemedi. Piyano referansı için internet bağlantısını kontrol et.');
    await window.Tone.start();
    $('pianoStatus').textContent = 'Piyano örnekleri yükleniyor…';
    const urls = {A0:'A0.mp3',C1:'C1.mp3','D#1':'Ds1.mp3','F#1':'Fs1.mp3',A1:'A1.mp3',C2:'C2.mp3','D#2':'Ds2.mp3','F#2':'Fs2.mp3',A2:'A2.mp3',C3:'C3.mp3','D#3':'Ds3.mp3','F#3':'Fs3.mp3',A3:'A3.mp3',C4:'C4.mp3','D#4':'Ds4.mp3','F#4':'Fs4.mp3',A4:'A4.mp3',C5:'C5.mp3','D#5':'Ds5.mp3','F#5':'Fs5.mp3',A5:'A5.mp3',C6:'C6.mp3','D#6':'Ds6.mp3','F#6':'Fs6.mp3',A6:'A6.mp3',C7:'C7.mp3','D#7':'Ds7.mp3','F#7':'Fs7.mp3',A7:'A7.mp3',C8:'C8.mp3'};
    pianoSampler = new window.Tone.Sampler({urls, release:1, baseUrl:'https://tonejs.github.io/audio/salamander/'}).toDestination();
    await window.Tone.loaded();
    $('pianoStatus').textContent = 'Örnek tabanlı piyano · Salamander Grand Piano';
    return pianoSampler;
  })().catch(error => { pianoSampler = null; $('pianoStatus').textContent = 'Piyano yüklenemedi · interneti kontrol et.'; throw error; }).finally(() => { pianoLoading = null; });
  return pianoLoading;
}
async function playPianoNote(pc, octave) {
  stopAllAudio(); await ensurePiano(); await window.Tone.start();
  const name = midiName((Number(octave) + 1) * 12 + Number(pc));
  pianoSampler.triggerAttackRelease(name, 1.15);
  const display = ($('flatsToggle').checked ? FLAT : SHARP)[pc];
  $('pianoStatus').textContent = `Piyano referansı hazır · ${display}${octave}`;
}
async function playReference(tag=null, fromAB=false) {
  const file = selected(); const useTag = tag || $('manualKeyInput').value.trim() || selectedKeyTag || file?.analysis?.tag;
  if (!useTag) throw new Error('Önce bir nota veya key adayı seç.');
  if (!fromAB) stopAllAudio();
  await ensurePiano(); await window.Tone.start();
  const notes = tagNotes(useTag);
  if (!notes) throw new Error('Bu key/nota etiketi için piyano referansı üretilemedi.');
  const type = $('referenceType').value === 'auto' ? (file?.analysis?.kind === 'pitch' ? 'note' : 'chord') : $('referenceType').value;
  const now = window.Tone.now() + 0.03;
  if (type === 'arpeggio') notes.forEach((note, i) => pianoSampler.triggerAttackRelease(note, '8n', now + i * 0.28));
  else pianoSampler.triggerAttackRelease(notes, type === 'note' ? 1.2 : 1.65, now);
  $('referenceLabel').textContent = `${useTag} · ${type === 'note' ? 'kök nota' : type === 'arpeggio' ? 'arpej' : 'akor'}`;
  return type === 'arpeggio' ? 1500 : type === 'note' ? 1350 : 1800;
}
function resolveABWait() { if (stopWaiter) { const finish = stopWaiter; stopWaiter = null; finish(); } }
function stopAllAudio() {
  abActive = false;
  audio.pause();
  resolveABWait();
  if (pianoSampler) { try { pianoSampler.releaseAll(); } catch (_) {} }
  $('abButton').innerHTML = '⇄ <span>Referans + sample dinle</span>';
}
async function playOriginal() {
  stopAllAudio(); if (!audio.src) throw new Error('Önce bir sample seç.');
  audio.currentTime = 0; await audio.play();
}
function waitForSampleEnd() {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; audio.removeEventListener('ended', finish); audio.removeEventListener('error', finish); if (stopWaiter === finish) stopWaiter = null; resolve(); };
    stopWaiter = finish; audio.addEventListener('ended', finish, {once:true}); audio.addEventListener('error', finish, {once:true});
  });
}
async function runAB() {
  if (abActive) { stopAllAudio(); return; }
  const file = selected(); const tag = $('manualKeyInput').value.trim() || selectedKeyTag || file?.analysis?.tag;
  if (!file || !tag) { toast('A/B karşılaştırma için sample ve nota/key seç.', 'error'); return; }
  if (!audio.src) { toast('Orijinal sample kaynağı hazır değil.', 'error'); return; }
  abActive = true; $('abButton').innerHTML = '■ <span>Karşılaştırmayı durdur</span>';
  try {
    do {
      if (!abActive) break;
      const duration = await playReference(tag, true);
      await wait(duration + 250);
      if (!abActive || selected()?.id !== file.id) break;
      audio.currentTime = 0; await audio.play(); await waitForSampleEnd();
      if (!$('repeatAB').checked) break;
      await wait(350);
    } while (abActive && $('repeatAB').checked && selected()?.id === file.id);
  } catch (error) { if (abActive) toast(error.message, 'error', 5000); }
  finally { abActive = false; resolveABWait(); $('abButton').innerHTML = '⇄ <span>Referans + sample dinle</span>'; }
}

function bindEvents() {
  $('browseButton').addEventListener('click', chooseFolder);
  $('scanButton').addEventListener('click', scanFolder);
  $('refreshButton').addEventListener('click', () => refreshState());
  $('bulkRenameButton').addEventListener('click', renameConfirmed);
  $('undoButton').addEventListener('click', undoRenames);
  $('confirmKeyButton').addEventListener('click', confirmSelectedKey);
  $('renameCurrentButton').addEventListener('click', renameSelected);
  $('playReferenceButton').addEventListener('click', () => playReference().catch(e => toast(e.message,'error',5000)));
  $('playOriginalButton').addEventListener('click', () => playOriginal().catch(e => toast(e.message,'error',5000)));
  $('abButton').addEventListener('click', runAB);
  $('stopAudioButton').addEventListener('click', stopAllAudio);
  $('fileSearch').addEventListener('input', renderFileList);
  $('folderPath').addEventListener('keydown', e => { if (e.key === 'Enter') scanFolder(); });
  $('filterTabs').querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    $('filterTabs').querySelectorAll('.filter-tab').forEach(tab => tab.classList.toggle('active', tab === btn));
    renderFileList();
  }));
  $('toggleAllCandidates').addEventListener('click', () => { showAllCandidates = !showAllCandidates; renderCandidates(selected()); });
  $('manualKeyInput').addEventListener('input', () => { selectedKeyTag = $('manualKeyInput').value.trim() || null; updateRenamePreview(); updateReferenceLabel(); renderCandidates(selected()); });
  $('forceRename').addEventListener('change', updateRenamePreview);
  $('referenceOctave').addEventListener('change', () => { updateReferenceLabel(); renderNotes(selected()?.analysis); });
  $('referenceType').addEventListener('change', updateReferenceLabel);
  $('flatsToggle').addEventListener('change', () => renderNotes(selected()?.analysis));
  $('helpButton').addEventListener('click', () => $('infoDialog').showModal());
  $('closeInfoButton').addEventListener('click', () => $('infoDialog').close());
  $('closeInfoButtonBottom').addEventListener('click', () => $('infoDialog').close());
  audio.addEventListener('error', () => { if (audio.src) toast('Tarayıcı bu ses dosyasını çözemedi; codec desteğini veya dosyayı kontrol et.', 'error', 5000); });
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('fileSearch').focus(); } if (e.key === 'Escape' && abActive) stopAllAudio(); });
}

bindEvents();
renderNotes(null);
refreshState();
