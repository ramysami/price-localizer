/*
 * Background service worker: keeps exchange rates fresh in chrome.storage.local.
 *
 * Rates are USD-based. The primary provider publishes new rates daily and tells us when the
 * next update is due; we check every 30 minutes and fetch as soon as a new set is available.
 */
importScripts('shared.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ALARM = 'refresh-rates';
const RETRY_DELAY = 5 * 60 * 1000;

const PROVIDERS = [
  {
    name: 'ExchangeRate-API',
    home: 'https://www.exchangerate-api.com',
    urls: ['https://open.er-api.com/v6/latest/USD'],
    parse(json) {
      if (json.result !== 'success' || !json.rates) throw new Error(json['error-type'] || 'Unexpected response');
      return {
        rates: json.rates,
        updatedAt: json.time_last_update_unix * 1000,
        nextUpdateAt: json.time_next_update_unix * 1000,
      };
    },
  },
  {
    name: 'Currency API',
    home: 'https://github.com/fawazahmed0/exchange-api',
    urls: [
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    ],
    parse(json) {
      if (!json.usd) throw new Error('Unexpected response');
      const rates = {};
      for (const [code, value] of Object.entries(json.usd)) {
        if (/^[a-z]{3}$/.test(code) && value > 0) rates[code.toUpperCase()] = value;
      }
      const updatedAt = Date.parse(`${json.date}T00:00:00Z`);
      return { rates, updatedAt, nextUpdateAt: updatedAt + DAY };
    },
  },
];

function isStale(record, now) {
  if (!record?.rates) return true;
  if (now - record.fetchedAt > DAY) return true;
  // Fell back to a secondary provider last time: try the primary again after an hour.
  if (record.provider !== PROVIDERS[0].name && now - record.fetchedAt > HOUR) return true;
  return now >= (record.nextUpdateAt || 0);
}

let inflight = null;

function refreshRates({ force = false } = {}) {
  if (!inflight) inflight = doRefresh(force).finally(() => (inflight = null));
  return inflight;
}

async function doRefresh(force) {
  const { rates, rateStatus } = await chrome.storage.local.get(['rates', 'rateStatus']);
  const now = Date.now();
  if (!force && !isStale(rates, now)) return { ok: true, rates };
  if (!force && rateStatus?.error && now - rateStatus.lastAttemptAt < RETRY_DELAY) {
    return { ok: false, error: rateStatus.error, rates };
  }

  const errors = [];
  for (const provider of PROVIDERS) {
    for (const url of provider.urls) {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = provider.parse(await res.json());
        parsed.rates.USD = 1;
        const record = { base: 'USD', provider: provider.name, providerUrl: provider.home, ...parsed, fetchedAt: now };
        await chrome.storage.local.set({ rates: record, rateStatus: { lastAttemptAt: now, error: null } });
        return { ok: true, rates: record };
      } catch (err) {
        errors.push(`${provider.name}: ${err.message}`);
      }
    }
  }
  const error = errors.join(' · ');
  await chrome.storage.local.set({ rateStatus: { lastAttemptAt: now, error } });
  return { ok: false, error, rates };
}

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((alarm) => {
    if (!alarm) chrome.alarms.create(ALARM, { periodInMinutes: 30 });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get('settings');
  await chrome.storage.sync.set({ settings: { ...PriceLocalizer.DEFAULT_SETTINGS, ...settings } });
  ensureAlarm();
  refreshRates();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshRates();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshRates();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'pl:refreshRates') return;
  refreshRates({ force: Boolean(msg.force) }).then(sendResponse);
  return true;
});
