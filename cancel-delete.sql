-- Cancellation removes rows. It never resets an order to pending.
begin;
create or replace function public.ddu_delete_cancelled_request(target_kind text, target_id uuid, expected_items jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $ddu_cancel$
declare customer public.ddu_customer_orders%rowtype; batch public.ddu_purchase_batches%rowtype;
 order_ids uuid[]; kept_allocations jsonb; kept_items jsonb; kept_sources uuid[]; quantities jsonb;
 deleted_batches integer:=0; deleted_orders integer:=0;
begin
 if auth.uid() is null or lower(coalesce(auth.jwt()->>'email',''))<>'boy800305@gmail.com' then raise exception 'DDU staff login required' using errcode='42501'; end if;
 if target_id is null or target_kind not in ('customer','purchase') or target_kind is null or jsonb_typeof(expected_items) is distinct from 'array' then raise exception 'Invalid cancellation'; end if;
 -- Match the receiving RPC's batch-before-order lock order. A user has a small
 -- batch queue; locking it also serializes two cancellations touching one batch.
 perform 1 from public.ddu_purchase_batches where created_by=auth.uid() order by id for update;
 if target_kind='purchase' then
  select * into batch from public.ddu_purchase_batches where id=target_id and created_by=auth.uid();
  if not found then return jsonb_build_object('deleted_orders',0,'deleted_batches',0); end if;
  if batch.items<>expected_items then raise exception 'Request changed' using errcode='P0001'; end if;
  order_ids:=batch.source_order_ids;
 else
  select * into customer from public.ddu_customer_orders where id=target_id and created_by=auth.uid() for update;
  if not found then return jsonb_build_object('deleted_orders',0,'deleted_batches',0); end if;
  if customer.items<>expected_items then raise exception 'Request changed' using errcode='P0001'; end if;
  order_ids:=array[target_id];
 end if;
 perform 1 from public.ddu_customer_orders where id=any(order_ids) order by id for update;
 if exists(select 1 from public.ddu_customer_orders where id=any(order_ids) and created_by<>auth.uid()) then raise exception 'Order unavailable' using errcode='42501'; end if;
 if exists(select 1 from public.ddu_customer_orders o cross join lateral jsonb_array_elements(o.items) e
  where o.id=any(order_ids) and (coalesce((e->>'received_qty')::integer,0)>0 or o.status in ('arrived','notified','collected')))
 or exists(select 1 from public.ddu_purchase_batches b where b.created_by=auth.uid() and (b.source_order_ids && order_ids or (target_kind='purchase' and b.id=target_id))
  and (b.status in ('partial','arrived') or exists(select 1 from jsonb_array_elements(b.items) e where coalesce((e->>'received_qty')::integer,0)>0)
  or exists(select 1 from public.ddu_purchase_receipts r where r.batch_id=b.id))) then
  raise exception 'Already received' using errcode='P0002';
 end if;
 for batch in select * from public.ddu_purchase_batches b where b.created_by=auth.uid()
  and (b.source_order_ids && order_ids or (target_kind='purchase' and b.id=target_id)) order by id loop
  select coalesce(jsonb_agg(a.value order by a.ordinality),'[]'::jsonb) into kept_allocations
   from jsonb_array_elements(batch.allocations) with ordinality a where not ((a.value->>'order_id')::uuid=any(order_ids));
  if jsonb_array_length(kept_allocations)=0 then
   delete from public.ddu_purchase_receipts where batch_id=batch.id;
   delete from public.ddu_purchase_batches where id=batch.id;
   deleted_batches:=deleted_batches+1;
  else
   -- Preserve other customers in a shared batch and reduce only the deleted
   -- customers' allocated quantities. No other customer is changed.
   select jsonb_agg(e.value||jsonb_build_object('qty',q.qty) order by e.ordinality) into kept_items
   from jsonb_array_elements(batch.items) with ordinality e join
    (select a->>'variant_id' variant_id,sum((a->>'qty')::integer) qty from jsonb_array_elements(kept_allocations) a group by a->>'variant_id') q
    on q.variant_id=e.value->>'variant_id';
   select array_agg(distinct (a->>'order_id')::uuid order by (a->>'order_id')::uuid) into kept_sources from jsonb_array_elements(kept_allocations) a;
   select jsonb_agg(jsonb_build_object('variant_id',e->>'variant_id','qty',(e->>'qty')::integer) order by e->>'variant_id') into quantities from jsonb_array_elements(kept_items) e;
   update public.ddu_purchase_batches set items=kept_items,allocations=kept_allocations,source_order_ids=kept_sources,requested_quantities=quantities where id=batch.id;
  end if;
 end loop;
 delete from public.ddu_customer_orders where id=any(order_ids) and created_by=auth.uid();
 get diagnostics deleted_orders=row_count;
 return jsonb_build_object('deleted_orders',deleted_orders,'deleted_batches',deleted_batches);
end $ddu_cancel$;
revoke all on function public.ddu_delete_cancelled_request(text,uuid,jsonb) from public,anon;
grant execute on function public.ddu_delete_cancelled_request(text,uuid,jsonb) to authenticated;
-- Old clients also physically delete a pending order when using the previous
-- cancellation API; the edit implementation and its checks stay unchanged.
CREATE OR REPLACE FUNCTION public.ddu_amend_customer_order(customer_order_id uuid, change_id uuid, expected_revision integer, action text, customer_reference text DEFAULT NULL::text, order_note text DEFAULT NULL::text, requested_items jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare customer public.ddu_customer_orders%rowtype; entry jsonb; snapshot jsonb:='[]'; item_snapshot jsonb;
begin
 if auth.uid() is null or lower(coalesce(auth.jwt()->>'email',''))<>'boy800305@gmail.com' then raise exception 'DDU staff login required' using errcode='42501'; end if;
 if change_id is null or expected_revision is null or action is null or action not in ('edit','cancel') then raise exception 'Invalid change'; end if;
 select * into customer from public.ddu_customer_orders where id=customer_order_id and created_by=auth.uid() for update;
 if not found then raise exception 'Order unavailable' using errcode='42501'; end if;
 if customer.last_change_id=change_id then return customer.id; end if;
 if customer.revision<>expected_revision or customer.status<>'pending' or exists(select 1 from jsonb_array_elements(customer.items) e where coalesce((e->>'ordered_qty')::integer,0)>0 or coalesce((e->>'received_qty')::integer,0)>0 or e ? 'purchase_batch_id') then raise exception 'Order changed or already ordered; refresh first' using errcode='P0001'; end if;
 if action='edit' then
 if customer_reference is null or length(trim(customer_reference)) not between 1 and 80 or length(coalesce(order_note,''))>1000 or jsonb_typeof(requested_items) is distinct from 'array' then raise exception 'Invalid order'; end if;
 if jsonb_array_length(requested_items) not between 1 and 100 then raise exception 'Invalid item count'; end if;
 if exists(select 1 from jsonb_array_elements(requested_items) e group by e->>'variant_id' having count(*)>1) then raise exception 'Duplicate variant'; end if;
 for entry in select value from jsonb_array_elements(requested_items) loop
 if coalesce(entry->>'qty','')!~'^[1-9][0-9]{0,2}$' then raise exception 'Invalid quantity'; end if;
 select jsonb_build_object('variant_id',v.shopline_variant_id,'product_code',p.product_code,'product_name',p.product_name,'variant_name',v.variant_name,'color',v.color,'size',v.size,'supplier_code',p.supplier_code,'qty',(entry->>'qty')::integer)
 into item_snapshot from public.variants v join public.products p using(shopline_product_id) where v.shopline_variant_id=entry->>'variant_id';
 if item_snapshot is null then raise exception 'Unknown variant'; end if;
 snapshot:=snapshot||jsonb_build_array(item_snapshot);
 end loop;
 update public.ddu_customer_orders set customer_ref=trim(customer_reference),note=coalesce(order_note,''),items=snapshot,revision=revision+1,modified_at=now(),last_change_id=change_id where id=customer.id;
 else
 perform public.ddu_delete_cancelled_request('customer',customer.id,customer.items);
 end if;
 return customer.id;
end $function$;

commit;
