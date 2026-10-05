import { randomUUID } from 'node:crypto';
import { CheckoutError } from './razorpay.mjs';

export function createD1Store(db) {
    let lease=null;
    async function guardedBatch(statements) {
        const raw=statements.map((s)=>s.nativeStatement||s);
        if (!lease) return db.batch(raw);
        const id=randomUUID();
        try {
            const result=await db.batch([
                db.prepare('INSERT INTO write_guards(id,lease_id,owner) VALUES(?,?,?)').bind(id,lease.id,lease.owner),
                ...raw, db.prepare('DELETE FROM write_guards WHERE id=?').bind(id)
            ]);
            return result.slice(1,-1);
        } catch(error) {
            if (String(error.message).includes('lease expired')) throw new CheckoutError(409,'This update expired. Refresh the order before trying again.');
            throw error;
        }
    }
    const database={
        prepare(sql) {
            let raw=db.prepare(sql);
            const statement={
                get nativeStatement(){return raw;},
                bind(...args){raw=raw.bind(...args);return statement;},
                first(...args){return raw.first(...args);},
                all(...args){return raw.all(...args);},
                async run(){return lease?(await guardedBatch([raw]))[0]:raw.run();}
            };
            return statement;
        },
        batch:guardedBatch
    };
    return {
        db:database,
        async read(id) {
            if (typeof id !== 'string') return null;
            const row = await db.prepare('SELECT checkout FROM orders WHERE id=?').bind(id).first();
            return row ? JSON.parse(row.checkout) : null;
        },
        async save(order) {
            // Only checkout fields are updated here. Shipping and refunds have independent records.
            await database.prepare(`INSERT INTO orders(id,checkout,state,key_id,test_mode,receipt,gateway_order_id,payment_id,total,created_at,customer_name,customer_email,customer_phone)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
              checkout=excluded.checkout,state=excluded.state,receipt=excluded.receipt,gateway_order_id=excluded.gateway_order_id,
              payment_id=excluded.payment_id,customer_name=excluded.customer_name,customer_email=excluded.customer_email,customer_phone=excluded.customer_phone`)
                .bind(order.id, JSON.stringify(order), order.state, order.keyId, Number(order.testMode), order.receipt || null,
                    order.razorpayOrderId || null, order.paymentId || null, order.quote.total, order.createdAt,
                    order.customer?.name || '', order.customer?.email || '', order.customer?.phone || '').run();
        },
        async lock(id, action) {
            const owner = randomUUID();
            // Cross-isolate lease, rather than a Map in one Worker. All gateway calls have a 15s timeout.
            const now = Date.now();
            const claim = await db.prepare(`INSERT INTO locks(id,owner,expires) VALUES(?,?,?)
              ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<?`)
                .bind(id, owner, now + 120000, now).run();
            if (!claim.meta.changes) throw new CheckoutError(409, 'This order is being updated. Wait a moment, then refresh.');
            lease={id,owner};
            try { return await action(); }
            finally { lease=null; await db.prepare('DELETE FROM locks WHERE id=? AND owner=?').bind(id, owner).run(); }
        }
    };
}
