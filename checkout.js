(() => {
    const form = document.querySelector('#delivery-form');
    const fields = form.querySelector('fieldset');
    const pay = document.querySelector('[data-checkout-pay]');
    const check = document.querySelector('[data-checkout-check]');
    const result = document.querySelector('[data-checkout-result]');
    const reset = document.querySelector('[data-checkout-reset]');
    const status = document.querySelector('#payment-status');
    let settings;
    let order;
    let busy = false;
    let razorpayScript;

    async function api(path, body) {
        let response;
        try {
            response = await fetch(path, {
                method: body === undefined ? 'GET' : 'POST',
                headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(25000)
            });
        } catch {
            throw new Error('The connection was interrupted. Check your payment status before trying again.');
        }
        let data;
        try { data = await response.json(); }
        catch { throw new Error('Checkout is temporarily unavailable. Please try again or contact SKINTRONICS.'); }
        if (!response.ok) {
            const error = new Error(data.error || 'Checkout is temporarily unavailable. Please try again.');
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function showQuote(quote) {
        if (!quote || quote.currency !== 'INR') return;
        const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: quote.currency });
        for (const field of ['price', 'shipping', 'tax', 'total']) {
            if (Number.isSafeInteger(quote[field]) && quote[field] >= 0) {
                document.querySelector(`[data-checkout-${field}]`).textContent = money.format(quote[field] / 100);
            }
        }
    }

    function setBusy(value, label = 'Please wait…') {
        busy = value;
        pay.disabled = value || !settings?.enabled;
        pay.textContent = value ? label : 'Pay with Razorpay';
        pay.setAttribute('aria-busy', String(value));
        check.disabled = value;
        fields.disabled = value || !settings?.enabled || Boolean(order?.razorpayOrderId);
    }

    function showOrder(next, focusResult = false) {
        order = next;
        showQuote(order.quote);
        if (order.customer) {
            form.hidden = false;
            for (const [name, value] of Object.entries(order.customer)) {
                const input = form.elements.namedItem(name);
                if (input) input.value = value;
            }
            document.querySelector('[data-delivery-note]').textContent = 'These delivery details are saved for this order. Contact SKINTRONICS if they need correcting.';
        }
        setBusy(false);
        check.hidden = true;
        pay.hidden = false;
        result.hidden = true;
        if (order.state === 'paid') {
            pay.hidden = true;
            result.hidden = false;
            fields.disabled = true;
            status.textContent = order.testMode ? 'Your test payment was verified. This is not a real purchase.' : 'Your payment was verified and your order has been recorded. Keep your order reference for support.';
            document.querySelector('[data-checkout-result-title]').textContent = order.testMode ? 'Test payment confirmed' : 'Payment confirmed';
            document.querySelector('[data-checkout-reference]').textContent = order.reference;
            if (focusResult) result.focus();
        } else if (order.state === 'pending') {
            pay.disabled = true;
            check.hidden = false;
            status.textContent = `Payment is still being confirmed. Check its status before paying again. Order reference: ${order.reference}`;
        } else {
            status.textContent = settings.enabled
                ? (order.state === 'created' ? 'Your order is ready. Continue with Razorpay to complete payment.' : 'Enter your delivery details, then pay using Razorpay.')
                : 'Online payment is not available yet. Contact SKINTRONICS for purchase details.';
        }
    }

    function uncertain(message) {
        setBusy(false);
        pay.disabled = true;
        check.hidden = false;
        status.textContent = message;
    }

    async function checkStatus() {
        if (busy) return;
        if (!settings) { await initialize(); return; }
        setBusy(true, 'Checking payment…');
        status.textContent = 'Checking your payment with Razorpay…';
        try { showOrder(await api('/api/razorpay/status'), true); }
        catch (error) { uncertain(error.message); }
    }

    function loadRazorpay() {
        if (window.Razorpay) return Promise.resolve();
        if (!razorpayScript) razorpayScript = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://checkout.razorpay.com/v1/checkout.js';
            script.async = true;
            const fail = () => {
                clearTimeout(timeout);
                script.remove();
                reject(new Error('Razorpay could not load. Check your connection and try again.'));
            };
            const timeout = setTimeout(fail, 15000);
            script.onload = () => {
                clearTimeout(timeout);
                if (window.Razorpay) resolve(); else fail();
            };
            script.onerror = fail;
            document.head.append(script);
        }).catch((error) => { razorpayScript = null; throw error; });
        return razorpayScript;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy || pay.disabled || !settings?.enabled) return;
        const customer = order?.customer || Object.fromEntries(new FormData(form));
        setBusy(true, 'Opening Razorpay…');
        status.textContent = 'Preparing your payment…';
        let requestedOrder = false;
        try {
            await loadRazorpay();
            requestedOrder = true;
            order = await api('/api/razorpay/order', { customer });
            if (['paid', 'pending'].includes(order.state)) { showOrder(order, true); return; }
            showQuote(order.quote);
            let callbackReceived = false;
            const razorpay = new window.Razorpay({
                key: settings.keyId, order_id: order.razorpayOrderId,
                amount: order.quote.total, currency: order.quote.currency,
                name: 'SKINTRONICS', description: 'Photon Skin Rejuvenation Mask · SM-2309',
                prefill: { name: order.customer.name, email: order.customer.email, contact: order.customer.phone },
                theme: { color: '#4f173f' }, retry: { enabled: true },
                handler: async (response) => {
                    callbackReceived = true;
                    status.textContent = 'Verifying your payment with Razorpay…';
                    pay.textContent = 'Verifying payment…';
                    try { showOrder(await api('/api/razorpay/verify', response), true); }
                    catch (error) { uncertain(error.message); }
                },
                modal: { ondismiss: async () => {
                    if (callbackReceived) return;
                    setBusy(false);
                    await checkStatus();
                } }
            });
            razorpay.on('payment.failed', () => {
                status.textContent = 'The payment attempt failed. Retry in Razorpay, or close it to check your order status.';
            });
            razorpay.open();
        } catch (error) {
            if (requestedOrder && error.status !== 400) uncertain(error.message);
            else { setBusy(false); status.textContent = error.message; }
        }
    });

    check.addEventListener('click', checkStatus);
    reset.addEventListener('click', async () => {
        reset.disabled = true;
        try { await api('/api/razorpay/reset', {}); location.reload(); }
        catch (error) { status.textContent = error.message; reset.disabled = false; }
    });

    async function initialize() {
        setBusy(true, 'Checking availability…');
        try {
            settings = await api('/api/checkout');
            showQuote(settings.quote);
            document.querySelector('[data-checkout-test]').hidden = !settings.testMode;
            form.hidden = !settings.enabled;
            if (settings.country) {
                const country = form.elements.namedItem('country');
                const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(settings.country);
                country.replaceChildren(new Option(name, settings.country, true, true));
                if (settings.country === 'IN') {
                    form.elements.namedItem('postalCode').pattern = '[1-9][0-9]{5}';
                    form.elements.namedItem('postalCode').inputMode = 'numeric';
                }
            }
            if (settings.order) showOrder(settings.order);
            else setBusy(false);
        } catch (error) {
            busy = false;
            pay.disabled = true;
            pay.textContent = 'Pay with Razorpay';
            pay.setAttribute('aria-busy', 'false');
            fields.disabled = true;
            check.disabled = false;
            check.hidden = false;
            status.textContent = error.message;
        }
    }
    initialize();
})();
