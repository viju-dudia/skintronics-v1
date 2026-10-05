import { mkdir,readFile,readdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';

const source=resolve(process.argv[2]||'.data/orders');
const destination=resolve('.data/import');
const entries=(await readdir(source)).filter((name)=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(name)).sort();
const literal=(value)=>value===null?'NULL':typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;
const sql=[];const manifest=[];
for(const name of entries){
    const raw=await readFile(join(source,name),'utf8');const order=JSON.parse(raw);
    if(`${order.id}.json`!==name||!Number.isSafeInteger(order.quote?.total)||order.quote.total<=0||!Number.isSafeInteger(order.createdAt)
        ||typeof order.keyId!=='string'||typeof order.testMode!=='boolean'||!['new','creating','created','pending','paid'].includes(order.state)
        ||!/^[a-f0-9]{64}$/.test(order.tokenHash)|| (order.state==='paid'&&!/^pay_[A-Za-z0-9]+$/.test(order.paymentId||'')))throw new Error(`Invalid legacy record: ${name}. No export was written.`);
    const values=[order.id,JSON.stringify(order),order.state,order.keyId,Number(order.testMode),order.receipt||null,order.razorpayOrderId||null,order.paymentId||null,order.quote.total,order.createdAt,order.customer?.name||'',order.customer?.email||'',order.customer?.phone||''];
    sql.push(`INSERT INTO orders(id,checkout,state,key_id,test_mode,receipt,gateway_order_id,payment_id,total,created_at,customer_name,customer_email,customer_phone) VALUES(${values.map(literal).join(',')}) ON CONFLICT(id) DO NOTHING;`);
    manifest.push({id:order.id,state:order.state,total:order.quote.total,testMode:order.testMode,sha256:createHash('sha256').update(raw).digest('hex')});
}
await mkdir(destination,{recursive:true,mode:0o700});
await writeFile(join(destination,'orders.sql'),sql.join('\n'),{mode:0o600});
await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
console.log(`Prepared ${entries.length} legacy records in .data/import. Treat both files as private customer data. Existing IDs will not be overwritten.`);
