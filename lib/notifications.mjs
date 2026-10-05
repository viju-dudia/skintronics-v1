export async function sendNotifications(env, db, fetchAPI = fetch) {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.OWNER_EMAIL) return { configured:false, sent:0 };
    const now=Date.now();
    const jobs=(await db.prepare(`SELECT * FROM notifications WHERE (state='queued' AND next_attempt<=?) OR (state='sending' AND lease_until<?) ORDER BY created_at LIMIT 8`).bind(now,now).all()).results;
    let sent=0;
    for (const job of jobs) {
        // Resend retains idempotency keys for 24h. Old uncertain sends require manual review.
        if (job.attempts>=6 || (job.first_attempt && now-job.first_attempt>=23*3600000)) {
            await db.prepare("UPDATE notifications SET state='failed',error=? WHERE id=? AND state<>'sent'").bind('Delivery needs review. Check the email provider before resending.',job.id).run();
            continue;
        }
        const claim=await db.prepare(`UPDATE notifications SET state='sending',lease_until=?,attempts=attempts+1,first_attempt=coalesce(first_attempt,?)
          WHERE id=? AND ((state='queued' AND next_attempt<=?) OR (state='sending' AND lease_until<?))`).bind(now+120000,now,job.id,now,now).run();
        if (!claim.meta.changes) continue;
        try {
            let payload=job.payload;
            if (!payload) {
                const row=await db.prepare('SELECT checkout,courier,tracking_number FROM orders WHERE id=?').bind(job.order_id).first();
                const order=JSON.parse(row.checkout);
                if (order.testMode) throw new Error();
                const money=(order.quote.total/100).toFixed(2);
                const subject=job.kind==='owner_paid' ? `New paid order ${order.receipt}` : job.kind==='customer_paid' ? `Your SKINTRONICS order ${order.receipt}` : job.kind==='shipped' ? `Your order ${order.receipt} has shipped` : `Refund processed for ${order.receipt}`;
                let text=job.kind==='owner_paid' ? `A live payment of INR ${money} has been verified. Open the admin dashboard to review order ${order.receipt}.`
                    : job.kind==='customer_paid' ? `Thank you, ${order.customer.name}. Your payment of INR ${money} is confirmed. Your order reference is ${order.receipt}.`
                    : job.kind==='shipped' ? `Your order ${order.receipt} has shipped with ${row.courier}. Tracking number: ${row.tracking_number}.`
                    : `Razorpay has marked your refund as processed. Refund reference: ${job.detail}. Bank credit may take additional time.`;
                if (job.kind==='refund') {
                    const refund=await db.prepare('SELECT amount FROM refunds WHERE gateway_id=?').bind(job.detail).first();
                    text+=` Refund amount: INR ${(refund.amount/100).toFixed(2)}.`;
                }
                payload=JSON.stringify({from:env.EMAIL_FROM,to:[job.kind==='owner_paid'?env.OWNER_EMAIL:order.customer.email],subject,text});
                await db.prepare('UPDATE notifications SET payload=? WHERE id=?').bind(payload,job.id).run();
            }
            const response=await fetchAPI('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`stx-${job.id}`},body:payload,signal:AbortSignal.timeout(15000),redirect:'manual'});
            if (!response.ok) throw new Error();
            await db.prepare("UPDATE notifications SET state='sent',sent_at=?,error=NULL WHERE id=?").bind(Date.now(),job.id).run();
            sent++;
        } catch {
            await db.prepare("UPDATE notifications SET state='queued',next_attempt=?,error=? WHERE id=? AND state='sending'")
                .bind(Date.now()+Math.min(3600000,120000*2**job.attempts),'Email delivery could not be confirmed. Automatic retry is queued.',job.id).run();
        }
    }
    return {configured:true,sent};
}
