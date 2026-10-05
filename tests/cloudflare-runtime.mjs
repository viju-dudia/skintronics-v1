// Runs against Cloudflare's actual local runtime after a fresh Wrangler dry build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions,Response:RuntimeResponse}=wranglerRequire('miniflare');

test('Cloudflare runtime verifies Access and persists checkout, fulfilment and refunds in D1',async(t)=>{
    const keyPair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',hash:'SHA-256',modulusLength:2048,publicExponent:new Uint8Array([1,0,1])},true,['sign','verify']);
    const jwk=await crypto.subtle.exportKey('jwk',keyPair.publicKey);jwk.kid='runtime-fixture';
    const header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
    const claims=Buffer.from(JSON.stringify({iss:'https://runtime-fixture.cloudflareaccess.com',aud:['runtime-audience'],exp:Date.now()/1000+300,email:'owner@example.test'})).toString('base64url');
    const signature=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keyPair.privateKey,new TextEncoder().encode(`${header}.${claims}`))).toString('base64url');
    const token=`${header}.${claims}.${signature}`;
    let remoteOrder;let remoteRefund;const origin='https://runtime.example.test';const requests=[];
    const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:new URL('../.cloudflare/worker/worker.js',import.meta.url).pathname,
        compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'runtime-fixture-database'},
        bindings:{APP_ORIGIN:origin,CHECKOUT_ENABLED:'true',RAZORPAY_KEY_ID:'rzp_live_runtimefixture',RAZORPAY_KEY_SECRET:'runtime-secret',RAZORPAY_WEBHOOK_SECRET:'runtime-webhook',PRODUCT_PRICE_PAISE:'799900',SHIPPING_PAISE:'0',TAX_PAISE:'0',SHIPPING_COUNTRY:'IN',ACCESS_TEAM_DOMAIN:'runtime-fixture.cloudflareaccess.com',ACCESS_AUD:'runtime-audience',ADMIN_EMAILS:'owner@example.test'},
        outboundService:async(request)=>{
            const url=new URL(request.url);
            requests.push(url.pathname);
            if(url.hostname==='runtime-fixture.cloudflareaccess.com')return RuntimeResponse.json({keys:[jwk]});
            assert.equal(url.hostname,'api.razorpay.com');
            const payment={id:'pay_RuntimeFixture',order_id:remoteOrder?.id,amount:799900,currency:'INR',status:'captured',captured:true};
            if(url.pathname==='/v1/orders'&&request.method==='POST'){remoteOrder={...await request.json(),id:'order_RuntimeFixture'};return RuntimeResponse.json(remoteOrder);}
            if(url.pathname==='/v1/payments/pay_RuntimeFixture/refund'){const body=await request.json();remoteRefund={...body,id:'rfnd_RuntimeFixture',payment_id:payment.id,currency:'INR',status:'pending'};assert.equal(request.headers.get('X-Refund-Idempotency'),body.receipt);return RuntimeResponse.json(remoteRefund);}
            if(url.pathname.endsWith('/refunds'))return RuntimeResponse.json({items:remoteRefund?[remoteRefund]:[]});
            if(url.pathname==='/v1/payments/pay_RuntimeFixture')return RuntimeResponse.json(payment);
            if(url.pathname.endsWith('/payments'))return RuntimeResponse.json({items:[payment]});
            if(url.pathname.startsWith('/v1/orders/'))return RuntimeResponse.json(remoteOrder);
            if(url.pathname==='/v1/refunds/rfnd_RuntimeFixture')return RuntimeResponse.json(remoteRefund);
            throw new Error(`Unexpected fixture request ${url.pathname}`);
        }}));
    t.after(()=>mf.dispose());
    const {DB}=await mf.getBindings();
    await DB.exec((await readFile(new URL('../migrations/0001_admin.sql',import.meta.url),'utf8')).replaceAll('\n',' '));
    const initial=await mf.dispatchFetch(`${origin}/api/checkout`);assert.equal(initial.status,200);
    const cookie=initial.headers.get('set-cookie').split(';')[0];
    const call=(path,body,admin=false)=>mf.dispatchFetch(`${origin}${path}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,...(admin?{'Cf-Access-Jwt-Assertion':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const customer={name:'Runtime Fixture',email:'customer@example.test',phone:'+919000000000',address:'1 Fixture Street',address2:'',city:'Pune',state:'Maharashtra',postalCode:'411001',country:'IN'};
    const creation=await call('/api/razorpay/order',{customer});assert.equal(creation.status,200,`${await creation.clone().text()} Fixture requests: ${requests.join(', ')}`);
    const order=await creation.json();
    const verification=await call('/api/razorpay/verify',{razorpay_order_id:order.razorpayOrderId,razorpay_payment_id:'pay_RuntimeFixture',razorpay_signature:createHmac('sha256','runtime-secret').update(`${order.razorpayOrderId}|pay_RuntimeFixture`).digest('hex')});assert.equal(verification.status,200,await verification.clone().text());
    assert.equal((await verification.json()).state,'paid');
    assert.equal((await call('/api/admin/orders')).status,401);
    const list=await call('/api/admin/orders',undefined,true);assert.equal(list.status,200,await list.clone().text());
    const orders=await list.json();assert.equal(orders.count,1);const id=orders.orders[0].id;
    const update=await call(`/api/admin/orders/${id}/fulfilment`,{version:0,fulfilment:'processing'},true);assert.equal(update.status,200,await update.clone().text());
    const refunded=await call(`/api/admin/orders/${id}/refunds`,{requestId:randomUUID(),amount:100000,reason:'Runtime fixture refund'},true);assert.equal(refunded.status,200,await refunded.clone().text());
    const result=await refunded.json();assert.equal(result.fulfilment,'processing');assert.equal(result.refunds[0].status,'pending');assert.equal(result.refundTotals.available,699900);
    remoteRefund.status='processed';const raw=JSON.stringify({event:'refund.processed',payload:{refund:{entity:remoteRefund}}});
    const event=await mf.dispatchFetch(`${origin}/api/razorpay/webhook`,{method:'POST',headers:{'x-razorpay-signature':createHmac('sha256','runtime-webhook').update(raw).digest('hex')},body:raw});assert.equal(event.status,200,await event.clone().text());
    const detail=await (await call(`/api/admin/orders/${id}`,undefined,true)).json();assert.equal(detail.refundTotals.processed,100000);assert.equal(detail.notifications.length,3);
});
