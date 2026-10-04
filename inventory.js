/* SHOPLINE inventory report: quantities remain separate for each store. */
(function(root) {
 'use strict';
 const normalize=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/g,' ');
 const key=(name,style)=>JSON.stringify([normalize(name),normalize(style)]);
 function reportStyle(value){return normalize(value).replace(/(?:顏色|尺寸)\s*[:：]\s*/g,'').replace(/\s+/g,' ').trim();}
 function mapReport(rows,products,variants) {
  const headers=rows[0]?.map(normalize)||[];
  const columns=['商品名稱','商品款式','商品條碼','預設倉庫','D','C'].map(h=>{
   const index=headers.indexOf(h);if(index<0||headers.lastIndexOf(h)!==index)throw new Error('報表缺少或重複欄位：'+h);return index;
  });
  const [nameCol,styleCol,barcodeCol,d1Col,d2Col,cCol]=columns;
  const names=new Map(products.map(p=>[p.shopline_product_id,p.product_name]));
  const barcodes=new Map(),styles=new Map();
  function index(map,k,v){if(k)map.set(k,map.has(k)?null:v);}
  for(const v of variants){index(barcodes,normalize(v.barcode),v);index(styles,key(names.get(v.shopline_product_id),v.variant_name),v);}
  const matched=[],unmatched=[],seen=new Set();
  for(let index=1;index<rows.length;index++){
   const row=rows[index];if(row.every(v=>normalize(v)===''))continue;
   const name=normalize(row[nameCol]),style=reportStyle(row[styleCol]),barcode=normalize(row[barcodeCol]);
   let v=barcode?barcodes.get(barcode):undefined;
   // A duplicated barcode is ambiguous. A unique name/style is the fallback only when barcode is absent from the catalog.
   if(v===undefined)v=styles.get(key(name,style));
   if(!v){unmatched.push({row:index+1,name,style,reason:v===null?'商品對應不唯一':'找不到商品規格'});continue;}
   if(normalize(names.get(v.shopline_product_id))!==name||normalize(v.variant_name)!==style){unmatched.push({row:index+1,name,style,reason:'條碼與商品名稱／規格不一致'});continue;}
   if(seen.has(v.shopline_variant_id))throw new Error('第 '+(index+1)+' 列重複對應同一規格；請先整理報表。');
   const quantities=[d1Col,d2Col,cCol].map(col=>{
    const raw=row[col],value=Number(raw);
    if(normalize(raw)===''||!Number.isSafeInteger(value)||Math.abs(value)>999999999)throw new Error('第 '+(index+1)+' 列的 '+headers[col]+' 庫存不是有效整數。');
    return value;
   });
   seen.add(v.shopline_variant_id);
   matched.push({variant_id:v.shopline_variant_id,d1:quantities[0],d2:quantities[1],c:quantities[2],name,style,row:index+1});
  }
  if(!matched.length)throw new Error('沒有可明確對應的規格，尚未更新庫存。');
  return {matched,unmatched};
 }
 root.DDUInventory={mapReport,reportStyle};
 if(typeof module!=='undefined')module.exports=root.DDUInventory;
})(typeof window==='undefined'?globalThis:window);
