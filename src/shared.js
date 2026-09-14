/*
 * Shared currency data and price parsing.
 * Loaded by the content script, the popup and the background service worker.
 */
(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetCurrency: 'EGP',
    color: '#16a34a',
    dollarCurrency: 'auto', // what a bare "$" means: 'auto' (guess from site TLD) or an ISO code
    currencyDisplay: 'symbol', // 'symbol' | 'narrowSymbol' | 'code'
    roundWhole: false,
    showTooltip: true,
    disabledSites: [],
  };

  // Symbols/abbreviations that identify exactly one currency.
  const SYMBOLS = {
    'US$': 'USD', 'U$S': 'USD',
    'C$': 'CAD', 'CA$': 'CAD', 'CAN$': 'CAD',
    'A$': 'AUD', 'AU$': 'AUD',
    'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD', 'SG$': 'SGD',
    'MX$': 'MXN', 'Mex$': 'MXN', 'R$': 'BRL', 'NT$': 'TWD',
    'N$': 'NAD', 'J$': 'JMD', 'TT$': 'TTD', 'RD$': 'DOP', 'COL$': 'COP', 'CLP$': 'CLP',
    '€': 'EUR', '£': 'GBP', '₹': 'INR', '₩': 'KRW', '원': 'KRW', '円': 'JPY',
    'JP¥': 'JPY', 'CN¥': 'CNY', 'RMB': 'CNY',
    '₽': 'RUB', 'руб.': 'RUB', 'руб': 'RUB',
    '₺': 'TRY', 'TL': 'TRY', '₪': 'ILS', '฿': 'THB', '₫': 'VND', '₱': 'PHP',
    'zł': 'PLN', '₴': 'UAH', '₦': 'NGN', '₸': 'KZT', '₡': 'CRC', '₵': 'GHS', 'GH₵': 'GHS',
    '₲': 'PYG', '₼': 'AZN', '₾': 'GEL', '៛': 'KHR', '₮': 'MNT', '֏': 'AMD', '৳': 'BDT', '₨': 'PKR',
    'Kč': 'CZK', 'lei': 'RON', 'Rp': 'IDR', 'RM': 'MYR', 'KSh': 'KES', 'S/': 'PEN', 'SFr.': 'CHF',
    'E£': 'EGP', 'LE': 'EGP', 'L.E.': 'EGP', 'L.E': 'EGP', 'ج.م.': 'EGP', 'ج.م': 'EGP', 'جنيه': 'EGP',
    'د.إ': 'AED', 'ر.س': 'SAR', 'د.ك': 'KWD', 'ر.ق': 'QAR', 'د.ب': 'BHD', 'ر.ع.': 'OMR',
    'د.ا': 'JOD', 'د.م.': 'MAD', 'د.ت': 'TND', 'ل.ل': 'LBP', 'ع.د': 'IQD',
  };

  // ISO codes recognised next to a number. Codes that are also common words or
  // product names (ALL, TRY, PHP, AMD, PEN, GEL, TOP, CUP, BOB, NPR…) are left out.
  const CODES = [
    'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'ISK',
    'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'RSD', 'RUB', 'UAH', 'ILS', 'AED', 'SAR', 'QAR', 'KWD', 'BHD',
    'OMR', 'JOD', 'EGP', 'MAD', 'TND', 'DZD', 'LYD', 'SDG', 'IQD', 'LBP', 'SYP', 'YER', 'NGN', 'KES',
    'GHS', 'ZAR', 'ETB', 'TZS', 'UGX', 'XAF', 'XOF', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'UYU', 'PYG',
    'VES', 'DOP', 'CRC', 'GTQ', 'JMD', 'TTD', 'HKD', 'SGD', 'TWD', 'KRW', 'THB', 'VND', 'IDR', 'MYR',
    'PKR', 'BDT', 'LKR', 'KZT', 'AZN', 'IRR', 'AFN',
  ];
  for (const code of CODES) SYMBOLS[code] = code;

  // Symbols shared by several currencies; resolved from the site's country TLD.
  const DOLLAR_TLDS = {
    ca: 'CAD', au: 'AUD', nz: 'NZD', mx: 'MXN', ar: 'ARS', cl: 'CLP', co: 'COP',
    sg: 'SGD', hk: 'HKD', tw: 'TWD', uy: 'UYU', jm: 'JMD', tt: 'TTD', na: 'NAD',
  };
  const YEN = { fallback: 'JPY', byTld: { cn: 'CNY' } };
  const KRONA = { fallback: null, byTld: { se: 'SEK', no: 'NOK', dk: 'DKK', is: 'ISK' } };
  const RUPEE = { fallback: 'INR', byTld: { pk: 'PKR', lk: 'LKR', np: 'NPR' } };
  const AMBIGUOUS = {
    '$': { fallback: 'USD', byTld: DOLLAR_TLDS },
    '¥': YEN, '￥': YEN,
    'kr': KRONA, 'kr.': KRONA,
    'Rs': RUPEE, 'Rs.': RUPEE,
  };

  // Currencies whose prices conventionally use "." as the thousands separator.
  const COMMA_DECIMAL = new Set([
    'EUR', 'BRL', 'TRY', 'RUB', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'RSD', 'SEK', 'NOK', 'DKK', 'ISK',
    'IDR', 'VND', 'ARS', 'CLP', 'COP', 'UYU', 'PYG', 'UAH', 'KZT',
  ]);

  const POPULAR = ['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED', 'KWD', 'QAR', 'TRY', 'INR', 'JPY', 'CNY', 'CAD', 'AUD'];

  const MAGNITUDES = {
    k: 1e3, K: 1e3, thousand: 1e3,
    m: 1e6, M: 1e6, mn: 1e6, MM: 1e6, million: 1e6, Million: 1e6,
    b: 1e9, B: 1e9, bn: 1e9, billion: 1e9, Billion: 1e9,
    trillion: 1e12, Trillion: 1e12,
  };

  // ---- Regex construction -------------------------------------------------

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  const allTokens = [...Object.keys(SYMBOLS), ...Object.keys(AMBIGUOUS)].sort((a, b) => b.length - a.length);
  const TOKEN = `(?:${allTokens.map(escapeRe).join('|')})`;
  const CODE = `(?:${CODES.join('|')})`;

  const D = '[0-9\\u0660-\\u0669]';
  const GROUP_SEP = "[,.'\\u2019\\u00A0\\u202F\\u2009\\u066C]";
  const DEC_SEP = '[.,\\u066B]';
  // 1,234.56 | 1.234,56 | 1 234,56 | 2,49,999 | 1234.5 | 12,99 | 3.459 | 0.00012 — never a partial number.
  const NUMBER =
    `(?:${D}{1,3}(?:,${D}{2})+,${D}{3}(?:\\.${D}{1,2})?` +
    `|${D}{1,3}(?:${GROUP_SEP}${D}{3})+(?:${DEC_SEP}${D}{1,2})?` +
    `|0${DEC_SEP}${D}{1,8}` +
    `|${D}+(?:${DEC_SEP}${D}{1,3})?)(?!${D}|${DEC_SEP}${D})`;
  const MAG = `(?:\\s?(?:${Object.keys(MAGNITUDES).sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}\\p{N}]))`;
  const DASH = '\\s{0,2}[-\\u2013\\u2014]\\s{0,2}';

  const PREFIX_FORM =
    `(?<![\\p{L}\\p{N}])(?<pTok>${TOKEN})\\s{0,2}(?<pN1>${NUMBER})(?<pM1>${MAG})?` +
    `(?:${DASH}(?:${TOKEN}\\s{0,2})?(?<pN2>${NUMBER})(?<pM2>${MAG})?(?!\\s?%))?` +
    `(?:\\s(?<pTrail>${CODE})(?![\\p{L}\\p{N}]))?`;
  const SUFFIX_FORM =
    `(?<![\\p{L}\\p{N}.,])(?<sN1>${NUMBER})(?:${DASH}(?<sN2>${NUMBER}))?(?<sM>${MAG})?\\s{0,2}(?<sTok>${TOKEN})(?![\\p{L}\\p{N}])`;

  const PRICE_SOURCE = `(?:${PREFIX_FORM}|${SUFFIX_FORM})`;
  const PRICE_RE = new RegExp(PRICE_SOURCE, 'gu');
  const FULL_PRICE_RE = new RegExp(`^${PRICE_SOURCE}$`, 'u');
  const HAS_DIGIT_RE = /[0-9٠-٩]/;
  const HAS_TOKEN_RE = new RegExp(TOKEN, 'u');

  // ---- Parsing ------------------------------------------------------------

  function parseAmount(raw, currency) {
    let s = raw
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/٫/g, '.')
      .replace(/٬/g, ',')
      .replace(/[\s'’]/g, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      const dec = lastDot > lastComma ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (lastDot >= 0 || lastComma >= 0) {
      const sep = lastDot >= 0 ? '.' : ',';
      const parts = s.split(sep);
      if (parts.length > 2) {
        s = parts.join('');
      } else {
        const [int, frac] = parts;
        const grouped = frac.length === 3 && int !== '0' && (sep === ',' || COMMA_DECIMAL.has(currency));
        s = grouped ? int + frac : `${int}.${frac}`;
      }
    }
    return parseFloat(s);
  }

  const magnitude = (mag) => (mag ? MAGNITUDES[mag.trim()] || 1 : 1);

  function countryTld(hostname) {
    const last = hostname.split('.').pop() || '';
    return /^[a-z]{2}$/.test(last) ? last : '';
  }

  /** Resolve the source currency for a matched token. */
  function resolveCurrency(token, { trailCode, tld, dollarCurrency }) {
    if (SYMBOLS[token]) return SYMBOLS[token];
    const amb = AMBIGUOUS[token];
    if (!amb) return null;
    if (trailCode) return trailCode;
    if (token === '$' && dollarCurrency && dollarCurrency !== 'auto') return dollarCurrency;
    return amb.byTld[tld] || amb.fallback;
  }

  /**
   * Turn a regex match into { from, amount, amount2, compact } or null.
   * amount2 is set for ranges like "$10–20".
   */
  function readMatch(groups, ctx) {
    const prefix = groups.pTok !== undefined;
    const token = prefix ? groups.pTok : groups.sTok;
    const from = resolveCurrency(token, { ...ctx, trailCode: prefix ? groups.pTrail : undefined });
    if (!from) return null;
    let m1, m2;
    if (prefix) {
      m1 = groups.pM1 || groups.pM2;
      m2 = groups.pM2 || groups.pM1;
    } else {
      m1 = m2 = groups.sM;
    }
    const n1 = prefix ? groups.pN1 : groups.sN1;
    const n2 = prefix ? groups.pN2 : groups.sN2;
    const amount = parseAmount(n1, from) * magnitude(m1);
    const amount2 = n2 ? parseAmount(n2, from) * magnitude(m2) : null;
    if (!Number.isFinite(amount) || (amount2 !== null && !Number.isFinite(amount2))) return null;
    return { from, amount, amount2, compact: Boolean(m1 || m2) };
  }

  // ---- Formatting ---------------------------------------------------------

  const formatterCache = new Map();

  function getFormatter(currency, { display = 'symbol', compact = false, round = false, small = false, locale } = {}) {
    const key = [currency, display, compact, round, small, locale].join('|');
    let fmt = formatterCache.get(key);
    if (!fmt) {
      const opts = { style: 'currency', currency, currencyDisplay: display };
      if (compact) {
        opts.notation = 'compact';
        opts.maximumFractionDigits = 2;
      } else if (small) {
        opts.maximumSignificantDigits = 3;
      } else if (round) {
        opts.minimumFractionDigits = 0;
        opts.maximumFractionDigits = 0;
      }
      try {
        fmt = new Intl.NumberFormat(locale, opts);
      } catch {
        fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
      }
      formatterCache.set(key, fmt);
    }
    return fmt;
  }

  function formatMoney(amount, currency, opts = {}) {
    const abs = Math.abs(amount);
    const small = !opts.compact && abs > 0 && abs < 0.1;
    const fmt = getFormatter(currency, { ...opts, small });
    if (opts.amount2 != null) {
      const hi = opts.amount2;
      if (typeof fmt.formatRange === 'function' && hi >= amount) return fmt.formatRange(amount, hi);
      return `${fmt.format(amount)} – ${fmt.format(hi)}`;
    }
    return fmt.format(amount);
  }

  function currencyName(code, locale) {
    try {
      return new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'currency' }).of(code) || code;
    } catch {
      return code;
    }
  }

  globalThis.PriceLocalizer = {
    DEFAULT_SETTINGS,
    POPULAR,
    PRICE_RE,
    FULL_PRICE_RE,
    HAS_DIGIT_RE,
    HAS_TOKEN_RE,
    parseAmount,
    countryTld,
    resolveCurrency,
    readMatch,
    formatMoney,
    currencyName,
  };
})();
