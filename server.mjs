import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig } from './lib/config.mjs';
import { createOrderStore } from './lib/order-store.mjs';
import { createCheckoutService } from './lib/checkout-service.mjs';
import { CheckoutError, createRazorpayClient } from './lib/razorpay.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicFiles = new Set(['index.html', 'checkout.html', 'science.html', 'results.html', 'how-to-use.html', 'styles.css', 'checkout.css', 'site.js', 'checkout.js']);
const logo = 'Skintroniks-20260903T124736Z-1-001/Skintroniks/SKINTRONICS_LOGO.png';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

async function readBody(request, maximum = 16384) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > maximum) throw new CheckoutError(413, 'Request is too large.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}

export function createApp({ config = readConfig(), store = createOrderStore(config.dataDir), gateway = createRazorpayClient(config) } = {}) {
    const checkout = createCheckoutService(config, store, gateway);
    const limits = new Map();
    function rateLimit(request, path) {
        const now = Date.now();
        for (const [key, value] of limits) if (value.expires <= now) limits.delete(key);
        const key = `${request.socket.remoteAddress}:${path === '/api/razorpay/order' ? 'orders' : 'other'}`;
        const limit = path === '/api/razorpay/order' ? 10 : 60;
        if (!limits.has(key)) {
            if (limits.size >= 2000) throw new CheckoutError(503, 'Checkout is busy. Please try again shortly.');
            limits.set(key, { count: 0, expires: now + 60000 });
        }
        if (++limits.get(key).count > limit) throw new CheckoutError(429, 'Please wait a minute before trying again.');
    }

    return createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'same-origin');
        try {
            const path = new URL(request.url, config.origin).pathname;
            if (path === '/api/razorpay/webhook' && request.method === 'POST') {
                const result = await checkout.webhook(await readBody(request, 262144), request.headers['x-razorpay-signature']);
                return json(response, 200, result);
            }
            if (path.startsWith('/api/')) {
                rateLimit(request, path);
                if (!['GET', 'POST'].includes(request.method)) throw new CheckoutError(405, 'Method not allowed.');
                if (request.method === 'POST') {
                    if (request.headers.origin !== config.origin) throw new CheckoutError(403, 'Please use checkout from the SKINTRONICS website.');
                    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new CheckoutError(415, 'Expected a JSON request.');
                }
                let session = await checkout.session(request.headers.cookie);
                if (path === '/api/checkout' && request.method === 'GET') {
                    if (config.enabled && !session) {
                        const created = await checkout.newSession();
                        session = created.order;
                        response.setHeader('Set-Cookie', created.cookie);
                    }
                    const current = session ? await checkout.status(session) : null;
                    return json(response, 200, {
                        enabled: config.enabled, testMode: config.testMode,
                        keyId: config.enabled ? config.keyId : null,
                        country: config.country, quote: current?.quote || config.quote, order: current
                    });
                }
                if (!session) throw new CheckoutError(401, 'Your checkout session expired. Reload the page to begin again.');
                if (path === '/api/razorpay/status' && request.method === 'GET') return json(response, 200, await checkout.status(session));
                if (path === '/api/razorpay/order' && request.method === 'POST' && !config.enabled) throw new CheckoutError(503, 'Online payment is not available yet. Please contact SKINTRONICS.');
                if (request.method !== 'POST') throw new CheckoutError(404, 'Not found.');
                let body;
                try { body = JSON.parse(await readBody(request)); }
                catch (error) { if (error instanceof CheckoutError) throw error; throw new CheckoutError(400, 'Invalid JSON request.'); }
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CheckoutError(400, 'Invalid request.');
                if (path === '/api/razorpay/order') return json(response, 200, await checkout.createOrder(session, body.customer));
                if (path === '/api/razorpay/verify') return json(response, 200, await checkout.verify(session, body));
                if (path === '/api/razorpay/reset') {
                    const state = await checkout.status(session);
                    if (state.state !== 'paid') throw new CheckoutError(409, 'Check your existing payment before starting another order.');
                    response.setHeader('Set-Cookie', `skintronics_checkout=; HttpOnly; SameSite=Lax; Path=/api/; Max-Age=0${config.origin.startsWith('https:') ? '; Secure' : ''}`);
                    return json(response, 200, { reset: true });
                }
                throw new CheckoutError(404, 'Not found.');
            }
            if (!['GET', 'HEAD'].includes(request.method)) throw new CheckoutError(405, 'Method not allowed.');
            const file = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
            const isAsset = /^assets\/[A-Za-z0-9_-]+\.(?:webp|png|jpe?g)$/.test(file);
            if (!publicFiles.has(file) && !isAsset && file !== logo) throw new CheckoutError(404, 'Not found.');
            const content = await readFile(join(root, file));
            response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-cache' });
            response.end(request.method === 'HEAD' ? undefined : content);
        } catch (error) {
            const status = error instanceof CheckoutError ? error.status : error.code === 'ENOENT' ? 404 : 500;
            if (status === 429) response.setHeader('Retry-After', '60');
            json(response, status, { error: error instanceof CheckoutError ? error.message : 'Checkout is temporarily unavailable. Please try again or contact SKINTRONICS.' });
        }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const config = readConfig();
    const app = createApp({ config });
    app.listen(config.port, config.host, () => {
        console.log(`SKINTRONICS: ${config.origin} — Razorpay ${config.enabled ? (config.testMode ? 'test mode' : 'live mode') : 'not configured'}`);
    });
}
