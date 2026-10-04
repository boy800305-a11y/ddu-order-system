// Customer orders are processed together. POS inventory remains separate for D1, D2 and C.
let inventoryPreview=null,inventoryImportId=null,importingInventory=false,previewingInventory=false;
const inventoryByVariant=new Map();
async function attachInventoryStock(variants){
 inventoryByVariant.clear();
 try{
  const client=getOrderClient(),session=await client.auth.getSession();if(session.error||!session.data.session)return;
  const ids=[...new Set(variants.map(v=>v.shopline_variant_id).filter(Boolean))];
  for(let i=0;i<ids.length;i+=100){
   const result=await client.from('ddu_store_inventory').select('variant_id,store_code,quantity,imported_at').in('variant_id',ids.slice(i,i+100));
   if(result.error)throw result.error;
   for(const row of result.data){if(!inventoryByVariant.has(row.variant_id))inventoryByVariant.set(row.variant_id,{});inventoryByVariant.get(row.variant_id)[row.store_code]=row;}
  }
 }catch{inventoryByVariant.clear();}
}
function appendStock(parent,variant){
 const stock=inventoryByVariant.get(variant.shopline_variant_id)||{};
 const group=addText(parent,'div','','status');
 for(const store of ['D1','D2','C']){
  const entry=stock[store],tag=addText(group,'span',store+'：'+(entry?entry.quantity+' 件':'未更新'), 'tag');
 }
 const dates=Object.values(stock).map(row=>row.imported_at).filter(Boolean);
 addText(parent,'div',dates.length?'庫存更新：'+new Date(dates.sort().at(-1)).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'登入並匯入報表後顯示庫存；未更新不代表 0 件。');
}
async function refreshInventoryTime(){
 const output=orderEl('inventoryLastUpdate');
 try{
  const client=getOrderClient(),session=await client.auth.getSession();if(session.error||!session.data.session){output.textContent='登入後可查看最後更新時間。';return;}
  const result=await client.from('ddu_inventory_imports').select('file_name,completed_at,expected_count,unmatched_count').eq('status','completed').order('completed_at',{ascending:false}).limit(1);
  if(result.error)throw result.error;
  const last=result.data[0];output.textContent=last?'最後更新：'+new Date(last.completed_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})+'｜'+last.expected_count+' 個規格｜未對應 '+last.unmatched_count+' 列｜'+last.file_name:'尚未匯入三店庫存報表。';
 }catch{output.textContent='三店庫存功能尚未完成啟用，或目前連線失敗。';}
}
async function readFullCatalog(client,table,columns){
 const rows=[];
 for(let offset=0;offset<100000;offset+=1000){
  // The existing public catalog policies are scoped to anon, even for logged-in staff.
  const page=await readCatalog(table,{select:columns,order:'id.asc',limit:'1000',offset:String(offset)});
  rows.push(...page);if(page.length<1000)return rows;
 }throw new Error('商品資料過多，請聯絡管理員。');
}
function clearInventoryPreview(){inventoryPreview=null;inventoryImportId=null;orderEl('inventoryPreview').replaceChildren();orderEl('confirmInventory').checked=false;orderEl('confirmInventory').disabled=true;orderEl('updateInventory').disabled=true;orderEl('inventoryConfirmLabel').hidden=true;}
orderEl('inventoryFile').addEventListener('change',()=>{if(!importingInventory&&!previewingInventory){clearInventoryPreview();orderEl('inventoryMessage').textContent='已選擇新檔案，請先預覽。';}});
orderEl('previewInventory').addEventListener('click',async()=>{
 if(importingInventory||previewingInventory)return;
 clearInventoryPreview();const file=orderEl('inventoryFile').files[0];
 if(!file){orderEl('inventoryMessage').textContent='請先選擇 SHOPLINE 庫存報表。';return;}
 if(file.size>10*1024*1024||!file.size){orderEl('inventoryMessage').textContent='報表需為 10 MB 以下的非空白檔案。';return;}
 previewingInventory=true;orderEl('previewInventory').disabled=true;orderEl('inventoryFile').disabled=true;orderEl('inventoryMessage').textContent='正在讀取報表並核對商品…';
 try{
  const client=getOrderClient(),session=await client.auth.getSession();if(session.error||!session.data.session)throw new Error('請先登入店員帳號。');
  if(!window.XLSX)throw new Error('Excel 讀取元件尚未載入，請重新整理。');
  const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:false});
  if(workbook.SheetNames.length!==1)throw new Error('請上傳只有一張工作表的原始庫存報表。');
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,defval:'',raw:true});
  if(rows.length>50001)throw new Error('報表最多 50,000 列。');
  const [products,variants]=await Promise.all([readFullCatalog(client,'products','id,shopline_product_id,product_name'),readFullCatalog(client,'variants','id,shopline_variant_id,shopline_product_id,variant_name')]);
  const report=DDUInventory.mapReport(rows,products,variants);
  inventoryPreview={...report,fileName:file.name,userId:session.data.session.user.id};inventoryImportId=crypto.randomUUID();
  const output=orderEl('inventoryPreview');
  addText(output,'p','可更新 '+report.matched.length+' 個規格；未對應 '+report.unmatched.length+' 列。未對應資料不寫入，原有庫存保留。');
  addText(output,'p','預設倉庫 → D1｜D → D2｜C → C。庫存總量欄位不匯入。');
  const table=document.createElement('table');table.style.width='100%';table.style.fontSize='13px';table.style.borderCollapse='collapse';output.appendChild(table);
  const head=document.createElement('tr');table.appendChild(head);['商品／規格','D1','D2','C'].forEach(label=>addText(head,'th',label));
  report.matched.slice(0,10).forEach(item=>{const row=document.createElement('tr');table.appendChild(row);[item.name+' / '+item.style,item.d1,item.d2,item.c].forEach(value=>{const cell=addText(row,'td',value);cell.style.padding='8px 3px';cell.style.borderBottom='1px solid #ddd';});});
  if(report.matched.some(r=>[r.d1,r.d2,r.c].some(q=>q<0)))addText(output,'p','報表含負庫存，會保留原報表數值，請另於 POS 核對。');
  if(report.unmatched.length){const detail=document.createElement('details');output.appendChild(detail);addText(detail,'summary','查看未對應資料（前 50 列）');report.unmatched.slice(0,50).forEach(r=>addText(detail,'p','第 '+r.row+' 列：'+r.name+' / '+r.style+'｜'+r.reason));}
  orderEl('inventoryConfirmLabel').hidden=false;orderEl('confirmInventory').disabled=false;
  orderEl('inventoryMessage').textContent='預覽完成，尚未更新庫存。請核對後勾選確認。';
 }catch(error){clearInventoryPreview();orderEl('inventoryMessage').textContent=error.message||'讀取失敗，尚未更新庫存。';}
 finally{previewingInventory=false;orderEl('previewInventory').disabled=false;orderEl('inventoryFile').disabled=false;}
});
orderEl('confirmInventory').addEventListener('change',()=>orderEl('updateInventory').disabled=!inventoryPreview||!orderEl('confirmInventory').checked||importingInventory);
orderEl('updateInventory').addEventListener('click',async()=>{
 if(importingInventory||previewingInventory||!inventoryPreview||!orderEl('confirmInventory').checked)return;
 importingInventory=true;['updateInventory','previewInventory','inventoryFile','confirmInventory','staffLogout'].forEach(id=>orderEl(id).disabled=true);
 try{
  const client=getOrderClient(),session=await client.auth.getSession();if(session.error||session.data.session?.user.id!==inventoryPreview.userId)throw new Error('登入帳號已變更，請重新預覽報表。');
  const report=inventoryPreview;
  for(let i=0;i<report.matched.length;i+=500){
   orderEl('inventoryMessage').textContent='正在上傳 '+Math.min(i+500,report.matched.length)+' / '+report.matched.length+' 個規格；完成前不會修改現有庫存。';
   const result=await client.rpc('ddu_stage_inventory',{import_id:inventoryImportId,source_file:report.fileName,total_count:report.matched.length,unmatched:report.unmatched.length,entries:report.matched.slice(i,i+500).map(({variant_id,d1,d2,c})=>({variant_id,d1,d2,c}))});if(result.error)throw result.error;
  }
  const result=await client.rpc('ddu_finish_inventory',{import_id:inventoryImportId});if(result.error)throw result.error;
  clearInventoryPreview();await refreshInventoryTime();inventoryByVariant.clear();orderEl('searchResults').replaceChildren();orderEl('searchStatus').textContent='庫存已更新，請重新搜尋商品。';
  orderEl('inventoryMessage').textContent='三店庫存已更新：'+result.data.count+' 個規格。已刷新今日庫存 −1 待處理清單；建立客訂不會自動扣庫存。';
  await loadTodayOrders();
 }catch(error){orderEl('inventoryMessage').textContent='尚未確認更新完成，請查看最後更新時間。原預覽已保留，可使用同一按鈕重試。'+(error.message?' '+error.message:'');}
 finally{importingInventory=false;['previewInventory','inventoryFile','staffLogout'].forEach(id=>orderEl(id).disabled=false);orderEl('confirmInventory').disabled=!inventoryPreview;orderEl('updateInventory').disabled=!inventoryPreview||!orderEl('confirmInventory').checked;}
});
refreshInventoryTime();

async function loadNegativeInventoryOrders(){
 const output=orderEl('negativeOrders'),message=orderEl('negativeOrderMessage'),revision=staffRevision;
 output.replaceChildren();message.textContent='正在讀取今日報表的庫存 −1 商品…';
 try{
  const client=getOrderClient(),session=await client.auth.getSession();
  if(session.error)throw session.error;
  if(!session.data.session){message.textContent='請先登入店員帳號。';return;}
  const [start,end]=taipeiDayBounds();
  const latest=await client.from('ddu_inventory_imports').select('id,file_name,completed_at').eq('status','completed').gte('completed_at',start).lt('completed_at',end).order('completed_at',{ascending:false}).order('id').limit(1);
  if(latest.error)throw latest.error;if(revision!==staffRevision)return;
  const report=latest.data[0];
  if(!report){message.textContent='今天尚未成功更新庫存報表。昨日庫存不列為今日待處理客訂。';return;}
  const stock=[];
  for(let offset=0;;offset+=1000){
   const page=await client.from('ddu_store_inventory').select('variant_id,store_code,quantity').eq('import_id',report.id).eq('quantity',-1).order('variant_id').order('store_code').range(offset,offset+999);
   if(page.error)throw page.error;if(revision!==staffRevision)return;
   stock.push(...page.data);if(page.data.length<1000)break;
  }
  let groups=[];
  if(stock.length){
   const [products,variants]=await Promise.all([readFullCatalog(client,'products','id,shopline_product_id,product_name'),readFullCatalog(client,'variants','id,shopline_variant_id,shopline_product_id,variant_name')]);
   groups=DDUInventory.negativeOrders(stock,products,variants);
  }
  if(revision!==staffRevision)return;
  groups.forEach(item=>{
   const row=addText(output,'article','','order-line');addText(row,'h3',item.name+' / '+item.style);
   addText(row,'p','待核對 '+item.qty+' 件｜'+item.stores.map(store=>store+'：−1').join('、'));
  });
  if(groups.length){
   const label=addText(output,'label','待處理商品清單（可選取複製）');label.htmlFor='negativeOrderText';
   const text=document.createElement('textarea');text.id='negativeOrderText';text.readOnly=true;text.style.width='100%';text.style.minHeight='160px';
   text.value='今日庫存 −1 待處理（未建立正式客訂）\n'+groups.map(item=>item.name+' / '+item.style+' × '+item.qty+'｜'+item.stores.map(s=>s+'：−1').join('、')).join('\n');output.appendChild(text);
  }
  message.textContent=(groups.length?groups.length+' 種規格，共 '+groups.reduce((sum,item)=>sum+item.qty,0)+' 件待核對。':'今日報表沒有庫存剛好 −1 的商品。')+' 報表更新：'+new Date(report.completed_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})+'｜'+report.file_name;
 }catch{if(revision!==staffRevision)return;output.replaceChildren();message.textContent='無法讀取庫存 −1 清單，請確認店員權限及連線後重試。';}
}
