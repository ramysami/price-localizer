// Unit tests for price detection and parsing. Run: node test/parse.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const sandbox = { Intl };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(new URL('../src/shared.js', import.meta.url), 'utf8'), sandbox);
const PL = sandbox.PriceLocalizer;

function detect(text, { tld = 'com', dollarCurrency = 'auto' } = {}) {
  return [...text.matchAll(PL.PRICE_RE)]
    .map((m) => ({ match: m[0], read: PL.readMatch(m.groups, { tld, dollarCurrency }) }))
    .filter((x) => x.read)
    .map(({ match, read }) => ({ match, from: read.from, amount: +read.amount.toFixed(4), amount2: read.amount2 }));
}

const cases = [
  ['$19.99', [{ match: '$19.99', from: 'USD', amount: 19.99, amount2: null }]],
  ['Only $1,299.00 today', [{ match: '$1,299.00', from: 'USD', amount: 1299, amount2: null }]],
  ['From $10 to $20', [{ match: '$10', from: 'USD', amount: 10, amount2: null }, { match: '$20', from: 'USD', amount: 20, amount2: null }]],
  ['$10–20', [{ match: '$10–20', from: 'USD', amount: 10, amount2: 20 }]],
  ['1.234,56 €', [{ match: '1.234,56 €', from: 'EUR', amount: 1234.56, amount2: null }]],
  ['€1.234', [{ match: '€1.234', from: 'EUR', amount: 1234, amount2: null }]],
  ['12,99 €', [{ match: '12,99 €', from: 'EUR', amount: 12.99, amount2: null }]],
  ['1 234,50 €', [{ match: '1 234,50 €', from: 'EUR', amount: 1234.5, amount2: null }]],
  ['£5m deal', [{ match: '£5m', from: 'GBP', amount: 5e6, amount2: null }]],
  ['raised $1.2 billion', [{ match: '$1.2 billion', from: 'USD', amount: 1.2e9, amount2: null }]],
  ['Gas $3.459/gal', [{ match: '$3.459', from: 'USD', amount: 3.459, amount2: null }]],
  ['USD 49', [{ match: 'USD 49', from: 'USD', amount: 49, amount2: null }]],
  ['49 USD', [{ match: '49 USD', from: 'USD', amount: 49, amount2: null }]],
  ['$5 CAD', [{ match: '$5 CAD', from: 'CAD', amount: 5, amount2: null }]],
  ['C$12', [{ match: 'C$12', from: 'CAD', amount: 12, amount2: null }]],
  ['R$ 1.500,00', [{ match: 'R$ 1.500,00', from: 'BRL', amount: 1500, amount2: null }]],
  ['¥1,200', [{ match: '¥1,200', from: 'JPY', amount: 1200, amount2: null }]],
  ['1,200円', [{ match: '1,200円', from: 'JPY', amount: 1200, amount2: null }]],
  ['₹2,49,999', [{ match: '₹2,49,999', from: 'INR', amount: 249999, amount2: null }]],
  ['250 ج.م', [{ match: '250 ج.م', from: 'EGP', amount: 250, amount2: null }]],
  ['٢٥٠ ج.م', [{ match: '٢٥٠ ج.م', from: 'EGP', amount: 250, amount2: null }]],
  ['LE 1,500', [{ match: 'LE 1,500', from: 'EGP', amount: 1500, amount2: null }]],
  ['99 SAR', [{ match: '99 SAR', from: 'SAR', amount: 99, amount2: null }]],
  ['CHF 1\'250.50', [{ match: "CHF 1'250.50", from: 'CHF', amount: 1250.5, amount2: null }]],
  ['$0.00012', [{ match: '$0.00012', from: 'USD', amount: 0.0001, amount2: null }]],
  // Things that must not be treated as prices
  ['TRY 30 DAYS FREE', []],
  ['AMD 5600X processor', []],
  ['PHP 8.3 released', []],
  ['ALL 3 items', []],
  ['Model X200 is 20% off', []],
  ['version 1.2.3', []],
  ['SALE 50', []],
  ['$10-20% off', [{ match: '$10', from: 'USD', amount: 10, amount2: null }]],
];

let failed = 0;
for (const [input, expected] of cases) {
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(detect(input))), expected);
  } catch (err) {
    failed++;
    console.error(`✗ ${JSON.stringify(input)}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(detect(input))}`);
  }
}

// Ambiguous symbols
assert.equal(detect('$5', { tld: 'ca' })[0].from, 'CAD');
assert.equal(detect('$5', { tld: 'ca', dollarCurrency: 'USD' })[0].from, 'USD');
assert.equal(detect('¥100', { tld: 'cn' })[0].from, 'CNY');
assert.equal(detect('100 kr', { tld: 'se' })[0].from, 'SEK');
assert.deepEqual(detect('100 kr', { tld: 'com' }), []);

// Split-price fragments: what earns the (expensive) walk up the ancestors.
for (const piece of ['$', '€', 'ج.م', 'US$', 'USD', 'kr', 'Rs.', 'LE', 'TL', '19', '99', '1,299',
  '1 299', '٢٥٠', '19.', '$19', '19 €', 'US$1,299', 'LE 1,500']) {
  assert.equal(PL.isPriceFragment(piece), true, `should be a price fragment: ${piece}`);
}
// A token matched as a substring turns half the page into currency; these must not.
for (const word of ['TITLE', 'SUBTITLE', 'SALES', 'LEARN MORE', 'PROFILE', 'DELETE', 'COMPLETE', 'ARTICLES',
  'FORMAT', 'kroner', 'skrill', 'Page 2', '4 left', '2 min read', 'Chapter 7', 'Aug 5', '99+', '(4)',
  'Add to cart', 'constructor', '__proto__', 'hasOwnProperty']) {
  assert.equal(PL.isPriceFragment(word), false, `should not be a price fragment: ${word}`);
}

// Formatting
assert.match(PL.formatMoney(1234.5, 'EGP', { locale: 'en-US' }), /EGP\s1,234\.50/);
assert.match(PL.formatMoney(1234.5, 'EGP', { locale: 'en-US', display: 'narrowSymbol' }), /E£1,234\.50/);
assert.match(PL.formatMoney(1234.5, 'EGP', { locale: 'en-US', round: true }), /EGP\s1,235$/);
assert.match(PL.formatMoney(2.5e8, 'EGP', { locale: 'en-US', compact: true }), /EGP\s250M/);

console.log(failed ? `\n${failed} of ${cases.length} detection cases failed` : `All ${cases.length} detection cases + extras passed`);
process.exit(failed ? 1 : 0);
