// Supplier images are generated locally. Creating/sharing an image never records a purchase.
const supplierImageUrls=new Set();
function releaseSupplierImages(parent){if(!parent?.querySelectorAll)return;parent.querySelectorAll('img').forEach(img=>{if(supplierImageUrls.has(img.src)){URL.revokeObjectURL(img.src);supplierImageUrls.delete(img.src);}});}
function supplierImageProducts(items){
 const products=new Map();
 for(const item of items){
  const code=String(item.product_code||'').trim(),name=String(item.product_name||'商品').trim();
  const key=code||name;
  if(!products.has(key))products.set(key,{code,name,rows:[]});
  products.get(key).rows.push({color:item.color||'—',size:item.size||'—',variant:item.variant_name||'未填規格',qty:item.qty});
 }
 return [...products.values()];
}
function supplierPhoto(source){return new Promise(resolve=>{if(!source){resolve(null);return;}const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>resolve(null);img.src=source;});}
function readPhotoMarks(code){
 try{const value=JSON.parse(localStorage.getItem('ddu-photo-marks-v1:'+code)||'null');return value&&value.source===productPhotos[code]&&value.points&&typeof value.points==='object'?value.points:{};}catch{return {};}
}
function validPhotoPoint(point){return point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1;}
function supplierPhotoLabels(product){
 const colors=new Map();
 for(const row of product.rows){if(!colors.has(row.color))colors.set(row.color,new Map());const sizes=colors.get(row.color);const size=row.size==='—'?row.variant:row.size;sizes.set(size,(sizes.get(size)||0)+row.qty);}
 return [...colors].map(([color,sizes])=>({color,lines:[...sizes].map(([size,qty])=>['F','均碼','單一尺寸','未填規格','—'].includes(size)?String(qty):size+'×'+qty)}));
}
async function makeSupplierImages(group,testOnly=false,phase='待叫貨清單'){
 const products=supplierImageProducts(group.items),files=[];
 const stamp=new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});
 // Validate all requested colors before exporting anything. Positions are set
 // by the operator; the application never infers a garment's color from pixels.
 for(const product of products){
  if(!productPhotos[product.code])throw new Error(product.code+' 尚未附照片，無法產生標記圖。');
  const points=readPhotoMarks(product.code);
  for(const label of supplierPhotoLabels(product))if(!validPhotoPoint(points[label.color]))throw new Error(product.code+' 的「'+(label.color==='—'?'單一顏色':label.color)+'」尚未設定標記位置。請先設定並儲存。');
 }
 for(let i=0;i<products.length;i++){
  const product=products[i],photo=await supplierPhoto(productPhotos[product.code]);if(!photo)throw new Error(product.code+' 照片載入失敗，請重試。');
  const points=readPhotoMarks(product.code),labels=supplierPhotoLabels(product);
  const canvas=document.createElement('canvas');canvas.width=1080;
  const scale=Math.min(1080/photo.naturalWidth,1450/photo.naturalHeight),w=photo.naturalWidth*scale,h=photo.naturalHeight*scale,x=(1080-w)/2,y=150;
  canvas.height=Math.ceil(y+h+85);const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.textBaseline='top';
  ctx.fillStyle='#111';ctx.font='bold 44px sans-serif';ctx.fillText((testOnly?'【測試】 ':'')+group.supplier+'   '+product.code,32,20);
  ctx.font='27px sans-serif';ctx.fillText('DDU '+phase+' · '+(i+1)+' / '+products.length+' 張',32,78);
  ctx.drawImage(photo,x,y,w,h);
  for(const label of labels){
   const point=points[label.color];let fontSize=100;ctx.font='bold '+fontSize+'px sans-serif';
   const maxWidth=Math.max(...label.lines.map(line=>ctx.measureText(line).width));if(maxWidth>w-20){fontSize=Math.max(24,Math.floor(fontSize*(w-20)/maxWidth));ctx.font='bold '+fontSize+'px sans-serif';}
   const lineHeight=fontSize*1.16,blockHeight=lineHeight*label.lines.length;
   const top=Math.max(y+8,Math.min(y+h-blockHeight-8,y+point.y*h-blockHeight/2));
   label.lines.forEach((line,n)=>{
    const width=ctx.measureText(line).width;const left=Math.max(x+8,Math.min(x+w-width-8,x+point.x*w-width/2));
    ctx.lineWidth=5;ctx.lineJoin='round';ctx.strokeStyle='rgba(255,255,255,.85)';ctx.strokeText(line,left,top+n*lineHeight);
    ctx.fillStyle='#ed1717';ctx.fillText(line,left,top+n*lineHeight);
   });
  }
  ctx.fillStyle='#555';ctx.font='23px sans-serif';ctx.fillText('產生時間：'+stamp,32,canvas.height-52);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('圖片產生失敗，請重試。');
  files.push(new File([blob],'DDU_'+group.supplier.replace(/[^\p{L}\p{N}_-]/gu,'_')+'_'+product.code+'_'+(i+1)+'.png',{type:'image/png'}));
 }
 return files;
}
function appendPhotoMarkEditor(parent,group,onSaved=()=>{}){
 const toggle=addText(parent,'button','設定照片顏色標記位置','secondary');toggle.type='button';
 const editor=addText(parent,'div');editor.hidden=true;addText(editor,'p','選擇顏色，再點照片中對應衣服的位置。設定保存在這台手機；更換照片後請重新設定。');
 toggle.addEventListener('click',()=>{editor.hidden=!editor.hidden;});
 for(const product of supplierImageProducts(group.items)){
  addText(editor,'h4',product.code+' '+product.name);const source=productPhotos[product.code];if(!source){addText(editor,'p','尚未附商品照，請先補上照片。');continue;}
  const labels=supplierPhotoLabels(product),points={...readPhotoMarks(product.code)};
  const label=addText(editor,'label','選擇要標記的顏色');const select=addText(label,'select');select.style.fontSize='16px';select.style.width='100%';select.style.padding='12px';
  labels.forEach(entry=>{const option=addText(select,'option',entry.color==='—'?'單一顏色':entry.color);option.value=entry.color;});
  const surface=addText(editor,'div');surface.style.position='relative';surface.style.margin='12px 0';
  const img=addText(surface,'img');img.src=source;img.alt=product.code+' 設定顏色位置的商品照片';img.style.display='block';img.style.width='100%';img.style.cursor='crosshair';
  const overlay=addText(surface,'div');overlay.style.position='absolute';overlay.style.inset='0';overlay.style.pointerEvents='none';
  const message=addText(editor,'p');message.setAttribute('role','status');
  const paint=()=>{overlay.replaceChildren();for(const entry of labels){const point=points[entry.color];if(!validPhotoPoint(point))continue;const mark=addText(overlay,'span',entry.lines.join('\n'));mark.style.position='absolute';mark.style.left=(point.x*100)+'%';mark.style.top=(point.y*100)+'%';mark.style.transform='translate(-50%,-50%)';mark.style.color='#ed1717';mark.style.fontWeight='bold';mark.style.fontSize='clamp(26px,8vw,48px)';mark.style.whiteSpace='pre';mark.style.webkitTextStroke='0.5px white';}};
  paint();
  img.addEventListener('click',event=>{const rect=img.getBoundingClientRect();points[select.value]={x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};paint();message.textContent='已放置「'+(select.value==='—'?'單一顏色':select.value)+'」紅字，請按儲存。';});
  const save=addText(editor,'button','儲存 '+product.code+' 標記位置','secondary');save.type='button';
  save.addEventListener('click',()=>{if(labels.some(entry=>!validPhotoPoint(points[entry.color]))){message.textContent='請先設定清單中每個顏色的位置。';return;}try{localStorage.setItem('ddu-photo-marks-v1:'+product.code,JSON.stringify({source,points}));message.textContent='位置已儲存。之後數量會自動更新。';onSaved();}catch{message.textContent='位置無法儲存，請確認瀏覽器儲存空間後重試。';}});
 }
 return editor;
}
function appendSupplierImageControls(parent,group,testOnly=false,phase='待叫貨清單',auto=false){
 const box=addText(parent,'div');const editor=appendPhotoMarkEditor(box,group,()=>{if(auto)generate();});const button=addText(box,'button','產生叫貨圖','secondary');button.type='button';
 const status=addText(box,'p',phase==='已叫貨清單'?'可產生已叫貨圖片，儲存到手機或分享至 WeChat。':'產生圖片後，儲存到手機或分享至 WeChat；傳送後再記錄已叫貨。');status.setAttribute('role','status');
 const output=addText(box,'div');let generation=0;
 async function generate(){
  const revision=staffRevision,current=++generation;button.disabled=true;status.textContent='正在產生叫貨圖…';
  try{
   const files=await makeSupplierImages(group,testOnly,phase);if(revision!==staffRevision||current!==generation||box.isConnected===false)return;
   releaseSupplierImages(output);output.replaceChildren();status.textContent='已產生 '+files.length+' 張圖片。可下載或長按圖片儲存，再傳給 '+group.supplier+'。產生圖片不會自動記錄已叫貨。';
   files.forEach((file,i)=>{
    const url=URL.createObjectURL(file);supplierImageUrls.add(url);const img=addText(output,'img');img.src=url;img.alt=group.supplier+' 叫貨圖 '+(i+1);img.style.width='100%';img.style.maxWidth='540px';img.style.display='block';img.style.margin='12px 0';
    const download=addText(output,'a','下載叫貨圖 '+(i+1),'secondary');download.href=url;download.download=file.name;download.style.display='block';download.style.textAlign='center';download.style.padding='14px';
   });
   if(navigator.canShare&&navigator.canShare({files})){
    const share=addText(output,'button','分享叫貨圖','secondary');share.type='button';
    share.addEventListener('click',async()=>{try{await navigator.share({files,title:group.supplier+' 叫貨圖'});status.textContent='分享視窗已關閉；請確認 WeChat 已送出，再記錄已叫貨。';}catch(error){if(error.name!=='AbortError')status.textContent='無法開啟分享，請下載或長按圖片儲存後，在 WeChat 傳送。';}});
   }
  }catch(error){editor.hidden=false;status.textContent=error.message||'叫貨圖產生失敗，請重試；仍可複製上方叫貨文字。';}
  finally{if(current===generation)button.disabled=false;}
 }
 button.addEventListener('click',generate);
 if(auto)generate();
}

let todayImageSignature='',refreshingTodayImages=false;
function clearAutoTodaySupplierImages(){
 todayImageSignature='';releaseSupplierImages(orderEl('todaySupplierImages'));
 orderEl('todaySupplierImages').replaceChildren();orderEl('todayImageMessage').textContent='';
}
function todayImageGroups(orders){
 const [start,end]=taipeiDayBounds();
 return groupSupplierOrders(orders.filter(order=>order.created_at>=start&&order.created_at<end),false);
}
function renderAutoTodaySupplierImages(orders){
 const result=todayImageGroups(orders);
 const signature=JSON.stringify({day:taipeiDayBounds()[0],groups:result.groups.map(group=>({supplier:group.supplier,items:group.items}))});
 if(signature===todayImageSignature)return;
 clearAutoTodaySupplierImages();todayImageSignature=signature;
 const output=orderEl('todaySupplierImages');
 orderEl('todayImageMessage').textContent=result.qty?'今日待叫貨 '+result.orderCount+' 張，共 '+result.qty+' 件。已設定位置的商品會自動產圖。':'今天沒有正式待叫貨客訂。';
 for(const group of result.groups){
  const products=new Map();
  for(const item of group.items){const key=item.product_code||item.product_name;if(!products.has(key))products.set(key,[]);products.get(key).push(item);}
  for(const items of products.values()){
   const row=addText(output,'article','','order-line');addText(row,'h4',(group.supplier||'未設定廠商')+' '+(items[0].product_code||items[0].product_name));
   if(!group.supplier){addText(row,'p','請先補上廠商，才能產生叫貨圖。');continue;}
   appendSupplierImageControls(row,{supplier:group.supplier,items,qty:items.reduce((sum,item)=>sum+item.qty,0)},false,'今日待叫貨',true);
  }
 }
}
async function refreshAutoTodaySupplierImages(){
 if(refreshingTodayImages||document.hidden||orderEl('todayPanel').hidden||loadingToday||savingOrder||confirmingPurchase||receivingPurchase)return;
 refreshingTodayImages=true;const revision=staffRevision;
 try{
  const client=getOrderClient(),session=await client.auth.getSession();if(session.error)throw session.error;
  if(!session.data.session){clearAutoTodaySupplierImages();return;}
  const [start,end]=taipeiDayBounds(),orders=[];
  for(let offset=0;;offset+=1000){
   const page=await client.from('ddu_customer_orders').select('id,created_at,items,status,is_test').gte('created_at',start).lt('created_at',end).eq('status','pending').eq('is_test',false).order('id').range(offset,offset+999);
   if(revision!==staffRevision)return;if(page.error)throw page.error;orders.push(...page.data);if(page.data.length<1000)break;
  }
  renderAutoTodaySupplierImages(orders);
 }catch{if(revision===staffRevision){clearAutoTodaySupplierImages();orderEl('todayImageMessage').textContent='今日數量更新失敗，圖片已收起，請重新查看今日客訂。';}}
 finally{refreshingTodayImages=false;}
}
if(typeof setInterval==='function')setInterval(refreshAutoTodaySupplierImages,60000);
if(typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshAutoTodaySupplierImages();});
