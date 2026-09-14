/*
 * Content script: finds prices in the page and rewrites them in the user's currency.
 *
 * DOM strategy (kept friendly to React/Vue-managed pages):
 *  - Never remove a page-owned text node. We only change its nodeValue, and insert our own
 *    <span>s after it when a price sits inside a longer sentence.
 *  - Prices split across elements (e.g. <span>$</span><span>19</span><sup>99</sup>) are
 *    rewritten in place: the converted value goes into one text node, the others are blanked.
 *  - Everything is reversible, so changing settings or disabling restores the original page.
 */
(() => {
  'use strict';

  if (globalThis.__priceLocalizerLoaded) return;
  globalThis.__priceLocalizerLoaded = true;

  const PL = globalThis.PriceLocalizer;
  const OWNER_ATTR = 'data-price-localizer';
  const SPAN_ATTR = 'data-price-localizer-span';
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option',
    'code', 'pre', 'kbd', 'samp', 'svg', 'math', 'canvas', 'iframe', 'head', 'title',
  ]);
  const SKIP_SELECTOR = [...SKIP_TAGS, `[${SPAN_ATTR}]`, '[contenteditable]:not([contenteditable="false"])'].join(',');
  const MAX_CLIMB = 4; // how many ancestors to inspect for prices split across elements
  const MAX_OWNER_TEXT = 48;
  const MAX_TEXT_NODE = 20000;
  const MAX_CHURN = 25; // stop fighting a page that keeps rewriting the same price
  const OBSERVE_OPTS = { childList: true, subtree: true, characterData: true };

  let settings = { ...PL.DEFAULT_SETTINGS };
  let rates = null;
  let active = false;
  let ctx = null;

  const written = new WeakMap(); // Text -> the value we wrote into it
  const ownerOfText = new WeakMap(); // Text -> element whose text we rewrote in place
  const ownerState = new WeakMap(); // element -> info needed to restore it
  const splitState = new WeakMap(); // Text -> { original, inserted: Node[] }
  const spanOrigin = new WeakMap(); // our <span> -> the Text it was split from
  const churn = new WeakMap(); // node -> number of times the page overwrote our conversion
  const ours = new WeakSet(); // nodes we created
  const roots = new Set([document]); // document + open shadow roots we've found
  const observer = new MutationObserver(onMutations);

  // ---- Conversion ---------------------------------------------------------

  function convert(groups, original) {
    const read = PL.readMatch(groups, ctx);
    if (!read || read.from === ctx.target) return null;
    const fromRate = ctx.rateTable[read.from];
    if (!fromRate) return null;
    const factor = ctx.targetRate / fromRate;
    const text = PL.formatMoney(read.amount * factor, ctx.target, {
      ...ctx.formatOpts,
      compact: read.compact,
      amount2: read.amount2 == null ? null : read.amount2 * factor,
    });
    const title = `${original.trim()} → ${text}\n1 ${read.from} = ${formatRate(factor)} ${ctx.target}${ctx.rateDate}`;
    return { text, title };
  }

  function formatRate(factor) {
    const opts = factor >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
    return factor.toLocaleString(navigator.language, opts);
  }

  const countDigits = (s) => (s.match(/[0-9٠-٩]/g) || []).length;

  // ---- Scanning -----------------------------------------------------------

  function rejectElement(el) {
    return (
      SKIP_TAGS.has(el.localName) ||
      el.hasAttribute(SPAN_ATTR) ||
      (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false')
    );
  }

  function isSkipped(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !el || Boolean(el.closest(SKIP_SELECTOR));
  }

  function scan(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      processText(root);
      return;
    }
    const shadows = [];
    if (root.shadowRoot) shadows.push(root.shadowRoot);
    const texts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (rejectElement(n)) return NodeFilter.FILTER_REJECT;
        if (n.shadowRoot) shadows.push(n.shadowRoot);
        return NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
    texts.forEach(processText);
    for (const shadow of shadows) {
      roots.add(shadow);
      scan(shadow);
    }
  }

  function processText(node) {
    const text = node.nodeValue;
    if (!text || text.length > MAX_TEXT_NODE || written.has(node) || ours.has(node) || !node.isConnected) return;

    const hasDigit = PL.HAS_DIGIT_RE.test(text);
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= 24 && (hasDigit || PL.HAS_TOKEN_RE.test(trimmed)) && convertSplitPrice(node, trimmed)) return;
    if (!hasDigit) return;

    const hits = [];
    for (const m of text.matchAll(PL.PRICE_RE)) {
      const conv = convert(m.groups, m[0]);
      if (conv) hits.push({ index: m.index, length: m[0].length, conv });
    }
    if (!hits.length) return;

    const parent = node.parentElement;
    const wholeNode = hits.length === 1 && hits[0].length === text.trim().length;
    if (wholeNode && parent && parent.childNodes.length === 1 && !parent.closest(`[${OWNER_ATTR}]`)) {
      rewriteOwner(parent, [node], hits[0].conv);
    } else {
      splitText(node, hits);
    }
  }

  /** Handle prices whose parts live in separate elements, e.g. Amazon's "$" "19" "." "99". */
  function convertSplitPrice(node, ownText) {
    let el = node.parentElement;
    for (let i = 0; el && i < MAX_CLIMB; i++, el = el.parentElement) {
      if (el === document.body || el === document.documentElement || SKIP_TAGS.has(el.localName)) return false;
      if (el.hasAttribute(OWNER_ATTR)) return true;
      const info = collectText(el);
      if (!info) return false; // too long, or already converted — ancestors will be too
      if (info.text === ownText) continue;
      const m = PL.FULL_PRICE_RE.exec(info.text);
      if (!m) continue;
      const conv = convert(m.groups, info.text);
      if (conv) rewriteOwner(el, info.nodes, conv);
      return true;
    }
    return false;
  }

  function collectText(el) {
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === Node.TEXT_NODE
          ? NodeFilter.FILTER_ACCEPT
          : SKIP_TAGS.has(n.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (written.has(n) || ours.has(n)) return null;
      const v = n.nodeValue;
      if (v.trim()) {
        // "$19<sup>99</sup>" means 19.99, not 1999
        if (/^\s*\d{2}\s*$/.test(v) && /\d$/.test(text) && isSuperscript(n.parentElement, el)) text += '.';
        nodes.push(n);
      }
      text += v;
      if (text.length > MAX_OWNER_TEXT * 2) return null;
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text && text.length <= MAX_OWNER_TEXT ? { text, nodes } : null;
  }

  function isSuperscript(el, stop) {
    if (!el || el === stop) return false;
    if (el.localName === 'sup') return true;
    const align = getComputedStyle(el).verticalAlign;
    return align === 'super' || align === 'top' || align === 'text-top';
  }

  // ---- DOM rewriting ------------------------------------------------------

  function paint(el, state) {
    state.styled.push({
      el,
      hadStyle: el.hasAttribute('style'),
      value: el.style.getPropertyValue('color'),
      priority: el.style.getPropertyPriority('color'),
    });
    el.style.setProperty('color', settings.color, 'important');
  }

  function rewriteOwner(el, nodes, conv) {
    // Put the converted value where the most digits were (the "19" rather than the "$").
    let target = nodes[0];
    let most = -1;
    for (const n of nodes) {
      const digits = countDigits(n.nodeValue);
      if (digits > most) {
        most = digits;
        target = n;
      }
    }
    const state = { texts: [], styled: [], title: null };
    for (const n of nodes) {
      const value = n === target ? conv.text : '';
      state.texts.push({ node: n, original: n.nodeValue });
      n.nodeValue = value;
      written.set(n, value);
      ownerOfText.set(n, el);
    }
    // Paint every element from the visible text up to the owner so child colour rules can't win.
    for (let e = target.parentElement; e; e = e.parentElement) {
      paint(e, state);
      if (e === el) break;
    }
    if (settings.showTooltip && !el.hasAttribute('title')) {
      el.setAttribute('title', conv.title);
      state.title = conv.title;
    }
    el.setAttribute(OWNER_ATTR, '');
    ownerState.set(el, state);
  }

  function ownText(value, inserted) {
    const t = document.createTextNode(value);
    ours.add(t);
    inserted.push(t);
    return t;
  }

  function splitText(node, hits) {
    const parent = node.parentNode;
    if (!parent) return;
    const text = node.nodeValue;
    const inserted = [];
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let head = null;
    for (const { index, length, conv } of hits) {
      const before = text.slice(cursor, index);
      if (head === null) head = before;
      else if (before) frag.append(ownText(before, inserted));

      const span = document.createElement('span');
      span.setAttribute(SPAN_ATTR, '');
      span.style.setProperty('color', settings.color, 'important');
      if (settings.showTooltip) span.title = conv.title;
      const label = document.createTextNode(conv.text);
      ours.add(label);
      ours.add(span);
      span.append(label);
      spanOrigin.set(span, node);
      inserted.push(span);
      frag.append(span);
      cursor = index + length;
    }
    const tail = text.slice(cursor);
    if (tail) frag.append(ownText(tail, inserted));

    parent.insertBefore(frag, node.nextSibling);
    node.nodeValue = head;
    written.set(node, head);
    splitState.set(node, { original: text, inserted });
  }

  // Restoring only touches text we still own: if the page changed a node, its new value wins.
  function releaseOwner(el) {
    const state = ownerState.get(el);
    el.removeAttribute(OWNER_ATTR);
    if (!state) return;
    for (const { node, original } of state.texts) {
      if (written.get(node) === node.nodeValue) node.nodeValue = original;
      written.delete(node);
      ownerOfText.delete(node);
    }
    for (const { el: styled, hadStyle, value, priority } of state.styled) {
      if (value) styled.style.setProperty('color', value, priority);
      else styled.style.removeProperty('color');
      if (!hadStyle && styled.getAttribute('style') === '') styled.removeAttribute('style');
    }
    if (state.title !== null && el.getAttribute('title') === state.title) el.removeAttribute('title');
    ownerState.delete(el);
  }

  function releaseSplit(node) {
    const state = splitState.get(node);
    if (!state) return;
    for (const n of state.inserted) n.remove();
    if (written.get(node) === node.nodeValue) node.nodeValue = state.original;
    written.delete(node);
    splitState.delete(node);
  }

  function revertAll() {
    for (const root of roots) {
      root.querySelectorAll(`[${OWNER_ATTR}]`).forEach(releaseOwner);
      root.querySelectorAll(`[${SPAN_ATTR}]`).forEach((span) => {
        const origin = spanOrigin.get(span);
        if (origin && splitState.has(origin)) releaseSplit(origin);
        else span.remove();
      });
    }
  }

  // ---- Watching the page --------------------------------------------------

  function withoutObserver(fn) {
    const pending = observer.takeRecords();
    observer.disconnect();
    try {
      fn(pending);
    } finally {
      if (active) {
        for (const root of roots) {
          if (root !== document && !root.host.isConnected) {
            roots.delete(root);
            continue;
          }
          observer.observe(root, OBSERVE_OPTS);
        }
      }
    }
  }

  function pageOverwrote(node) {
    const count = (churn.get(node) || 0) + 1;
    churn.set(node, count);
    return count <= MAX_CHURN;
  }

  function onMutations(records) {
    if (!active) return;
    withoutObserver((pending) => {
      const queue = new Set();
      for (const r of records.concat(pending)) {
        if (r.type === 'characterData') {
          const n = r.target;
          if (ours.has(n)) continue;
          if (!written.has(n)) {
            queue.add(n);
          } else if (written.get(n) !== n.nodeValue) {
            // The page updated a price we had converted (e.g. quantity changed).
            const owner = ownerOfText.get(n);
            if (owner) {
              releaseOwner(owner);
              if (pageOverwrote(owner)) queue.add(owner);
            } else if (splitState.has(n)) {
              releaseSplit(n);
              if (pageOverwrote(n)) queue.add(n);
            }
          }
          continue;
        }

        for (const n of r.removedNodes) if (splitState.has(n)) releaseSplit(n);
        const owner = r.target.nodeType === Node.ELEMENT_NODE && r.target.closest(`[${OWNER_ATTR}]`);
        if (owner) {
          releaseOwner(owner);
          if (pageOverwrote(owner)) queue.add(owner);
          continue;
        }
        for (const n of r.addedNodes) if (!ours.has(n)) queue.add(n);
      }
      for (const n of queue) if (n.isConnected && !isSkipped(n)) scan(n);
    });
  }

  // ---- Lifecycle ----------------------------------------------------------

  function shouldRun() {
    return (
      settings.enabled &&
      rates?.rates?.[settings.targetCurrency] &&
      !settings.disabledSites.includes(location.hostname) &&
      document.designMode !== 'on'
    );
  }

  function start() {
    if (active || !shouldRun()) return;
    const updated = rates.updatedAt ? new Date(rates.updatedAt) : null;
    ctx = {
      tld: PL.countryTld(location.hostname),
      dollarCurrency: settings.dollarCurrency,
      target: settings.targetCurrency,
      rateTable: rates.rates,
      targetRate: rates.rates[settings.targetCurrency],
      rateDate: updated ? ` · rates of ${updated.toLocaleDateString(navigator.language, { day: 'numeric', month: 'short' })}` : '',
      formatOpts: { display: settings.currencyDisplay, round: settings.roundWhole, locale: navigator.language },
    };
    active = true;
    withoutObserver(() => scan(document.body || document.documentElement));
  }

  function stop() {
    if (!active) return;
    active = false;
    observer.takeRecords();
    observer.disconnect();
    revertAll();
  }

  function restart() {
    stop();
    start();
  }

  function requestRatesIfStale() {
    const now = Date.now();
    const stale = !rates?.rates || now > (rates.nextUpdateAt || 0) + 60 * 60 * 1000;
    if (stale) chrome.runtime.sendMessage({ type: 'pl:refreshRates' }).catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    let changed = false;
    if (area === 'sync' && changes.settings) {
      settings = { ...PL.DEFAULT_SETTINGS, ...changes.settings.newValue };
      changed = true;
    }
    if (area === 'local' && changes.rates) {
      rates = changes.rates.newValue || null;
      changed = true;
    }
    if (changed) restart();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'pl:pageInfo') return;
    let count = 0;
    for (const root of roots) {
      root.querySelectorAll(`[${OWNER_ATTR}],[${SPAN_ATTR}]`).forEach((el) => {
        if (!el.checkVisibility || el.checkVisibility()) count++;
      });
    }
    sendResponse({ hostname: location.hostname, active, count });
  });

  Promise.all([chrome.storage.sync.get('settings'), chrome.storage.local.get('rates')]).then(([sync, local]) => {
    settings = { ...PL.DEFAULT_SETTINGS, ...sync.settings };
    rates = local.rates || null;
    requestRatesIfStale();
    start();
  });
})();
