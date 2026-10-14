'use strict';

/* =========================================================
   StudyTechAssistant — a student dictionary. Pure static, no build step.
   Data: Wiktionary + Simple Wiktionary (definitions, IPA,
   audio, etymology), Datamuse (suggestions), Tatoeba
   (backup example sentences).
   ========================================================= */

const LEVELS = ['Beginner', 'Student', 'Advanced', 'Expert'];
const LEVEL_NOTES = [
  'Simple meanings in everyday words.',
  'The core meanings, each with an example.',
  'More senses, nuance, synonyms and word family.',
  'Every sense, sub-senses, literary quotations and the full word history.',
];
const CFG = {
  sensesPerPos: [2, 3, 6, Infinity],
  posMax: [3, 6, 12, Infinity],
  examples: [1, 1, 2, 3],
  etyChars: [200, 420, 850, 1700],
  etySections: [1, 1, 2, 4],
  lineageMax: [3, 5, 7, 99],
  derivedMax: [0, 0, 12, 40],
};

const WIKT = 'https://en.wiktionary.org/w/api.php?action=parse&format=json&origin=*&formatversion=2&redirects=1&prop=text&disableeditsection=1&disablelimitreport=1&page=';
const SIMPLE = 'https://simple.wiktionary.org/w/api.php?action=parse&format=json&origin=*&formatversion=2&redirects=1&prop=text&disableeditsection=1&disablelimitreport=1&page=';
const DATAMUSE = 'https://api.datamuse.com/';
const TATOEBA = 'https://api.tatoeba.org/unstable/sentences?lang=eng&sort=relevance&limit=40&q=';

const POS = new Set(['Noun', 'Verb', 'Adjective', 'Adverb', 'Pronoun', 'Preposition', 'Conjunction', 'Interjection',
  'Determiner', 'Article', 'Numeral', 'Particle', 'Proper noun', 'Prefix', 'Suffix', 'Phrase', 'Prepositional phrase',
  'Proverb', 'Idiom', 'Contraction', 'Abbreviation', 'Initialism', 'Acronym', 'Symbol', 'Letter', 'Interjection']);

const NEVER = /\b(ethnic slur|slur)\b/i;
const HIDE_BY_LEVEL = [
  /\b(obsolete|archaic|rare|dated|dialect(al)?|non-?standard|historical|vulgar|offensive|derogatory|slang|euphemistic|sexual|pejorative|nonce|eye dialect|misspelling|uncommon|poetic|informal)\b/i,
  /\b(obsolete|archaic|rare|dialect(al)?|non-?standard|vulgar|offensive|derogatory|euphemistic|sexual|pejorative|nonce|eye dialect|misspelling)\b/i,
  /\b(obsolete|vulgar|offensive|derogatory|sexual|nonce|misspelling)\b/i,
  null,
];
const GRAMMAR_LABEL = /^(transitive|intransitive|ambitransitive|countable|uncountable|ergative|stative|copulative|reflexive|not comparable|comparable|attributive|predicative|postpositive|usually|chiefly|often|with|in the plural|plural only|singular only|auxiliary|modal|impersonal)/i;

/* ---------- tiny helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
const uniq = (a) => [...new Set(a)];
function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'data') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

async function getJSON(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* =========================================================
   State
   ========================================================= */
const state = {
  level: Math.min(3, Math.max(0, +load('lexi.level', 1) || 0)),
  history: load('lexi.history', []),
  current: null,   // { query, data }
};

/* =========================================================
   Fetching + parsing
   ========================================================= */
const cache = new Map();

function fetchEntry(word) {
  const key = word.trim();
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const lower = key.toLowerCase();
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    const simpleP = fetchWiki(SIMPLE, lower, true).catch(() => null);
    let en = null;
    // null = no English entry under that spelling; a thrown error = network trouble (shown to the user)
    for (const v of uniq([key, lower, cap])) {
      en = await fetchWiki(WIKT, v, false);
      if (en) break;
    }
    // don't let the (slower) Simple Wiktionary hold up the page; it fills in when it lands
    const simple = en ? await Promise.race([simpleP, new Promise(r => setTimeout(() => r(undefined), 700))]) : await simpleP;
    if (!en && !simple) return null;
    const title = en?.title || simple?.title || key;
    const data = {
      title,
      en, simple: simple || null,
      tatoeba: null,
      tatoebaP: fetchTatoeba(title).catch(() => []),
    };
    if (simple === undefined) simpleP.then(s => {
      if (!s) return;
      data.simple = s;
      if (state.current?.data === data) render();
    });
    return data;
  })();
  cache.set(key, p);
  p.then(v => { if (!v) cache.delete(key); }, () => cache.delete(key));
  return p;
}

async function fetchWiki(base, page, isSimple) {
  const url = base + encodeURIComponent(page);
  const j = await getJSON(url).catch(() => new Promise(r => setTimeout(r, 400)).then(() => getJSON(url)));
  if (j.error || !j.parse) return null;
  const doc = new DOMParser().parseFromString(j.parse.text, 'text/html');
  const root = doc.querySelector('.mw-parser-output') || doc.body;
  // phones get MobileFrontend output, which wraps each section in <section>; flatten it
  const flat = (els) => els.flatMap(e => (e.tagName === 'SECTION' ? flat([...e.children]) : [e]));
  let nodes = flat([...root.children]);
  if (!isSimple) {
    const start = nodes.findIndex(n => headingOf(n)?.id === 'English');
    if (start < 0) return null;
    const rest = nodes.slice(start + 1);
    const end = rest.findIndex(n => headingOf(n)?.lvl === 2);
    nodes = end < 0 ? rest : rest.slice(0, end);
  }
  const parsed = parseSections(sectionize(nodes));
  if (!parsed.pos.length) return null;
  parsed.title = j.parse.title;
  return parsed;
}

function headingOf(el) {
  let hEl = null;
  if (el.classList && el.classList.contains('mw-heading')) hEl = el.querySelector('h1,h2,h3,h4,h5,h6');
  else if (/^H[1-6]$/.test(el.tagName)) hEl = el;
  if (!hEl) return null;
  return { text: norm(hEl.textContent.replace(/\[(edit|change)\]/g, '')), lvl: +hEl.tagName[1], id: hEl.id };
}

function sectionize(nodes) {
  const secs = [];
  let cur = null;
  for (const el of nodes) {
    const hd = headingOf(el);
    if (hd) { cur = { title: hd.text, els: [] }; secs.push(cur); }
    else if (cur) cur.els.push(el);
  }
  return secs;
}

function parseSections(secs) {
  const out = { pos: [], ety: [], pron: { ipa: [], audio: [], hyph: null }, derived: [], related: [] };
  for (const s of secs) {
    const t = s.title.replace(/\s*\d+$/, '');
    if (t === 'Etymology') {
      const paras = etyParas(s.els);
      if (paras.length) out.ety.push(paras);
    } else if (t === 'Pronunciation') {
      parsePron(s.els, out.pron);
    } else if (POS.has(t)) {
      const ol = s.els.find(e => e.tagName === 'OL');
      if (!ol) continue;
      const headP = s.els.find(e => e.tagName === 'P');
      const senses = [...ol.children].filter(li => li.tagName === 'LI').map(li => parseSense(li, true)).filter(x => x && x.text);
      if (senses.length) out.pos.push({ pos: t, forms: formsOf(headP), senses });
    } else if (t === 'Derived terms' || t === 'Related terms' || t === 'Related words') {
      const words = s.els.flatMap(e => [...e.querySelectorAll('a[href^="/wiki/"]')])
        .map(a => norm(a.textContent))
        .filter(w => w && !w.includes(':') && w.length < 40);
      (t === 'Derived terms' ? out.derived : out.related).push(...words);
    }
  }
  out.derived = uniq(out.derived);
  out.related = uniq(out.related);
  return out;
}

function formsOf(p) {
  if (!p) return '';
  const txt = norm(p.textContent);
  const m = txt.match(/\((.+)\)\s*$/);
  return m && m[1].length < 180 ? m[1] : '';
}

function parseSense(li, allowSubs) {
  const labelEls = li.querySelectorAll(':scope > .usage-label-sense .ib-content, :scope > .usage-label-sense .label-content');
  const labels = uniq([...labelEls].map(e => norm(e.textContent)).filter(Boolean));

  const dateEl = li.querySelector(':scope > .defdate');
  const date = dateEl ? norm(dateEl.textContent).replace(/^\[|\]$/g, '') : '';

  const def = li.cloneNode(true);
  def.querySelectorAll(':scope > dl, :scope > ul, :scope > ol, :scope > .usage-label-sense, .defdate, style, sup, link, .reference, .maintenance-line, .HQToggle, .citation-whole, figure').forEach(e => e.remove());
  const text = norm(def.textContent);

  // examples
  let exEls = [...li.querySelectorAll(':scope > dl .e-example')];
  if (!exEls.length) exEls = [...li.querySelectorAll(':scope > dl > dd')]
    .filter(dd => !dd.querySelector('.nyms') && !/^(Synonyms?|Antonyms?|See also)\b/.test(norm(dd.textContent)));
  const ex = exEls
    .map(e => ({ segs: segments(e), collo: !!e.closest('.collocation') }))
    .filter(e => e.segs.length)
    .sort((a, b) => a.collo - b.collo)
    .map(e => e.segs);

  // literary quotation (used at Expert)
  let quote = null;
  const qEl = li.querySelector(':scope > ul .h-quotation .e-quotation, :scope > ul .e-quotation');
  if (qEl) {
    const qt = norm(qEl.textContent);
    const src = li.querySelector(':scope > ul .cited-source');
    const cite = src ? norm(src.textContent).split(/,\s*/).slice(0, 2).join(', ') : '';
    if (qt.length > 20 && qt.length < 320) quote = { text: qt, cite };
  }

  const nym = (sel) => uniq([...li.querySelectorAll(sel)]
    .filter(a => !/Thesaurus:|Appendix:/.test(a.getAttribute('href') || ''))
    .map(a => norm(a.textContent)).filter(w => w && w.length < 30));
  const syn = nym(':scope > dl .nyms.synonym a, :scope > ul.onyms-collapse-synonyms a');
  const ant = nym(':scope > dl .nyms.antonym a, :scope > ul.onyms-collapse-antonyms a');

  const subs = allowSubs
    ? [...li.querySelectorAll(':scope > ol > li')].map(x => parseSense(x, false)).filter(x => x && x.text)
    : [];

  const lemmaA = li.querySelector('.form-of-definition-link a[title]');
  const lemma = lemmaA ? lemmaA.getAttribute('title') : '';

  return { def, text, labels, date, ex, quote, syn, ant, subs, lemma };
}

// Example sentence -> [{t, b}] keeping only bold emphasis
function segments(el) {
  const segs = [];
  const walk = (n, bold) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (c.nodeValue) segs.push({ t: c.nodeValue, b: bold }); }
      else if (c.nodeType === 1 && !/^(SUP|STYLE|LINK)$/.test(c.tagName)) walk(c, bold || c.tagName === 'B' || c.tagName === 'STRONG');
    }
  };
  walk(el, false);
  const full = norm(segs.map(s => s.t).join(''));
  return full.length > 1 ? segs : [];
}

function etyParas(els) {
  const out = [];
  for (const el of els) {
    if (el.tagName !== 'P') continue;
    const c = el.cloneNode(true);
    c.querySelectorAll('sup, style, .reference').forEach(e => e.remove());
    const t = norm(c.textContent);
    if (t && !/^Etymology tree/i.test(t) && !/etymology is (missing|incomplete)/i.test(t)) out.push(t);
  }
  return out;
}

function parsePron(els, pron) {
  for (const el of els) {
    el.querySelectorAll('.IPA').forEach(span => {
      const ipa = norm(span.textContent);
      if (!ipa.startsWith('/')) return;
      const li = span.closest('li');
      const ctx = li ? norm(li.textContent.split(ipa)[0]) : '';
      const accent = /General American|\bGA\b|\bUS\b|American|Canada/.test(ctx) ? 'US'
        : /Received Pronunciation|\bRP\b|\bUK\b|British|SSB/.test(ctx) ? 'UK' : '';
      if (!pron.ipa.some(p => p.ipa === ipa)) pron.ipa.push({ ipa, accent });
    });
    el.querySelectorAll('audio').forEach(a => {
      const srcs = [...a.querySelectorAll('source')];
      const pick = srcs.find(s => /mpeg/.test(s.type)) || srcs[0];
      if (!pick) return;
      let src = pick.getAttribute('src');
      if (src.startsWith('//')) src = 'https:' + src;
      const name = (a.dataset.mwtitle || src).toLowerCase();
      const ctx = norm(a.closest('li')?.textContent || '');
      const accent = /en-us|\(us\)|-us-/.test(name) || /\bUS\b|General American|California|Canada/.test(ctx) ? 'US'
        : /en-uk|en-gb|-uk-/.test(name) || /\bUK\b|Received Pronunciation|Southern England|London/.test(ctx) ? 'UK' : '';
      pron.audio.push({ src, accent });
    });
    el.querySelectorAll('li').forEach(li => {
      const t = norm(li.textContent);
      if (!pron.hyph && /^Hyphenation/i.test(t)) {
        const v = t.split(':')[1];
        if (v) pron.hyph = norm(v.split(',')[0]);
      }
    });
  }
}

async function fetchTatoeba(word) {
  const j = await getJSON(TATOEBA + encodeURIComponent(word));
  const stem = word.toLowerCase().slice(0, Math.max(3, word.length - 2));
  const re = new RegExp('\\b' + esc(stem) + '\\w*', 'i');
  return (j.data || [])
    .map(s => s.text)
    .filter(t => t.length >= 18 && t.length <= 150 && re.test(t))
    .sort((a, b) => a.length - b.length)
    .slice(0, 20)
    .map(t => {
      const m = t.match(re);
      const prev = (t.slice(0, m.index).toLowerCase().match(/([a-z']+)\W*$/) || [])[1] || '';
      return {
        prev, form: m[0].toLowerCase(), base: word.toLowerCase(),
        segs: [{ t: t.slice(0, m.index), b: false }, { t: m[0], b: true }, { t: t.slice(m.index + m[0].length), b: false }],
      };
    });
}

// Rough check that a sentence uses the word as the given part of speech
const DET = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'some', 'any', 'no', 'every', 'each', 'one', 'another', 'of', 'new', 'old', 'good', 'big', 'little']);
const PRE_VERB = new Set(['to', 'will', 'would', 'can', 'could', 'should', 'must', 'might', 'may', 'i', 'you', 'we', 'they', 'he', 'she', 'it', "don't", "didn't", "doesn't", "won't", "can't", 'not', 'never', 'always', 'often', 'also', 'just', 'please', "let's", 'usually', 'sometimes', 'did', 'do', 'does']);
const PRE_ADJ = new Set(['is', 'was', 'are', 'were', 'be', 'been', 'am', 'very', 'so', 'too', 'really', 'feel', 'feels', 'felt', 'look', 'looks', 'looked', 'seem', 'seems', 'seemed', 'more', 'most', 'quite', 'become', 'became', 'get', 'got', 'such', 'extremely', 'pretty', 'less']);
function fitsPos(t, pos) {
  const inflected = t.form !== t.base;
  if (pos === 'Noun' || pos === 'Proper noun') return DET.has(t.prev);
  if (pos === 'Verb') return PRE_VERB.has(t.prev) || (inflected && /(ed|ing)$/.test(t.form) && !/(ed|ing)$/.test(t.base))
    || (!!t.prev && !DET.has(t.prev) && !PRE_ADJ.has(t.prev) && !/^(of|in|on|at|for|with|by|from|about)$/.test(t.prev));
  if (pos === 'Adjective') return PRE_ADJ.has(t.prev) || DET.has(t.prev);
  return true;
}

/* =========================================================
   Pronunciation: IPA -> friendly respelling + key
   ========================================================= */
const VOWEL_CH = 'aeiouæɑɒɔəɛɪʊʌɐɜɝɚɵᵻɨɘ';
// [open-syllable form, closed-syllable form]
const VOWELS = {
  'aɪɹ': ['ire', 'ire'], 'aʊɹ': ['our', 'our'],
  'ɪɹ': ['eer', 'eer'], 'iɹ': ['eer', 'eer'], 'ɛɹ': ['air', 'air'], 'eɹ': ['air', 'air'], 'ɑɹ': ['ar', 'ar'],
  'ɔɹ': ['or', 'or'], 'oɹ': ['or', 'or'], 'ʊɹ': ['oor', 'oor'], 'uɹ': ['oor', 'oor'], 'ɜɹ': ['ur', 'ur'], 'əɹ': ['er', 'er'],
  'aɪ': ['eye', 'y'], 'aʊ': ['ow', 'ow'], 'ɔɪ': ['oy', 'oy'], 'eɪ': ['ay', 'ay'], 'oʊ': ['oh', 'oh'], 'əʊ': ['oh', 'oh'],
  'ɪə': ['eer', 'eer'], 'ɛə': ['air', 'air'], 'eə': ['air', 'air'], 'ʊə': ['oor', 'oor'],
  'ɝ': ['ur', 'ur'], 'ɚ': ['er', 'er'], 'ɜ': ['ur', 'ur'],
  'i': ['ee', 'ee'], 'ɪ': ['ih', 'i'], 'ᵻ': ['ih', 'i'], 'ɨ': ['ih', 'i'], 'e': ['eh', 'e'], 'ɛ': ['eh', 'e'],
  'æ': ['a', 'a'], 'a': ['ah', 'a'], 'ɑ': ['ah', 'ah'], 'ɒ': ['o', 'o'], 'ɔ': ['aw', 'aw'], 'o': ['oh', 'oh'],
  'ʊ': ['uu', 'uu'], 'u': ['oo', 'oo'], 'ʌ': ['uh', 'u'], 'ə': ['uh', 'uh'], 'ɐ': ['uh', 'uh'], 'ɵ': ['oh', 'oh'], 'ɘ': ['uh', 'uh'],
  'l̩': ['uhl', 'uhl'], 'n̩': ['uhn', 'uhn'], 'm̩': ['uhm', 'uhm'],
};
const CONS = {
  'tʃ': 'ch', 'dʒ': 'j', 'p': 'p', 'b': 'b', 't': 't', 'd': 'd', 'k': 'k', 'g': 'g', 'f': 'f', 'v': 'v',
  'θ': 'th', 'ð': 'th', 's': 's', 'z': 'z', 'ʃ': 'sh', 'ʒ': 'zh', 'h': 'h', 'm': 'm', 'n': 'n', 'ŋ': 'ng',
  'l': 'l', 'ɹ': 'r', 'w': 'w', 'j': 'y', 'ʍ': 'wh', 'x': 'kh', 'ʔ': '', 'ɾ': 'd', 'c': 'k',
};
const ONSET2 = /^(?:[pbtdkgfθʃ][lɹwj]|s[ptkmnlw]|[mn]j)$/;
const KEY = [
  ['æ', 'a', 'cat'], ['ɑ', 'ah', 'father'], ['ɒ', 'o', 'hot (UK)'], ['ɔ', 'aw', 'law'], ['ɛ', 'e', 'bed'], ['e', 'e', 'bed'],
  ['ɪ', 'i', 'sit'], ['i', 'ee', 'see'], ['ʌ', 'u', 'cup'], ['ə', 'uh', 'about'], ['ɚ', 'er', 'butter'], ['ɝ', 'ur', 'bird'],
  ['ɜ', 'ur', 'bird'], ['ʊ', 'uu', 'book'], ['u', 'oo', 'food'], ['eɪ', 'ay', 'day'], ['aɪ', 'eye', 'my'], ['ɔɪ', 'oy', 'boy'],
  ['aʊ', 'ow', 'now'], ['oʊ', 'oh', 'go'], ['əʊ', 'oh', 'go'], ['θ', 'th', 'thin'], ['ð', 'th', 'this'], ['ʃ', 'sh', 'she'],
  ['ʒ', 'zh', 'vision'], ['tʃ', 'ch', 'chair'], ['dʒ', 'j', 'jump'], ['ŋ', 'ng', 'sing'], ['j', 'y', 'yes'], ['ɹ', 'r', 'red'],
  ['ɾ', 'd', 'water (US)'], ['ˈ', '', 'next part is loudest (CAPS)'], ['ˌ', '', 'next part gets a lighter beat'],
];

function cleanIPA(ipa) {
  return ipa.split(',')[0]
    .replace(/[\/\[\]()ːˑ̯‿ʰ̃͡ʲ]/g, '')
    .replace(/ɡ/g, 'g').replace(/ɫ/g, 'l').replace(/[rɻ]/g, 'ɹ').replace(/ɝː/g, 'ɝ')
    .trim();
}

function respell(ipa) {
  const s = cleanIPA(ipa);
  const toks = [];
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === 'ˈ' || ch === 'ˌ') { toks.push({ k: ch === 'ˈ' ? 'S1' : 'S2' }); i++; continue; }
    if (ch === '.' || ch === ' ' || ch === '-') { toks.push({ k: 'B' }); i++; continue; }
    let hit = null;
    for (const len of [3, 2, 1]) {
      const sub = s.substr(i, len);
      if (VOWELS[sub]) {
        // r-colouring only when the r isn't starting the next syllable
        if (sub.endsWith('ɹ') && VOWEL_CH.includes(s.slice(i + len).replace(/^[.ˈˌ]+/, '')[0] || '')) continue;
        hit = { k: 'V', ipa: sub, len }; break;
      }
      if (CONS[sub] != null) { hit = { k: 'C', ipa: sub, len }; break; }
    }
    if (!hit) { i++; continue; }
    toks.push(hit); i += hit.len;
  }
  const vIdx = toks.map((t, i) => (t.k === 'V' ? i : -1)).filter(i => i >= 0);
  if (!vIdx.length) return null;

  // split points between consecutive vowels
  const cuts = [];
  for (let n = 0; n < vIdx.length - 1; n++) {
    const a = vIdx[n], b = vIdx[n + 1];
    const gap = toks.slice(a + 1, b);
    const mark = gap.findIndex(t => t.k !== 'C');
    if (mark >= 0) { cuts.push(a + 1 + mark); continue; }
    const cs = gap.length;
    if (cs <= 1) { cuts.push(a + 1); continue; }
    const last2 = gap[cs - 2].ipa + gap[cs - 1].ipa;
    cuts.push(ONSET2.test(last2) ? b - 2 : b - 1);
  }
  const syl = [];
  let start = 0;
  for (const c of [...cuts, toks.length]) { syl.push(toks.slice(start, c)); start = c; }

  return syl.map(tt => {
    const stress = tt.some(t => t.k === 'S1') ? 1 : tt.some(t => t.k === 'S2') ? 2 : 0;
    const ph = tt.filter(t => t.k === 'V' || t.k === 'C');
    const vi = ph.findIndex(t => t.k === 'V');
    const closed = ph.length && ph[ph.length - 1].k === 'C';
    let txt = ph.map((t, i) => {
      if (t.k === 'C') return CONS[t.ipa];
      if (t.ipa === 'aɪ') return vi === 0 ? 'eye' : 'y';
      return VOWELS[t.ipa][closed ? 1 : 0];
    }).join('');
    if (stress === 1) txt = txt.toUpperCase();
    return { txt, stress };
  }).filter(x => x.txt);
}

function keyFor(ipa) {
  const s = cleanIPA(ipa);
  const used = [];
  let rest = s;
  for (const [sym, sound, ex] of [...KEY].sort((a, b) => b[0].length - a[0].length)) {
    if (rest.includes(sym)) { used.push([sym, sound, ex]); rest = rest.split(sym).join(' '); }
  }
  return KEY.filter(k => used.some(u => u[0] === k[0]));
}

/* audio */
let currentAudio = null;
function speak(text, rate, btn) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = rate;
  const v = speechSynthesis.getVoices().find(v => v.lang === 'en-US' && /Samantha|Google US|Aria|Jenny|Natural/.test(v.name))
    || speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('en'));
  if (v) u.voice = v;
  btn?.classList.add('playing');
  u.onend = u.onerror = () => btn?.classList.remove('playing');
  speechSynthesis.speak(u);
}
function play(word, audio, slow, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (!audio) return speak(word, slow ? 0.55 : 0.95, btn);
  const a = new Audio(audio.src);
  a.playbackRate = slow ? 0.6 : 1;
  a.preservesPitch = true;
  currentAudio = a;
  btn?.classList.add('playing');
  a.onended = () => btn?.classList.remove('playing');
  a.onerror = () => { btn?.classList.remove('playing'); speak(word, slow ? 0.55 : 0.95, btn); };
  a.play().catch(() => a.onerror());
}

/* =========================================================
   Etymology helpers
   ========================================================= */
const LANGS = ['Proto-Indo-European', 'Proto-Germanic', 'Proto-West Germanic', 'Proto-Italic', 'Proto-Hellenic', 'Proto-Celtic',
  'Proto-Slavic', 'Proto-Indo-Iranian', 'Ancient Greek', 'Koine Greek', 'Byzantine Greek', 'Medieval Greek', 'Greek',
  'Classical Latin', 'Late Latin', 'Medieval Latin', 'Vulgar Latin', 'New Latin', 'Ecclesiastical Latin', 'Old Latin', 'Latin',
  'Old French', 'Middle French', 'Anglo-Norman', 'Old Northern French', 'Anglo-French', 'French', 'Old English', 'Middle English',
  'Old Norse', 'Middle Dutch', 'Dutch', 'Middle Low German', 'Low German', 'Old High German', 'Middle High German', 'German',
  'Old Saxon', 'Old Frisian', 'Frankish', 'Gothic', 'Italian', 'Old Italian', 'Spanish', 'Old Spanish', 'Portuguese', 'Catalan',
  'Old Occitan', 'Occitan', 'Provençal', 'Arabic', 'Classical Persian', 'Middle Persian', 'Persian', 'Hebrew', 'Biblical Hebrew',
  'Aramaic', 'Sanskrit', 'Hindi', 'Urdu', 'Tamil', 'Japanese', 'Middle Chinese', 'Mandarin', 'Cantonese', 'Chinese',
  'Classical Nahuatl', 'Nahuatl', 'Malay', 'Ottoman Turkish', 'Turkish', 'Old Irish', 'Middle Irish', 'Irish', 'Scottish Gaelic',
  'Welsh', 'Russian', 'Egyptian', 'Coptic', 'Akkadian', 'Sumerian', 'Swahili', 'Yiddish', 'Hawaiian', 'Etruscan', 'Gaulish',
  'Scots', 'Norwegian Bokmål', 'Norwegian Nynorsk', 'Norwegian','Swedish', 'Danish', 'Icelandic', 'Polish', 'Czech', 'Hungarian', 'Finnish', 'Quechua', 'Tupi', 'Taino'];
const LANG_ALT = [...LANGS].sort((a, b) => b.length - a.length).map(esc).join('|');
const TERM = "\\*?[\\p{L}\\p{M}ʰʷʲ₀-₉'ʼ·-]+";
const LANG_TERM_RE = () => new RegExp(`(${LANG_ALT})(?:\\s+(${TERM}))?`, 'gu');
const STOPTERMS = new Set(['and', 'or', 'the', 'a', 'an', 'word', 'words', 'term', 'terms', 'verb', 'noun', 'adjective', 'from',
  'of', 'in', 'as', 'by', 'via', 'which', 'compound', 'form', 'forms', 'root', 'stem', 'suffix', 'prefix', 'borrowing',
  'diminutive', 'plural', 'sense', 'senses', 'origin', 'is', 'was', 'with', 'to', 'cognates', 'equivalent', 'calque']);

// "from Latin dīcō" names a source word; "the Persian story" does not
// after a comma/plus we also need the term to look foreign (accents, *roots) or carry a gloss
function sourceLead(text, idx, term, gloss) {
  const before = text.slice(Math.max(0, idx - 24), idx);
  if (idx === 0 || /\b(?:from|via|into|through)\s*$/i.test(before)) return true;
  return /(?:\b(?:of|in|to|and|or)|[+,(;:])\s*$/i.test(before) && (!!gloss || /[^\x00-\x7F]|^\*/.test(term || ''));
}

function lineage(text, headword, level) {
  let t = text.split(/\b(?:[Cc]alque|[Tt]ranslation of|[Cc]ognate|[Cc]ompare|[Aa]kin to|[Dd]oublet of|[Ss]ee also|[Bb]y surface analysis|[Rr]elated to|[Ee]quivalent to|[Dd]isplaced|[Ss]uperseded|[Rr]eplaced|[Ss]urface analysis)\b/)[0];
  t = t.replace(/\((?!“)[^()]*\)/g, ' ');
  // "Latin dīcō (“to speak”)"  or a language-less "from dictiō (“a speaking”)" that inherits the last language
  const re = new RegExp(`(${LANG_ALT})\\s+(${TERM})(?:,?\\s*\\(“([^”]{1,60})”)?|\\b(?:from|of)\\s+(${TERM}),?\\s*\\(“([^”]{1,60})”`, 'gu');
  const steps = [];
  let m, lastLang = '';
  while ((m = re.exec(t))) {
    const l = m[1] || lastLang;
    const term = m[2] || m[4];
    const gloss = m[3] || m[5] || '';
    if (!l || STOPTERMS.has(term.toLowerCase()) || term.startsWith('-') || term.endsWith('-')) continue;
    if (m[1] && !sourceLead(t, m.index, term, gloss)) continue;
    lastLang = l;
    if (steps.some(s => s.l === l && s.t === term)) continue;
    steps.push({ l, t: term, g: gloss });
  }
  let chain = steps.reverse();
  if (level < 2) {
    // keep the oldest word for each language so the root survives
    chain = chain.filter(s => !s.l.startsWith('Proto-'))
      .filter((s, i, a) => i === 0 || a[i - 1].l !== s.l);
  }
  chain = chain.slice(-CFG.lineageMax[level]);
  if (!chain.length) return [];
  // today's English word first, then back in time to the oldest root
  return [{ l: 'English', t: headword, g: '' }, ...chain.reverse()];
}

function clipEty(paras, cap) {
  const out = [];
  let used = 0;
  for (const p of paras) {
    if (used + p.length <= cap) { out.push(p); used += p.length; continue; }
    const room = cap - used;
    if (out.length && room < 120) break;
    const sents = p.match(/[^]+?(?:[.!?](?=\s+[\p{Lu}“"(\[])|$)/gu) || [p];
    let acc = '';
    for (const s of sents) {
      if (acc && (acc + s).length > room) break;
      acc += s;
    }
    acc = acc.trim();
    if (acc.length > room * 1.25) {
      const cut = acc.lastIndexOf(', from ', room);
      const cut2 = cut > 40 ? cut : acc.lastIndexOf(', ', room);
      if (cut2 > 40) acc = acc.slice(0, cut2) + '…';
    }
    out.push(acc);
    break;
  }
  return out;
}

function etyNode(text) {
  const p = h('p');
  const re = LANG_TERM_RE();
  let last = 0, m;
  while ((m = re.exec(text))) {
    p.append(text.slice(last, m.index));
    p.append(h('span', { class: 'lang', text: m[1] }));
    if (m[2] && !STOPTERMS.has(m[2].toLowerCase()) && sourceLead(text, m.index, m[2], /^,?\s*\(“/.test(text.slice(re.lastIndex)))) {
      p.append(' ', h('span', { class: 'term', text: m[2] }));
    } else if (m[2]) p.append(' ' + m[2]);
    last = re.lastIndex;
  }
  p.append(text.slice(last));
  return p;
}

/* =========================================================
   Rendering
   ========================================================= */
const main = $('#main');

// Turn a parsed (inert) definition element into tappable words
function tappable(src) {
  const frag = document.createDocumentFragment();
  const walk = (node, into) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        const parts = c.nodeValue.split(/([A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z])/);
        parts.forEach((part, i) => {
          if (!part) return;
          if (i % 2) into.append(h('span', { class: 'w', data: { w: part.toLowerCase() } }, part));
          else into.append(part);
        });
      } else if (c.nodeType === 1) {
        if (/^(STYLE|SUP|LINK|SCRIPT)$/.test(c.tagName)) continue;
        const href = c.tagName === 'A' ? c.getAttribute('href') || '' : '';
        if (href.startsWith('/wiki/') && !href.slice(6).includes(':')) {
          const lemma = decodeURIComponent(href.slice(6).split('#')[0]).replace(/_/g, ' ');
          into.append(h('span', { class: 'w link', data: { w: lemma } }, c.textContent));
        } else if (c.tagName === 'I' || c.tagName === 'B' || c.tagName === 'EM' || c.tagName === 'STRONG') {
          const wrap = h(c.tagName.toLowerCase());
          walk(c, wrap);
          into.append(wrap);
        } else walk(c, into);
      }
    }
  };
  walk(src, frag);
  return frag;
}

function exampleNode(segs, src) {
  const p = h('p', { class: 'ex' });
  for (const s of segs) p.append(s.b ? h('b', { text: s.t }) : s.t);
  if (src) p.append(h('span', { class: 'src', text: src }));
  return p;
}

function wordBtn(w) { return h('button', { class: 'word-btn', data: { w } }, w); }
const CRUDE = /fuck|shit|cunt|dick|cock|bitch|piss|whore|slut|nigg|fag/i;
const clean = (words) => words.filter(w => !CRUDE.test(w));

function chooseSenses(group, level) {
  const hide = HIDE_BY_LEVEL[level];
  const ok = (s) => {
    const lab = s.labels.join(', ');
    if (NEVER.test(lab)) return false;
    return !(hide && (hide.test(lab) || hide.test(s.text.slice(0, 40))));
  };
  let list = group.senses.filter(ok);
  if (!list.length) list = group.senses.filter(s => !NEVER.test(s.labels.join(','))).slice(0, 1);
  const max = CFG.sensesPerPos[level];
  if (level === 0 && list.length > max) {
    // prefer the plainest of the first few
    const pool = list.slice(0, 4).map((s, i) => ({ s, i })).sort((a, b) => a.s.text.length - b.s.text.length).slice(0, max);
    list = pool.sort((a, b) => a.i - b.i).map(x => x.s);
  } else list = list.slice(0, max);
  return list;
}

function render() {
  const cur = state.current;
  if (!cur) return renderHome();
  const { data } = cur;
  if (!data) return renderMissing(cur.query);

  const L = state.level;
  const en = data.en, simple = data.simple;
  const word = data.title;

  // pick the source for definitions
  const useSimple = L === 0 && simple && simple.pos.length;
  const base = useSimple ? simple : (en || simple);
  let groups = base.pos.slice(0, CFG.posMax[L]).map(g => ({ pos: g.pos, forms: g.forms, senses: chooseSenses(g, L) }));

  // make sure every sense has an example sentence
  const simplePool = {};
  if (!useSimple && simple) for (const g of simple.pos) (simplePool[g.pos] ||= []).push(...g.senses.flatMap(s => s.ex));
  const tat = (data.tatoeba || []).slice();
  let missing = false;
  for (const g of groups) g.senses.forEach((s, idx) => {
    s._fill = null;
    if (s.ex.length) return;
    const fromSimple = simplePool[g.pos]?.shift();
    // general sentences only suit a word's main, unlabelled senses
    const general = idx === 0 || (idx === 1 && s.labels.every(l => GRAMMAR_LABEL.test(l)));
    const ti = fromSimple || !general ? -1 : tat.findIndex(t => fitsPos(t, g.pos));
    if (fromSimple) s._fill = { segs: fromSimple };
    else if (ti >= 0) s._fill = { segs: tat.splice(ti, 1)[0].segs, src: 'Tatoeba' };
    else if (general) missing = true;
  });

  const pron = (en && (en.pron.ipa.length || en.pron.audio.length)) ? en.pron : (simple?.pron || { ipa: [], audio: [] });
  const ipaMain = pron.ipa.find(p => p.accent === 'US') || pron.ipa[0];
  const audio = pron.audio.find(a => a.accent === 'US') || pron.audio[0] || null;

  const frag = document.createDocumentFragment();

  /* ---- head ---- */
  const head = h('section', { class: 'entry-head' }, h('h1', { class: 'headword', text: word }));
  const hyph = pron.hyph || (en?.pron.hyph);
  if (hyph && hyph.includes('‧')) head.append(h('div', { class: 'syll', text: hyph.replace(/‧/g, ' · ') }));

  const playBtn = h('button', { class: 'play', 'aria-label': `Play pronunciation of ${word}`, title: audio ? 'Recorded pronunciation' : 'Device voice' },
    svgIcon('play'));
  playBtn.addEventListener('click', () => play(word, audio, false, playBtn));
  const slowBtn = h('button', { class: 'slow', text: 'Slow' });
  slowBtn.addEventListener('click', () => play(word, audio, true, playBtn));

  const pronText = h('div', { class: 'pron-text' });
  if (ipaMain) {
    const rs = respell(ipaMain.ipa);
    if (rs && rs.length) {
      const r = h('span', { class: 'respell' });
      rs.forEach((sy, i) => {
        if (i) r.append('-');
        r.append(sy.stress === 1 ? h('span', { class: 'stress', text: sy.txt }) : sy.txt);
      });
      pronText.append(r);
    }
    const uk = pron.ipa.find(p => p.accent === 'UK');
    const shown = L >= 3 && uk && uk !== ipaMain ? [ipaMain, uk] : [ipaMain];
    for (const p of shown) {
      pronText.append(h('span', { class: 'ipa' }, p.accent && L >= 2 ? h('small', { text: p.accent }) : null, p.ipa));
    }
  }
  const pronRow = h('div', { class: 'pron' }, playBtn, pronText, slowBtn);
  head.append(pronRow);

  if (ipaMain) {
    const keyItems = keyFor(ipaMain.ipa);
    if (keyItems.length) {
      const keyBox = h('div', { class: 'key', hidden: true },
        keyItems.map(([sym, sound, ex]) => h('div', null, h('b', { text: sym }),
          h('span', null, sound ? h('em', { text: sound }) : null, sound ? ' as in ' : '', ex))));
      const toggle = h('button', { class: 'key-toggle', 'aria-expanded': 'false', text: 'Sound key' });
      toggle.addEventListener('click', () => {
        keyBox.hidden = !keyBox.hidden;
        toggle.setAttribute('aria-expanded', String(!keyBox.hidden));
      });
      pronRow.append(toggle);
      head.append(keyBox);
    }
  }
  frag.append(head);
  frag.append(h('p', { class: 'level-note', text: `${LEVELS[L]} · ${LEVEL_NOTES[L]}` }));

  // "ran" -> point to "run"
  const lemmas = uniq((en || base).pos.flatMap(g => g.senses.slice(0, L >= 3 ? 3 : 1).map(s => s.lemma))
    .filter(l => l && l.toLowerCase() !== word.toLowerCase()));
  if (lemmas.length) frag.append(h('div', { class: 'formof' }, h('span', { text: `“${word}” is a form of` }), lemmas.slice(0, 2).map(wordBtn)));

  /* ---- senses ---- */
  for (const g of groups) {
    const card = h('section', { class: 'card' });
    const ph = h('div', { class: 'pos-head' }, h('h2', { class: 'pos', text: g.pos.toLowerCase() }));
    if (L >= 1 && g.forms) ph.append(h('span', { class: 'forms', text: g.forms }));
    card.append(ph);
    const ol = h('ol', { class: 'senses' });
    for (const s of g.senses) {
      const li = h('li', { class: 'sense' });
      const p = h('p', { class: 'def' });
      const labs = L === 0 ? [] : s.labels.flatMap(l => l.split(/,\s*/)).filter(l => L >= 2 || !GRAMMAR_LABEL.test(l));
      if (labs.length) p.append(h('span', { class: 'labels' }, labs.slice(0, 4).map(l => h('span', { class: 'label', text: l }))));
      p.append(tappable(s.def));
      if (L >= 3 && s.date) p.append(h('span', { class: 'date', text: s.date }));
      li.append(p);

      const exs = s.ex.length ? s.ex.slice(0, CFG.examples[L]).map(e => exampleNode(e)) : (s._fill ? [exampleNode(s._fill.segs, s._fill.src)] : []);
      li.append(...exs);

      if (L >= 3 && s.quote) li.append(h('p', { class: 'quote' }, '“' + s.quote.text + '”', s.quote.cite ? h('cite', { text: '— ' + s.quote.cite }) : null));

      if (L >= 2 && s.subs.length) {
        const subs = s.subs.filter(x => !NEVER.test(x.labels.join(',')) && (L >= 3 || !HIDE_BY_LEVEL[2].test(x.labels.join(','))));
        if (subs.length) li.append(h('ul', { class: 'subs' }, subs.slice(0, L >= 3 ? 99 : 3).map(x => {
          const d = h('li', null, tappable(x.def));
          if (x.ex[0]) d.append(exampleNode(x.ex[0]));
          return d;
        })));
      }
      if (L >= 2 && (s.syn.length || s.ant.length)) {
        const syn = clean(s.syn), ant = clean(s.ant);
        if (syn.length) li.append(h('div', { class: 'nyms' }, h('span', { class: 'k', text: 'Similar' }), syn.slice(0, 6).map(wordBtn)));
        if (ant.length) li.append(h('div', { class: 'nyms' }, h('span', { class: 'k', text: 'Opposite' }), ant.slice(0, 4).map(wordBtn)));
      }
      ol.append(li);
    }
    card.append(ol);
    frag.append(card);
  }

  /* ---- etymology ---- */
  const etys = (en?.ety || []).slice(0, CFG.etySections[L]);
  if (etys.length) {
    const card = h('section', { class: 'card ety' }, h('h3', { class: 'section-title', text: L === 0 ? 'Where it comes from' : 'Word history' }));
    etys.forEach((paras, i) => {
      if (etys.length > 1) card.append(h('h4', { text: `Origin ${i + 1}` }));
      const chain = lineage(paras.join(' '), word, L);
      if (chain.length > 1) {
        card.append(h('ol', { class: 'lineage' }, chain.map(s => h('li', null,
          h('span', { class: 'l', text: s.l }), h('span', { class: 't', text: s.t }), s.g ? h('span', { class: 'g', text: `“${s.g}”` }) : null))));
      }
      // lower levels: drop transliterations, keep the meanings — "(ephēmérios, “of the day”)" -> "(“of the day”)"
      const simpler = L < 2 ? paras.map(t => norm(t.replace(/\([^()“]*?,\s*(“[^”]*”)\)/g, '($1)').replace(/\s*\((?!“)[^()]*\)/g, '')).replace(/\s+([,.])/g, '$1')) : paras;
      clipEty(simpler, CFG.etyChars[L]).forEach(t => card.append(etyNode(t)));
    });
    frag.append(card);
  }

  /* ---- word family (A/E) ---- */
  if (L >= 2 && en) {
    const derived = clean(en.derived).filter(w => w.toLowerCase() !== word.toLowerCase()).slice(0, CFG.derivedMax[L]);
    const related = L >= 3 ? clean(en.related).slice(0, 24) : [];
    if (derived.length || related.length) {
      const card = h('section', { class: 'card' });
      if (derived.length) card.append(h('h3', { class: 'section-title', text: 'Word family' }), h('div', { class: 'chips' }, derived.map(wordBtn)));
      if (related.length) card.append(h('h3', { class: 'section-title', text: 'Related words' }), h('div', { class: 'chips' }, related.map(wordBtn)));
      frag.append(card);
    }
  }

  frag.append(h('p', { class: 'level-note' }, h('a', { href: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word), target: '_blank', rel: 'noopener', text: 'See full entry on Wiktionary ↗' })));

  main.classList.toggle('static', main._shown === data); // no entrance animation when refreshing the same word
  main._shown = data;
  main.replaceChildren(frag);

  // late-arriving extras
  if (missing && !data.tatoeba) data.tatoebaP.then(t => { data.tatoeba = t; if (t.length && state.current?.data === data) render(); });
}

function svgIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', name === 'play' ? 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z' : '');
  svg.append(p);
  return svg;
}

const STARTERS = ['serendipity', 'ephemeral', 'photosynthesis', 'democracy', 'resilient', 'curious', 'ubiquitous', 'metaphor', 'gravity', 'empathy'];
function renderHome() {
  const picks = [...STARTERS].sort(() => Math.random() - .5).slice(0, 6);
  main.replaceChildren(h('section', { class: 'welcome' },
    h('h1', { text: 'Look up any word.' }),
    h('p', { text: 'Pick your level above. Tap any word inside a definition to look that up too.' }),
    h('div', { class: 'chips' }, picks.map(wordBtn))));
}

async function renderMissing(q) {
  const box = h('section', { class: 'empty' }, h('h2', { text: `No entry for “${q}”` }), h('p', { text: 'Check the spelling, or try one of these:' }));
  const chips = h('div', { class: 'chips' });
  box.append(chips);
  main.replaceChildren(box);
  try {
    const s = await getJSON(DATAMUSE + 'sug?max=8&s=' + encodeURIComponent(q));
    s.map(x => x.word).filter(w => w.toLowerCase() !== q.toLowerCase()).forEach(w => chips.append(wordBtn(w)));
    if (!chips.children.length) box.querySelector('p').textContent = 'Check the spelling and try again.';
  } catch { /* offline */ }
}

function renderLoading(q) {
  main.replaceChildren(h('div', { 'aria-busy': 'true', 'aria-label': `Loading ${q}` },
    h('div', { class: 'skeleton h' }), h('div', { class: 'skeleton', style: 'width:90%' }),
    h('div', { class: 'skeleton', style: 'width:75%' }), h('div', { class: 'skeleton', style: 'width:82%' })));
}

/* =========================================================
   History + trail
   ========================================================= */
function addHistory(w) {
  state.history = [{ w, t: Date.now() }, ...state.history.filter(x => x.w.toLowerCase() !== w.toLowerCase())].slice(0, 300);
  save('lexi.history', state.history);
  renderTrail();
}
function renderTrail() {
  const cur = state.current?.data?.title?.toLowerCase();
  const trail = $('#trail');
  trail.replaceChildren(...state.history.slice(0, 20).map(x =>
    h('a', { class: 'chip' + (x.w.toLowerCase() === cur ? ' current' : ''), href: '#/' + encodeURIComponent(x.w), text: x.w })));
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString();
}
function openSheet() {
  const list = $('#historyList');
  list.replaceChildren(...(state.history.length
    ? state.history.map(x => h('li', null, h('a', { href: '#/' + encodeURIComponent(x.w) }, h('span', { text: x.w }), h('time', { text: ago(x.t) }))))
    : [h('li', { class: 'none', text: 'Words you look up will appear here.' })]));
  $('#sheetBackdrop').hidden = false;
  const sheet = $('#sheet');
  sheet.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  $('#sheetBackdrop').hidden = true;
}

/* =========================================================
   Routing
   ========================================================= */
function go(word) {
  word = norm(word);
  if (!word) return;
  const hash = '#/' + encodeURIComponent(word);
  if (location.hash === hash) route(); else location.hash = hash;
}

let routeToken = 0;
async function route() {
  closeSheet();
  const q = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!q) { state.current = null; renderTrail(); return render(); }
  const token = ++routeToken;
  renderLoading(q);
  window.scrollTo({ top: 0 });
  let data = null;
  try { data = await fetchEntry(q); } catch {
    if (token !== routeToken) return;
    state.current = null;
    const retry = h('button', { class: 'word-btn', text: 'Try again', onclick: route });
    return main.replaceChildren(h('section', { class: 'empty' }, h('h2', { text: 'Couldn’t reach the dictionary' }),
      h('p', { text: 'Check your connection and try again.' }), h('div', { class: 'chips' }, retry)));
  }
  if (token !== routeToken) return;
  state.current = { query: q, data };
  document.title = data ? `${data.title} — StudyTechAssistant` : 'StudyTechAssistant — Dictionary';
  if (data) addHistory(data.title); else renderTrail();
  render();
}

/* =========================================================
   Search + suggestions
   ========================================================= */
const input = $('#q');
const sugBox = $('#suggest');
let sugItems = [], sugSel = -1, sugCtl = null, sugTimer = 0, prefetchTimer = 0;

function showSuggest(words, q) {
  sugItems = words;
  sugSel = -1;
  if (!words.length) { hideSuggest(); return; }
  sugBox.replaceChildren(...words.map((w, i) => {
    const li = h('li', { role: 'option', id: 'sug' + i, 'aria-selected': 'false', data: { w: w.w } });
    if (q && w.w.toLowerCase().startsWith(q.toLowerCase())) li.append(h('span', null, w.w.slice(0, q.length), h('mark', { text: w.w.slice(q.length) })));
    else li.append(h('span', { text: w.w }));
    if (w.recent) li.append(h('span', { class: 'tag', text: 'recent' }));
    return li;
  }));
  sugBox.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}
function hideSuggest() {
  sugBox.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}
function markSel() {
  [...sugBox.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sugSel)));
  if (sugSel >= 0) input.setAttribute('aria-activedescendant', 'sug' + sugSel);
}

async function suggest(q) {
  const lq = q.toLowerCase();
  const recent = state.history.filter(x => x.w.toLowerCase().startsWith(lq)).slice(0, q ? 3 : 6).map(x => ({ w: x.w, recent: true }));
  if (!q) return showSuggest(recent, q);
  sugCtl?.abort();
  sugCtl = new AbortController();
  try {
    const res = await getJSON(DATAMUSE + 'sug?max=25&s=' + encodeURIComponent(q), sugCtl.signal);
    if (input.value.trim() !== q) return;
    // single words only ("category", not "category 3" / "category theory"), each spelling once
    const multi = /\s/.test(q);
    const seen = new Set(recent.map(r => r.w.toLowerCase()));
    const words = [];
    for (const { word } of res) {
      const k = word.toLowerCase();
      if (seen.has(k) || (!multi && !/^[a-z][a-z'’-]*$/i.test(word))) continue;
      seen.add(k);
      words.push({ w: word });
    }
    const list = [...recent, ...words].slice(0, 8);
    showSuggest(list, q);
    clearTimeout(prefetchTimer);
    if (list[0]) prefetchTimer = setTimeout(() => fetchEntry(list[0].w), 450);
  } catch { /* aborted */ }
}

input.addEventListener('input', () => {
  const q = input.value.trim();
  $('#clearQ').hidden = !input.value;
  clearTimeout(sugTimer);
  sugTimer = setTimeout(() => suggest(q), 90);
});
input.addEventListener('focus', () => suggest(input.value.trim()));
input.addEventListener('blur', () => setTimeout(hideSuggest, 150));
input.addEventListener('keydown', (e) => {
  if (sugBox.hidden || !sugItems.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); sugSel = (sugSel + 1) % sugItems.length; markSel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sugSel = (sugSel - 1 + sugItems.length) % sugItems.length; markSel(); }
  else if (e.key === 'Escape') hideSuggest();
});
sugBox.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus so click registers
sugBox.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) submit(li.dataset.w);
});
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submit(sugSel >= 0 ? sugItems[sugSel].w : input.value);
});
$('#clearQ').addEventListener('click', () => { input.value = ''; $('#clearQ').hidden = true; input.focus(); suggest(''); });

function submit(w) {
  w = norm(w || '');
  if (!w) return;
  input.value = '';
  $('#clearQ').hidden = true;
  hideSuggest();
  input.blur();
  go(w);
}

/* =========================================================
   Level control
   ========================================================= */
function setLevel(l, rerender) {
  state.level = l;
  save('lexi.level', l);
  document.querySelectorAll('#levels button').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.level === l)));
  $('#levels .pill').style.transform = `translateX(${l * 100}%)`;
  if (rerender && state.current) {
    const y = window.scrollY;
    render();
    window.scrollTo({ top: Math.min(y, document.body.scrollHeight) });
  }
}
$('#levels').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-level]');
  if (b) setLevel(+b.dataset.level, true);
});

/* =========================================================
   Global taps: any tappable word or word button
   ========================================================= */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-w]');
  if (!t || t.closest('#suggest')) return;
  e.preventDefault();
  go(t.dataset.w);
});
$('#historyBtn').addEventListener('click', openSheet);
$('#sheetBackdrop').addEventListener('click', closeSheet);
$('#clearHistory').addEventListener('click', () => {
  state.history = [];
  save('lexi.history', []);
  renderTrail();
  openSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
});
if ('speechSynthesis' in window) speechSynthesis.getVoices();

window.addEventListener('hashchange', route);
setLevel(state.level, false);
renderTrail();
route();
