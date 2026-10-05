// Fictional sample data only. No customer records, credentials or gateway calls.
const people=[['Asha Rao','Pune','awaiting','paid'],['Meera Kapoor','Mumbai','processing','paid'],['Ananya Iyer','Bengaluru','shipped','paid'],['Nisha Patel','Ahmedabad','delivered','paid'],['Riya Shah','Delhi','awaiting','pending'],['Kavya Nair','Kochi','cancelled','paid']];
const today=new Date().setUTCHours(0,0,0,0);
const orders=people.map(([name,city,fulfilment,state],index)=>{
    const createdAt=today-index*86400000;
    const refunded=fulfilment==='cancelled'?799900:0;
    const shipped=['shipped','delivered'].includes(fulfilment);
    return {id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,reference:`stx_demo_${String(index+1).padStart(4,'0')}`,
        state,fulfilment,testMode:true,createdAt,paidAt:state==='paid'?new Date(createdAt).toISOString():null,
        customer:{name,email:`customer${index+1}@example.test`,phone:'+919000000000',address:'12 Example Street',address2:'Fictional demo address',city,state:'Example state',postalCode:'411001',country:'IN'},
        quote:{price:799900,shipping:0,tax:0,total:799900,currency:'INR',product:'SM-2309',quantity:1},
        paymentId:state==='paid'?`pay_Demo${index+1}`:null,razorpayOrderId:`order_Demo${index+1}`,paymentAttempts:[],
        courier:shipped?'Example Courier':'',trackingNumber:shipped?`DEMO${index+1}`:'',dispatchDate:shipped?new Date(createdAt).toISOString().slice(0,10):'',
        version:0,checkedAt:createdAt,checkError:null,refunded,
        refunds:refunded?[{request_id:'demo-refund',gateway_id:'rfnd_Demo',amount:refunded,status:'processed',reason:'Sample cancellation',error:null}]:[],
        refundTotals:{processed:refunded,reserved:refunded,available:799900-refunded,uncertain:false},
        events:[{actor:'Demo preview',message:'Fictional order created for dashboard preview',createdAt}],notifications:[]};
});

export function demoRequest(path,body,raw=false){
    if(body!==undefined)throw new Error('Demo preview is read-only. Connect Cloudflare to save changes or issue refunds.');
    const url=new URL(path,'https://demo.example.test');
    if(url.pathname==='/api/admin/session')return {email:'Demo preview',preview:true,readOnly:true,notificationsConfigured:false};
    if(['/api/admin/orders','/api/admin/orders/export'].includes(url.pathname)){
        const p=url.searchParams,mode=p.get('mode')||'live';
        const modeOrders=mode==='test'?orders:[];
        const q=(p.get('q')||'').trim().toLowerCase();
        const filtered=modeOrders.filter((o)=>{
            if(q&&!`${o.customer.name} ${o.customer.email} ${o.customer.phone} ${o.reference} ${o.paymentId||''}`.toLowerCase().includes(q))return false;
            if(p.get('payment')&&p.get('payment')!==o.state)return false;
            if(p.get('fulfilment')&&p.get('fulfilment')!==o.fulfilment)return false;
            if(p.get('from')&&o.createdAt<Date.parse(p.get('from')))return false;
            if(p.get('to')&&o.createdAt>=Date.parse(p.get('to'))+86400000)return false;
            return true;
        });
        if(url.pathname.endsWith('/export')&&raw){
            const quote=(v)=>`"${String(v??'').replaceAll('"','""')}"`;
            const csv=[['Order','Customer','Amount (INR)','Payment','Fulfilment'],...filtered.map((o)=>[o.reference,o.customer.name,(o.quote.total/100).toFixed(2),o.state,o.fulfilment])].map((row)=>row.map(quote).join(',')).join('\r\n');
            return new Response('\uFEFF'+csv,{headers:{'Content-Type':'text/csv; charset=utf-8'}});
        }
        const page=Math.max(1,Number(p.get('page'))||1);
        return {orders:structuredClone(filtered.slice((page-1)*25,page*25)),count:filtered.length,page,pages:Math.max(1,Math.ceil(filtered.length/25)),mode,
            metrics:{awaiting:modeOrders.filter((o)=>o.state==='paid'&&['awaiting','processing'].includes(o.fulfilment)).length,
                shipped:modeOrders.filter((o)=>o.fulfilment==='shipped').length,captured:modeOrders.filter((o)=>o.state==='paid').reduce((n,o)=>n+o.quote.total,0),refunded:modeOrders.reduce((n,o)=>n+o.refunded,0)}};
    }
    const match=/^\/api\/admin\/orders\/([a-f0-9-]{36})$/.exec(url.pathname);
    const order=match&&orders.find((o)=>o.id===match[1]);
    if(order)return structuredClone(order);
    throw new Error('Demo order not found.');
}
