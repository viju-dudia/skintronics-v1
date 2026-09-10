import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CheckoutError, verifySignature } from './razorpay.mjs';

const orderIdValid = (value) => typeof value === 'string' && /^order_[A-Za-z0-9]+$/.test(value);
const paymentIdValid = (value) => typeof value === 'string' && /^pay_[A-Za-z0-9]+$/.test(value);
const hashToken = (token) => createHash('sha256').update(token).digest();
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;

export function validateCustomer(input, country) {
    const fields = { name: 100, email: 254, phone: 25, address: 200, address2: 200, city: 100, state: 100, postalCode: 20, country: 2 };
    const customer = {};
    for (const [field, maximum] of Object.entries(fields)) {
        const value = typeof input?.[field] === 'string' ? input[field].trim() : '';
        if ((field !== 'address2' && !value) || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
            throw new CheckoutError(400, `Please check your ${field === 'postalCode' ? 'postal code' : field}.`);
        }
        customer[field] = value;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new CheckoutError(400, 'Enter a valid email address.');
    if (!/^\+?[0-9 ()-]{7,25}$/.test(customer.phone) || customer.phone.replace(/\D/g, '').length < 7) {
        throw new CheckoutError(400, 'Enter a valid phone number, including your country code.');
    }
    if (customer.country !== country) throw new CheckoutError(400, 'Delivery is not available to the selected country.');
    if (country === 'IN' && !/^[1-9]\d{5}$/.test(customer.postalCode)) throw new CheckoutError(400, 'Enter a valid six-digit PIN code.');
    return customer;
}

export function createCheckoutService(config, store, gateway) {
    const publicOrder = (order, state = order.state) => ({
        state, reference: order.receipt || '', paymentId: order.paymentId || '',
        razorpayOrderId: order.razorpayOrderId || '', quote: order.quote,
        testMode: order.testMode, customer: order.customer || null
    });
    const isOwnPayment = (order, payment) => paymentIdValid(payment?.id)
        && payment.order_id === order.razorpayOrderId && payment.amount === order.quote.total
        && payment.currency === order.quote.currency;

    async function recordCaptured(order, payment) {
        if (!isOwnPayment(order, payment) || payment.status !== 'captured' || payment.captured !== true) {
            throw new CheckoutError(400, 'Payment details could not be verified. Contact SKINTRONICS before paying again.');
        }
        if (order.state !== 'paid') {
            order.state = 'paid';
            order.paymentId = payment.id;
            order.paidAt = new Date().toISOString();
            await store.save(order);
        }
        return publicOrder(order);
    }

    async function reconcile(order) {
        if (!order.razorpayOrderId || order.state === 'paid') return publicOrder(order);
        const response = await gateway(`/orders/${order.razorpayOrderId}/payments`);
        if (!Array.isArray(response.items)) throw new CheckoutError(502, 'Payment status is temporarily unavailable. Please check again.');
        const captured = response.items.find((payment) => isOwnPayment(order, payment) && payment.status === 'captured' && payment.captured === true);
        if (captured) return recordCaptured(order, captured);
        const pending = response.items.some((payment) => isOwnPayment(order, payment) && payment.status === 'authorized');
        return publicOrder(order, pending ? 'pending' : 'created');
    }

    return {
        async session(cookie) {
            const match = /(?:^|;\s*)skintronics_checkout=([a-f0-9-]{36})\.([a-f0-9]{64})(?:;|$)/.exec(cookie || '');
            if (!match) return null;
            const order = await store.read(match[1]);
            if (!order || order.keyId !== config.keyId || Date.now() - order.createdAt > sessionLifetime) return null;
            const expected = Buffer.from(order.tokenHash, 'hex');
            if (expected.length !== 32 || !timingSafeEqual(expected, hashToken(match[2]))) return null;
            return order;
        },
        async newSession() {
            const token = randomBytes(32).toString('hex');
            const order = {
                id: randomUUID(), tokenHash: hashToken(token).toString('hex'), createdAt: Date.now(),
                state: 'new', keyId: config.keyId, testMode: config.testMode, quote: config.quote
            };
            await store.save(order);
            return { order, cookie: `skintronics_checkout=${order.id}.${token}; HttpOnly; SameSite=Lax; Path=/api/; Max-Age=604800${config.origin.startsWith('https:') ? '; Secure' : ''}` };
        },
        async status(session) {
            return store.lock(session.id, async () => reconcile(await store.read(session.id)));
        },
        async createOrder(session, customerInput) {
            return store.lock(session.id, async () => {
                const order = await store.read(session.id);
                if (order.razorpayOrderId) {
                    // Retries reuse the existing gateway order and its original delivery details.
                    return reconcile(order);
                }
                const customer = validateCustomer(customerInput, config.country);
                const receipt = `stx_${randomUUID().replaceAll('-', '')}`;
                const quote = config.quote;
                const created = await gateway('/orders', {
                    amount: quote.total, currency: quote.currency, receipt, partial_payment: false,
                    notes: { checkout_id: order.id, product: 'SM-2309', quantity: '1' }
                });
                if (!orderIdValid(created.id) || created.amount !== quote.total || created.currency !== quote.currency || created.receipt !== receipt) {
                    throw new CheckoutError(502, 'The payment order could not be prepared. Please try again.');
                }
                Object.assign(order, { state: 'created', customer, receipt, quote, razorpayOrderId: created.id });
                await store.save(order);
                return publicOrder(order);
            });
        },
        async verify(session, response) {
            return store.lock(session.id, async () => {
                const order = await store.read(session.id);
                if (!order.razorpayOrderId || response.razorpay_order_id !== order.razorpayOrderId || !paymentIdValid(response.razorpay_payment_id)
                    || !verifySignature(`${order.razorpayOrderId}|${response.razorpay_payment_id}`, response.razorpay_signature, config.keySecret)) {
                    throw new CheckoutError(400, 'Payment verification failed. Contact SKINTRONICS before making another payment.');
                }
                const payment = await gateway(`/payments/${response.razorpay_payment_id}`);
                if (!isOwnPayment(order, payment) || payment.id !== response.razorpay_payment_id) throw new CheckoutError(400, 'Payment details do not match this order. Contact SKINTRONICS.');
                if (payment.status === 'captured' && payment.captured === true) return recordCaptured(order, payment);
                return publicOrder(order, 'pending');
            });
        },
        async webhook(rawBody, signature) {
            if (!config.webhookSecret) throw new CheckoutError(503, 'Webhook not configured');
            if (!verifySignature(rawBody, signature, config.webhookSecret)) throw new CheckoutError(400, 'Invalid webhook signature');
            let event;
            try { event = JSON.parse(rawBody); } catch { throw new CheckoutError(400, 'Invalid webhook body'); }
            if (!['payment.captured', 'order.paid'].includes(event.event)) return { received: true };
            const payment = event.payload?.payment?.entity;
            if (!paymentIdValid(payment?.id) || !orderIdValid(payment?.order_id)) throw new CheckoutError(400, 'Missing payment identifiers');
            const gatewayOrder = await gateway(`/orders/${payment.order_id}`);
            if (gatewayOrder?.id !== payment.order_id) throw new CheckoutError(502, 'Could not verify the gateway order');
            const id = gatewayOrder.notes?.checkout_id;
            const stored = await store.read(id);
            if (!stored || stored.razorpayOrderId !== payment.order_id) return { received: true };
            await store.lock(id, async () => {
                const order = await store.read(id);
                if (order.state === 'paid') return;
                // Fetch the current status rather than trusting a potentially old event snapshot.
                const verified = await gateway(`/payments/${payment.id}`);
                if (verified?.id !== payment.id) throw new CheckoutError(502, 'Could not verify the gateway payment');
                await recordCaptured(order, verified);
            });
            return { received: true };
        }
    };
}
