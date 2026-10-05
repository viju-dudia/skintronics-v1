import { readPaymentConfig } from './lib/config.mjs';
import { createD1Store } from './lib/d1-store.mjs';
import { createCheckoutService } from './lib/checkout-service.mjs';
import { createRazorpayClient, CheckoutError, verifySignature } from './lib/razorpay.mjs';
import { authorizeAdmin } from './lib/access.mjs';
import { createAdminService, ordersCSV } from './lib/admin-service.mjs';
import { sendNotifications } from './lib/notifications.mjs';

const publicPaths=new Set(['/','/index.html','/checkout.html','/science.html','/results.html','/how-to-use.html','/styles.css','/checkout.css','/site.js','/checkout.js']);
const adminPaths=new Set(['/admin','/admin/','/admin.html','/admin.css','/admin.js','/admin-demo.js']);
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
async function bodyBytes(request,max=16384) {
    if (Number(request.headers.get('content-length'))>max) throw new CheckoutError(413,'Request is too large.');
    const reader=request.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks=[]; let length=0;
    while (true) {
        const {done,value}=await reader.read(); if (done) break;
        length+=value.length;
        if (length>max) { await reader.cancel(); throw new CheckoutError(413,'Request is too large.'); }
        chunks.push(value);
    }
    const bytes=new Uint8Array(length); let offset=0;
    for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
    return bytes;
}
async function bodyJSON(request,origin) {
    if (request.headers.get('origin')!==origin) throw new CheckoutError(403,'Open this action from the SKINTRONICS website.');
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||'')) throw new CheckoutError(415,'Expected a JSON request.');
    let body;
    try {body=JSON.parse(new TextDecoder().decode(await bodyBytes(request)));}
    catch (error) {if (error instanceof CheckoutError) throw error;throw new CheckoutError(400,'Invalid request.');}
    if (!body || typeof body!=='object' || Array.isArray(body)) throw new CheckoutError(400,'Invalid request.');
    return body;
}
async function rateLimit(db,key,maximum) {
    // Short, atomic counters shared between Worker instances; IP supplied by Cloudflare, not the browser.
    const bucket=`rate:${Math.floor(Date.now()/60000)}:${key}`;
    const row=await db.prepare(`INSERT INTO locks(id,owner,expires) VALUES(?,'1',?) ON CONFLICT(id) DO UPDATE SET owner=CAST(CAST(locks.owner AS INTEGER)+1 AS TEXT) RETURNING owner`)
        .bind(bucket,Date.now()+120000).first();
    if (Number(row.owner)>maximum) throw new CheckoutError(429,'Too many requests. Wait a minute and try again.');
}

export function createWorker({ authorize=authorizeAdmin, gatewayFactory=createRazorpayClient, allowTestFulfilment=false, preview=false }={}) {
    function services(env) {
        if (!env.DB) throw new CheckoutError(503,'Order storage is not configured.');
        const config=readPaymentConfig(env);
        const store=createD1Store(env.DB);
        const gateway=gatewayFactory(config);
        const checkout=createCheckoutService(config,store,gateway);
        const admin=createAdminService({config,store,gateway,allowTestFulfilment});
        return {config,store,gateway,checkout,admin};
    }
    async function refresh(id,env) {
        const {store,checkout,admin,config}=services(env);
        const order=await store.read(id);
        if (!order || order.keyId!==config.keyId) throw new CheckoutError(409,'Use the matching Razorpay key to check this order.');
        try {
            await checkout.status(order);
            await store.lock(id,async()=>admin.refreshRefunds(await store.read(id)));
            await env.DB.prepare('UPDATE orders SET checked_at=?,check_error=NULL,next_check=? WHERE id=?').bind(Date.now(),Date.now()+900000,id).run();
        } catch (error) {
            await env.DB.prepare('UPDATE orders SET check_error=?,next_check=? WHERE id=?').bind('Payment or refund verification needs another check.',Date.now()+300000,id).run();
            throw error;
        }
        return admin.detail(id);
    }
    return {
        async fetch(request,env) {
            try {
                const url=new URL(request.url); const path=url.pathname;
                if (adminPaths.has(path)) {
                    // The shell contains no customer data. API requests always require a validated identity.
                    if (!['GET','HEAD'].includes(request.method)) throw new CheckoutError(405,'Method not allowed.');
                    if (path==='/admin/') return new Response(null,{status:308,headers:{Location:'/admin','Cache-Control':'no-store'}});
                    const assetURL=new URL(path==='/admin'||path==='/admin/'?'/admin.html':path,url);
                    const asset=await env.ASSETS.fetch(new Request(assetURL,{method:request.method}));
                    const headers=new Headers(asset.headers);
                    headers.set('Cache-Control','no-store');
                    headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
                    headers.set('X-Content-Type-Options','nosniff');
                    headers.set('Referrer-Policy','no-referrer');
                    return new Response(asset.body,{status:asset.status,headers});
                }
                if (path.startsWith('/api/')) {
                    const {config,store,checkout,admin}=services(env);
                    if (path==='/api/razorpay/webhook' && request.method==='POST') {
                        const raw=await bodyBytes(request,262144);
                        const signature=request.headers.get('x-razorpay-signature');
                        if (!config.webhookSecret) throw new CheckoutError(503,'Webhook not configured.');
                        if (!verifySignature(raw,signature,config.webhookSecret)) throw new CheckoutError(400,'Invalid webhook signature.');
                        let event;try {event=JSON.parse(new TextDecoder().decode(raw));} catch {throw new CheckoutError(400,'Invalid webhook body.');}
                        if (['refund.created','refund.processed','refund.failed'].includes(event.event)) await admin.refundWebhook(event);
                        else await checkout.webhook(raw,signature);
                        return json({received:true});
                    }
                    if (path.startsWith('/api/admin/')) {
                        const identity=await authorize(request,env);
                        await rateLimit(env.DB,`admin:${identity.email}`,120);
                        if (request.method==='GET') {
                            if (path==='/api/admin/session') return json({email:identity.email,preview,notificationsConfigured:Boolean(env.RESEND_API_KEY&&env.EMAIL_FROM&&env.OWNER_EMAIL)});
                            if (path==='/api/admin/orders') return json(await admin.list(url.searchParams));
                            if (path==='/api/admin/orders/export') {
                                const result=await admin.list(url.searchParams,true);
                                return new Response('\uFEFF'+ordersCSV(result.orders),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="skintronics-orders.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
                            }
                            const match=/^\/api\/admin\/orders\/([a-f0-9-]{36})$/.exec(path);
                            if (match) return json(await admin.detail(match[1]));
                        }
                        if (request.method==='POST') {
                            const body=await bodyJSON(request,config.origin);
                            const match=/^\/api\/admin\/orders\/([a-f0-9-]{36})\/(fulfilment|notes|refunds|refresh|retry-refund)$/.exec(path);
                            if (match) {
                                const [,id,action]=match;
                                if (action==='fulfilment') return json(await admin.updateFulfilment(id,body,identity.email));
                                if (action==='notes') return json(await admin.note(id,body.message,identity.email));
                                if (action==='refunds') return json(await admin.refund(id,body,identity.email));
                                if (action==='retry-refund') return json(await admin.retryRefund(id,body.requestId));
                                return json(await refresh(id,env));
                            }
                        }
                        throw new CheckoutError(404,'Admin action not found.');
                    }
                    if (!['GET','POST'].includes(request.method)) throw new CheckoutError(405,'Method not allowed.');
                    await rateLimit(env.DB,`checkout:${request.headers.get('CF-Connecting-IP')||'unknown'}`,path==='/api/razorpay/order'?10:60);
                    const body=request.method==='POST'?await bodyJSON(request,config.origin):null;
                    let session=await checkout.session(request.headers.get('cookie'));
                    if (path==='/api/checkout' && request.method==='GET') {
                        let cookie;
                        if (config.enabled&&!session) {const created=await checkout.newSession();session=created.order;cookie=created.cookie;}
                        return json({enabled:config.enabled,testMode:config.testMode,keyId:config.enabled?config.keyId:null,country:config.country,
                            quote:session?.quote||config.quote,order:session?await checkout.status(session):null},200,cookie?{'Set-Cookie':cookie}:{});
                    }
                    if (!session) throw new CheckoutError(401,'Your checkout session expired. Reload the page to begin again.');
                    if (path==='/api/razorpay/status'&&request.method==='GET') return json(await checkout.status(session));
                    if (request.method==='POST') {
                        if (path==='/api/razorpay/order') {
                            if (!config.enabled) throw new CheckoutError(503,'Online payment is not available yet.');
                            return json(await checkout.createOrder(session,body.customer));
                        }
                        if (path==='/api/razorpay/verify') return json(await checkout.verify(session,body));
                        if (path==='/api/razorpay/reset') {
                            if ((await checkout.status(session)).state!=='paid') throw new CheckoutError(409,'Check your existing payment before starting another order.');
                            return json({reset:true},200,{'Set-Cookie':`skintronics_checkout=; HttpOnly; SameSite=Lax; Path=/api/; Max-Age=0${config.origin.startsWith('https:')?'; Secure':''}`});
                        }
                    }
                    throw new CheckoutError(404,'Not found.');
                }
                if (!['GET','HEAD'].includes(request.method)) throw new CheckoutError(405,'Method not allowed.');
                const asset=/^\/assets\/[A-Za-z0-9_-]+\.(webp|png|jpe?g)$/.test(path);
                const logo=path==='/Skintroniks-20260903T124736Z-1-001/Skintroniks/SKINTRONICS_LOGO.png';
                if (!publicPaths.has(path)&&!asset&&!logo) throw new CheckoutError(404,'Not found.');
                return env.ASSETS.fetch(request);
            } catch (error) {
                return json({error:error instanceof CheckoutError?error.message:'The request could not be completed. Refresh and try again.'},error instanceof CheckoutError?error.status:500);
            }
        },
        async scheduled(controller,env,ctx) {
            const task=(async()=>{
                const {config}=services(env);
                const rows=(await env.DB.prepare(`SELECT id FROM orders WHERE receipt IS NOT NULL AND key_id=? AND next_check<=?
                  AND (state<>'paid' OR fulfilment IN ('awaiting','processing','shipped','returned') OR EXISTS
                  (SELECT 1 FROM refunds WHERE order_id=orders.id AND status IN ('submitting','uncertain','pending')))
                  ORDER BY next_check,created_at LIMIT 8`).bind(config.keyId,Date.now()).all()).results;
                for (const row of rows) {try {await refresh(row.id,env);}catch {/* Errors are recorded on the order; try the next order. */}}
                await sendNotifications(env,env.DB);
                await env.DB.prepare('DELETE FROM locks WHERE expires<?').bind(Date.now()).run();
            })();
            if (ctx) ctx.waitUntil(task);
            return task;
        }
    };
}
export default createWorker();
