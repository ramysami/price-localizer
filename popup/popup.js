const PL = globalThis.PriceLocalizer;
const $ = (id) => document.getElementById(id);

const DOLLAR_CHOICES = ['USD', 'CAD', 'AUD', 'NZD', 'MXN', 'SGD', 'HKD', 'TWD', 'ARS', 'CLP', 'COP'];
const locale = navigator.language;

let settings = { ...PL.DEFAULT_SETTINGS };
let rates = null;
let rateStatus = null;
let page = { tabId: null, host: '', info: null };

init();

async function init() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.local.get(['rates', 'rateStatus']),
  ]);
  settings = { ...PL.DEFAULT_SETTINGS, ...sync.settings };
  rates = local.rates || null;
  rateStatus = local.rateStatus || null;

  renderAll();
  bindEvents();
  loadPageInfo();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.rates || changes.rateStatus)) {
      if (changes.rates) rates = changes.rates.newValue || null;
      if (changes.rateStatus) rateStatus = changes.rateStatus.newValue || null;
      renderCurrencyOptions();
      renderRates();
      refreshPageInfoSoon();
    }
  });

  // Let the background fetch new rates if the current ones are due for an update.
  chrome.runtime.sendMessage({ type: 'pl:refreshRates' }).catch(() => {});
}

function save(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.sync.set({ settings });
  renderAll();
  refreshPageInfoSoon();
}

function bindEvents() {
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('target').addEventListener('change', (e) => save({ targetCurrency: e.target.value }));
  $('display').addEventListener('change', (e) => save({ currencyDisplay: e.target.value }));
  $('dollar').addEventListener('change', (e) => save({ dollarCurrency: e.target.value }));
  $('roundWhole').addEventListener('change', (e) => save({ roundWhole: e.target.checked }));
  $('showTooltip').addEventListener('change', (e) => save({ showTooltip: e.target.checked }));
  // Preview while dragging, persist once the picker closes (storage.sync has write quotas).
  $('color').addEventListener('input', (e) => ($('colorSample').style.color = e.target.value));
  $('color').addEventListener('change', (e) => save({ color: e.target.value }));

  $('siteEnabled').addEventListener('change', (e) => {
    const sites = new Set(settings.disabledSites);
    if (e.target.checked) sites.delete(page.host);
    else sites.add(page.host);
    save({ disabledSites: [...sites] });
  });

  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    btn.classList.add('spinning');
    btn.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'pl:refreshRates', force: true });
      if (result && !result.ok) showError(`Couldn't refresh rates. ${result.error}`);
    } catch (err) {
      showError(`Couldn't refresh rates. ${err.message}`);
    } finally {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
  });
}

// ---- Rendering -----------------------------------------------------------

function renderAll() {
  $('enabled').checked = settings.enabled;
  $('roundWhole').checked = settings.roundWhole;
  $('showTooltip').checked = settings.showTooltip;
  $('color').value = settings.color;
  document.querySelector('.app').classList.toggle('off', !settings.enabled);
  $('status').textContent = settings.enabled ? `Converting prices to ${settings.targetCurrency}` : 'Paused everywhere';

  renderCurrencyOptions();
  renderDisplayOptions();
  renderDollarOptions();
  renderRates();
  renderSite();

  const sample = $('colorSample');
  sample.textContent = PL.formatMoney(1250, settings.targetCurrency, sampleOpts());
  sample.style.color = settings.color;
}

function sampleOpts(display = settings.currencyDisplay) {
  return { display, round: settings.roundWhole, locale };
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function renderCurrencyOptions() {
  const select = $('target');
  const codes = new Set(rates?.rates ? Object.keys(rates.rates) : PL.POPULAR);
  codes.add(settings.targetCurrency);

  const named = [...codes]
    .map((code) => ({ code, name: PL.currencyName(code, locale) }))
    .filter(({ code, name }) => name !== code || code === settings.targetCurrency)
    .sort((a, b) => a.name.localeCompare(b.name));

  const popular = document.createElement('optgroup');
  popular.label = 'Popular';
  for (const code of PL.POPULAR) {
    if (codes.has(code)) popular.append(option(code, `${code} — ${PL.currencyName(code, locale)}`));
  }
  const all = document.createElement('optgroup');
  all.label = 'All currencies';
  for (const { code, name } of named) all.append(option(code, `${code} — ${name}`));

  select.replaceChildren(popular, all);
  select.value = settings.targetCurrency;
}

function renderDisplayOptions() {
  const select = $('display');
  const currencyPart = (display) => {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: settings.targetCurrency, currencyDisplay: display });
    return fmt.formatToParts(1).find((p) => p.type === 'currency')?.value || settings.targetCurrency;
  };
  select.replaceChildren(
    ...[
      ['symbol', 'Symbol'],
      ['narrowSymbol', 'Short symbol'],
      ['code', 'Code'],
    ].map(([value, label]) => option(value, `${label} (${currencyPart(value)})`)),
  );
  select.value = settings.currencyDisplay;
}

function renderDollarOptions() {
  const select = $('dollar');
  select.replaceChildren(
    option('auto', 'Auto (by website)'),
    ...DOLLAR_CHOICES.map((code) => option(code, `${code} — ${PL.currencyName(code, locale)}`)),
  );
  select.value = settings.dollarCurrency;
}

function renderRates() {
  const target = settings.targetCurrency;
  const table = rates?.rates;
  $('rateError').hidden = true;

  if (!table) {
    $('ratePreview').textContent = '–';
    $('rateMeta').textContent = rateStatus?.error ? 'Exchange rates unavailable' : 'Loading exchange rates…';
    if (rateStatus?.error) showError(rateStatus.error);
    return;
  }

  const base = target === 'USD' ? 'EUR' : 'USD';
  if (table[target] && table[base]) {
    const value = table[target] / table[base];
    const opts = value >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
    $('ratePreview').textContent = `1 ${base} = ${value.toLocaleString(locale, opts)} ${target}`;
  } else {
    $('ratePreview').textContent = `No rate available for ${target}`;
  }

  const parts = [`Updated ${relativeTime(rates.updatedAt)}`, rates.provider];
  if (rates.nextUpdateAt > Date.now()) parts.push(`next ${relativeTime(rates.nextUpdateAt)}`);
  $('rateMeta').textContent = parts.join(' · ');
  $('rateMeta').title = `Rates published ${new Date(rates.updatedAt).toLocaleString(locale)}\nFetched ${new Date(rates.fetchedAt).toLocaleString(locale)}\nSource: ${rates.providerUrl}`;

  if (rateStatus?.error) showError(`Last refresh failed, using saved rates. ${rateStatus.error}`);
}

function showError(message) {
  $('rateError').textContent = message;
  $('rateError').hidden = false;
}

function relativeTime(ts) {
  const diff = ts - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60 * 60 * 1000) return rtf.format(Math.round(diff / 60000), 'minute');
  if (abs < 48 * 60 * 60 * 1000) return rtf.format(Math.round(diff / 3600000), 'hour');
  return rtf.format(Math.round(diff / 86400000), 'day');
}

// ---- Current tab -----------------------------------------------------------

async function loadPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    page.tabId = tab?.id ?? null;
    try {
      const url = new URL(tab.url);
      page.host = /^https?:$/.test(url.protocol) || url.protocol === 'file:' ? url.hostname : '';
    } catch {
      page.host = '';
    }
    await queryContentScript();
  } finally {
    renderSite();
  }
}

async function queryContentScript() {
  if (page.tabId == null) return;
  try {
    page.info = await chrome.tabs.sendMessage(page.tabId, { type: 'pl:pageInfo' }, { frameId: 0 });
    if (page.info?.hostname) page.host = page.info.hostname;
  } catch {
    page.info = null;
  }
}

let refreshTimer = null;
function refreshPageInfoSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await queryContentScript();
    renderSite();
  }, 250);
}

function renderSite() {
  const toggle = $('siteEnabled');
  const stats = $('siteStats');
  const siteDisabled = settings.disabledSites.includes(page.host);

  if (!page.host && !page.info) {
    $('siteName').textContent = 'This page';
    stats.textContent = 'Chrome doesn’t allow extensions to change this page.';
    toggle.checked = false;
    toggle.disabled = true;
    return;
  }

  $('siteName').textContent = page.host || 'This page';
  toggle.disabled = !settings.enabled || !page.host;
  toggle.checked = !siteDisabled;

  if (!settings.enabled) stats.textContent = 'Paused everywhere';
  else if (siteDisabled) stats.textContent = 'Paused on this site';
  else if (!page.info) stats.textContent = 'Reload the page to start converting';
  else if (!rates?.rates) stats.textContent = 'Waiting for exchange rates…';
  else if (page.info.count === 0) stats.textContent = 'No prices to convert on this page';
  else stats.textContent = `${page.info.count.toLocaleString(locale)} price${page.info.count === 1 ? '' : 's'} converted`;
}
