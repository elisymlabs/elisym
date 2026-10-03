// The demo store: the product and the network come from the page URL
// (?product=naddr1...&network=devnet), so one page serves any store.

// The bech32 alphabet.
// cspell:disable-next-line
const NADDR_RE = /^naddr1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,1000}$/;
const NETWORKS = ['devnet', 'mainnet'];

const params = new URLSearchParams(location.search);
const product = params.get('product');
const network = params.get('network') ?? 'devnet';

function showSetup(problem) {
  document.getElementById('setup').hidden = false;
  if (problem !== undefined) {
    const error = document.getElementById('setup-error');
    error.textContent = problem;
    error.hidden = false;
  }
}

function onSetupSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const next = new URLSearchParams({
    product: String(form.get('product') ?? '').trim(),
    network: String(form.get('network') ?? 'devnet'),
  });
  if (form.get('collect-email') === 'on') {
    next.set('collect-email', '1');
  }
  if (form.get('inline') === 'on') {
    next.set('display', 'inline');
  }
  location.search = next.toString();
}

function logEvent(text) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  document.getElementById('events').append(item);
}

function logStatus(event) {
  logEvent(event.detail.state);
}

function showStore() {
  const badge = document.getElementById('network-badge');
  badge.textContent = network === 'mainnet' ? 'mainnet - real money' : 'devnet';
  badge.classList.toggle('mainnet', network === 'mainnet');
  badge.hidden = false;

  const buy = document.createElement('elisym-buy');
  buy.setAttribute('product', product);
  buy.setAttribute('network', network);
  buy.setAttribute('theme', 'dark');
  if (params.get('collect-email') === '1') {
    buy.setAttribute('collect-email', '');
  }
  if (params.get('display') === 'inline') {
    buy.setAttribute('display', 'inline');
  } else {
    buy.setAttribute('label', 'Buy the demo product');
  }
  buy.addEventListener('elisym-status', logStatus);
  buy.addEventListener('elisym-open', () => logEvent('opened'));
  buy.addEventListener('elisym-close', () => logEvent('closed'));
  document.getElementById('checkout').append(buy);
  document.getElementById('store').hidden = false;
}

document.getElementById('setup-form').addEventListener('submit', onSetupSubmit);

if (product === null) {
  showSetup();
} else if (!NADDR_RE.test(product)) {
  showSetup('That is not a product naddr: copy the naddr line that setup printed.');
} else if (!NETWORKS.includes(network)) {
  showSetup('The network is devnet or mainnet.');
} else {
  showStore();
}
