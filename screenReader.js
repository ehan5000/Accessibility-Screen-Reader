// Screen Reader Simulation — Ehan Hassan

// ---------- Element refs ----------
const fileUpload          = document.getElementById('fileUpload');
const contentFrame        = document.getElementById('contentFrame'); // <iframe>
const screenReaderOutput  = document.getElementById('screenReaderOutput');
const playBtn             = document.getElementById('playBtn');
const pauseBtn            = document.getElementById('pauseBtn');
const resumeBtn           = document.getElementById('resumeBtn');
const stopBtn             = document.getElementById('stopBtn');
const speedControl        = document.getElementById('speedControl');

// ---------- Speech engine ----------
const synth = window.speechSynthesis;

// ---------- Language/voice selection ----------
let selectedLang  = 'en';   // 'en' or 'fr'
let selectedVoice = null;
let voicesLoaded  = false;

// Prefer good voices when available
const VOICE_PREFERENCES = {
  en: [
    'Google US English', 'Google UK English Female', 'Google UK English Male',
    'Microsoft David', 'Microsoft Mark', 'Microsoft Zira',
    'English (United States)', 'en-US'
  ],
  fr: [
    'Google français', 'Google français du Canada',
    'Microsoft Claude', 'Microsoft Caroline', 'Microsoft Hortense',
    'French (Canada)', 'French (France)', 'fr-CA', 'fr-FR'
  ]
};

function loadVoices() {
  return new Promise(resolve => {
    const tryLoad = () => {
      const v = synth.getVoices();
      if (v && v.length) {
        voicesLoaded = true;
        resolve(v);
      } else {
        // voices load async in some browsers
        setTimeout(tryLoad, 100);
      }
    };
    tryLoad();
  });
}

function pickBestVoice(allVoices, langCode) {
  // Try named preferences first
  for (const pref of VOICE_PREFERENCES[langCode]) {
    const found = allVoices.find(v =>
      (v.name && v.name.toLowerCase().includes(pref.toLowerCase())) ||
      (v.lang && v.lang.toLowerCase().includes(pref.toLowerCase()))
    );
    if (found) return found;
  }
  // Then any voice whose lang starts with our code
  const direct = allVoices.find(v => (v.lang || '').toLowerCase().startsWith(langCode));
  if (direct) return direct;
  // Then any voice containing our code
  return allVoices.find(v => (v.lang || '').toLowerCase().includes(langCode)) || null;
}

function detectDocLang(doc, plainText) {
  // 1) <html lang="...">
  const htmlLang = (doc.documentElement.getAttribute('lang') || '').trim().toLowerCase();
  if (htmlLang.startsWith('fr')) return 'fr';
  if (htmlLang.startsWith('en')) return 'en';

  // 2) meta http-equiv="content-language"
  const meta = doc.querySelector('meta[http-equiv="content-language"]');
  const metaLang = meta ? (meta.content || '').trim().toLowerCase() : '';
  if (metaLang.startsWith('fr')) return 'fr';
  if (metaLang.startsWith('en')) return 'en';

  // 3) Tiny heuristic on text content
  const sample = (plainText || '').slice(0, 8000).toLowerCase();
  const frHits = (sample.match(/\b(le|la|les|des|de|du|un|une|et|avec|pour|sur|au|aux)\b/g) || []).length;
  const enHits = (sample.match(/\b(the|and|with|for|to|of|in|on|by|from)\b/g) || []).length;
  if (frHits > enHits * 1.3) return 'fr';
  return 'en';
}

async function setLanguageAndVoice(doc, plainText) {
  selectedLang = detectDocLang(doc, plainText) === 'fr' ? 'fr' : 'en';
  const allVoices = voicesLoaded ? synth.getVoices() : await loadVoices();
  selectedVoice = pickBestVoice(allVoices, selectedLang);
}

function applyVoice(u) {
  u.lang = selectedLang === 'fr' ? 'fr-CA' : 'en-US'; // sensible defaults
  if (selectedVoice) u.voice = selectedVoice;
}

// ---------- State ----------
let frameDoc = null;            // iframe's document
let fullText = '';              // exact text buffer rendered in the iframe (word/space spans)
let spokenText = '';            // buffer with expansions applied (abbr/aria/emphasis/negatives)
let spokenToOriginal = [];      // spoken char -> original char mapping

// Transcript 
let tSpans = [];
let tCharToSpan = [];
let tSpanStart = [];

// Web content (iframe) spans
let wSpans = [];                // word/space spans inside the iframe
let lastContentHighlight = null;

// Navigation caches (inside iframe)
let abbrNodes = [], abbrTitles = [], abbrStarts = [], abbrIndex = 0;
let headingNodes = [], headingTitles = [], headingStarts = [], headingIndex = 0;
let ariaNodes = [], ariaLabels = [], ariaStarts = [];

// Playback pointer
let lastOriginalIdx = 0;

// ---------- Utilities ----------

// --- Content theme (Ontario-ish) for the iframe ---
function injectContentTheme(doc) {
  const style = doc.createElement('style');
  style.textContent = `
    /* Base text */
    html { font-size: 16px; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans",
           "Helvetica Neue", Arial, "Apple Color Emoji","Segoe UI Emoji";
           color:#111827; line-height:1.55; }
    p { margin: .5rem 0 1rem; }
    a { color:#0a66cc; text-decoration: underline; text-underline-offset: 2px; }
    a:hover { text-decoration-thickness: 2px; }

    /* Headings (sizes tuned to your screenshot) */
    h1, h2, h3, h4, h5, h6 { font-weight:800; line-height:1.25; margin:1.25rem 0 .5rem; }
    h1 { font-size: 1.85rem; }
    h2 { font-size: 1.6rem;  border-top: 3px solid #e5e7eb; padding-top: 1rem; }
    h3 { font-size: 1.35rem; }
    h4 { font-size: 1.15rem; }
    h5 { font-size: 1rem; }
    h6 { font-size: .9rem; }

    /* Lists */
    ul, ol { padding-left: 1.5rem; margin: .25rem 0 1rem; }
    li { margin: .15rem 0; }

    /* Tables (Ontario look) */
    .sr-table-scroll { overflow:auto; -webkit-overflow-scrolling:touch; }
    table { width:100%; border-collapse:collapse; margin: 1rem 0; font-size:.95rem; background:#fff; }
    caption { text-align:left; font-weight:700; margin-bottom:.5rem; }
    thead th {
      padding:.75rem 1rem; border-bottom:3px solid #111827; font-weight:700; vertical-align:bottom;
      background:#fff;
    }
    tbody th, tbody td { padding:.65rem 1rem; vertical-align:top; border-top:1px solid #e5e7eb; }
    tbody tr:nth-child(even) { background:#fafafa; }
    th[scope="row"] { font-weight:600; }

    /* HR & fine print */
    hr { border:0; border-top:1px solid #e5e7eb; margin:1.25rem 0; }
    small, .fineprint { color:#6b7280; font-size:.85rem; }
  `;
  doc.head.appendChild(style);
}

// Wrap every table in a horizontal scroll container
function wrapTablesForScroll(doc) {
  doc.querySelectorAll('table').forEach(t => {
    if (t.closest('.sr-table-scroll')) return;
    const wrap = doc.createElement('div');
    wrap.className = 'sr-table-scroll';
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });
}

function injectStyles(doc) {
  const style = doc.createElement('style');
  style.textContent = `
    .sr-highlight { background: #bfdbfe; border-radius: .2rem; transition: background .1s linear; }
    .sr-focus     { background: #fde68a; }
    .sr-outline   { outline: 2px dashed #3b82f6; outline-offset: 2px; }
  `;
  doc.head.appendChild(style);
}

// Wrap text nodes into (word|space) spans carrying global char offsets.
// Skips SCRIPT/STYLE/NOSCRIPT/IFRAME/OBJECT content.
function wrapIntoWordSpans(doc, root) {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const list = [];
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentNode && n.parentNode.tagName;
    if (p && /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT)$/i.test(p)) continue;
    if (!n.nodeValue) continue;
    list.push(n);
  }

  const spans = [];
  let buffer = '';

  list.forEach(textNode => {
    const frag = doc.createDocumentFragment();
    const parts = textNode.nodeValue.split(/(\s+)/); // keep spaces as tokens
    parts.forEach(tok => {
      if (!tok) return;
      const sp = doc.createElement('span');
      sp.textContent = tok;
      sp.dataset.start = buffer.length;
      buffer += tok;
      sp.dataset.end = buffer.length;
      frag.appendChild(sp);
      spans.push(sp);
    });
    textNode.parentNode.replaceChild(frag, textNode);
  });

  return { spans, buffer };
}

// Start offset for an element based on first word/span inside it.
function elementStartOffset(el) {
  const first = el.querySelector('span[data-start]');
  return first ? Number(first.dataset.start) : -1;
}

// Spoken buffer builder: splice in replacements (title) at given offsets.
function buildSpokenFromExpansions(expansions) {
  let cursor = 0;
  spokenText = '';
  spokenToOriginal = [];

  const seq = [...expansions].sort((a,b) => a.off - b.off);
  seq.push({ off: fullText.length, disp: '', title: '' }); // sentinel

  for (const { off, disp, title } of seq) {
    while (cursor < off) { // raw until expansion
      spokenText += fullText[cursor];
      spokenToOriginal.push(cursor);
      cursor++;
    }
    for (const ch of title) { // insert spoken replacement
      spokenText += ch;
      spokenToOriginal.push(cursor);
    }
    cursor += disp.length; // skip displayed token
  }
}

// Transcript rendering (non-clickable)
function renderTranscript(text) {
  const p = document.createElement('p');
  tSpans = [];
  tCharToSpan = [];
  let cIdx = 0, sIdx = 0;

  text.split(/(\s+)/).forEach(tok => {
    const sp = document.createElement('span');
    sp.textContent = tok;
    sp.dataset.sIdx = sIdx;
    p.appendChild(sp);
    tSpans.push(sp);
    for (let i=0;i<tok.length;i++) tCharToSpan[cIdx++] = sIdx;
    sIdx++;
  });

  screenReaderOutput.innerHTML = '';
  screenReaderOutput.appendChild(p);

  tSpanStart = Array(tSpans.length).fill(Infinity);
  tCharToSpan.forEach((s,c) => { if (c < tSpanStart[s]) tSpanStart[s] = c; });

  screenReaderOutput.style.userSelect = 'text';
  screenReaderOutput.style.pointerEvents = 'auto'; // transcript not clickable (kept as text)
}

// Highlights
function highlightTranscriptAt(origIdx) {
  tSpans.forEach(s => s.classList.remove('sr-highlight'));
  const sIdx = tCharToSpan[origIdx];
  if (sIdx != null && tSpans[sIdx]) tSpans[sIdx].classList.add('sr-highlight');
}

function highlightContentAt(origIdx) {
  if (!wSpans.length) return;
  if (lastContentHighlight) lastContentHighlight.classList.remove('sr-highlight');
  for (const sp of wSpans) {
    const a = Number(sp.dataset.start), b = Number(sp.dataset.end);
    if (origIdx >= a && origIdx < b) {
      sp.classList.add('sr-highlight');
      lastContentHighlight = sp;
      sp.scrollIntoView({ block: 'center', inline: 'nearest' });
      break;
    }
  }
}

// Emphasis prefix helper
function emphasisPrefix(el) {
  const imp = el.closest('strong,b');
  const emp = el.closest('em,i,mark');
  if (imp && emp) return 'important emphasis ';
  if (imp) return 'important ';
  if (emp) return 'emphasis ';
  return '';
}

// Overlap helper
function overlaps(aStart, aLen, ranges) {
  const aEnd = aStart + aLen;
  for (const [s,e] of ranges) {
    if (aStart < e && aEnd > s) return true;
  }
  return false;
}

// Negative & accounting detection
function collectNegativeExpansions(text, existingRanges) {
  const exps = [];

  // Hyphen/true minus before number: -12,345.67 or −12.3
  const reMinus = /[-\u2212]\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = reMinus.exec(text))) {
    const idx = m.index;
    const prev = idx > 0 ? text[idx-1] : '';
    if (idx === 0 || /\s|\(/.test(prev)) {
      const disp = m[0];
      const number = disp.replace(/^[-\u2212]/,'');
      if (!overlaps(idx, disp.length, existingRanges)) {
        exps.push({ off: idx, disp, title: 'minus ' + number });
      }
    }
  }

  // Accounting style: ( 1,000 ) -> negative 1,000
  const reParen = /\(\s*\d[\d,]*(?:\.\d+)?\s*\)/g;
  while ((m = reParen.exec(text))) {
    const disp = m[0];
    const inner = disp.replace(/[()\s]/g,'');
    const idx = m.index;
    if (!overlaps(idx, disp.length, existingRanges)) {
      exps.push({ off: idx, disp, title: 'negative ' + inner });
    }
  }

  return exps;
}

// ---------- Speaking ----------
function speakFromOriginal(origOff = 0) {
  synth.cancel();
  if (!spokenText) return;

  let sOff = spokenToOriginal.findIndex(o => o >= origOff);
  if (sOff < 0) sOff = 0;

  const utt = new SpeechSynthesisUtterance(spokenText.slice(sOff));
  utt.rate = parseFloat(speedControl.value);
  applyVoice(utt);
  utt.onboundary = ev => {
    if (ev.name === 'word') {
      const spokenIdx = sOff + ev.charIndex;
      const origIdx   = spokenToOriginal[spokenIdx];
      lastOriginalIdx = origIdx;
      highlightTranscriptAt(origIdx);
      highlightContentAt(origIdx);
    }
  };
  synth.speak(utt);
}

// ---------- File load into iframe ----------
fileUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    contentFrame.srcdoc = reader.result;

    contentFrame.onload = async () => {
      const doc = contentFrame.contentDocument;
      frameDoc = doc;
      injectStyles(document);  // transcript highlight
      injectStyles(frameDoc);  // web content highlight
       injectContentTheme(frameDoc);
      wrapTablesForScroll(frameDoc);

      // Wrap words in iframe doc
      const { spans, buffer } = wrapIntoWordSpans(frameDoc, frameDoc.body);
      wSpans  = spans;
      fullText = buffer;

      // Choose language & voice now that we have text + DOM
      await setLanguageAndVoice(frameDoc, fullText);

      // Collect core nodes
      abbrNodes  = Array.from(frameDoc.querySelectorAll('abbr'));
      abbrTitles = abbrNodes.map(a => {
        const base = a.title || a.textContent || '';
        return emphasisPrefix(a) + base; // add cue if wrapped in strong/em
      });
      abbrStarts = abbrNodes.map(a => elementStartOffset(a));

      ariaNodes  = Array.from(frameDoc.querySelectorAll('[aria-label]'));
      ariaLabels = ariaNodes.map(n => emphasisPrefix(n) + (n.getAttribute('aria-label') || ''));
      ariaStarts = ariaNodes.map(n => elementStartOffset(n));

      headingNodes  = Array.from(frameDoc.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      headingTitles = headingNodes.map(h => (h.innerText || '').trim());
      headingStarts = headingNodes.map(h => elementStartOffset(h));

      // Build expansions: abbr + aria first
      const expansions = [];
      const taken = []; // [start,end) ranges to avoid overlaps

      abbrNodes.forEach((n,i) => {
        const off = abbrStarts[i];
        if (off >= 0) {
          const disp = n.textContent || '';
          expansions.push({ off, disp, title: abbrTitles[i] });
          taken.push([off, off + disp.length]);
        }
      });

      ariaNodes.forEach((n,i) => {
        const off = ariaStarts[i];
        if (off >= 0) {
          const disp = n.textContent || '';
          expansions.push({ off, disp, title: ariaLabels[i] });
          taken.push([off, off + disp.length]);
        }
      });

      // Emphasis for plain strong/em/i/b/mark (that are NOT overlapping abbr/aria)
      const emphEls = Array.from(frameDoc.querySelectorAll('strong,b,em,i,mark'));
      emphEls.forEach(el => {
        const off = elementStartOffset(el);
        if (off < 0) return;
        const disp = el.textContent || '';
        if (!disp.trim()) return;
        const prefix = emphasisPrefix(el);
        if (!prefix) return;
        if (overlaps(off, disp.length, taken)) return; // abbr/aria already handled
        expansions.push({ off, disp, title: prefix + disp });
        taken.push([off, off + disp.length]);
      });

      // Negatives (hyphen/minus + accounting style), avoid overlaps
      const negativeExps = collectNegativeExpansions(fullText, taken);
      negativeExps.forEach(({off, disp, title}) => {
        expansions.push({ off, disp, title });
        taken.push([off, off + disp.length]);
      });

      // Build spoken buffer + render transcript
      buildSpokenFromExpansions(expansions);
      renderTranscript(fullText);

      // Click-to-speak inside iframe ONLY (transcript is not clickable)
      frameDoc.addEventListener('click', (ev) => {
        // aria-label shortcut
        const ariaAncestor = ev.target.closest('[aria-label]');
        if (ariaAncestor) {
          const label = emphasisPrefix(ariaAncestor) + (ariaAncestor.getAttribute('aria-label') || '');
          synth.cancel();
          const u = new SpeechSynthesisUtterance(label);
          applyVoice(u);
          u.rate = parseFloat(speedControl.value);
          synth.speak(u);
          ariaAncestor.classList.add('sr-focus','sr-outline');
          ariaAncestor.scrollIntoView({ block: 'center' });
          return;
        }
        // start exactly from clicked word
        const span = ev.target.closest('span[data-start]');
        if (!span) return;
        const origOff = Number(span.dataset.start);
        speakFromOriginal(origOff);
      }, { passive: true });

      // Also listen for T/H when iframe has focus
      frameDoc.addEventListener('keydown', handleKeys);

      // Reset
      abbrIndex = headingIndex = 0;
      lastOriginalIdx = 0;
      if (lastContentHighlight) lastContentHighlight.classList.remove('sr-highlight');
      lastContentHighlight = null;
    };
  };
  reader.readAsText(file);
});

// ---------- Controls ----------
playBtn.addEventListener('click',   () => speakFromOriginal(0));
pauseBtn.addEventListener('click',  () => { if (synth.speaking) synth.pause(); });
resumeBtn.addEventListener('click', () => { if (synth.paused)   synth.resume(); });
stopBtn.addEventListener('click',   () => {
  synth.cancel();
  tSpans.forEach(s => s.classList.remove('sr-highlight'));
  if (lastContentHighlight) lastContentHighlight.classList.remove('sr-highlight');
});

// Live speed update (no restart from top)
speedControl.addEventListener('input', () => {
  if (synth.speaking || synth.paused) speakFromOriginal(lastOriginalIdx);
});

// ---------- Keyboard navigation (global + iframe) ----------
function handleKeys(e) {
  if (!frameDoc) return;

  // T — next abbreviation (speak title, keep letters visible)
  if (e.key === 't' && abbrNodes.length) {
    e.preventDefault();
    abbrIndex = (abbrIndex + 1) % abbrNodes.length;

    wSpans.forEach(s => s.classList.remove('sr-focus','sr-outline'));
    const node = abbrNodes[abbrIndex];
    node.classList.add('sr-focus','sr-outline');
    node.scrollIntoView({ block: 'center' });

    synth.cancel();
    const u = new SpeechSynthesisUtterance(abbrTitles[abbrIndex]);
    applyVoice(u);
    u.rate = parseFloat(speedControl.value);
    synth.speak(u);

    const start = abbrStarts[abbrIndex];
    if (start >= 0) {
      highlightTranscriptAt(start);
      highlightContentAt(start);
      lastOriginalIdx = start;
    }
  }

  // H — next heading
  if (e.key === 'h' && headingNodes.length) {
    e.preventDefault();
    headingIndex = (headingIndex + 1) % headingNodes.length;

    wSpans.forEach(s => s.classList.remove('sr-focus','sr-outline'));
    const node = headingNodes[headingIndex];
    node.classList.add('sr-focus','sr-outline');
    node.scrollIntoView({ block: 'center' });

    synth.cancel();
    const u = new SpeechSynthesisUtterance(headingTitles[headingIndex]);
    applyVoice(u);
    u.rate = parseFloat(speedControl.value);
    synth.speak(u);

    const start = headingStarts[headingIndex];
    if (start >= 0) {
      highlightTranscriptAt(start);
      highlightContentAt(start);
      lastOriginalIdx = start;
    }
  }
}
document.addEventListener('keydown', handleKeys);

// Make sure voices are available ASAP (some browsers need this to warm up)
synth.onvoiceschanged = () => { voicesLoaded = true; };
