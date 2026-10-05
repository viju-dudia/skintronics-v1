import { CheckoutError } from './razorpay.mjs';

export const fulfilmentLabels = { awaiting: 'Awaiting fulfilment', processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', returned: 'Returned' };
const transitions = { awaiting: ['processing','cancelled'], processing: ['shipped','cancelled'], shipped: ['delivered','returned'], delivered: ['returned'], cancelled: [], returned: [] };
const textField = (value, maximum = 200) => {
    if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new CheckoutError(400, 'Check the entered details.');
    return value.trim();
};
const refundId = (value) => typeof value === 'string' && /^rfnd_[a-zA-Z0-9]+$/.test(value);
const totals = (refunds, total) => {
    const processed = refunds.filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount, 0);
    const reserved = refunds.filter((r) => r.status !== 'failed').reduce((sum, r) => sum + r.amount, 0);
    return { processed, reserved, available: Math.max(0, total - reserved), uncertain: refunds.some((r) => ['submitting','uncertain'].includes(r.status)) };
};

export function createAdminService({ config, store, gateway, allowTestFulfilment = false }) {
    const db = store.db;
    async function rowFor(id) {
        const row = await db.prepare('SELECT * FROM orders WHERE id=? AND receipt IS NOT NULL').bind(id).first();
        if (!row) throw new CheckoutError(404, 'Order not found.');
        return row;
    }
    const refundRows = async (id) => (await db.prepare('SELECT * FROM refunds WHERE order_id=? ORDER BY created_at DESC').bind(id).all()).results;
    function present(row) {
        const order = JSON.parse(row.checkout);
        return { id: row.id, reference: row.receipt, state: row.state, testMode: Boolean(row.test_mode), createdAt: row.created_at,
            paidAt: order.paidAt || null, customer: order.customer, quote: order.quote, paymentId: row.payment_id,
            razorpayOrderId: row.gateway_order_id, paymentAttempts: order.paymentAttempts || [],
            fulfilment: row.fulfilment, courier: row.courier, trackingNumber: row.tracking_number, dispatchDate: row.dispatch_date,
            version: row.version, checkedAt: row.checked_at, checkError: row.check_error, refunded: row.refunded || 0 };
    }
    async function detail(id) {
        const row = await rowFor(id);
        const refunds = await refundRows(id);
        const events = (await db.prepare('SELECT actor,message,created_at AS createdAt FROM events WHERE order_id=? ORDER BY id DESC LIMIT 100').bind(id).all()).results;
        const notifications = (await db.prepare('SELECT id,kind,state,attempts,error,sent_at AS sentAt FROM notifications WHERE order_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all()).results;
        return { ...present(row), refunds: refunds.map(({ payload, ...r }) => r), refundTotals: totals(refunds, row.total), events, notifications };
    }
    function filters(params) {
        const clauses = ['receipt IS NOT NULL'];
        const values = [];
        const mode = params.get('mode') || 'live';
        if (!['live','test'].includes(mode)) throw new CheckoutError(400, 'Choose live or test orders.');
        clauses.push('test_mode=?'); values.push(Number(mode === 'test'));
        const q = (params.get('q') || '').trim().toLowerCase();
        if (q.length > 200) throw new CheckoutError(400, 'Search is too long.');
        if (q) { clauses.push("instr(lower(customer_name || ' ' || customer_email || ' ' || customer_phone || ' ' || receipt || ' ' || coalesce(payment_id,'')),?)>0"); values.push(q); }
        const state = params.get('payment');
        if (state) {
            if (!['paid','pending','created','creating'].includes(state)) throw new CheckoutError(400, 'Invalid payment filter.');
            clauses.push('state=?'); values.push(state);
        }
        const fulfilment = params.get('fulfilment');
        if (fulfilment) {
            if (!Object.hasOwn(fulfilmentLabels, fulfilment)) throw new CheckoutError(400, 'Invalid fulfilment filter.');
            clauses.push('fulfilment=?'); values.push(fulfilment);
        }
        for (const field of ['from','to']) {
            const value = params.get(field);
            if (!value) continue;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new CheckoutError(400, 'Invalid date filter.');
            clauses.push(field === 'from' ? 'created_at>=?' : 'created_at<?');
            values.push(Date.parse(value) + (field === 'to' ? 86400000 : 0));
        }
        return { where: clauses.join(' AND '), values, mode };
    }
    async function list(params, exportAll = false) {
        const { where, values, mode } = filters(params);
        const page = Number(params.get('page') || 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new CheckoutError(400, 'Invalid page.');
        const count = await db.prepare(`SELECT count(*) AS count FROM orders WHERE ${where}`).bind(...values).first();
        if (exportAll && count.count > 5000) throw new CheckoutError(400, 'Narrow the export using date filters to 5,000 orders or fewer.');
        const rows = (await db.prepare(`SELECT *,coalesce((SELECT sum(amount) FROM refunds WHERE order_id=orders.id AND status='processed'),0) AS refunded
            FROM orders WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).bind(...values, exportAll ? 5000 : 25, exportAll ? 0 : (page-1)*25).all()).results;
        const metrics = await db.prepare(`SELECT count(*) AS orders,
          coalesce(sum(CASE WHEN state='paid' THEN total ELSE 0 END),0) AS captured,
          sum(CASE WHEN state='paid' AND fulfilment IN ('awaiting','processing') AND total>coalesce((SELECT sum(amount) FROM refunds WHERE order_id=orders.id AND status='processed'),0) THEN 1 ELSE 0 END) AS awaiting,
          sum(CASE WHEN fulfilment='shipped' THEN 1 ELSE 0 END) AS shipped FROM orders WHERE test_mode=? AND receipt IS NOT NULL`).bind(Number(mode === 'test')).first();
        const refunded = await db.prepare(`SELECT coalesce(sum(r.amount),0) AS total FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.status='processed' AND o.test_mode=?`).bind(Number(mode === 'test')).first();
        return { orders: rows.map(present), count: count.count, page, pages: Math.max(1, Math.ceil(count.count/25)), metrics: { ...metrics, refunded: refunded.total }, mode };
    }
    async function updateFulfilment(id, body, actor) {
        return store.lock(id, async () => {
            const row = await rowFor(id);
            if (body.version !== row.version) throw new CheckoutError(409, 'This order changed in another session. Refresh before saving.');
            const next = body.fulfilment;
            if (!Object.hasOwn(transitions, next) || (next !== row.fulfilment && !transitions[row.fulfilment].includes(next))) throw new CheckoutError(400, 'This fulfilment change is not allowed.');
            const courier = textField(body.courier || '', 100);
            const tracking = textField(body.trackingNumber || '', 100);
            const date = textField(body.dispatchDate || '', 10);
            const reason = textField(body.reason || '', 500);
            if (['processing','shipped','delivered'].includes(next)) {
                const refunds = totals(await refundRows(id), row.total);
                if (row.state !== 'paid' || (row.test_mode && !allowTestFulfilment) || refunds.processed >= row.total || refunds.reserved >= row.total || refunds.uncertain) {
                    throw new CheckoutError(409, 'Only verified, live orders without a full or uncertain refund can be fulfilled.');
                }
            }
            if (['shipped','delivered','returned'].includes(next) && (!courier || !tracking || !/^\d{4}-\d{2}-\d{2}$/.test(date)
                || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date > new Date().toISOString().slice(0,10))) {
                throw new CheckoutError(400, 'Enter a courier, tracking number, and valid dispatch date before recording shipment.');
            }
            if (['cancelled','returned'].includes(next) && !reason) throw new CheckoutError(400, 'Record a reason for the cancellation or return.');
            const message = `Fulfilment: ${fulfilmentLabels[next]}${tracking ? `; ${courier}, ${tracking}` : ''}${reason ? `; ${reason}` : ''}`;
            const results = await db.batch([
                db.prepare('UPDATE orders SET fulfilment=?,courier=?,tracking_number=?,dispatch_date=?,version=version+1 WHERE id=? AND version=?').bind(next,courier,tracking,date,id,row.version),
                db.prepare('INSERT INTO events(order_id,actor,message,created_at) VALUES(?,?,?,?)').bind(id,actor,message,Date.now())
            ]);
            if (!results[0].meta.changes) throw new CheckoutError(409, 'Refresh this order before saving.');
            return detail(id);
        });
    }
    async function note(id, message, actor) {
        await rowFor(id);
        const value = textField(message, 2000);
        if (!value) throw new CheckoutError(400, 'Write a note before saving.');
        await db.prepare('INSERT INTO events(order_id,actor,message,created_at) VALUES(?,?,?,?)').bind(id,actor,`Note: ${value}`,Date.now()).run();
        return detail(id);
    }
    async function syncRefund(order, entity) {
        if (!refundId(entity?.id) || entity.payment_id !== order.paymentId || entity.currency !== order.quote.currency
            || !Number.isSafeInteger(entity.amount) || entity.amount <= 0 || entity.amount > order.quote.total
            || !['pending','processed','failed'].includes(entity.status)) throw new CheckoutError(502, 'Refund details could not be verified.');
        const existing = await db.prepare('SELECT * FROM refunds WHERE gateway_id=? OR request_id=?').bind(entity.id,entity.receipt || '').first();
        if (existing && (existing.order_id !== order.id || existing.amount !== entity.amount)) throw new CheckoutError(502, 'Refund details do not match the saved request.');
        const now = Date.now();
        const requestId = existing?.request_id || `external:${entity.id}`;
        await db.batch([
            db.prepare(`INSERT INTO refunds(request_id,order_id,gateway_id,amount,status,reason,actor,created_at,updated_at,payload)
              VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET gateway_id=excluded.gateway_id,
              status=CASE WHEN refunds.status='processed' THEN 'processed' ELSE excluded.status END,updated_at=excluded.updated_at,error=NULL`)
                .bind(requestId,order.id,entity.id,entity.amount,entity.status,existing?.reason || 'Issued through Razorpay',existing?.actor || 'Razorpay',existing?.created_at || now,now,existing?.payload || '{}'),
            db.prepare(`INSERT INTO events(order_id,actor,message,created_at) SELECT ?,?,?,? WHERE NOT EXISTS
              (SELECT 1 FROM events WHERE order_id=? AND message=?)`)
                .bind(order.id,'Razorpay',`Refund ${entity.id}: ${entity.status}`,now,order.id,`Refund ${entity.id}: ${entity.status}`),
            db.prepare(`INSERT OR IGNORE INTO notifications(id,order_id,kind,detail,created_at)
              SELECT ?,?,'refund',?,? WHERE ?='processed' AND ?=0`).bind(`${requestId}:refund`,order.id,entity.id,now,entity.status,Number(order.testMode))
        ]);
    }
    function ownKey(order) {
        if (order.keyId !== config.keyId) throw new CheckoutError(409, 'This order belongs to a different Razorpay key. Use the matching account and mode to check it.');
    }
    async function refreshRefunds(order) {
        if (!order.paymentId) return;
        ownKey(order);
        for (let skip=0; skip<1000; skip+=100) {
            const response = await gateway(`/payments/${order.paymentId}/refunds?count=100&skip=${skip}`);
            if (!Array.isArray(response?.items)) throw new CheckoutError(502, 'Refund status is temporarily unavailable.');
            for (const entity of response.items) await syncRefund(order,entity);
            if (response.items.length < 100) return;
        }
        throw new CheckoutError(502, 'Too many refunds to verify automatically. Review this payment in Razorpay.');
    }
    async function sendRefund(order, refund) {
        ownKey(order);
        try {
            const entity = await gateway(`/payments/${order.paymentId}/refund`,JSON.parse(refund.payload),{'X-Refund-Idempotency': refund.request_id});
            await syncRefund(order,entity);
        } catch (error) {
            const rejected=error.gatewayStatus>=400&&error.gatewayStatus<500&&![409,429].includes(error.gatewayStatus);
            await db.prepare("UPDATE refunds SET status=?,error=?,updated_at=? WHERE request_id=? AND status IN ('submitting','uncertain')")
                .bind(rejected?'failed':'uncertain',rejected?'Razorpay rejected this request. Review the payment and account before creating a new refund.':'The response was interrupted. Check status or retry this same request; do not create another refund.',Date.now(),refund.request_id).run();
        }
    }
    async function refund(id, body, actor) {
        return store.lock(id, async () => {
            const row = await rowFor(id);
            const order = JSON.parse(row.checkout);
            ownKey(order);
            if (order.state !== 'paid' || !order.paymentId) throw new CheckoutError(409, 'This order has no verified captured payment to refund.');
            // Persisted request IDs make a repeated browser POST or timeout recovery the same operation.
            if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.requestId || '')) throw new CheckoutError(400, 'Invalid refund request. Refresh the order.');
            const reason = textField(body.reason || '',500);
            if (!reason || !Number.isSafeInteger(body.amount) || body.amount < 100) throw new CheckoutError(400, 'Enter a reason and an amount of at least ₹1.');
            const existing = await db.prepare('SELECT * FROM refunds WHERE request_id=?').bind(body.requestId).first();
            if (existing) {
                if (existing.order_id !== id || existing.amount !== body.amount || existing.reason !== reason) throw new CheckoutError(409, 'A refund request cannot change when retried.');
                if (['submitting','uncertain'].includes(existing.status)) await sendRefund(order,existing);
                return detail(id);
            }
            await refreshRefunds(order);
            const current = totals(await refundRows(id),row.total);
            if (current.uncertain || body.amount > current.available) throw new CheckoutError(409, 'The amount exceeds the available refund balance, or an earlier request still needs checking.');
            const payment = await gateway(`/payments/${order.paymentId}`);
            if (payment?.id !== order.paymentId || payment.order_id !== order.razorpayOrderId || payment.amount !== row.total
                || payment.currency !== order.quote.currency || payment.status !== 'captured' || payment.captured !== true) throw new CheckoutError(409, 'The payment is not eligible for this refund. Refresh its status first.');
            const payload = JSON.stringify({amount:body.amount,speed:'normal',receipt:body.requestId});
            const now = Date.now();
            await db.batch([
                db.prepare(`INSERT INTO refunds(request_id,order_id,amount,status,reason,actor,created_at,updated_at,payload) VALUES(?,?,?,'submitting',?,?,?,?,?)`)
                    .bind(body.requestId,id,body.amount,reason,actor,now,now,payload),
                db.prepare('INSERT INTO events(order_id,actor,message,created_at) VALUES(?,?,?,?)').bind(id,actor,`Refund requested: ₹${(body.amount/100).toFixed(2)}; ${reason}`,now)
            ]);
            await sendRefund(order,{request_id:body.requestId,payload});
            return detail(id);
        });
    }
    async function retryRefund(id, requestId) {
        return store.lock(id,async () => {
            const order = JSON.parse((await rowFor(id)).checkout);
            ownKey(order);
            await refreshRefunds(order);
            const refund = await db.prepare('SELECT * FROM refunds WHERE request_id=? AND order_id=?').bind(requestId,id).first();
            if (!refund) throw new CheckoutError(404,'Refund request not found.');
            if (['submitting','uncertain'].includes(refund.status)) await sendRefund(order,refund);
            return detail(id);
        });
    }
    async function refundWebhook(event) {
        const entity = event.payload?.refund?.entity;
        if (!refundId(entity?.id) || typeof entity.payment_id !== 'string') throw new CheckoutError(400,'Invalid refund event.');
        const row = await db.prepare('SELECT id,checkout FROM orders WHERE payment_id=?').bind(entity.payment_id).first();
        if (!row) throw new CheckoutError(409,'Payment has not been recorded yet. Retry the refund event.');
        await store.lock(row.id, async () => {
            const order = JSON.parse(row.checkout);
            ownKey(order);
            await syncRefund(order,await gateway(`/refunds/${entity.id}`));
        });
    }
    return { list, detail, updateFulfilment, note, refund, retryRefund, refreshRefunds, refundWebhook };
}

export function ordersCSV(orders) {
    // Prevent spreadsheet formulas from customer-controlled names, addresses and notes.
    const cell = (value) => { const s=String(value ?? ''); return `"${/^[\s]*[=+\-@]|^[\t\r\n]/.test(s) ? "'" : ''}${s.replaceAll('"','""')}"`; };
    const headers=['Reference','Created (UTC)','Customer','Email','Phone','Address','City','State','PIN','Captured amount (INR)','Refunded (INR)','Payment status','Fulfilment','Courier','Tracking','Dispatch date','Payment ID','Mode'];
    return [headers,...orders.map((o)=>[o.reference,new Date(o.createdAt).toISOString(),o.customer?.name,o.customer?.email,o.customer?.phone,
        [o.customer?.address,o.customer?.address2].filter(Boolean).join(', '),o.customer?.city,o.customer?.state,o.customer?.postalCode,
        o.state==='paid' ? (o.quote.total/100).toFixed(2) : '0.00',(o.refunded/100).toFixed(2),o.state,fulfilmentLabels[o.fulfilment],o.courier,o.trackingNumber,o.dispatchDate,o.paymentId,o.testMode?'test':'live'])]
        .map((row)=>row.map(cell).join(',')).join('\r\n');
}
