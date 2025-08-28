// Screen Reader Simulation
// Ehan Hassan

// ---------- Element refs ----------
const fileUpload         = document.getElementById('fileUpload');
const contentFrame       = document.getElementById('contentFrame');
const screenReaderOutput = document.getElementById('screenReaderOutput');
const playBtn            = document.getElementById('playBtn');
const pauseBtn           = document.getElementById('pauseBtn');
const resumeBtn          = document.getElementById('resumeBtn');
const stopBtn            = document.getElementById('stopBtn');
const speedControl       = document.getElementById('speedControl');

// ---------- Speech engine ----------
const synth = window.speechSynthesis;

// ---------- Language/voice selection ----------
let selectedLang  = 'en';
let selectedVoice = null;
let voicesLoaded  = false;

const VOICE_PREFERENCES = {
  en: [
    'Google US English', 'Google UK English Female', 'Google UK English Male',
    'Microsoft David', 'Microsoft Mark', 'Microsoft Zira', 'en-US'
  ],
  fr: [
    'Google français', 'Google français du Canada',
    'Microsoft Claude', 'Microsoft Caroline', 'Microsoft Hortense', 'fr-CA','fr-FR'
  ]
};

function loadVoices() {
  return new Promise(resolve => {
    const tick = () => {
      const v = synth.getVoices();
      if (v && v.length) { voicesLoaded = true; resolve(v); }
      else setTimeout(tick, 100);
    };
    tick();
  });
}
function pickBestVoice(allVoices, langCode) {
  for (const pref of VOICE_PREFERENCES[langCode]) {
    const found = allVoices.find(v =>
      (v.name && v.name.toLowerCase().includes(pref.toLowerCase())) ||
      (v.lang && v.lang.toLowerCase().includes(pref.toLowerCase()))
    );
    if (found) return found;
  }
  return (
    allVoices.find(v => (v.lang || '').toLowerCase().startsWith(langCode)) ||
    allVoices.find(v => (v.lang || '').toLowerCase().includes(langCode)) ||
    null
  );
}
function detectDocLang(doc, sampleText) {
  const htmlLang = (doc.documentElement.getAttribute('lang') || '').toLowerCase();
  if (htmlLang.startsWith('fr')) return 'fr';
  if (htmlLang.startsWith('en')) return 'en';
  const sample = (sampleText || doc.body?.innerText || '').slice(0, 8000).toLowerCase();
  const frHits = (sample.match(/\b(le|la|les|des|de|du|un|une|et|avec|pour|sur|au|aux)\b/g) || []).length;
  const enHits = (sample.match(/\b(the|and|with|for|to|of|in|on|by|from)\b/g) || []).length;
  return frHits > enHits * 1.3 ? 'fr' : 'en';
}
async function setLanguageAndVoice(doc, sampleText) {
  selectedLang  = detectDocLang(doc, sampleText);
  const voices  = voicesLoaded ? synth.getVoices() : await loadVoices();
  selectedVoice = pickBestVoice(voices, selectedLang);
}
function applyVoice(u) {
  u.lang  = selectedLang === 'fr' ? 'fr-CA' : 'en-US';
  if (selectedVoice) u.voice = selectedVoice;
}

// ---------- Ontario-ish content theme ----------
function injectContentTheme(doc) {
  const style = doc.createElement('style');
  style.textContent = `
    html{font-size:16px}
    body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",
         "Helvetica Neue",Arial,"Apple Color Emoji","Segoe UI Emoji";color:#111827;line-height:1.55}
    h1,h2,h3,h4,h5,h6{font-weight:800;line-height:1.25;margin:1.25rem 0 .5rem}
    h1{font-size:1.85rem} h2{font-size:1.6rem;border-top:3px solid #e5e7eb;padding-top:1rem}
    h3{font-size:1.35rem} h4{font-size:1.15rem} h5{font-size:1rem} h6{font-size:.9rem}
    .sr-table-scroll{overflow:auto;-webkit-overflow-scrolling:touch}
    table{width:100%;border-collapse:collapse;margin:1rem 0;background:#fff;font-size:.95rem}
    thead th{padding:.75rem 1rem;border-bottom:3px solid #111827;font-weight:700;vertical-align:bottom}
    tbody th, tbody td{padding:.65rem 1rem;vertical-align:top;border-top:1px solid #e5e7eb}
    tbody tr:nth-child(even){background:#fafafa}
    .sr-highlight{background:#bfdbfe;border-radius:.2rem}
    .sr-focus{background:#fde68a}
    .sr-outline{outline:2px dashed #3b82f6;outline-offset:2px}
  `;
  doc.head.appendChild(style);
}
function wrapTablesForScroll(doc) {
  doc.querySelectorAll('table').forEach(t => {
    if (t.closest('.sr-table-scroll')) return;
    const w = doc.createElement('div');
    w.className = 'sr-table-scroll';
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  });
}

// ---------- Helpers ----------
const nextTick = () => new Promise(r => setTimeout(r, 0));
const isSkippableTag = tag => /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT)$/i.test(tag);

// add “important/emphasis” cue if text is visually emphasized
function emphasisPrefix(el) {
  if (!el) return '';
  const imp = el.closest('strong,b');
  const emp = el.closest('em,i,mark');
  if (imp && emp) return selectedLang === 'fr' ? 'important, emphase ' : 'important emphasis ';
  if (imp)         return selectedLang === 'fr' ? 'important ' : 'important ';
  if (emp)         return selectedLang === 'fr' ? 'emphase ' : 'emphasis ';
  return '';
}

// handle negatives
function normalizeNegatives(str) {
  // − or - before a number
  str = str.replace(/(^|[\s(])([-\u2212])(\d[\d,]*(?:\.\d+)?)/g, (_, a, _m, n) => `${a}${selectedLang==='fr'?'moins':'minus'} ${n}`);
  // accounting style ( 1,234 )
  str = str.replace(/\(\s*(\d[\d,]*(?:\.\d+)?)\s*\)/g, (_, n) => `${selectedLang==='fr'?'négatif':'negative'} ${n}`);
  return str;
}

// ---------- Streaming speakable segments ----------
/*
  segments[] keeps the reading order, but we *don’t* rewrite the DOM.
  Each segment is one of:
  {type:'text', node: Text, text: "…" }
  {type:'abbr', el: Element, text: "expanded title" }
  {type:'aria', el: Element, text: "aria-label" }
  {type:'img',  el: HTMLImageElement, text: "alt or aria-label" }
*/
let frameDoc = null;
let segments = [];
let textNodeToSeg = new WeakMap();

// nav caches (still lightweight)
let abbrNodes = [], abbrTitles = [], abbrIndex = 0;
let headingNodes = [], headingTitles = [], headingIndex = 0;

// playback pointers
let curSegIdx = 0;
let curLocalOffset = 0;   
let currentUtt = null;
let lastWordWrap = null; 

function clearWordWrap() {
  if (!lastWordWrap) return;
  const wrap = lastWordWrap;
  const parent = wrap.parentNode;
  if (!parent) { lastWordWrap = null; return; }
  // unwrap <span>
  while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
  parent.removeChild(wrap);
  lastWordWrap = null;
}

function highlightWordInTextNode(textNode, start, end) {
  clearWordWrap();
  if (!textNode || start == null || end == null || start >= end) return;
  const doc = textNode.ownerDocument;
  const range = doc.createRange();
  range.setStart(textNode, Math.max(0, start));
  range.setEnd(textNode, Math.min(textNode.length, end));
  const span = doc.createElement('span');
  span.className = 'sr-highlight';
  range.surroundContents(span);
  lastWordWrap = span;
}

function wordBounds(text, pos) {
  let s = pos, e = pos;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return [s, e];
}

async function buildSegmentsStreaming(doc) {
  segments = [];
  textNodeToSeg = new WeakMap();

  // make status line once
  let status = document.getElementById('srBuildStatus');
  if (!status) {
    status = document.createElement('div');
    status.id = 'srBuildStatus';
    status.className = 'text-sm text-gray-500 mt-2';
    fileUpload.parentElement.appendChild(status);
  }
  status.textContent = 'Preparing content…';

  // collect headings/abbr upfront (cheap)
  abbrNodes    = Array.from(doc.querySelectorAll('abbr'));
  abbrTitles   = abbrNodes.map(a => (a.title || a.textContent || '').trim());
  headingNodes = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  headingTitles= headingNodes.map(h => (h.innerText || '').trim());

  // iterative DFS so we can yield to the UI
  const stack = [doc.body];
  let processed = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    // skip hidden subtrees fast
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;
      const tag = el.tagName;
      if (isSkippableTag(tag)) continue;
      if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) continue;

      // special speakables (we *accept* and do not descend)
      if (el.matches('abbr')) {
        const text = (el.getAttribute('title') || el.textContent || '').trim();
        if (text) segments.push({ type: 'abbr', el, text: emphasisPrefix(el) + text });
        processed++;
        continue;
      }
      if (el.hasAttribute('aria-label')) {
        const text = (el.getAttribute('aria-label') || '').trim();
        if (text) segments.push({ type: 'aria', el, text: emphasisPrefix(el) + text });
        processed++;
        continue;
      }
      if (tag === 'IMG') {
        const aria = (el.getAttribute('aria-label') || '').trim();
        const alt  = (el.getAttribute('alt') || '').trim();
        const text = aria || alt;            // empty alt = decorative (skip)
        if (text) segments.push({ type: 'img', el, text });
        processed++;
        continue;
      }

      // otherwise descend children (push in reverse to keep DOM order)
      for (let i = el.childNodes.length - 1; i >= 0; i--) stack.push(el.childNodes[i]);
      continue;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.nodeValue;
      if (val && val.trim()) {
        segments.push({ type: 'text', node, text: val });
        textNodeToSeg.set(node, segments.length - 1);
        processed++;
      }
    }

    if (processed % 2000 === 0) { // yield to keep Chrome responsive
      status.textContent = `Preparing content… ${processed.toLocaleString()} nodes`;
      await nextTick();
    }
  }

  status.textContent = `Ready • ${segments.length.toLocaleString()} speakable items`;
}

// ---------- Speaking one segment at a time ----------
function speakFrom(segIdx = 0, localOffset = 0) {
  synth.cancel();
  clearWordWrap();
  if (!segments.length) return;

  curSegIdx = Math.max(0, Math.min(segIdx, segments.length - 1));
  curLocalOffset = Math.max(0, localOffset);

  const seg = segments[curSegIdx];

  // build utterance text
  let toSpeak = '';
  if (seg.type === 'text') {
    toSpeak = normalizeNegatives(seg.text.slice(curLocalOffset));
  } else {
    toSpeak = seg.text;
  }
  if (!toSpeak) { // skip empties
    // jump to next
    return speakFrom(curSegIdx + 1, 0);
  }

  const utt = new SpeechSynthesisUtterance(toSpeak);
  currentUtt = utt;
  applyVoice(utt);
  utt.rate = parseFloat(speedControl.value);

  utt.onboundary = ev => {
    if (ev.name !== 'word') return;

    if (segments[curSegIdx]?.type === 'text') {
      // figure current word in the *original* text node
      const segText = segments[curSegIdx].text;
      const localPos = curLocalOffset + ev.charIndex;
      const [s, e] = wordBounds(segText, localPos);
      highlightWordInTextNode(segments[curSegIdx].node, s, e);
    } else {
      // emphasize the whole element for abbr/aria/img
      const el = segments[curSegIdx].el;
      if (!el) return;
      el.classList.add('sr-focus', 'sr-outline');
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      // remove quickly on next boundary/end
      setTimeout(() => el.classList.remove('sr-outline'), 400);
    }
  };

  utt.onend = () => {
    // clean highlight on elements
    if (segments[curSegIdx]?.el) {
      segments[curSegIdx].el.classList.remove('sr-focus');
      segments[curSegIdx].el.classList.remove('sr-outline');
    }
    clearWordWrap();
    // move to next segment
    curSegIdx++;
    curLocalOffset = 0;
    if (curSegIdx < segments.length) speakFrom(curSegIdx, 0);
  };

  synth.speak(utt);
}

// ---------- Click-to-speak inside the iframe ----------
function caretRangeFromPointSafe(doc, x, y) {
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    const r = doc.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
  }
  return null;
}

// ---------- Keyboard navigation ----------
function handleKeys(e) {
  if (!frameDoc) return;

  // T — next <abbr>
  if (e.key === 't' && abbrNodes.length) {
    e.preventDefault();
    abbrIndex = (abbrIndex + 1) % abbrNodes.length;
    const el = abbrNodes[abbrIndex];
    el.classList.add('sr-focus', 'sr-outline');
    el.scrollIntoView({ block: 'center' });
    synth.cancel();
    const u = new SpeechSynthesisUtterance((emphasisPrefix(el) + (el.title || el.textContent || '')).trim());
    applyVoice(u); u.rate = parseFloat(speedControl.value);
    synth.speak(u);
    setTimeout(() => el.classList.remove('sr-outline'), 500);
  }

  // H — next heading (speak the text of the heading)
  if (e.key === 'h' && headingNodes.length) {
    e.preventDefault();
    headingIndex = (headingIndex + 1) % headingNodes.length;
    const el = headingNodes[headingIndex];
    el.classList.add('sr-focus', 'sr-outline');
    el.scrollIntoView({ block: 'center' });
    synth.cancel();
    const u = new SpeechSynthesisUtterance((el.innerText || '').trim());
    applyVoice(u); u.rate = parseFloat(speedControl.value);
    synth.speak(u);
    setTimeout(() => el.classList.remove('sr-outline'), 500);
  }
}
document.addEventListener('keydown', handleKeys);

// ---------- File load ----------
fileUpload.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    contentFrame.srcdoc = reader.result;

    contentFrame.onload = async () => {
      frameDoc = contentFrame.contentDocument;
      injectContentTheme(frameDoc);
      wrapTablesForScroll(frameDoc);

      // build the speakable stream (non-blocking)
      await buildSegmentsStreaming(frameDoc);

      // choose a voice (cheap sample text: first 10k chars of body)
      await setLanguageAndVoice(frameDoc, frameDoc.body?.innerText?.slice(0, 10000) || '');

      // click-to-speak inside iframe
      frameDoc.addEventListener('click', ev => {
        // aria/image/abbr shortcuts
        const aria = ev.target.closest('[aria-label]');
        if (aria) {
          synth.cancel();
          const u = new SpeechSynthesisUtterance((emphasisPrefix(aria) + (aria.getAttribute('aria-label') || '')).trim());
          applyVoice(u); u.rate = parseFloat(speedControl.value);
          aria.classList.add('sr-focus','sr-outline');
          aria.scrollIntoView({ block:'center' });
          synth.speak(u);
          setTimeout(() => aria.classList.remove('sr-outline'), 500);
          return;
        }
        const abbr = ev.target.closest('abbr');
        if (abbr) {
          synth.cancel();
          const u = new SpeechSynthesisUtterance((emphasisPrefix(abbr) + (abbr.title || abbr.textContent || '')).trim());
          applyVoice(u); u.rate = parseFloat(speedControl.value);
          abbr.classList.add('sr-focus','sr-outline');
          abbr.scrollIntoView({ block:'center' });
          synth.speak(u);
          setTimeout(() => abbr.classList.remove('sr-outline'), 500);
          return;
        }
        const img = ev.target.closest('img');
        if (img) {
          const text = (img.getAttribute('aria-label') || img.getAttribute('alt') || '').trim();
          if (text) {
            synth.cancel();
            const u = new SpeechSynthesisUtterance(text);
            applyVoice(u); u.rate = parseFloat(speedControl.value);
            img.classList.add('sr-focus','sr-outline');
            img.scrollIntoView({ block:'center' });
            synth.speak(u);
            setTimeout(() => img.classList.remove('sr-outline'), 500);
            return;
          }
        }

        // precise word click in a text node
        const r = caretRangeFromPointSafe(frameDoc, ev.clientX, ev.clientY);
        if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return;
        const node = r.startContainer;
        const offset = r.startOffset;
        const segIdx = textNodeToSeg.get(node);
        if (segIdx == null) return;
        speakFrom(segIdx, offset);
      }, { passive: true });

      // transcript: keep as plain text, not clickable
      screenReaderOutput.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = (frameDoc.body?.innerText || '').slice(0, 5000) + '…';
      screenReaderOutput.appendChild(p);

      // reset nav
      abbrIndex = 0; headingIndex = 0;
      clearWordWrap();
    };
  };
  reader.readAsText(file);
});

// ---------- Controls ----------
playBtn.addEventListener('click',   () => speakFrom(0, 0));
pauseBtn.addEventListener('click',  () => { if (synth.speaking) synth.pause(); });
resumeBtn.addEventListener('click', () => { if (synth.paused)   synth.resume(); });
stopBtn.addEventListener('click',   () => { synth.cancel(); clearWordWrap(); });

speedControl.addEventListener('input', () => {
  if (synth.speaking || synth.paused) {
    // restart current segment at the last seen char if we can
    // (approximate by restarting at same segment and keeping local offset)
    speakFrom(curSegIdx, curLocalOffset);
  }
});

// warm up voice list on browsers that fire this late
synth.onvoiceschanged = () => { voicesLoaded = true; };
