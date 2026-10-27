import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid();
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

async function access(req, stationId) {
  const stationQ = await req.supabase.from('stations').select('id,company_id,name').eq('id', stationId).maybeSingle();
  if (stationQ.error) throw stationQ.error;
  if (!stationQ.data) return { missing: true };
  const [companyQ, memberQ] = await Promise.all([
    req.supabase.from('company_members').select('role,status').eq('company_id', stationQ.data.company_id).eq('user_id', req.user.id).maybeSingle(),
    req.supabase.from('station_members').select('role,status').eq('station_id', stationId).eq('user_id', req.user.id).maybeSingle(),
  ]);
  if (companyQ.error) throw companyQ.error;
  if (memberQ.error) throw memberQ.error;
  const owner = ['COMPANY_OWNER', 'COMPANY_ADMIN'].includes(companyQ.data?.role) && companyQ.data?.status === 'active';
  const manager = memberQ.data?.role === 'STATION_MANAGER' && memberQ.data?.status === 'active';
  const attendant = memberQ.data?.role === 'ATTENDANT' && memberQ.data?.status === 'active';
  return { station: stationQ.data, owner, manager, attendant, canManage: owner || manager, canOperate: owner || manager || attendant };
}

async function audit(req, scope, action, entityType, entityId, metadata = {}) {
  const q = await req.supabase.from('audit_events').insert({ company_id: scope.station.company_id, station_id: scope.station.id, actor_user_id: req.user.id, action, entity_type: entityType, entity_id: String(entityId), metadata });
  if (q.error) throw q.error;
}

async function notifyManagers(supabase, scope, fingerprint, title, message, severity = 'warning') {
  const [ownersQ, managersQ] = await Promise.all([
    supabase.from('company_members').select('user_id').eq('company_id', scope.station.company_id).in('role', ['COMPANY_OWNER','COMPANY_ADMIN']).eq('status', 'active'),
    supabase.from('station_members').select('user_id').eq('station_id', scope.station.id).eq('role', 'STATION_MANAGER').eq('status', 'active'),
  ]);
  if (ownersQ.error) throw ownersQ.error;
  if (managersQ.error) throw managersQ.error;
  const recipients = [...new Set([...(ownersQ.data || []).map(x => x.user_id), ...(managersQ.data || []).map(x => x.user_id)])];
  if (!recipients.length) return;
  const rows = recipients.map(user_id => ({ user_id, company_id: scope.station.company_id, station_id: scope.station.id, fingerprint: `${fingerprint}:${user_id}`.slice(0, 500), title, message, severity, notification_type: 'operational_anomaly', action_path: '/advanced-operations' }));
  const saved = await supabase.from('notification_inbox').upsert(rows, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true });
  if (saved.error) throw saved.error;
}

async function scoped(req, res, stationId, write = false) {
  const scope = await access(req, stationId);
  if (scope.missing) { fail(res, 404, 'STATION_NOT_FOUND', 'Station not found.'); return null; }
  if (!scope.canOperate) { fail(res, 403, 'STATION_ACCESS_DENIED', 'You are not assigned to this station.'); return null; }
  if (write && !scope.canManage) { fail(res, 403, 'MANAGER_REQUIRED', 'Only company leadership or an assigned station manager can perform this action.'); return null; }
  return scope;
}

const productSchema = z.object({ stationId: uuid, sku: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(120), category: z.string().trim().min(1).max(60).default('general'), unit: z.string().trim().min(1).max(20).default('each'), unitPrice: z.coerce.number().min(0).max(100000000), stockQuantity: z.coerce.number().min(0).max(100000000).default(0), trackStock: z.boolean().default(true) });
const checkoutSchema = z.object({ stationId: uuid, idempotencyKey: uuid, paymentMethod: z.enum(['cash','pos','bank_transfer','credit','other']), paymentReference: z.string().max(120).optional(), discountAmount: z.coerce.number().min(0).max(100000000).default(0), items: z.array(z.object({ productId: uuid, quantity: z.coerce.number().positive().max(1000000) })).min(1).max(100) });
const verifySchema = z.object({ stationId: uuid, actualQuantity: z.coerce.number().min(0).max(100000000), actualInvoiceAmount: z.preprocess(v => v === '' || v == null ? undefined : v, z.coerce.number().min(0).max(100000000000).optional()), supplierDocumentReference: z.string().trim().max(120).optional(), notes: z.string().trim().max(1000).optional() });
const connectionSchema = z.object({ stationId: uuid, providerKey: z.string().trim().min(2).max(80), displayName: z.string().trim().min(2).max(120), integrationType: z.enum(['accounting','payment','dispenser','tank_gauge','pos','webhook','other']), direction: z.enum(['inbound','outbound','bidirectional']).default('bidirectional'), credentialReference: z.string().trim().regex(/^(ENV|SECRET_REF):[A-Z][A-Z0-9_]{1,119}$/).optional(), config: z.record(z.unknown()).default({}) }).superRefine((v, ctx) => { if (JSON.stringify(v.config).length > 4000) ctx.addIssue({ code: 'custom', path: ['config'], message: 'Configuration must be no larger than 4 KB.' }); if (/secret|password|token|api[_-]?key|private[_-]?key|credential|authorization|connectionstring|client[_-]?secret|access[_-]?key/i.test(JSON.stringify(v.config))) ctx.addIssue({ code: 'custom', path: ['config'], message: 'Do not place credentials or secrets in integration config. Use a server-side credential reference.' }); });

export default function advancedOperationsRoutes() {
  const r = Router();

  r.get('/workspace', async (req, res, next) => {
    const p = z.object({ stationId: uuid }).safeParse(req.query);
    if (!p.success) return fail(res, 400, 'VALIDATION_ERROR', 'Select a valid station.');
    try {
      const scope = await scoped(req, res, p.data.stationId); if (!scope) return;
      const sid = scope.station.id;
      const queries = await Promise.all([
        req.supabase.from('delivery_receipt_checks').select('id,delivery_id,expected_quantity,actual_quantity,quantity_variance,expected_invoice_amount,actual_invoice_amount,invoice_variance,status,supplier_document_reference,notes,verified_at').eq('station_id', sid).order('verified_at', { ascending: false }).limit(100),
        req.supabase.from('shop_products').select('id,sku,name,category,unit,unit_price,stock_quantity,track_stock,active,updated_at').eq('station_id', sid).order('name').limit(500),
        (scope.attendant && !scope.canManage ? req.supabase.from('shop_sales').select('id,receipt_number,status,subtotal,discount_amount,total_amount,payment_method,payment_reference,cashier_user_id,created_at').eq('station_id', sid).eq('cashier_user_id', req.user.id).order('created_at', { ascending: false }).limit(100) : req.supabase.from('shop_sales').select('id,receipt_number,status,subtotal,discount_amount,total_amount,payment_method,payment_reference,cashier_user_id,created_at').eq('station_id', sid).order('created_at', { ascending: false }).limit(100)),
        (scope.canManage ? req.supabase.from('operational_anomaly_cases').select('id,anomaly_type,severity,title,description,source_table,source_id,status,occurrence_count,first_seen_at,last_seen_at,escalation_level,next_escalation_at,resolution_note,created_at,updated_at').eq('station_id', sid).order('last_seen_at', { ascending: false }).limit(200) : Promise.resolve({ data: [], error: null })),
        (scope.canManage ? req.supabase.from('integration_connections').select('id,provider_key,display_name,integration_type,status,direction,credential_reference,last_tested_at,last_success_at,last_error_code,created_at,updated_at').eq('company_id', scope.station.company_id).or(`station_id.eq.${sid},station_id.is.null`).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null })),
        (scope.canManage ? req.supabase.from('integration_event_log').select('id,connection_id,direction,event_type,external_event_id,idempotency_key,status,payload_summary,error_code,received_at,processed_at').eq('station_id', sid).order('received_at', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null })),
        (scope.canManage ? req.supabase.from('audit_events').select('id,actor_user_id,action,entity_type,entity_id,metadata,created_at').eq('station_id', sid).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null })),
      ]);
      const error = queries.find(q => q.error)?.error; if (error) throw error;
      const [deliveryChecks, shopProducts, shopSales, anomalies, integrations, integrationEvents, auditEvents] = queries.map(q => q.data || []);
      res.json({ data: { station: scope.station, permissions: { canManage: scope.canManage, canOperate: scope.canOperate }, deliveryChecks, shopProducts, shopSales, anomalies, integrations: integrations.map(({ credential_reference, ...row }) => ({ ...row, credentialConfigured: Boolean(credential_reference) })), integrationEvents, auditEvents } });
    } catch (e) { next(e); }
  });

  r.post('/deliveries/:deliveryId/verify', async (req, res, next) => {
    const p = verifySchema.safeParse(req.body);
    if (!p.success || !uuid.safeParse(req.params.deliveryId).success) return fail(res, 400, 'VALIDATION_ERROR', 'Provide a valid delivery, actual received quantity and optional invoice details.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const deliveryQ = await req.supabase.from('tank_deliveries').select('id,station_id,supplier_name,delivery_reference,quantity_units,quantity_litres,unit_cost_per_unit,unit_cost_per_litre,unit_of_measure,delivered_at').eq('id', req.params.deliveryId).eq('station_id', scope.station.id).maybeSingle();
      if (deliveryQ.error) throw deliveryQ.error;
      if (!deliveryQ.data) return fail(res, 404, 'DELIVERY_NOT_FOUND', 'Delivery not found for this station.');
      const delivery = deliveryQ.data;
      const expectedQty = Number(delivery.quantity_units ?? delivery.quantity_litres ?? 0);
      const expectedInvoice = expectedQty * Number(delivery.unit_cost_per_unit ?? delivery.unit_cost_per_litre ?? 0);
      const qtyVariance = Number((p.data.actualQuantity - expectedQty).toFixed(3));
      const invoiceVariance = p.data.actualInvoiceAmount === undefined ? null : Number((p.data.actualInvoiceAmount - expectedInvoice).toFixed(2));
      const tolerance = Math.max(0.01, expectedQty * 0.001);
      const status = Math.abs(qtyVariance) > tolerance || (invoiceVariance !== null && Math.abs(invoiceVariance) > 1) ? (qtyVariance < -tolerance ? 'short' : qtyVariance > tolerance ? 'over' : 'disputed') : 'matched';
      const saved = await req.supabase.from('delivery_receipt_checks').insert({ company_id: scope.station.company_id, station_id: scope.station.id, delivery_id: delivery.id, expected_quantity: expectedQty, actual_quantity: p.data.actualQuantity, expected_invoice_amount: Number(expectedInvoice.toFixed(2)), actual_invoice_amount: p.data.actualInvoiceAmount ?? null, invoice_variance: invoiceVariance, status, supplier_document_reference: p.data.supplierDocumentReference || null, notes: p.data.notes || null, verified_by: req.user.id }).select('*').single();
      if (saved.error) { if (saved.error.code === '23505') return fail(res, 409, 'DELIVERY_ALREADY_VERIFIED', 'This delivery already has a receipt verification. Contact a manager to resolve the existing record; do not overwrite it.'); throw saved.error; }
      await audit(req, scope, 'DELIVERY_RECEIPT_VERIFIED', 'delivery_receipt_check', saved.data.id, { deliveryId: delivery.id, status, expectedQty, actualQty: p.data.actualQuantity, qtyVariance });
      if (status !== 'matched') {
        const fingerprint = `delivery_variance:${delivery.id}`;
        const anomalySaved = await req.supabase.from('operational_anomaly_cases').upsert({ company_id: scope.station.company_id, station_id: scope.station.id, fingerprint, anomaly_type: 'delivery_variance', severity: status === 'short' ? 'critical' : 'warning', title: `Supplier delivery ${status}`, description: `${delivery.supplier_name} / ${delivery.delivery_reference}: expected ${expectedQty} ${delivery.unit_of_measure || 'units'}, received ${p.data.actualQuantity}; variance ${qtyVariance}.`, source_table: 'delivery_receipt_checks', source_id: saved.data.id, status: 'open', next_escalation_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'station_id,fingerprint' });
        if (anomalySaved.error) throw anomalySaved.error;
        await notifyManagers(req.supabase, scope, `anomaly:${scope.station.id}:${fingerprint}`, `Supplier delivery ${status}`, `${delivery.supplier_name} / ${delivery.delivery_reference}: expected ${expectedQty}, received ${p.data.actualQuantity}; variance ${qtyVariance}. Review delivery evidence.`, status === 'short' ? 'critical' : 'warning');
      }
      res.status(201).json({ data: { verification: saved.data, supplier: delivery.supplier_name, deliveryReference: delivery.delivery_reference, expectedInvoiceAmount: Number(expectedInvoice.toFixed(2)), note: 'Verification is append-only; the original delivery record is not modified.' } });
    } catch (e) { next(e); }
  });

  r.post('/shop-products', async (req, res, next) => {
    const p = productSchema.safeParse(req.body); if (!p.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter a valid SKU, product name, unit price and stock quantity.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const saved = await req.supabase.from('shop_products').insert({ company_id: scope.station.company_id, station_id: scope.station.id, sku: p.data.sku.toUpperCase(), name: p.data.name, category: p.data.category, unit: p.data.unit, unit_price: p.data.unitPrice, stock_quantity: p.data.stockQuantity, track_stock: p.data.trackStock, created_by: req.user.id }).select('id,sku,name,category,unit,unit_price,stock_quantity,track_stock,active,created_at').single();
      if (saved.error) { if (saved.error.code === '23505') return fail(res, 409, 'DUPLICATE_SKU', 'A product with this SKU already exists at this station.'); throw saved.error; }
      await audit(req, scope, 'SHOP_PRODUCT_CREATED', 'shop_product', saved.data.id, { sku: saved.data.sku, name: saved.data.name });
      res.status(201).json({ data: saved.data });
    } catch (e) { next(e); }
  });

  r.patch('/shop-products/:id', async (req, res, next) => {
    const p = z.object({ stationId: uuid, unitPrice: z.coerce.number().min(0).max(100000000).optional(), active: z.boolean().optional(), trackStock: z.boolean().optional(), stockQuantity: z.coerce.number().min(0).max(100000000).optional(), name: z.string().trim().min(2).max(120).optional(), category: z.string().trim().min(1).max(60).optional() }).refine(v => Object.keys(v).some(k => k !== 'stationId'), 'At least one change is required').safeParse(req.body);
    if (!p.success || !uuid.safeParse(req.params.id).success) return fail(res, 400, 'VALIDATION_ERROR', 'Provide a product and at least one valid field to update.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const beforeQ = await req.supabase.from('shop_products').select('id,sku,name,category,unit_price,stock_quantity,track_stock,active').eq('id', req.params.id).eq('station_id', scope.station.id).maybeSingle();
      if (beforeQ.error) throw beforeQ.error; if (!beforeQ.data) return fail(res, 404, 'PRODUCT_NOT_FOUND', 'Shop product not found.');
      const changes = { updated_at: new Date().toISOString() };
      if (p.data.unitPrice !== undefined) changes.unit_price = p.data.unitPrice;
      if (p.data.active !== undefined) changes.active = p.data.active;
      if (p.data.trackStock !== undefined) changes.track_stock = p.data.trackStock;
      if (p.data.stockQuantity !== undefined) changes.stock_quantity = p.data.stockQuantity;
      if (p.data.name !== undefined) changes.name = p.data.name;
      if (p.data.category !== undefined) changes.category = p.data.category;
      const saved = await req.supabase.from('shop_products').update(changes).eq('id', req.params.id).eq('station_id', scope.station.id).select('id,sku,name,category,unit,unit_price,stock_quantity,track_stock,active,updated_at').maybeSingle();
      if (saved.error) throw saved.error; if (!saved.data) return fail(res, 404, 'PRODUCT_NOT_FOUND', 'Shop product not found.');
      const changedFields = Object.keys(changes).filter(k => k !== 'updated_at');
      const before = Object.fromEntries(changedFields.map(key => [key, beforeQ.data[key]]));
      const after = Object.fromEntries(changedFields.map(key => [key, saved.data[key]]));
      await audit(req, scope, 'SHOP_PRODUCT_UPDATED', 'shop_product', saved.data.id, { changedFields, before, after });
      res.json({ data: saved.data });
    } catch (e) { next(e); }
  });

  r.post('/pos/checkout', async (req, res, next) => {
    const p = checkoutSchema.safeParse(req.body); if (!p.success) return fail(res, 400, 'VALIDATION_ERROR', 'Provide a valid payment method, unique idempotency key and sale items.');
    try {
      const scope = await scoped(req, res, p.data.stationId); if (!scope) return;
      if (p.data.discountAmount > 0 && !scope.canManage) return fail(res, 403, 'DISCOUNT_APPROVAL_REQUIRED', 'Only a manager can apply a shop sale discount.');
      if (p.data.paymentMethod === 'credit' && !scope.canManage) return fail(res, 403, 'CREDIT_APPROVAL_REQUIRED', 'Only a manager can post a credit sale.');
      const result = await req.supabase.rpc('checkout_shop_sale', { p_station_id: scope.station.id, p_company_id: scope.station.company_id, p_cashier_user_id: req.user.id, p_idempotency_key: p.data.idempotencyKey, p_payment_method: p.data.paymentMethod, p_payment_reference: p.data.paymentReference || null, p_discount_amount: p.data.discountAmount, p_items: p.data.items });
      if (result.error) {
        const message = String(result.error.message || '');
        const mappings = [['SHOP_STOCK_INSUFFICIENT', 409, 'INSUFFICIENT_STOCK', 'Insufficient stock for one or more items.'], ['SHOP_PRODUCT_NOT_FOUND', 404, 'PRODUCT_NOT_FOUND', 'A product is unavailable or belongs to another station.'], ['DISCOUNT_EXCEEDS_SUBTOTAL', 400, 'DISCOUNT_EXCEEDS_SUBTOTAL', 'Discount cannot exceed the sale subtotal.'], ['INVALID_SALE_ITEMS', 400, 'INVALID_SALE_ITEMS', 'Add between 1 and 100 valid sale items.']];
        const matched = mappings.find(([code]) => message.includes(code)); if (matched) return fail(res, matched[1], matched[2], matched[3]); throw result.error;
      }
      const payload = result.data || {}; const sale = payload.sale || payload;
      res.status(payload.duplicate ? 200 : 201).json({ data: { sale, duplicate: Boolean(payload.duplicate), note: payload.duplicate ? 'This idempotency key was already processed; no second sale was created.' : 'Sale and stock movements committed atomically.' } });
    } catch (e) { next(e); }
  });

  r.get('/pos/sales/:saleId', async (req, res, next) => {
    const p = z.object({ stationId: uuid }).safeParse(req.query); if (!p.success || !uuid.safeParse(req.params.saleId).success) return fail(res, 400, 'VALIDATION_ERROR', 'Select a valid station and sale.');
    try {
      const scope = await scoped(req, res, p.data.stationId); if (!scope) return;
      const [saleQ, itemsQ] = await Promise.all([req.supabase.from('shop_sales').select('*').eq('id', req.params.saleId).eq('station_id', scope.station.id).maybeSingle(), req.supabase.from('shop_sale_items').select('*').eq('sale_id', req.params.saleId).eq('station_id', scope.station.id).order('created_at')]);
      if (saleQ.error) throw saleQ.error; if (itemsQ.error) throw itemsQ.error; if (!saleQ.data) return fail(res, 404, 'SALE_NOT_FOUND', 'Sale not found.');
      res.json({ data: { sale: saleQ.data, items: itemsQ.data || [] } });
    } catch (e) { next(e); }
  });

  r.post('/anomalies/scan', async (req, res, next) => {
    const p = z.object({ stationId: uuid }).safeParse(req.body); if (!p.success) return fail(res, 400, 'VALIDATION_ERROR', 'Select a valid station.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const [litreQ, kgQ, reversalQ, kgReversalQ, checksQ, kgChecksQ] = await Promise.all([
        req.supabase.from('nozzle_meter_readings').select('id,expected_amount,recorded_at,status').eq('station_id', scope.station.id).eq('status', 'approved').gte('recorded_at', since).order('recorded_at', { ascending: false }).limit(500),
        req.supabase.from('kg_nozzle_meter_readings').select('id,expected_amount,recorded_at,status').eq('station_id', scope.station.id).eq('status', 'approved').gte('recorded_at', since).order('recorded_at', { ascending: false }).limit(500),
        req.supabase.from('sales_collection_reversals').select('id,collection_id,amount,reason,created_at').eq('station_id', scope.station.id).gte('created_at', since).limit(300),
        req.supabase.from('kg_sales_collection_reversals').select('id,collection_id,amount,reason,created_at').eq('station_id', scope.station.id).gte('created_at', since).limit(300),
        req.supabase.from('tank_stock_checks').select('id,variance_litres,measured_at,tank_id').eq('station_id', scope.station.id).gte('measured_at', since).limit(300),
        req.supabase.from('kg_tank_stock_checks').select('id,variance_kg,measured_at,tank_id').eq('station_id', scope.station.id).gte('measured_at', since).limit(300),
      ]);
      for (const q of [litreQ, kgQ, reversalQ, kgReversalQ, checksQ, kgChecksQ]) if (q.error) throw q.error;
      const findings = [];
      for (const [rows, table, collectionTable, reversalRows, unit] of [[litreQ.data || [], 'nozzle_meter_readings', 'sales_collections', reversalQ.data || [], 'litre'], [kgQ.data || [], 'kg_nozzle_meter_readings', 'kg_sales_collections', kgReversalQ.data || [], 'kg']]) {
        const ids = rows.map(row => row.id);
        if (!ids.length) continue;
        const collectionQ = await req.supabase.from(collectionTable).select('id,reading_id,amount').eq('station_id', scope.station.id).in('reading_id', ids);
        if (collectionQ.error) throw collectionQ.error;
        const collections = collectionQ.data || []; const collectionIds = collections.map(row => row.id);
        const reversalQ = collectionIds.length ? await req.supabase.from(table === 'nozzle_meter_readings' ? 'sales_collection_reversals' : 'kg_sales_collection_reversals').select('collection_id,amount').eq('station_id', scope.station.id).in('collection_id', collectionIds) : { data: [], error: null };
        if (reversalQ.error) throw reversalQ.error;
        const reversed = new Map(); for (const row of reversalQ.data || []) reversed.set(row.collection_id, (reversed.get(row.collection_id) || 0) + Math.abs(Number(row.amount || 0)));
        const collectedByReading = new Map();
        for (const row of collections) collectedByReading.set(row.reading_id, (collectedByReading.get(row.reading_id) || 0) + Number(row.amount || 0) - (reversed.get(row.id) || 0));
        for (const reading of rows) {
          const collected = collectedByReading.get(reading.id) || 0;
          const expected = Number(reading.expected_amount || 0); const gap = Number((expected - collected).toFixed(2));
          if (gap >= 1000 && gap >= expected * 0.01) findings.push({ fingerprint: `collection_gap:${reading.id}`, anomaly_type: 'collection_gap', severity: gap >= 10000 ? 'critical' : 'warning', title: 'Sales collection gap', description: `${unit} meter sale ${reading.id}: expected ₦${expected.toFixed(2)}, net collected ₦${collected.toFixed(2)}, gap ₦${gap.toFixed(2)}.`, source_table: table, source_id: reading.id });
        }
      }
      for (const [rows, table] of [[reversalQ.data || [], 'sales_collection_reversals'], [kgReversalQ.data || [], 'kg_sales_collection_reversals']]) for (const reversal of rows) if (Math.abs(Number(reversal.amount || 0)) >= 10000) findings.push({ fingerprint: `large_reversal:${reversal.id}`, anomaly_type: 'large_reversal', severity: 'critical', title: 'Large sales collection reversal', description: `A ₦${Math.abs(Number(reversal.amount)).toFixed(2)} collection reversal was recorded. Review the reason and approval evidence.`, source_table: table, source_id: reversal.id });
      for (const [rows, field, table, unit] of [[checksQ.data || [], 'variance_litres', 'tank_stock_checks', 'litres'], [kgChecksQ.data || [], 'variance_kg', 'kg_tank_stock_checks', 'kg']]) for (const check of rows) if (Math.abs(Number(check[field] || 0)) >= (unit === 'kg' ? 5 : 10)) findings.push({ fingerprint: `stock_variance:${check.id}`, anomaly_type: 'stock_variance', severity: Math.abs(Number(check[field])) >= (unit === 'kg' ? 50 : 100) ? 'critical' : 'warning', title: 'Physical stock variance', description: `Tank ${check.tank_id}: physical stock variance ${Number(check[field]).toFixed(2)} ${unit}. Investigate deliveries, meter sales and measurement evidence.`, source_table: table, source_id: check.id });
      let created = 0, updated = 0;
      for (const finding of findings) {
        const existingQ = await req.supabase.from('operational_anomaly_cases').select('id,occurrence_count,status,escalation_level,next_escalation_at').eq('station_id', scope.station.id).eq('fingerprint', finding.fingerprint).maybeSingle();
        if (existingQ.error) throw existingQ.error;
        const reopened = ['resolved', 'dismissed'].includes(existingQ.data?.status);
        const row = { company_id: scope.station.company_id, station_id: scope.station.id, ...finding, status: reopened ? 'open' : (existingQ.data?.status || 'open'), occurrence_count: (existingQ.data?.occurrence_count || 0) + 1, escalation_level: reopened ? 0 : (existingQ.data?.escalation_level || 0), last_seen_at: new Date().toISOString(), next_escalation_at: (!existingQ.data || reopened) ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : existingQ.data.next_escalation_at, updated_at: new Date().toISOString() };
        const saved = await req.supabase.from('operational_anomaly_cases').upsert(row, { onConflict: 'station_id,fingerprint' }).select('id').single();
        if (saved.error) throw saved.error;
        await notifyManagers(req.supabase, scope, `anomaly:${scope.station.id}:${finding.fingerprint}${reopened ? `:reopened:${row.occurrence_count}` : ''}`, finding.title, finding.description, finding.severity === 'critical' ? 'critical' : 'warning');
        if (existingQ.data) updated++; else created++;
      }
      await audit(req, scope, 'ANOMALY_SCAN_COMPLETED', 'operational_anomaly_scan', scope.station.id, { findings: findings.length, created, updated, windowDays: 7 });
      res.json({ data: { scanned: true, windowDays: 7, findings: findings.length, created, updated, note: 'Rule-based operational screening only. These are investigation leads, not proof of fraud; review source records before taking action.' } });
    } catch (e) { next(e); }
  });

  r.patch('/anomalies/:id/status', async (req, res, next) => {
    const p = z.object({ stationId: uuid, status: z.enum(['acknowledged','resolved','dismissed']), note: z.string().trim().max(1000).optional() }).safeParse(req.body);
    if (!p.success || !uuid.safeParse(req.params.id).success) return fail(res, 400, 'VALIDATION_ERROR', 'Choose an anomaly and a valid resolution status.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const update = { status: p.data.status, updated_at: new Date().toISOString() };
      if (p.data.status === 'resolved' || p.data.status === 'dismissed') { update.resolution_note = p.data.note || null; update.resolved_by = req.user.id; update.resolved_at = new Date().toISOString(); }
      const saved = await req.supabase.from('operational_anomaly_cases').update(update).eq('id', req.params.id).eq('station_id', scope.station.id).select('id,status,resolution_note,resolved_by,resolved_at,updated_at').maybeSingle();
      if (saved.error) throw saved.error; if (!saved.data) return fail(res, 404, 'ANOMALY_NOT_FOUND', 'Anomaly case not found.');
      await audit(req, scope, `ANOMALY_${p.data.status.toUpperCase()}`, 'operational_anomaly_case', saved.data.id, { note: p.data.note || null });
      res.json({ data: saved.data });
    } catch (e) { next(e); }
  });

  r.post('/integrations', async (req, res, next) => {
    const p = connectionSchema.safeParse(req.body); if (!p.success) return fail(res, 400, 'VALIDATION_ERROR', 'Provide a valid integration definition. Never submit credentials in config.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const saved = await req.supabase.from('integration_connections').insert({ company_id: scope.station.company_id, station_id: scope.station.id, provider_key: p.data.providerKey.toLowerCase(), display_name: p.data.displayName, integration_type: p.data.integrationType, direction: p.data.direction, config: p.data.config, credential_reference: p.data.credentialReference || null, created_by: req.user.id }).select('id,provider_key,display_name,integration_type,direction,status,created_at').single();
      if (saved.error) throw saved.error;
      await audit(req, scope, 'INTEGRATION_CONNECTION_REGISTERED', 'integration_connection', saved.data.id, { providerKey: saved.data.provider_key, integrationType: saved.data.integration_type });
      res.status(201).json({ data: { ...saved.data, note: 'Registry entry created. It does not connect external hardware or a provider until a matching adapter, credentials and staging tests are configured.' } });
    } catch (e) { next(e); }
  });

  r.post('/integrations/:id/test', async (req, res, next) => {
    const p = z.object({ stationId: uuid }).safeParse(req.body); if (!p.success || !uuid.safeParse(req.params.id).success) return fail(res, 400, 'VALIDATION_ERROR', 'Select a valid station and integration.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const found = await req.supabase.from('integration_connections').select('id,company_id,station_id,provider_key,display_name,integration_type,credential_reference').eq('id', req.params.id).eq('company_id', scope.station.company_id).or(`station_id.eq.${scope.station.id},station_id.is.null`).maybeSingle();
      if (found.error) throw found.error; if (!found.data) return fail(res, 404, 'INTEGRATION_NOT_FOUND', 'Integration not found.');
      const connection = found.data;
      const eventId = randomUUID();
      const event = await req.supabase.from('integration_event_log').insert({ connection_id: connection.id, company_id: scope.station.company_id, station_id: scope.station.id, direction: 'outbound', event_type: 'configuration_self_check', external_event_id: eventId, idempotency_key: `self-check:${eventId}`, status: 'ignored', error_code: 'ADAPTER_NOT_CONFIGURED', payload_summary: { providerKey: connection.provider_key, integrationType: connection.integration_type, credentialReferenceConfigured: Boolean(connection.credential_reference), adapterExecution: 'not-run' }, processed_at: new Date().toISOString() }).select('id').single();
      if (event.error) throw event.error;
      const connectionUpdate = await req.supabase.from('integration_connections').update({ status: 'testing', last_tested_at: new Date().toISOString(), last_error_code: 'ADAPTER_NOT_CONFIGURED', updated_at: new Date().toISOString() }).eq('id', connection.id); if (connectionUpdate.error) throw connectionUpdate.error;
      await audit(req, scope, 'INTEGRATION_SELF_CHECK_RECORDED', 'integration_connection', connection.id, { eventId: event.data.id });
      res.json({ data: { connectionId: connection.id, eventId: event.data.id, configurationValid: true, providerReachable: null, status: 'testing', note: 'Configuration metadata was recorded, but no external provider or physical device was contacted. Implement and configure the provider-specific adapter before marking this connection active.' } });
    } catch (e) { next(e); }
  });

  r.patch('/integrations/:id/status', async (req, res, next) => {
    const p = z.object({ stationId: uuid, status: z.enum(['draft','paused']) }).safeParse(req.body); if (!p.success || !uuid.safeParse(req.params.id).success) return fail(res, 400, 'VALIDATION_ERROR', 'Only draft or paused status can be set manually.');
    try {
      const scope = await scoped(req, res, p.data.stationId, true); if (!scope) return;
      const saved = await req.supabase.from('integration_connections').update({ status: p.data.status, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('company_id', scope.station.company_id).or(`station_id.eq.${scope.station.id},station_id.is.null`).select('id,status').maybeSingle();
      if (saved.error) throw saved.error; if (!saved.data) return fail(res, 404, 'INTEGRATION_NOT_FOUND', 'Integration not found.');
      await audit(req, scope, 'INTEGRATION_STATUS_CHANGED', 'integration_connection', saved.data.id, { status: saved.data.status });
      res.json({ data: saved.data });
    } catch (e) { next(e); }
  });

  return r;
}
