import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { createWorker } from '../worker.mjs';
import { localD1 } from './local-d1.mjs';
import { createD1Store } from '../lib/d1-store.mjs';

const db=localD1();
await db.exec(await readFile(new URL('../migrations/0001_admin.sql',import.meta.url),'utf8'));
const origin='http://127.0.0.1:4174';
const store=createD1Store(db);
const payments=new Map();const refunds=new Map();
const people=[['Asha Rao','Pune','awaiting','paid'],['Meera Kapoor','Mumbai','processing','paid'],['Ananya Iyer','Bengaluru','shipped','paid'],['Nisha Patel','Ahmedabad','delivered','paid'],['Riya Shah','Delhi','awaiting','pending'],['Kavya Nair','Kochi','cancelled','paid']];
for (const [index,[name,city,fulfilment,state]] of people.entries()) {
    const id=randomUUID();
    const order={id,keyId:'rzp_test_preview',tokenHash:'0'.repeat(64),testMode:true,createdAt:Date.now()-index*86400000,state:'created',receipt:`stx_preview_${String(index+1).padStart(4,'0')}`,
        razorpayOrderId:`order_Preview${index+1}`,quote:{price:799900,shipping:0,tax:0,total:799900,currency:'INR',product:'SM-2309',quantity:1},
        customer:{name,email:`customer${index+1}@example.test`,phone:'+919000000000',address:'12 Example Street',address2:'Preview address',city,state:'Example state',postalCode:'411001',country:'IN'}};
    await store.save(order);
    if(state==='paid'){order.state='paid';order.paymentId=`pay_Preview${index+1}`;order.paidAt=new Date(order.createdAt).toISOString();await store.save(order);}
    else{order.state='pending';await store.save(order);}
    await db.prepare('UPDATE orders SET fulfilment=?,courier=?,tracking_number=?,dispatch_date=? WHERE id=?')
        .bind(fulfilment,['shipped','delivered'].includes(fulfilment)?'Example Courier':'',['shipped','delivered'].includes(fulfilment)?`PREVIEW${index+1}`:'',['shipped','delivered'].includes(fulfilment)?new Date(order.createdAt).toISOString().slice(0,10):'',id).run();
    payments.set(`pay_Preview${index+1}`,{id:`pay_Preview${index+1}`,order_id:order.razorpayOrderId,amount:799900,currency:'INR',status:state==='paid'?'captured':'authorized',captured:state==='paid'});
    if(fulfilment==='cancelled')await db.prepare(`INSERT INTO refunds(request_id,order_id,gateway_id,amount,status,reason,actor,created_at,updated_at,payload) VALUES(?,?,?,?,'processed',?,?,?,?,?)`)
        .bind(randomUUID(),id,'rfnd_PreviewExisting',799900,'Customer requested cancellation','preview@example.test',Date.now(),Date.now(),'{}').run();
}
const gateway=async(path,payload,headers)=>{
    const match=/^\/payments\/(pay_[A-Za-z0-9]+)\/refund$/.exec(path);
    if(match){const key=headers['X-Refund-Idempotency'];if(!refunds.has(key))refunds.set(key,{id:`rfnd_Preview${refunds.size+1}`,payment_id:match[1],currency:'INR',amount:payload.amount,status:'pending',receipt:payload.receipt});return refunds.get(key);}
    if(path.startsWith('/refunds/'))return [...refunds.values()].find((r)=>r.id===path.slice(9));
    const refundList=/^\/payments\/(pay_[A-Za-z0-9]+)\/refunds/.exec(path);
    if(refundList)return {items:[...refunds.values()].filter((r)=>r.payment_id===refundList[1])};
    if(path.startsWith('/payments/'))return payments.get(path.slice(10));
    const orderList=/^\/orders\/(order_[A-Za-z0-9]+)\/payments$/.exec(path);
    if(orderList)return {items:[...payments.values()].filter((p)=>p.order_id===orderList[1])};
    throw new Error('Preview does not contact Razorpay.');
};
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg'};
const env={DB:db,APP_ORIGIN:origin,RAZORPAY_KEY_ID:'rzp_test_preview',RAZORPAY_KEY_SECRET:'preview-only',PRODUCT_PRICE_PAISE:'799900',SHIPPING_PAISE:'0',TAX_PAISE:'0',SHIPPING_COUNTRY:'IN',ASSETS:{async fetch(request){
    const path=new URL(request.url).pathname;
    try{return new Response(await readFile(new URL(`..${path==='/'?'/index.html':path}`,import.meta.url)),{headers:{'Content-Type':types[extname(path)]||'text/html; charset=utf-8'}});}catch{return new Response('Not found',{status:404});}
}}};
const worker=createWorker({authorize:async()=>({email:'preview@example.test'}),gatewayFactory:()=>gateway,allowTestFulfilment:true,preview:true});
const server=createServer(async(req,res)=>{
    try{
        const chunks=[];let length=0;for await(const c of req){length+=c.length;if(length>262144)throw new Error();chunks.push(c);}
        const request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
        const response=await worker.fetch(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500);res.end('Preview request failed.');}
});
server.listen(4174,'127.0.0.1',()=>console.log(`Admin fixture preview: ${origin}/admin (fictional orders; loopback only)`));
