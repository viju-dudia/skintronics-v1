import { resolve } from 'node:path';

function amount(value) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function readConfig(env = process.env) {
    const price = amount(env.PRODUCT_PRICE_PAISE);
    const shipping = amount(env.SHIPPING_PAISE);
    const tax = amount(env.TAX_PAISE);
    const total = price !== null && shipping !== null && tax !== null ? price + shipping + tax : null;
    const origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:4173').origin;
    const keyId = env.RAZORPAY_KEY_ID || '';
    const keySecret = env.RAZORPAY_KEY_SECRET || '';
    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET || '';
    const testMode = keyId.startsWith('rzp_test_');
    const country = env.SHIPPING_COUNTRY || '';
    const currency = env.CHECKOUT_CURRENCY || 'INR';
    const validAmounts = price > 0 && shipping !== null && tax !== null && Number.isSafeInteger(total);
    const validKeys = /^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) && keySecret.length > 0;
    return {
        origin, keyId, keySecret, webhookSecret, testMode, country,
        host: env.HOST || '127.0.0.1',
        port: Number(env.PORT || 4173),
        dataDir: resolve(env.ORDER_DATA_DIR || '.data/orders'),
        enabled: env.CHECKOUT_ENABLED === 'true' && validKeys && validAmounts && currency === 'INR'
            && /^[A-Z]{2}$/.test(country) && (testMode || (origin.startsWith('https://') && webhookSecret.length > 0)),
        quote: { currency, price, shipping, tax, total, quantity: 1, product: 'SM-2309' }
    };
}
