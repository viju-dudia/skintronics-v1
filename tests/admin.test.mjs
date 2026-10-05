import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID,createHmac } from 'node:crypto';
import { localD1 } from '../scripts/local-d1.mjs';
import { createD1Store } from '../lib/d1-store.mjs';
import { createCheckoutService } from '../lib/checkout-service.mjs';
import { createAdminService,ordersCSV } from '../lib/admin-service.mjs';
import { readPaymentConfig } from '../lib/config.mjs';
import { authorizeAdmin } from '../lib/access.mjs';
import { createWorker } from '../worker.mjs';
import { sendNotifications } from '../lib/notifications.mjs';
import { GatewayRequestError } from '../lib/razorpay.mjs';

const schema=await readFile(new URL('../migrations/0001_admin.sql',import.meta.url),'utf8');
const envBase={APP_ORIGIN:'https://shop.example.test',CHECKOUT_ENABLED:'true',RAZORPAY_KEY_ID:'rzp_live_fixture',RAZORPAY_KEY_SECRET:'fixture-secret',RAZORPAY_WEBHOOK_SECRET:'fixture-webhook',PRODUCT_PRICE_PAISE:'799900',SHIPPING_PAISE:'0',TAX_PAISE:'0',SHIPPING_COUNTRY:'IN'};
const customer={name:'Fixture Customer',email:'customer@example.test',phone:'+919000000000',address:'12 Fixture Street',address2:'',city:'Pune',state:'Maharashtra',postalCode:'411001',country:'IN'};
async function fixture(t) {
    const db=localD1();await db.exec(schema);t.after(()=>db.close());
    const env={...envBase,DB:db};const config=readPaymentConfig(env);const store=createD1Store(db);
    const remote={orders:[],refunds:[],refundCalls:0,loseRefundResponse:false,loseOrderResponse:false,payment:null,keys:[]};
    const gateway=async(path,payload,headers={})=>{
        if(path==='/orders'&&payload){const order={...payload,id:`order_Fixture${remote.orders.length+1}`};remote.orders.push(order);if(remote.loseOrderResponse)throw new Error('Response lost');return order;}
        if(path.startsWith('/orders?receipt='))return {items:remote.orders.filter((o)=>o.receipt===new URL(path,'https://fixture.test').searchParams.get('receipt'))};
        if(/\/orders\/order_Fixture\d+\/payments/.test(path))return {items:remote.payment?[remote.payment]:[]};
        if(/\/payments\/pay_Fixture\d+\/refunds/.test(path))return {items:remote.refunds};
        if(/\/payments\/pay_Fixture\d+\/refund$/.test(path)&&payload){remote.refundCalls++;remote.keys.push(headers['X-Refund-Idempotency']);let r=remote.refunds.find((r)=>r.receipt===payload.receipt);if(!r){r={id:`rfnd_Fixture${remote.refunds.length+1}`,payment_id:remote.payment.id,currency:'INR',amount:payload.amount,status:'pending',receipt:payload.receipt};remote.refunds.push(r);}if(remote.loseRefundResponse)throw new Error('Response lost');return r;}
        if(path.startsWith('/refunds/'))return remote.refunds.find((r)=>r.id===path.slice(9));
        if(path.startsWith('/payments/'))return remote.payment;
        return remote.orders.find((o)=>path===`/orders/${o.id}`);
    };
    const checkout=createCheckoutService(config,store,gateway);
    const admin=createAdminService({config,store,gateway});
    async function create({paid=true,testMode=false}={}){
        const {order}=await checkout.newSession();await checkout.createOrder(order,customer);
        remote.payment={id:`pay_Fixture${remote.orders.length}`,order_id:remote.orders.at(-1).id,amount:799900,currency:'INR',status:paid?'captured':'authorized',captured:paid};
        await checkout.status(await store.read(order.id));
        if(testMode)await db.prepare('UPDATE orders SET test_mode=1 WHERE id=?').bind(order.id).run();
        return admin.detail(order.id);
    }
    const worker=createWorker({authorize:async()=>({email:'owner@example.test'}),gatewayFactory:()=>gateway});
    const api=(path,body,headers={})=>worker.fetch(new Request(`${env.APP_ORIGIN}${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:env.APP_ORIGIN,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),env);
    return {db,env,config,store,remote,gateway,checkout,admin,create,api,worker};
}

test('D1 capture, restart recovery, pending persistence and notification deduplication',async(t)=>{
    const f=await fixture(t);const order=await f.create({paid:false});
    assert.equal((await f.store.read(order.id)).state,'pending');
    f.remote.payment.status='captured';f.remote.payment.captured=true;
    await f.checkout.status(await f.store.read(order.id));await f.checkout.status(await f.store.read(order.id));
    const restarted=createD1Store(f.db);assert.equal((await restarted.read(order.id)).state,'paid');
    assert.equal((await f.db.prepare('SELECT count(*) AS count FROM notifications').first()).count,2);
    assert.equal((await f.admin.detail(order.id)).events.filter((e)=>e.message==='Payment captured and verified').length,1);
});
test('ambiguous order creation is recovered by its receipt without a second gateway order',async(t)=>{
    const f=await fixture(t);const {order}=await f.checkout.newSession();f.remote.loseOrderResponse=true;
    await assert.rejects(f.checkout.createOrder(order,customer));
    assert.equal((await f.store.read(order.id)).state,'creating');f.remote.loseOrderResponse=false;
    assert.equal((await f.checkout.createOrder(order,customer)).state,'created');assert.equal(f.remote.orders.length,1);
});
test('admin list excludes empty sessions, defaults to live, filters and does not expose checkout secrets',async(t)=>{
    const f=await fixture(t);await f.checkout.newSession();const live=await f.create();await f.create({testMode:true});
    const response=await f.api('/api/admin/orders');assert.equal(response.status,200);const data=await response.json();
    assert.equal(data.count,1);assert.equal(data.orders[0].id,live.id);assert.equal(data.metrics.captured,799900);
    assert.equal(JSON.stringify(data).includes('tokenHash'),false);assert.equal(JSON.stringify(data).includes('fixture-secret'),false);
    assert.equal((await f.admin.list(new URLSearchParams('mode=test'))).count,1);
    assert.equal((await f.admin.list(new URLSearchParams('q=missing'))).count,0);
    assert.equal((await f.admin.list(new URLSearchParams('payment=pending'))).count,0);
    await assert.rejects(f.admin.list(new URLSearchParams('from=2026-02-30')));
});
test('fulfilment requires live capture, valid transitions, tracking, version and audit history',async(t)=>{
    const f=await fixture(t);const order=await f.create();
    const body={version:0,fulfilment:'processing'};await f.admin.updateFulfilment(order.id,body,'owner@example.test');
    await assert.rejects(f.admin.updateFulfilment(order.id,body,'owner@example.test'),/another session/);
    await assert.rejects(f.admin.updateFulfilment(order.id,{version:1,fulfilment:'shipped'},'owner@example.test'),/courier/);
    const shipped=await f.admin.updateFulfilment(order.id,{version:1,fulfilment:'shipped',courier:'Fixture courier',trackingNumber:'FIX123',dispatchDate:'2026-01-01'},'owner@example.test');
    assert.equal(shipped.fulfilment,'shipped');assert.equal(shipped.version,2);
    assert.equal(shipped.notifications.filter((n)=>n.kind==='shipped').length,1);
    await f.checkout.status(await f.store.read(order.id));assert.equal((await f.admin.detail(order.id)).trackingNumber,'FIX123');
    const pending=await f.create({paid:false});await assert.rejects(f.admin.updateFulfilment(pending.id,{version:0,fulfilment:'processing'},'owner'),/verified, live/);
    const testOrder=await f.create({testMode:true});await assert.rejects(f.admin.updateFulfilment(testOrder.id,{version:0,fulfilment:'processing'},'owner'),/verified, live/);
});
test('a refund timeout preserves intent; repeated requests use the same key and cannot over-refund',async(t)=>{
    const f=await fixture(t);const order=await f.create();f.remote.loseRefundResponse=true;
    const body={requestId:randomUUID(),amount:100000,reason:'Customer request'};
    let detail=await f.admin.refund(order.id,body,'owner');assert.equal(detail.refunds[0].status,'uncertain');
    assert.equal(detail.refundTotals.available,699900);
    await assert.rejects(f.admin.refund(order.id,{...body,amount:200000},'owner'),/cannot change/);
    f.remote.loseRefundResponse=false;detail=await f.admin.refund(order.id,body,'owner');
    assert.equal(detail.refunds[0].status,'pending');assert.equal(f.remote.refunds.length,1);assert.deepEqual(f.remote.keys,[body.requestId,body.requestId]);
    await assert.rejects(f.admin.refund(order.id,{requestId:randomUUID(),amount:700000,reason:'Too much'},'owner'),/exceeds/);
    assert.equal(f.remote.refunds.length,1);
    f.remote.refunds[0].status='processed';await f.admin.refreshRefunds(await f.store.read(order.id));
    assert.equal((await f.admin.detail(order.id)).refundTotals.processed,100000);
});
test('refund webhooks verify current status, import dashboard refunds, deduplicate and block full-refund dispatch',async(t)=>{
    const f=await fixture(t);const order=await f.create();
    const entity={id:'rfnd_External',payment_id:order.paymentId,currency:'INR',amount:799900,status:'processed'};f.remote.refunds.push(entity);
    const event={event:'refund.processed',payload:{refund:{entity}}};
    const raw=JSON.stringify(event);const signature=createHmac('sha256',envBase.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    const send=(sig)=>f.worker.fetch(new Request(`${f.env.APP_ORIGIN}/api/razorpay/webhook`,{method:'POST',headers:{'x-razorpay-signature':sig},body:raw}),f.env);
    assert.equal((await send('0'.repeat(64))).status,400);assert.equal((await send(signature)).status,200);assert.equal((await send(signature)).status,200);
    const detail=await f.admin.detail(order.id);assert.equal(detail.refunds.length,1);assert.equal(detail.refundTotals.available,0);
    assert.equal(detail.notifications.filter((n)=>n.kind==='refund').length,1);
    await assert.rejects(f.admin.updateFulfilment(order.id,{version:0,fulfilment:'processing'},'owner'),/verified, live/);
});
test('admin rejects cross-origin writes, malformed bodies and production access bypasses',async(t)=>{
    const f=await fixture(t);const order=await f.create();
    assert.equal((await f.api(`/api/admin/orders/${order.id}/notes`,{message:'test'},{Origin:'https://evil.test'})).status,403);
    assert.equal((await f.api(`/api/admin/orders/${order.id}/notes`,[])).status,400);
    const production=createWorker({gatewayFactory:()=>f.gateway});
    const request=new Request(`${f.env.APP_ORIGIN}/api/admin/orders`,{headers:{'cf-access-authenticated-user-email':'owner@example.test'}});
    assert.equal((await production.fetch(request,f.env)).status,503);
    assert.equal((await production.fetch(request,{...f.env,ACCESS_TEAM_DOMAIN:'fixture.cloudflareaccess.com',ACCESS_AUD:'fixture-aud',ADMIN_EMAILS:'owner@example.test'})).status,401);
    assert.equal((await f.api('/api/admin/orders/export')).headers.get('content-type'),'text/csv; charset=utf-8');
});
test('CSV neutralises spreadsheet formulas and internal notes are retained as text',async(t)=>{
    const f=await fixture(t);const order=await f.create();await f.admin.note(order.id,'<script>example</script>','owner');
    assert.ok((await f.admin.detail(order.id)).events.some((e)=>e.message==='Note: <script>example</script>'));
    const csv=ordersCSV([{...order,customer:{...customer,name:'=HYPERLINK("evil")'}}]);assert.ok(csv.includes("\"'=HYPERLINK"));
});
test('cross-instance D1 lease serialises an order and releases after errors',async(t)=>{
    const f=await fixture(t);let release;const gate=new Promise((resolve)=>release=resolve);
    const first=f.store.lock('fixture-lock',async()=>gate);await new Promise((resolve)=>setImmediate(resolve));
    await assert.rejects(createD1Store(f.db).lock('fixture-lock',async()=>{}),/being updated/);release();await first;
    await assert.rejects(f.store.lock('fixture-lock',async()=>{throw new Error('failure');}));
    await createD1Store(f.db).lock('fixture-lock',async()=>{});
});
test('an expired lease cannot write stale checkout data',async(t)=>{
    const f=await fixture(t);const order=await f.create();
    await f.store.lock(order.id,async()=>{
        await f.db.prepare('UPDATE locks SET expires=0 WHERE id=?').bind(order.id).run();
        const stale=await f.store.read(order.id);stale.state='created';
        await assert.rejects(f.store.save(stale),/expired/);
    });
    assert.equal((await f.store.read(order.id)).state,'paid');
});
test('a definitive refund rejection releases the reserved amount',async(t)=>{
    const f=await fixture(t);const order=await f.create();
    const service=createAdminService({config:f.config,store:f.store,gateway:async(path,...args)=>{
        if(path.endsWith('/refund'))throw new GatewayRequestError(400);return f.gateway(path,...args);
    }});
    const detail=await service.refund(order.id,{requestId:randomUUID(),amount:100000,reason:'Fixture rejection'},'owner');
    assert.equal(detail.refunds[0].status,'failed');assert.equal(detail.refundTotals.available,799900);
});
test('scheduled reconciliation captures a payment after the browser is gone',async(t)=>{
    const f=await fixture(t);const order=await f.create({paid:false});f.remote.payment.status='captured';f.remote.payment.captured=true;
    await f.worker.scheduled({},f.env);assert.equal((await f.store.read(order.id)).state,'paid');
    assert.ok((await f.admin.detail(order.id)).checkedAt);
});
test('a full refund before capture recovery is reconciled without making the order dispatchable',async(t)=>{
    const f=await fixture(t);const order=await f.create({paid:false});
    f.remote.payment.status='refunded';f.remote.payment.captured=true;
    f.remote.refunds.push({id:'rfnd_LateFixture',payment_id:f.remote.payment.id,currency:'INR',amount:799900,status:'processed'});
    await f.worker.scheduled({},f.env);
    const detail=await f.admin.detail(order.id);assert.equal(detail.state,'paid');assert.equal(detail.refundTotals.processed,799900);
    await assert.rejects(f.admin.updateFulfilment(order.id,{version:0,fulfilment:'processing'},'owner'),/verified, live/);
});
test('notifications retain exact payload and idempotency key across uncertain responses',async(t)=>{
    const f=await fixture(t);await f.create();const env={...f.env,RESEND_API_KEY:'fixture-key',EMAIL_FROM:'Store <store@example.test>',OWNER_EMAIL:'owner@example.test'};
    const attempts=[];let fail=true;const fetchEmail=async(url,options)=>{attempts.push(options);if(fail)throw new Error('timeout');return new Response('{}');};
    await sendNotifications(env,f.db,fetchEmail);assert.equal(attempts.length,2);
    await f.db.prepare('UPDATE notifications SET next_attempt=0').run();fail=false;
    await sendNotifications(env,f.db,fetchEmail);
    assert.equal(attempts[0].body,attempts[2].body);assert.equal(attempts[0].headers['Idempotency-Key'],attempts[2].headers['Idempotency-Key']);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM notifications WHERE state='sent'").first()).count,2);
});
test('Access validates signature, issuer, audience, expiry and the owner allowlist',async()=>{
    const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
    const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey);jwk.kid='fixture-key';
    const env={ACCESS_TEAM_DOMAIN:'authfixture.cloudflareaccess.com',ACCESS_AUD:'fixture-audience',ADMIN_EMAILS:'owner@example.test'};
    const fetchCerts=async()=>Response.json({keys:[jwk]});
    async function request(overrides={}){
        const header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
        const claims=Buffer.from(JSON.stringify({iss:`https://${env.ACCESS_TEAM_DOMAIN}`,aud:[env.ACCESS_AUD],exp:Date.now()/1000+60,email:'owner@example.test',...overrides})).toString('base64url');
        const signature=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(`${header}.${claims}`))).toString('base64url');
        return new Request('https://shop.example.test/api/admin/session',{headers:{'Cf-Access-Jwt-Assertion':`${header}.${claims}.${signature}`}});
    }
    assert.equal((await authorizeAdmin(await request(),env,fetchCerts)).email,'owner@example.test');
    for(const bad of [{exp:0},{iss:'https://evil.test'},{aud:['wrong']},{email:'other@example.test'}])await assert.rejects(authorizeAdmin(await request(bad),env,fetchCerts));
    const forged=await request();forged.headers.set('Cf-Access-Jwt-Assertion',forged.headers.get('Cf-Access-Jwt-Assertion').slice(0,-5)+'abcde');await assert.rejects(authorizeAdmin(forged,env,fetchCerts));
});
test('legacy migration preserves checkout sessions and quotes and is safe to re-import',async(t)=>{
    const f=await fixture(t);const original=await f.create();const stored=await f.store.read(original.id);
    stored.customer.name="Fixture O'Brien";
    const directory=await mkdtemp(join(tmpdir(),'skintronics-migration-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const source=join(directory,'source');await mkdir(source);
    await writeFile(join(source,`${stored.id}.json`),JSON.stringify(stored));
    await promisify(execFile)(process.execPath,[resolve('scripts/export-legacy-orders.mjs'),source],{cwd:directory});
    const sql=await readFile(join(directory,'.data/import/orders.sql'),'utf8');
    const target=localD1();t.after(()=>target.close());await target.exec(schema);await target.exec(sql);await target.exec(sql);
    assert.equal((await target.prepare('SELECT count(*) AS count FROM orders').first()).count,1);
    assert.deepEqual(await createD1Store(target).read(stored.id),stored);
    assert.equal((await target.prepare('SELECT count(*) AS count FROM notifications').first()).count,0);
});
