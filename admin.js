(() => {
    // TEMPORARY PREVIEW: set this to false before live production deployment.
    // This skips login only for fictional, read-only demo data. Enable Cloudflare Access
    // and configure the Worker before using real orders; server authentication stays required.
    const TEMPORARY_STATIC_PREVIEW=true;
    const githubPages=location.hostname.endsWith('.github.io');
    const localDemo=['localhost','127.0.0.1'].includes(location.hostname)&&new URLSearchParams(location.search).get('preview')==='demo';
    const staticPreview=TEMPORARY_STATIC_PREVIEW&&(githubPages||localDemo);
    const demo=staticPreview?import('./admin-demo.js'):null;
    const $=(selector)=>document.querySelector(selector);
    const escape=(value)=>String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money=(value)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format((value||0)/100);
    const date=(value)=>value?new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'Not checked yet';
    const fulfilment={awaiting:'Awaiting fulfilment',processing:'Processing',shipped:'Shipped',delivered:'Delivered',cancelled:'Cancelled',returned:'Returned'};
    const payments={paid:'Paid',pending:'Pending capture',created:'Awaiting payment',creating:'Checking order'};
    const transitions={awaiting:['processing','cancelled'],processing:['shipped','cancelled'],shipped:['delivered','returned'],delivered:['returned'],cancelled:[],returned:[]};
    const refundLabels={submitting:'Submitting',uncertain:'Checking status',pending:'Pending',processed:'Processed',failed:'Failed'};
    let session, current, page=1, pages=1, listRevision=0, detailRevision=0, pendingRefund, actionBusy=false;
    const pendingKey=(id)=>`skintronics-refund:${id}`;
    function browserRefund(id) {try{return JSON.parse(sessionStorage.getItem(pendingKey(id)));}catch{return null;}}
    const badge=(value,label)=>`<span class="badge ${escape(value)}">${escape(label||value)}</span>`;
    function message(text,type='error',detail=false) {
        const target=$(detail?'#detail-message':'#message');target.textContent=text;target.className=`message ${type}`;target.hidden=!text;
    }
    async function request(path,body,raw=false) {
        if(staticPreview)return (await demo).demoRequest(path,body,raw);
        let response;
        try {
            response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
                headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
        } catch {throw new Error('The connection was interrupted. Refresh the order before repeating an action.');}
        if (raw&&response.ok) return response;
        let data;
        try {data=await response.json();}catch {throw new Error([404,405,501].includes(response.status)?'The admin backend is not available on this website. Deploy the Cloudflare Worker with D1 and Cloudflare Access to manage orders.':'Your session may have expired. Reload this page to sign in again.');}
        if (!response.ok) {const error=new Error(data.error||'The request could not be completed.');error.status=response.status;throw error;}
        return data;
    }
    function params() {
        const p=new URLSearchParams({mode:$('#mode').value,page});
        for (const [name,id] of [['q','search'],['payment','payment-filter'],['fulfilment','fulfilment-filter'],['from','date-from'],['to','date-to']]) {
            if ($(`#${id}`).value) p.set(name,$(`#${id}`).value);
        }
        return p;
    }
    async function loadOrders() {
        if (!session) return;
        const revision=++listRevision;
        $('#refresh-list').disabled=true;$('#orders-body').setAttribute('aria-busy','true');
        message('');
        try {
            const data=await request(`/api/admin/orders?${params()}`);
            if (revision!==listRevision) return;
            pages=data.pages;
            $('#metric-awaiting').textContent=data.metrics.awaiting||0;
            $('#metric-shipped').textContent=data.metrics.shipped||0;
            $('#metric-captured').textContent=money(data.metrics.captured);
            $('#metric-refunded').textContent=money(data.metrics.refunded);
            $('#queue-description').textContent=`${data.mode==='test'?'Test':'Live'} orders · Overview totals cover all dates`;
            $('#orders-body').innerHTML=data.orders.map((o)=>`<tr><td><button class="order-link" data-order="${escape(o.id)}" type="button">${escape(o.reference)}</button><small>${escape(date(o.createdAt))}</small></td>
              <td><strong>${escape(o.customer?.name)}</strong><small>${escape(o.customer?.phone)}</small></td><td><strong>${money(o.quote.total)}</strong>${o.refunded?`<small>${money(o.refunded)} refunded</small>`:''}</td>
              <td>${badge(o.state,payments[o.state])}</td><td>${badge(o.fulfilment,fulfilment[o.fulfilment])}</td><td><button class="button secondary" data-order="${escape(o.id)}" type="button" aria-label="Open order for ${escape(o.customer?.name)}">View</button></td></tr>`).join('');
            $('#empty-state').hidden=data.orders.length!==0;
            $('#count-label').textContent=`${data.count} ${data.count===1?'order':'orders'}${data.count?` · Showing ${(page-1)*25+1}–${Math.min(page*25,data.count)}`:''}`;
            $('#page-label').textContent=`${page} / ${pages}`;
            $('#previous').disabled=page<=1;$('#next').disabled=page>=pages;
        } catch(error) {if(revision===listRevision)message(error.message);}
        finally {if(revision===listRevision){$('#refresh-list').disabled=false;$('#orders-body').removeAttribute('aria-busy');}}
    }
    function renderDetail(o) {
        current=o;$('#detail-title').textContent=o.reference;
        let unconfirmed=browserRefund(o.id);
        if(unconfirmed&&o.refunds.some((r)=>r.request_id===unconfirmed.requestId)){sessionStorage.removeItem(pendingKey(o.id));unconfirmed=null;}
        const customer=o.customer||{};
        const canFulfil=o.state==='paid'&&(!o.testMode||session.preview)&&o.refundTotals.reserved<o.quote.total&&!o.refundTotals.uncertain;
        const choices=[o.fulfilment,...transitions[o.fulfilment]].filter((s)=>canFulfil||!['processing','shipped','delivered'].includes(s)||s===o.fulfilment);
        const refundable=o.state==='paid'&&o.refundTotals.available>=100&&!o.refundTotals.uncertain&&!unconfirmed;
        $('#detail-content').innerHTML=`<div class="detail-summary">${badge(o.state,payments[o.state])}${badge(o.fulfilment,fulfilment[o.fulfilment])}${o.testMode?badge('pending','Test order'):''}<span class="amount">${money(o.quote.total)}</span></div>
          <div class="detail-grid">
          <section class="detail-section"><h3>Customer & delivery</h3><p><strong>${escape(customer.name)}</strong></p><p>${escape(customer.email)}</p><p>${escape(customer.phone)}</p><p>${escape(customer.address)}${customer.address2?`<br>${escape(customer.address2)}`:''}<br>${escape(customer.city)}, ${escape(customer.state)} ${escape(customer.postalCode)}<br>${escape(customer.country)}</p><p>Original checkout address. Record any requested correction in the internal notes before dispatch.</p></section>
          <section class="detail-section"><h3>Payment & product</h3><p>Photon Skin Rejuvenation Mask · ${escape(o.quote.product)}</p><p>Quantity: ${escape(o.quote.quantity)}</p><p>Order placed: ${escape(date(o.createdAt))}</p><p class="reference">Payment: ${escape(o.paymentId||'Awaiting confirmation')}</p><p class="reference">Razorpay order: ${escape(o.razorpayOrderId||'Checking creation')}</p><div class="detail-actions"><button type="button" class="button secondary" id="refresh-payment">Check payment & refunds</button><small>Last check: ${escape(date(o.checkedAt))}</small></div>${o.checkError?`<p class="message error">${escape(o.checkError)}</p>`:''}</section>
          <section class="detail-section wide"><h3>Fulfilment</h3><form id="fulfilment-form" class="form-grid"><label>Status<select name="fulfilment">${choices.map((s)=>`<option value="${s}"${s===o.fulfilment?' selected':''}>${fulfilment[s]}</option>`).join('')}</select></label><label>Courier<input name="courier" maxlength="100" value="${escape(o.courier)}" placeholder="Courier name"></label><label>Tracking number<input name="trackingNumber" maxlength="100" value="${escape(o.trackingNumber)}" placeholder="Shipment reference"></label><label>Dispatch date<input name="dispatchDate" type="date" max="${new Date().toISOString().slice(0,10)}" value="${escape(o.dispatchDate)}"></label><label class="wide">Reason for cancellation or return<input name="reason" maxlength="500" placeholder="Required when cancelling or recording a return"></label><button class="button" type="submit">Save fulfilment</button></form></section>
          <section class="detail-section wide"><h3>Refunds</h3><dl><dt>Captured payment</dt><dd>${money(o.state==='paid'?o.quote.total:0)}</dd><dt>Processed refunds</dt><dd>${money(o.refundTotals.processed)}</dd><dt>Available to refund</dt><dd>${money(o.state==='paid'?o.refundTotals.available:0)}</dd></dl>
          ${refundable?`<form id="refund-form" class="form-grid"><label>Refund amount (INR)<input name="amount" inputmode="decimal" required value="${(o.refundTotals.available/100).toFixed(2)}" pattern="[0-9]+(\\.[0-9]{1,2})?" autocomplete="off"></label><label>Reason<input name="reason" maxlength="500" required placeholder="Why is this refund being issued?"></label><button type="submit" class="button secondary">Review refund</button></form><p>Normal refund · Usually 5–7 working days after initiation.</p>`:`<p>${unconfirmed?'Your last refund submission was interrupted. Check its status, or retry that exact request.':o.refundTotals.uncertain?'An earlier refund needs checking. Resolve it before creating another request.':'No refund is currently available for this order.'}</p>${unconfirmed?'<button class="button secondary" id="retry-browser-refund" type="button">Retry last submitted refund</button>':''}`}
          <div class="refund-list">${o.refunds.map((r)=>`<div class="refund-record"><strong>${money(r.amount)}</strong>${badge(r.status,refundLabels[r.status])}<p>${escape(r.reason)}</p><p class="reference">${escape(r.gateway_id||'Waiting for Razorpay reference')}</p>${r.error?`<p>${escape(r.error)}</p>`:''}${['submitting','uncertain'].includes(r.status)?`<button class="button secondary" type="button" data-retry-refund="${escape(r.request_id)}">Check / retry same refund</button>`:''}</div>`).join('')}</div></section>
          <section class="detail-section wide"><h3>Internal notes & activity</h3><form id="note-form" class="form-grid"><label class="wide">Add an internal note<textarea name="message" rows="2" maxlength="2000" required placeholder="Packing instructions, customer requests or return details"></textarea></label><button type="submit" class="button secondary">Save note</button></form><ul class="timeline">${o.events.map((e)=>`<li>${escape(e.message)}<small>${escape(e.actor)} · ${escape(date(e.createdAt))}</small></li>`).join('')||'<li>No activity recorded yet.</li>'}</ul></section>
          <section class="detail-section wide"><h3>Email notifications</h3>${o.notifications.map((n)=>`<div class="notification-line"><span>${escape({owner_paid:'Owner: new order',customer_paid:'Customer: payment confirmed',shipped:'Customer: shipment',refund:'Customer: refund processed'}[n.kind])}${n.error?`<br>${escape(n.error)}`:''}</span>${badge(n.state,n.state==='queued'?'Queued':n.state==='sending'?'Sending':n.state==='sent'?'Sent':'Needs review')}</div>`).join('')||'<p>No notifications for this order. Test orders do not send emails.</p>'}</section></div>`;
        $('#refresh-payment').addEventListener('click',()=>act('refresh',{},'Payment and refund status checked.'));
        $('#fulfilment-form').addEventListener('submit',(event)=>{event.preventDefault();act('fulfilment',{...Object.fromEntries(new FormData(event.currentTarget)),version:current.version},'Fulfilment saved.');});
        $('#note-form').addEventListener('submit',(event)=>{event.preventDefault();act('notes',Object.fromEntries(new FormData(event.currentTarget)),'Note saved.');});
        $('#refund-form')?.addEventListener('submit',(event)=>{
            event.preventDefault();if(actionBusy)return;
            const values=Object.fromEntries(new FormData(event.currentTarget));
            if(!/^\d+(\.\d{1,2})?$/.test(values.amount)){message('Enter a valid amount with up to two decimal places.','error',true);return;}
            const [rupees,paise='']=values.amount.split('.');
            const amount=Number(rupees)*100+Number(paise.padEnd(2,'0'));
            if(!Number.isSafeInteger(amount)||amount<100||amount>current.refundTotals.available){message('Check the amount against the available refund balance.','error',true);return;}
            pendingRefund={orderId:current.id,body:{requestId:crypto.randomUUID(),amount,reason:values.reason}};
            $('#refund-confirm-text').textContent=`Refund ${money(amount)} to ${current.customer.name} for order ${current.reference}? Reason: ${values.reason}`;
            $('#refund-confirm').showModal();$('#cancel-refund').focus();
        });
        document.querySelectorAll('[data-retry-refund]').forEach((button)=>button.addEventListener('click',()=>act('retry-refund',{requestId:button.dataset.retryRefund},'Refund status checked.')));
        $('#retry-browser-refund')?.addEventListener('click',()=>act('refunds',unconfirmed,'Refund request checked.'));
        if(session.readOnly){
            $('#detail-content').querySelectorAll('button,input,select,textarea').forEach((element)=>element.disabled=true);
            message('Demo order · Changes and refunds are disabled.','',true);
        }
    }
    async function openOrder(id) {
        const revision=++detailRevision;current=null;message('','error',true);
        $('#detail-title').textContent='Loading order…';$('#detail-content').replaceChildren();
        if(!$('#order-dialog').open)$('#order-dialog').showModal();
        try{const result=await request(`/api/admin/orders/${id}`);if(revision===detailRevision&&$('#order-dialog').open)renderDetail(result);}
        catch(error){if(revision===detailRevision)message(error.message,'error',true);}
    }
    async function act(action,body,success) {
        if(actionBusy||!current)return;
        actionBusy=true;const id=current.id;const revision=detailRevision;
        $('#detail-content').querySelectorAll('button').forEach((b)=>b.disabled=true);message('Saving…','',true);
        try{
            const result=await request(`/api/admin/orders/${id}/${action}`,body);
            if(revision===detailRevision&&$('#order-dialog').open){renderDetail(result);message(result.refundTotals.uncertain?'Refund response needs checking. Use “Check / retry same refund” to resolve it.':success,result.refundTotals.uncertain?'':'success',true);}
            await loadOrders();
        }catch(error){
            if(action==='refunds'&&error.status&&error.status<500&&error.status!==409)sessionStorage.removeItem(pendingKey(id));
            if(revision===detailRevision){renderDetail(current);message(error.message,'error',true);}
        }
        finally{actionBusy=false;}
    }
    $('#confirm-refund').addEventListener('click',()=>{
        if(!pendingRefund||pendingRefund.orderId!==current?.id)return;
        const refund=pendingRefund;
        try{sessionStorage.setItem(pendingKey(refund.orderId),JSON.stringify(refund.body));}catch{message('Allow session storage before submitting a refund so interrupted requests can be recovered.','error',true);$('#refund-confirm').close();return;}
        pendingRefund=null;$('#refund-confirm').close();act('refunds',refund.body,'Refund request recorded.');
    });
    $('#cancel-refund').addEventListener('click',()=>{$('#refund-confirm').close();pendingRefund=null;});
    $('#orders-body').addEventListener('click',(event)=>{const button=event.target.closest('[data-order]');if(button)openOrder(button.dataset.order);});
    $('#close-detail').addEventListener('click',()=>$('#order-dialog').close());
    $('#order-dialog').addEventListener('close',()=>{detailRevision++;current=null;});
    $('#filters').addEventListener('submit',(event)=>{event.preventDefault();page=1;loadOrders();});
    $('#mode').addEventListener('change',()=>{page=1;loadOrders();});
    $('#refresh-list').addEventListener('click',loadOrders);
    $('#previous').addEventListener('click',()=>{if(page>1){page--;loadOrders();}});
    $('#next').addEventListener('click',()=>{if(page<pages){page++;loadOrders();}});
    $('#nav-orders').addEventListener('click',()=>{$('#filters').reset();page=1;loadOrders();});
    $('#export').addEventListener('click',async()=>{
        $('#export').disabled=true;
        try{const response=await request(`/api/admin/orders/export?${params()}`,undefined,true);const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download='skintronics-orders.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
        catch(error){message(error.message);}finally{$('#export').disabled=false;}
    });
    async function initialize(){
        if(githubPages&&!staticPreview){
            $('#identity').textContent='Backend not connected';$('.sidebar-bottom a').hidden=true;
            $('#access-title').textContent='Admin setup required';$('#access-panel').hidden=false;
            $('#access-message').textContent='This website is hosted on GitHub Pages, which serves the storefront but cannot run the admin backend. To manage real orders, deploy the Cloudflare Worker and configure D1 and Cloudflare Access. Then open /admin on your Cloudflare domain. The local preview is available on the computer running it.';
            $('#retry-access').hidden=true;$('#refresh-list').disabled=true;return;
        }
        $('#retry-access').disabled=true;
        try{
            session=await request('/api/admin/session');$('#identity').textContent=session.email;
            $('#preview-banner').hidden=!session.preview;if(session.preview){$('#mode').value='test';$('.sidebar-bottom a').hidden=true;}
            if(session.readOnly)$('#preview-banner').textContent='Demo preview · Sample orders only. Changes, refunds and emails are disabled.';
            $('#email-note').textContent=session.readOnly?'Sample data for viewing the dashboard. Connect Cloudflare to manage real orders.':session.preview?'Preview uses fictional records. Changes are reset when the preview server restarts.':session.notificationsConfigured?'Email notifications are queued automatically and sent by scheduled jobs.':'Email sending is not configured. Notification jobs are saved until an email provider is connected.';
            $('#workspace').hidden=false;$('#access-panel').hidden=true;await loadOrders();
        }catch(error){session=null;$('#identity').textContent='Access required';$('#workspace').hidden=true;$('#access-panel').hidden=false;$('#access-message').textContent=error.message;}
        finally{$('#retry-access').disabled=false;}
    }
    $('#retry-access').addEventListener('click',initialize);
    initialize();
})();
