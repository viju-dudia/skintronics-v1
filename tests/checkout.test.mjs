import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { createOrderStore } from '../lib/order-store.mjs';
import { createCheckoutService } from '../lib/checkout-service.mjs';
import { CheckoutError } from '../lib/razorpay.mjs';

// Deliberately fictional fixtures, never storefront prices or merchant credentials.
const environment = {
    CHECKOUT_ENABLED: 'true', RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: 'test-secret-only',
    RAZORPAY_WEBHOOK_SECRET: 'webhook-test-secret', PRODUCT_PRICE_PAISE: '199900',
    SHIPPING_PAISE: '1000', TAX_PAISE: '0', SHIPPING_COUNTRY: 'IN', CHECKOUT_CURRENCY: 'INR'
};
const customer = { name: 'Test Customer', email: 'buyer@example.test', phone: '+919000000000',
    address: '1 Test Street', address2: '', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'IN' };
const sign = (message, secret = environment.RAZORPAY_KEY_SECRET) => createHmac('sha256', secret).update(message).digest('hex');

async function fixture(t, overrides = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'skintronics-test-'));
    const config = { ...readConfig({ ...environment, ...overrides }), dataDir: directory };
    const store = createOrderStore(directory);
    const state = { orders: [], payment: null, fail: false };
    const gateway = async (path, body) => {
        if (state.fail) throw new CheckoutError(502, 'Gateway temporarily unavailable');
        if (path === '/orders' && body) {
            const order = { ...body, id: `order_Test${state.orders.length + 1}` };
            state.orders.push(order);
            return order;
        }
        if (/\/orders\/order_Test\d+\/payments$/.test(path)) return { items: state.payment ? [state.payment] : [] };
        if (path.startsWith('/payments/')) return state.payment;
        return state.orders.find((order) => path === `/orders/${order.id}`);
    };
    const app = createApp({ config, store, gateway });
    await new Promise((done) => app.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${app.address().port}`;
    config.origin = base;
    t.after(async () => {
        app.closeAllConnections();
        await new Promise((done) => app.close(done));
        // Only remove this fixture's verified temporary directory.
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
        assert.match(directory, /skintronics-test-/);
        await rm(directory, { recursive: true, force: true });
    });
    const initial = await fetch(`${base}/api/checkout`);
    const cookie = initial.headers.get('set-cookie')?.split(';')[0] || '';
    const request = (path, body, headers = {}) => fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const create = () => request('/api/razorpay/order', { customer });
    const captured = () => {
        state.payment = { id: 'pay_Test1', order_id: state.orders[0].id, amount: config.quote.total,
            currency: 'INR', status: 'captured', captured: true };
        return { razorpay_order_id: state.payment.order_id, razorpay_payment_id: state.payment.id,
            razorpay_signature: sign(`${state.payment.order_id}|${state.payment.id}`) };
    };
    return { config, store, state, gateway, base, cookie, request, create, captured, initial: await initial.json(), directory };
}

test('checkout stays unavailable for absent, incomplete, invalid, or unsafe live configuration', async (t) => {
    assert.equal(readConfig({}).enabled, false);
    for (const bad of [{ PRODUCT_PRICE_PAISE: '' }, { PRODUCT_PRICE_PAISE: '1.5' }, { PRODUCT_PRICE_PAISE: '-1' },
        { SHIPPING_PAISE: '' }, { TAX_PAISE: '' }, { SHIPPING_COUNTRY: '' }, { RAZORPAY_KEY_SECRET: '' },
        { CHECKOUT_CURRENCY: 'USD' }, { RAZORPAY_KEY_ID: 'rzp_live_fixture', APP_ORIGIN: 'http://example.test' }]) {
        assert.equal(readConfig({ ...environment, ...bad }).enabled, false, JSON.stringify(bad));
    }
    const f = await fixture(t, { CHECKOUT_ENABLED: 'false' });
    assert.equal(f.initial.enabled, false);
    assert.equal(f.cookie, '');
    assert.equal(f.initial.keyId, null);
    assert.equal(JSON.stringify(f.initial).includes(environment.RAZORPAY_KEY_SECRET), false);
});

test('server determines amount and quantity; parallel clicks and retries reuse one order', async (t) => {
    const f = await fixture(t);
    const results = await Promise.all([f.request('/api/razorpay/order', { customer, amount: 1, currency: 'USD', quantity: 99 }), f.create()]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.equal(f.state.orders.length, 1);
    assert.equal(f.state.orders[0].amount, 200900);
    assert.equal(f.state.orders[0].currency, 'INR');
    assert.equal(f.state.orders[0].notes.quantity, '1');
    assert.equal((await f.create()).status, 200);
    assert.equal(f.state.orders.length, 1);
    const stored = JSON.parse(await readFile(join(f.directory, `${f.state.orders[0].notes.checkout_id}.json`), 'utf8'));
    assert.deepEqual(stored.customer, customer);
    assert.equal(stored.state, 'created');
    assert.equal(stored.testMode, true);
});

test('delivery validation fails before creating a gateway order', async (t) => {
    const f = await fixture(t);
    for (const bad of [{ email: 'bad' }, { country: 'US' }, { postalCode: '123' }, { address: '' }, { phone: 'letters' }]) {
        assert.equal((await f.request('/api/razorpay/order', { customer: { ...customer, ...bad } })).status, 400);
    }
    assert.equal(f.state.orders.length, 0);
});

test('forged signatures, wrong orders and wrong amounts never confirm payment', async (t) => {
    const f = await fixture(t);
    await f.create();
    const valid = f.captured();
    assert.equal((await f.request('/api/razorpay/verify', { ...valid, razorpay_signature: '0'.repeat(64) })).status, 400);
    assert.equal((await f.request('/api/razorpay/verify', { ...valid, razorpay_order_id: 'order_Other' })).status, 400);
    f.state.payment.amount = 1;
    assert.equal((await f.request('/api/razorpay/verify', valid)).status, 400);
    f.state.payment.amount = f.config.quote.total;
    f.state.payment.currency = 'USD';
    assert.equal((await f.request('/api/razorpay/verify', valid)).status, 400);
    f.state.payment.currency = 'INR';
    f.state.payment.id = 'pay_Wrong';
    assert.equal((await f.request('/api/razorpay/verify', valid)).status, 400);
    const stored = await f.store.read(f.state.orders[0].notes.checkout_id);
    assert.equal(stored.state, 'created');
});

test('authorization is pending; capture confirms once and survives a service restart', async (t) => {
    const f = await fixture(t);
    await f.create();
    const valid = f.captured();
    f.state.payment.status = 'authorized';
    f.state.payment.captured = false;
    assert.equal((await (await f.request('/api/razorpay/verify', valid)).json()).state, 'pending');
    assert.equal((await (await f.create()).json()).state, 'pending');
    assert.equal(f.state.orders.length, 1);
    f.state.payment.status = 'captured';
    f.state.payment.captured = true;
    const verified = await (await f.request('/api/razorpay/verify', valid)).json();
    assert.equal(verified.state, 'paid');
    assert.equal(verified.paymentId, 'pay_Test1');
    assert.equal(verified.customer.email, customer.email);
    assert.equal(verified.tokenHash, undefined);
    const afterRestart = createCheckoutService(f.config, createOrderStore(f.directory), f.gateway);
    const session = await afterRestart.session(f.cookie);
    assert.equal((await afterRestart.status(session)).state, 'paid');
    assert.equal((await f.request('/api/razorpay/reset', {})).status, 200);
});

test('status recovery detects a captured payment when the browser callback is lost', async (t) => {
    const f = await fixture(t);
    await f.create();
    f.captured();
    const recovered = await (await f.request('/api/razorpay/status')).json();
    assert.equal(recovered.state, 'paid');
    assert.equal((await (await f.create()).json()).state, 'paid');
    assert.equal(f.state.orders.length, 1);
});

test('signed raw-body webhook records capture; duplicates and older events do not overwrite it', async (t) => {
    const f = await fixture(t);
    await f.create();
    f.captured();
    const event = { event: 'payment.captured', payload: { payment: { entity: f.state.payment } } };
    const raw = JSON.stringify(event, null, 2);
    const send = (body, signature) => fetch(`${f.base}/api/razorpay/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature }, body
    });
    assert.equal((await send(raw, sign(raw, 'wrong-secret'))).status, 400);
    assert.equal((await send(raw, sign(raw, environment.RAZORPAY_WEBHOOK_SECRET))).status, 200);
    const before = await f.store.read(f.state.orders[0].notes.checkout_id);
    assert.equal(before.state, 'paid');
    assert.equal((await send(raw, sign(raw, environment.RAZORPAY_WEBHOOK_SECRET))).status, 200);
    const late = JSON.stringify({ ...event, event: 'payment.authorized' });
    assert.equal((await send(late, sign(late, environment.RAZORPAY_WEBHOOK_SECRET))).status, 200);
    assert.deepEqual(await f.store.read(before.id), before);
});

test('cross-site requests, forged sessions, reset of unpaid orders, and private-file access are blocked', async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request('/api/razorpay/order', { customer }, { Origin: 'https://other.example.test' })).status, 403);
    assert.equal((await f.request('/api/razorpay/order', { customer }, { Cookie: f.cookie.slice(0, -64) + '0'.repeat(64) })).status, 401);
    assert.equal((await f.request('/api/razorpay/reset', {})).status, 409);
    for (const path of ['/.env', '/.env.example', '/server.mjs', '/lib/config.mjs', '/.git/config', '/SITE_SOURCE_OF_TRUTH.md', '/assets/..%2f.env', '/.data/orders/private.json']) {
        assert.equal((await fetch(`${f.base}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${f.base}/checkout.html`)).status, 200);
    assert.equal((await fetch(`${f.base}/assets/product-front-480.webp`)).status, 200);
});

test('gateway errors keep the session retryable and do not record a paid order', async (t) => {
    const f = await fixture(t);
    f.state.fail = true;
    assert.equal((await f.create()).status, 502);
    assert.equal((await (await f.request('/api/razorpay/status')).json()).state, 'new');
    f.state.fail = false;
    assert.equal((await f.create()).status, 200);
    assert.equal(f.state.orders.length, 1);
});
