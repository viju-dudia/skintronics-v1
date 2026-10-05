import { createHmac, timingSafeEqual } from 'node:crypto';

export class CheckoutError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export class GatewayRequestError extends CheckoutError {
    constructor(gatewayStatus) {
        super(502,'Razorpay could not complete this request. Check its status before trying again.');
        this.gatewayStatus=gatewayStatus;
    }
}

export function verifySignature(message, signature, secret) {
    if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = createHmac('sha256', secret).update(message).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function createRazorpayClient(config, fetchAPI = fetch) {
    return async (path, payload, extraHeaders = {}) => {
        let response;
        try {
            response = await fetchAPI(`https://api.razorpay.com/v1${path}`, {
                method: payload ? 'POST' : 'GET',
                headers: {
                    Authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`,
                    'Content-Type': 'application/json', ...extraHeaders
                },
                body: payload ? JSON.stringify(payload) : undefined,
                signal: AbortSignal.timeout(15000),
                redirect: 'manual'
            });
            if (!response.ok) throw new GatewayRequestError(response.status);
            return await response.json();
        } catch (error) {
            if (error instanceof GatewayRequestError) throw error;
            // Never return gateway payloads, credentials, or customer details in errors.
            throw new CheckoutError(502, 'Razorpay could not be reached. Please check your payment status before trying again.');
        }
    };
}
