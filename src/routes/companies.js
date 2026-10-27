
import { Router } from 'express';
import { z } from 'zod';

const SUPPORTED_CURRENCIES = ['NGN','USD','CAD','GHS','KES','ZAR','GBP','EUR','AUD','INR','PKR','UGX','TZS','RWF','XOF','XAF','AED'];
const schema = z.object({
  name: z.string().trim().min(2).max(160),
  currency: z.enum(SUPPORTED_CURRENCIES).default('NGN'),
});

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function validDateRange(from, to) {
  if (
    !datePattern.test(from || '') ||
    !datePattern.test(to || '')
  ) {
    return false;
  }

  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);

  if (
    !Number.isFinite(a.getTime()) ||
    !Number.isFinite(b.getTime()) ||
    a.toISOString().slice(0, 10) !== from ||
    b.toISOString().slice(0, 10) !== to
  ) {
    return false;
  }

  return a <= b && (b - a) / 86400000 <= 366;
}

function inRange(q, column, from, to) {
  const start = `${from}T00:00:00.000+01:00`;
  const end = new Date(
    new Date(`${to}T00:00:00.000+01:00`).getTime() + 86400000
  ).toISOString();

  return q.gte(column, start).lt(column, end);
}

const sum = (rows, key) =>
  (rows || []).reduce(
    (total, row) => total + Number(row[key] || 0),
    0
  );

async function fetchPaged(makeQuery, orderColumn, cap = 100000) {
  const rows = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    let query = makeQuery().order(orderColumn, { ascending: true });
    if (orderColumn !== 'id') query = query.order('id', { ascending: true });
    const result = await query.range(offset, Math.min(offset + 999, cap - 1));
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < 1000) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function companyLeadership(req) {
  const q = await req.supabase
    .from('company_members')
    .select('company_id,role')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN'])
    .limit(1)
    .maybeSingle();

  if (q.error) throw q.error;

  return q.data;
}

// Resolve the accounting currency from the authorized company record.
// Reports must never reference an undeclared currency helper or silently
// relabel financial values using a per-user preference.
async function companyCurrency(req, companyId) {
  const result = await req.supabase
    .from('companies')
    .select('currency')
    .eq('id', companyId)
    .maybeSingle();

  if (result.error) throw result.error;
  if (!result.data) {
    const error = new Error('COMPANY_NOT_FOUND');
    error.code = 'COMPANY_NOT_FOUND';
    throw error;
  }

  return result.data.currency || 'NGN';
}

export default function companyRoutes() {
  const r = Router();

  // Company base currency is a company-level accounting choice, not a per-user display toggle.
  // It can be changed only before a station is created, preventing silent relabelling of money.
  r.get('/settings', async (req, res, next) => {
    try {
      const membership = await req.supabase.from('company_members')
        .select('company_id,role').eq('user_id', req.user.id).eq('status', 'active')
        .in('role', ['COMPANY_OWNER','COMPANY_ADMIN']).limit(1).maybeSingle();
      if (membership.error) throw membership.error;
      if (!membership.data) return res.status(403).json({error:{code:'FORBIDDEN',message:'Company owner or director access is required.'}});
      const [company, stations] = await Promise.all([
        req.supabase.from('companies').select('id,name,currency').eq('id', membership.data.company_id).single(),
        req.supabase.from('stations').select('id').eq('company_id', membership.data.company_id).limit(1),
      ]);
      if (company.error) throw company.error;
      if (stations.error) throw stations.error;
      return res.json({data:{...company.data, canChangeCurrency: (stations.data || []).length === 0, supportedCurrencies: SUPPORTED_CURRENCIES}});
    } catch (e) { next(e); }
  });

  r.put('/settings/currency', async (req, res, next) => {
    const parsed = z.object({currency:z.enum(SUPPORTED_CURRENCIES)}).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({error:{code:'INVALID_CURRENCY',message:'Choose a supported company currency.'}});
    try {
      const membership = await req.supabase.from('company_members')
        .select('company_id,role').eq('user_id', req.user.id).eq('status', 'active')
        .in('role', ['COMPANY_OWNER','COMPANY_ADMIN']).limit(1).maybeSingle();
      if (membership.error) throw membership.error;
      if (!membership.data) return res.status(403).json({error:{code:'OWNER_REQUIRED',message:'Only a company owner or director can change the company currency.'}});
      const stations = await req.supabase.from('stations').select('id').eq('company_id', membership.data.company_id).limit(1);
      if (stations.error) throw stations.error;
      if ((stations.data || []).length) return res.status(409).json({error:{code:'CURRENCY_LOCKED',message:'Company currency is locked after the first station is created. Changing it safely requires a reviewed financial conversion.'}});
      const updated = await req.supabase.from('companies').update({currency:parsed.data.currency}).eq('id', membership.data.company_id).select('id,name,currency').single();
      if (updated.error) throw updated.error;
      await req.supabase.from('audit_events').insert({company_id:membership.data.company_id,actor_user_id:req.user.id,action:'COMPANY_CURRENCY_UPDATED',entity_type:'company',entity_id:membership.data.company_id,metadata:{currency:parsed.data.currency}});
      return res.json({data:{...updated.data,canChangeCurrency:true}});
    } catch (e) { next(e); }
  });

  r.get('/dashboard-summary', async (req, res, next) => {
    try {
      const result = await req.supabase.rpc(
        'get_company_dashboard_summary',
        { p_user_id: req.user.id }
      );

      if (result.error) {
        if (
          /COMPANY_(?:OWNER|LEADERSHIP)_REQUIRED/.test(
            String(result.error.message || '')
          )
        ) {
          return res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message:
                'Company owner or director access is required for consolidated company reports.',
            },
          });
        }

        throw result.error;
      }

      return res.json({
        data: result.data || { branches: [] },
      });
    } catch (e) {
      next(e);
    }
  });

  r.get('/financial-report', async (req, res, next) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');

      if (!validDateRange(from, to)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_DATE_RANGE',
            message:
              'Provide valid from/to dates covering no more than 367 calendar days.',
          },
        });
      }

      const owner = await companyLeadership(req);

      if (!owner) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message:
              'Company owner or director access is required for consolidated financial reports.',
          },
        });
      }

      const reportCurrency = await companyCurrency(req, owner.company_id);
      const sq = await req.supabase
        .from('stations')
        .select('id,name,address,status')
        .eq('company_id', owner.company_id)
        .order('name');

      if (sq.error) throw sq.error;

      const stations = sq.data || [];

      if (!stations.length) {
        return res.json({
          data: {
            from,
            to,
            branches: [],
            totals: {
              salesLitres: 0,
              salesKg: 0,
              expectedSales: 0,
              grossCollections: 0,
              reversals: 0,
              netCollections: 0,
              stockChecks: 0,
              stockDiscrepancies: 0,
            },
            currency: reportCurrency,
            warnings: [],
          },
        });
      }

      const ids = stations.map((station) => station.id);

      /*
       * Official sales totals include approved meter readings only.
       * Migration 0025 adds review status to both litre and kilogram
       * readings. Pending/rejected readings must never inflate company
       * sales, expected revenue, or financial summaries.
       */
      const specs = [
        [
          'litreSales',
          'nozzle_meter_readings',
          'recorded_at',
          'expected_amount',
          true,
        ],
        [
          'kgSales',
          'kg_nozzle_meter_readings',
          'recorded_at',
          'expected_amount',
          true,
        ],
        [
          'litreCollections',
          'sales_collections',
          'collected_at',
          'amount',
          false,
        ],
        [
          'kgCollections',
          'kg_sales_collections',
          'collected_at',
          'amount',
          false,
        ],
        [
          'litreReversals',
          'sales_collection_reversals',
          'created_at',
          'amount',
          false,
        ],
        [
          'kgReversals',
          'kg_sales_collection_reversals',
          'created_at',
          'amount',
          false,
        ],
        [
          'litreChecks',
          'tank_stock_checks',
          'measured_at',
          null,
          false,
        ],
        [
          'kgChecks',
          'kg_tank_stock_checks',
          'measured_at',
          null,
          false,
        ],
      ];

      const results = await Promise.all(
        specs.map(
          async ([key, table, column, _valueField, approvedOnly]) => {
            const all = [];

            for (let offset = 0; offset < 100000; offset += 1000) {
              let q = req.supabase
                .from(table)
                .select('*')
                .in('station_id', ids);

              q = inRange(q, column, from, to);

              if (approvedOnly) {
                q = q.eq('status', 'approved');
              }

              const result = await q
                .order(column, { ascending: true })
                .range(offset, offset + 999);

              if (result.error) throw result.error;

              all.push(...(result.data || []));

              if (!result.data || result.data.length < 1000) {
                break;
              }
            }

            return [key, all, all.length >= 100000];
          }
        )
      );

      const data = Object.fromEntries(
        results.map(([key, rows]) => [key, rows])
      );

      const truncatedSources = results
        .filter(([, , truncated]) => truncated)
        .map(([key]) => key);

      const warnings = [];

      if (truncatedSources.length) {
        warnings.push(
          'A source table reached the 100,000-row reporting safety cap: ' +
            truncatedSources.join(', ') +
            '. Narrow the date range before relying on totals.'
        );
      }

      const branches = stations.map((st) => {
        const rows = (key) =>
          data[key].filter((row) => row.station_id === st.id);

        const litreSales = rows('litreSales');
        const kgSales = rows('kgSales');
        const lc = rows('litreCollections');
        const kc = rows('kgCollections');
        const lr = rows('litreReversals');
        const kr = rows('kgReversals');
        const lchecks = rows('litreChecks');
        const kchecks = rows('kgChecks');

        const grossCollections =
          sum(lc, 'amount') + sum(kc, 'amount');

        const reversals =
          sum(lr, 'amount') + sum(kr, 'amount');

        const variances = [
          ...lchecks.map((row) =>
            Number(row.variance_litres || 0)
          ),
          ...kchecks.map((row) =>
            Number(row.variance_kg || 0)
          ),
        ];

        return {
          stationId: st.id,
          branch: st.name,
          address: st.address,
          status: st.status,

          salesLitres: sum(litreSales, 'litres_sold'),
          salesKg: sum(kgSales, 'kg_sold'),

          litreSalesAmount: sum(
            litreSales,
            'expected_amount'
          ),
          kgSalesAmount: sum(
            kgSales,
            'expected_amount'
          ),

          expectedSales:
            sum(litreSales, 'expected_amount') +
            sum(kgSales, 'expected_amount'),

          grossCollections,
          reversals,
          netCollections: grossCollections - reversals,

          litreReadingCount: litreSales.length,
          kgReadingCount: kgSales.length,
          collectionCount: lc.length + kc.length,

          stockChecks: lchecks.length + kchecks.length,

          stockDiscrepancies: variances.filter(
            (value) => Math.abs(value) >= 0.01
          ).length,

          largestAbsoluteStockVariance: variances.reduce(
            (maximum, value) =>
              Math.max(maximum, Math.abs(value)),
            0
          ),
        };
      });

      const totals = branches.reduce(
        (acc, branch) => {
          for (const key of [
            'salesLitres',
            'salesKg',
            'litreSalesAmount',
            'kgSalesAmount',
            'expectedSales',
            'grossCollections',
            'reversals',
            'netCollections',
            'litreReadingCount',
            'kgReadingCount',
            'collectionCount',
            'stockChecks',
            'stockDiscrepancies',
          ]) {
            acc[key] += Number(branch[key] || 0);
          }

          acc.largestAbsoluteStockVariance = Math.max(
            acc.largestAbsoluteStockVariance,
            branch.largestAbsoluteStockVariance || 0
          );

          return acc;
        },
        {
          salesLitres: 0,
          salesKg: 0,
          litreSalesAmount: 0,
          kgSalesAmount: 0,
          expectedSales: 0,
          grossCollections: 0,
          reversals: 0,
          netCollections: 0,
          litreReadingCount: 0,
          kgReadingCount: 0,
          collectionCount: 0,
          stockChecks: 0,
          stockDiscrepancies: 0,
          largestAbsoluteStockVariance: 0,
        }
      );

      return res.json({
        data: {
          from,
          to,
          branches,
          totals,
          currency: reportCurrency,
          note:
            'Litres and kilograms are reported separately. Expected sales are meter-derived; net collections subtract reversals posted during the selected period.',
          warnings,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  r.get('/profit-loss-report', async (req, res, next) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!validDateRange(from, to)) return res.status(400).json({ error: { code: 'INVALID_DATE_RANGE', message: 'Provide valid from/to dates covering no more than 367 calendar days.' } });
      const leader = await companyLeadership(req);
      if (!leader) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Company owner or director access is required for profit and loss reports.' } });
      const reportCurrency = await companyCurrency(req, leader.company_id);
      const stationsQ = await req.supabase.from('stations').select('id,name,address,status').eq('company_id', leader.company_id).order('name');
      if (stationsQ.error) throw stationsQ.error;
      const stations = stationsQ.data || [];
      const ids = stations.map(s => s.id);
      if (!ids.length) return res.json({ data: { from, to, branches: [], totals: { revenue: 0, costOfGoodsSold: null, grossProfit: null, operatingExpenses: 0, netOperatingResult: null }, costCoverageComplete: false, currency: reportCurrency, warnings: ['No branches are configured.'] } });
      const endExclusive = new Date(new Date(`${to}T00:00:00.000+01:00`).getTime() + 86400000).toISOString();
      const start = `${from}T00:00:00.000+01:00`;
      const [tanksResult, deliveriesResult, nozzlesResult, litreResult, kgResult, litreMovesResult, kgMovesResult, expensesResult, payrollResult] = await Promise.all([
        fetchPaged(() => req.supabase.from('station_tanks').select('id,station_id,name,unit_of_measure,opening_stock_units,opening_stock_unit_cost').in('station_id', ids), 'created_at'),
        fetchPaged(() => req.supabase.from('tank_deliveries').select('id,station_id,tank_id,quantity_units,quantity_litres,unit_cost_per_unit,unit_cost_per_litre,unit_of_measure,delivered_at').in('station_id', ids).lt('delivered_at', endExclusive), 'delivered_at'),
        fetchPaged(() => req.supabase.from('pump_nozzles').select('id,station_id,tank_id').in('station_id', ids), 'created_at'),
        fetchPaged(() => req.supabase.from('nozzle_meter_readings').select('station_id,nozzle_id,litres_sold,expected_amount,recorded_at,status').in('station_id', ids).eq('status','approved').lt('recorded_at', endExclusive), 'recorded_at'),
        fetchPaged(() => req.supabase.from('kg_nozzle_meter_readings').select('station_id,nozzle_id,kg_sold,expected_amount,recorded_at,status').in('station_id', ids).eq('status','approved').lt('recorded_at', endExclusive), 'recorded_at'),
        fetchPaged(() => req.supabase.from('tank_stock_movements').select('station_id,tank_id,movement_type,quantity_litres,created_at').in('station_id', ids).lt('created_at', endExclusive), 'created_at'),
        fetchPaged(() => req.supabase.from('kg_tank_stock_movements').select('station_id,tank_id,movement_type,quantity_kg,created_at').in('station_id', ids).lt('created_at', endExclusive), 'created_at'),
        fetchPaged(() => req.supabase.from('operating_expenses').select('station_id,amount,incurred_on,status').eq('company_id', leader.company_id).eq('status','approved').gte('incurred_on', from).lte('incurred_on', to), 'incurred_on'),
        fetchPaged(() => req.supabase.from('branch_payroll').select('station_id,net_salary,period_start,period_end,status').eq('company_id', leader.company_id).eq('status','approved').lte('period_start', to).gte('period_end', from), 'period_start'),
      ]);
      const tanks = tanksResult.rows, deliveries = deliveriesResult.rows, nozzles = nozzlesResult.rows, litre = litreResult.rows, kg = kgResult.rows, litreMoves = litreMovesResult.rows, kgMoves = kgMovesResult.rows, expenses = expensesResult.rows, payroll = payrollResult.rows;
      const nozzleMap = new Map(nozzles.map(n => [n.id, n]));
      const periodStartMs = new Date(start).getTime();
      const periodEndMs = new Date(endExclusive).getTime();
      const revenueByStation = new Map();
      const volumeByTank = new Map();
      const cogsByStation = new Map();
      const unknownCostStations = new Set();
      const inventoryByTank = new Map();
      const eventsByTank = new Map();
      const addEvent = (tankId, event) => { const list = eventsByTank.get(tankId) || []; list.push(event); eventsByTank.set(tankId, list); };
      for (const d of deliveries) addEvent(d.tank_id, { at: d.delivered_at, kind: 'delivery', qty: Number(d.quantity_units ?? d.quantity_litres ?? 0), unitCost: Number(d.unit_cost_per_unit ?? d.unit_cost_per_litre ?? 0) });
      for (const r of [...litre, ...kg]) {
        const nozzle = nozzleMap.get(r.nozzle_id);
        if (!nozzle) { unknownCostStations.add(r.station_id); continue; }
        const unit = r.kg_sold == null ? 'litre' : 'kg';
        const qty = Number(unit === 'kg' ? r.kg_sold : r.litres_sold) || 0;
        const at = r.recorded_at;
        addEvent(nozzle.tank_id, { at, kind: 'sale', qty, stationId: r.station_id, revenue: Number(r.expected_amount || 0), inPeriod: new Date(at).getTime() >= periodStartMs && new Date(at).getTime() < periodEndMs });
        if (new Date(at).getTime() >= periodStartMs && new Date(at).getTime() < periodEndMs) {
          revenueByStation.set(r.station_id, (revenueByStation.get(r.station_id) || 0) + Number(r.expected_amount || 0));
          const item = volumeByTank.get(nozzle.tank_id) || { litres: 0, kilograms: 0 };
          if (unit === 'kg') item.kilograms += qty; else item.litres += qty;
          volumeByTank.set(nozzle.tank_id, item);
        }
      }
      for (const m of litreMoves) addEvent(m.tank_id, { at: m.created_at, kind: 'adjustment', movement: m.movement_type, qty: Number(m.quantity_litres || 0) });
      for (const m of kgMoves) addEvent(m.tank_id, { at: m.created_at, kind: 'adjustment', movement: m.movement_type, qty: Number(m.quantity_kg || 0) });
      let eventSourceTruncated = [tanksResult, deliveriesResult, nozzlesResult, litreResult, kgResult, litreMovesResult, kgMovesResult, expensesResult, payrollResult].some(x => x.truncated);
      for (const tank of tanks) {
        const openingQty = Number(tank.opening_stock_units || 0);
        const openingCost = tank.opening_stock_unit_cost == null ? null : Number(tank.opening_stock_unit_cost);
        let quantity = openingQty;
        let value = openingCost == null ? 0 : openingQty * openingCost;
        let costKnown = openingQty === 0 || openingCost != null;
        let cogs = 0;
        const events = (eventsByTank.get(tank.id) || []).sort((x,y)=>new Date(x.at).getTime()-new Date(y.at).getTime());
        for (const event of events) {
          if (event.kind === 'delivery') {
            quantity += event.qty;
            value += event.qty * event.unitCost;
          } else if (event.kind === 'adjustment') {
            const avg = quantity > 0 ? value / quantity : 0;
            if (event.movement === 'adjustment_in') { quantity += event.qty; value += event.qty * avg; if (avg <= 0 && event.qty > 0) costKnown = false; }
            else { if (event.qty > quantity + 0.01) costKnown = false; const remove = Math.min(event.qty, Math.max(quantity, 0)); quantity -= event.qty; value = Math.max(0, value - remove * avg); }
          } else {
            const avg = quantity > 0 ? value / quantity : 0;
            if (event.qty > quantity + 0.01) costKnown = false;
            if (event.inPeriod) {
              if (!costKnown) unknownCostStations.add(event.stationId);
              else cogs += event.qty * avg;
            }
            const remove = Math.min(event.qty, Math.max(quantity, 0));
            quantity -= event.qty;
            value = Math.max(0, value - remove * avg);
          }
        }
        inventoryByTank.set(tank.id, { quantity, value, costKnown });
        const stationId = tank.station_id;
        cogsByStation.set(stationId, (cogsByStation.get(stationId) || 0) + cogs);
      }
      const branches = stations.map(st => {
        const stTanks = tanks.filter(t => t.station_id === st.id);
        const unknown = unknownCostStations.has(st.id) || stTanks.some(t => (inventoryByTank.get(t.id)?.quantity ?? 0) < -0.01);
        const cogs = cogsByStation.get(st.id) || 0;
        const revenue = revenueByStation.get(st.id) || 0;
        const branchExpenses = expenses.filter(e=>e.station_id===st.id);
        const branchPayroll = payroll.filter(e=>e.station_id===st.id);
        const payrollExpense = branchPayroll.reduce((a,e)=>{const totalDays=(new Date(`${e.period_end}T00:00:00Z`)-new Date(`${e.period_start}T00:00:00Z`))/86400000+1;const overlapStart=e.period_start>from?e.period_start:from;const overlapEnd=e.period_end<to?e.period_end:to;const overlapDays=Math.max(0,(new Date(`${overlapEnd}T00:00:00Z`)-new Date(`${overlapStart}T00:00:00Z`))/86400000+1);return a+(totalDays>0?Number(e.net_salary||0)*overlapDays/totalDays:0)},0);
        const expense = branchExpenses.reduce((a,e)=>a+Number(e.amount||0),0) + payrollExpense;
        const branchCoverage = !unknown && !eventSourceTruncated;
        const volume = stTanks.reduce((a,t)=>{const v=volumeByTank.get(t.id)||{};a.litres+=v.litres||0;a.kilograms+=v.kilograms||0;return a;},{litres:0,kilograms:0});
        return { stationId:st.id, branch:st.name, address:st.address, status:st.status, revenue, costOfGoodsSold:branchCoverage?cogs:null, grossProfit:branchCoverage?revenue-cogs:null, operatingExpenses:expense, payrollExpenses:payrollExpense, otherOperatingExpenses:branchExpenses.reduce((a,e)=>a+Number(e.amount||0),0), netOperatingResult:branchCoverage?revenue-cogs-expense:null, costCoverageComplete:branchCoverage, approvedExpenseCount:branchExpenses.length+branchPayroll.length, approvedPayrollCount:branchPayroll.length, salesVolumeByUnit:volume };
      });
      const allCovered = branches.every(b=>b.costCoverageComplete);
      const totals = branches.reduce((a,b)=>({ revenue:a.revenue+b.revenue, costOfGoodsSold: allCovered ? a.costOfGoodsSold+(b.costOfGoodsSold||0) : null, grossProfit: allCovered ? a.grossProfit+(b.grossProfit||0) : null, operatingExpenses:a.operatingExpenses+b.operatingExpenses, netOperatingResult:allCovered ? a.netOperatingResult+(b.netOperatingResult||0) : null, approvedExpenseCount:a.approvedExpenseCount+b.approvedExpenseCount }),{revenue:0,costOfGoodsSold:allCovered?0:null,grossProfit:allCovered?0:null,operatingExpenses:0,netOperatingResult:allCovered?0:null,approvedExpenseCount:0});
      const warnings = [];
      if (!allCovered) warnings.push('Profit is withheld for branches with missing opening inventory cost, untraceable meter-to-tank mapping, stock deficits, or reporting-source row caps. Verify opening costs and reconcile inventory before relying on gross or net operating profit.');
      warnings.push('Cost of goods sold is replayed using a moving weighted-average inventory cost across recorded deliveries, approved meter sales and stock-adjustment movements. This remains an operational estimate, not a substitute for reviewed statutory accounts. Only approved operating expenses and approved payroll are included; payroll cost is accrued proportionally across the recorded service period, while payment status is tracked separately.');
      if ([tanksResult, deliveriesResult, nozzlesResult, litreResult, kgResult, expensesResult, payrollResult].some(x => x.truncated)) warnings.push('A source reached the 100,000-row safety cap; narrow the reporting period before relying on totals.');
      res.json({data:{from,to,branches,totals,costCoverageComplete:allCovered,costingMethod:'period_weighted_average',currency:reportCurrency,warnings}});
    } catch (e) { next(e); }
  });

  r.get('/expenses', async (req, res, next) => {
    try {
      const leader = await companyLeadership(req);
      if (!leader) return res.status(403).json({error:{code:'FORBIDDEN',message:'Company owner or director access is required to review expenses.'}});
      const q = await req.supabase.from('operating_expenses').select('*,stations(name)').eq('company_id',leader.company_id).order('incurred_on',{ascending:false}).limit(500);
      if (q.error) throw q.error;
      res.json({data:q.data||[]});
    } catch(e) { next(e); }
  });

  r.post('/expenses', async (req, res, next) => {
    try {
      const p = z.object({stationId:z.string().uuid(),category:z.enum(['utilities','staff','maintenance','security','transport','bank_charges','rent','taxes','generator_fuel','licenses','office_supplies','insurance','communications','staff_welfare','professional_fees','repairs','other']),description:z.string().trim().min(3).max(500),amount:z.coerce.number().positive().max(100000000000),incurredOn:z.string().regex(datePattern),reference:z.string().trim().min(2).max(100)}).safeParse(req.body);
      if (!p.success) return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Enter a valid branch, category, date, amount, description and supporting reference.'}});
      if (!validDateRange(p.data.incurredOn, p.data.incurredOn)) return res.status(400).json({error:{code:'INVALID_DATE',message:'Enter a real expense date in YYYY-MM-DD format.'}});
      const stationQ=await req.supabase.from('stations').select('id,company_id').eq('id',p.data.stationId).maybeSingle();
      if(stationQ.error)throw stationQ.error;
      if(!stationQ.data)return res.status(404).json({error:{code:'NOT_FOUND',message:'Branch not found.'}});
      const [leaderQ,memberQ]=await Promise.all([
        req.supabase.from('company_members').select('role,status').eq('company_id',stationQ.data.company_id).eq('user_id',req.user.id).eq('status','active').in('role',['COMPANY_OWNER','COMPANY_ADMIN']).maybeSingle(),
        req.supabase.from('station_members').select('role,status').eq('station_id',p.data.stationId).eq('user_id',req.user.id).eq('status','active').eq('role','STATION_MANAGER').maybeSingle()
      ]);
      if(leaderQ.error)throw leaderQ.error;if(memberQ.error)throw memberQ.error;
      if(!leaderQ.data&&!memberQ.data)return res.status(403).json({error:{code:'FORBIDDEN',message:'Only company leadership or the assigned branch manager can submit a branch expense.'}});
      const q=await req.supabase.from('operating_expenses').insert({company_id:stationQ.data.company_id,station_id:p.data.stationId,category:p.data.category,description:p.data.description,amount:p.data.amount,incurred_on:p.data.incurredOn,reference:p.data.reference,requested_by:req.user.id,status:'pending'}).select('*').single();
      if(q.error)throw q.error;
      res.status(201).json({data:q.data,message:'Expense submitted for independent review. It is excluded from profit and loss until approved.'});
    } catch(e) { next(e); }
  });

  r.post('/expenses/:id/review', async (req, res, next) => {
    try {
      const p=z.object({approve:z.boolean(),note:z.string().trim().max(500).optional()}).safeParse(req.body);
      if(!p.success)return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Choose approve or reject and optionally provide a review note.'}});
      const leader=await companyLeadership(req);
      if(!leader)return res.status(403).json({error:{code:'FORBIDDEN',message:'Only a company owner or director can review expenses.'}});
      const existing=await req.supabase.from('operating_expenses').select('id,company_id,status,requested_by').eq('id',req.params.id).eq('company_id',leader.company_id).maybeSingle();
      if(existing.error)throw existing.error;
      if(!existing.data)return res.status(404).json({error:{code:'NOT_FOUND',message:'Expense not found in this company.'}});
      if(existing.data.status!=='pending')return res.status(409).json({error:{code:'ALREADY_REVIEWED',message:'This expense has already been reviewed.'}});
      if(existing.data.requested_by===req.user.id)return res.status(409).json({error:{code:'SELF_APPROVAL_NOT_ALLOWED',message:'The expense submitter cannot approve their own expense.'}});
      const q=await req.supabase.from('operating_expenses').update({status:p.data.approve?'approved':'rejected',reviewed_by:req.user.id,reviewed_at:new Date().toISOString(),review_note:p.data.note||null}).eq('id',req.params.id).eq('company_id',leader.company_id).eq('status','pending').select('*').maybeSingle();
      if(q.error)throw q.error;
      if(!q.data)return res.status(409).json({error:{code:'ALREADY_REVIEWED',message:'Expense status changed before this review could be saved.'}});
      res.json({data:q.data});
    } catch(e) { next(e); }
  });

  r.get('/daily-closing-report', async (req, res, next) => {
    try {
      const date = String(req.query.date || '');

      if (
        !datePattern.test(date) ||
        !Number.isFinite(
          new Date(`${date}T00:00:00Z`).getTime()
        ) ||
        new Date(`${date}T00:00:00Z`)
          .toISOString()
          .slice(0, 10) !== date
      ) {
        return res.status(400).json({
          error: {
            code: 'INVALID_DATE',
            message:
              'Provide a valid report date in YYYY-MM-DD format.',
          },
        });
      }

      const owner = await companyLeadership(req);

      if (!owner) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message:
              'Only an active company owner or director can view the consolidated daily closing report.',
          },
        });
      }

      const stationsResult = await req.supabase
        .from('stations')
        .select('id,name,address,status')
        .eq('company_id', owner.company_id)
        .order('name');

      if (stationsResult.error) throw stationsResult.error;

      const stations = stationsResult.data || [];

      if (!stations.length) {
        return res.json({
          data: {
            date,
            branches: [],
            totals: {
              shifts: 0,
              openShifts: 0,
              closedUnreconciled: 0,
              reconciledShifts: 0,
              expectedSales: 0,
              collections: 0,
              salesVariance: 0,
              cashVariance: 0,
            },
            note: 'No branches are configured for this company.',
          },
        });
      }

      const ids = stations.map((station) => station.id);
      const start = `${date}T00:00:00.000Z`;
      const end = new Date(
        new Date(`${date}T00:00:00.000Z`).getTime() +
          86400000
      ).toISOString();

      const managerCloseResult = await req.supabase
        .from('station_daily_closing_reviews')
        .select(
          'id,station_id,business_date,status,submitted_by,submitted_at,manager_note,summary,reviewed_by,reviewed_at,review_note'
        )
        .in('station_id', ids)
        .eq('business_date', date)
        .order('submitted_at', { ascending: false });

      if (managerCloseResult.error) throw managerCloseResult.error;

      // PostgREST commonly caps a response at 1,000 rows. Page explicitly so
      // the daily report does not silently omit shifts on busy branches.
      const pageSize = 1000;
      const maxRows = 100000;
      const shiftRows = [];
      let shiftsTruncated = false;

      for (let offset = 0; offset < maxRows; offset += pageSize) {
        const result = await req.supabase
          .from('station_cash_shifts')
          .select(
            'id,station_id,cashier_user_id,status,opened_at,closed_at,opening_float,counted_cash,variance'
          )
          .in('station_id', ids)
          .gte('opened_at', start)
          .lt('opened_at', end)
          .order('opened_at', { ascending: true })
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (result.error) throw result.error;
        const page = result.data || [];
        shiftRows.push(...page);
        if (page.length < pageSize) break;
        if (offset + pageSize >= maxRows) shiftsTruncated = true;
      }

      // Reconciliations are keyed to the shifts in this report. Fetching every
      // reconciliation for every branch (then taking an arbitrary 10,000) can
      // associate old records with today's report and silently lose recent data.
      const recRows = [];
      const shiftIds = shiftRows.map((shift) => shift.id);
      for (let i = 0; i < shiftIds.length; i += 500) {
        const chunk = shiftIds.slice(i, i + 500);
        for (let offset = 0; offset < maxRows; offset += pageSize) {
          const result = await req.supabase
            .from('station_shift_reconciliations')
            .select(
              'id,station_id,cash_shift_id,expected_sales,collected_total,sales_variance,cash_variance,status,reconciled_by,reconciled_at,notes,handover_note'
            )
            .in('cash_shift_id', chunk)
            .order('reconciled_at', { ascending: false })
            .range(offset, offset + pageSize - 1);

          if (result.error) throw result.error;
          const page = result.data || [];
          recRows.push(...page);
          if (page.length < pageSize) break;
          if (offset + pageSize >= maxRows) {
            throw new Error('REPORT_RESULT_LIMIT_EXCEEDED: reconciliation rows');
          }
        }
      }

      const managerCloses = new Map(
        (managerCloseResult.data || []).map((item) => [item.station_id, item])
      );
      // Rows are ordered newest-first. Keep the first row for each shift so
      // duplicate historical reconciliations cannot overwrite the latest one.
      const recs = new Map();
      for (const item of recRows) {
        if (!recs.has(item.cash_shift_id)) recs.set(item.cash_shift_id, item);
      }

      const branches = stations.map((st) => {
        const shifts = shiftRows
          .filter((shift) => shift.station_id === st.id)
          .map((shift) => {
            const reconciliation = recs.get(shift.id) || null;

            const closingState =
              shift.status === 'open'
                ? 'open'
                : reconciliation
                  ? 'reconciled'
                  : 'closed_unreconciled';

            return {
              shiftId: shift.id,
              cashierUserId: shift.cashier_user_id,
              status: shift.status,
              openedAt: shift.opened_at,
              closedAt: shift.closed_at,
              openingFloat: Number(shift.opening_float || 0),
              countedCash:
                shift.counted_cash == null
                  ? null
                  : Number(shift.counted_cash),
              shiftCashVariance:
                shift.variance == null
                  ? null
                  : Number(shift.variance),
              closingState,

              reconciliation: reconciliation
                ? {
                    id: reconciliation.id,
                    expectedSales: Number(
                      reconciliation.expected_sales || 0
                    ),
                    collections: Number(
                      reconciliation.collected_total || 0
                    ),
                    salesVariance: Number(
                      reconciliation.sales_variance || 0
                    ),
                    cashVariance: Number(
                      reconciliation.cash_variance || 0
                    ),
                    status: reconciliation.status,
                    reconciledBy: reconciliation.reconciled_by,
                    reconciledAt: reconciliation.reconciled_at,
                    handoverNote:
                      reconciliation.handover_note ?? reconciliation.notes ?? null,
                  }
                : null,
            };
          });

        return {
          stationId: st.id,
          branch: st.name,
          address: st.address,
          status: st.status,
          dailyCloseSubmission:
            managerCloses.get(st.id) || null,
          shifts,
          shiftCount: shifts.length,
          openShifts: shifts.filter(
            (shift) => shift.closingState === 'open'
          ).length,
          closedUnreconciled: shifts.filter(
            (shift) =>
              shift.closingState === 'closed_unreconciled'
          ).length,
          reconciledShifts: shifts.filter(
            (shift) => shift.closingState === 'reconciled'
          ).length,
          expectedSales: shifts.reduce(
            (total, shift) =>
              total +
              (shift.reconciliation?.expectedSales || 0),
            0
          ),
          collections: shifts.reduce(
            (total, shift) =>
              total +
              (shift.reconciliation?.collections || 0),
            0
          ),
          salesVariance: shifts.reduce(
            (total, shift) =>
              total +
              (shift.reconciliation?.salesVariance || 0),
            0
          ),
          cashVariance: shifts.reduce(
            (total, shift) =>
              total +
              (shift.reconciliation?.cashVariance || 0),
            0
          ),
        };
      });

      const totals = branches.reduce(
        (acc, branch) => {
          for (const key of [
            'openShifts',
            'closedUnreconciled',
            'reconciledShifts',
            'expectedSales',
            'collections',
            'salesVariance',
            'cashVariance',
          ]) {
            acc[key] += branch[key] || 0;
          }

          acc.shifts += branch.shiftCount || 0;

          return acc;
        },
        {
          shifts: 0,
          openShifts: 0,
          closedUnreconciled: 0,
          reconciledShifts: 0,
          expectedSales: 0,
          collections: 0,
          salesVariance: 0,
          cashVariance: 0,
        }
      );

      return res.json({
        data: {
          date,
          branches,
          totals,
          warnings: shiftsTruncated
            ? ['The report reached the 100,000-shift safety cap. Narrow the date scope before relying on totals.']
            : [],
          note:
            'Shifts are grouped by opening date. Open shifts are not finalized. A closed shift without a saved reconciliation is outstanding. Variances are review signals and require human investigation; this report does not automatically close shifts or post accounting entries.',
        },
      });
    } catch (e) {
      next(e);
    }
  });

  r.post('/daily-closing-review/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id || '');

      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_ID',
            message: 'Select a valid daily closing submission.',
          },
        });
      }

      const body = z
        .object({
          approve: z.boolean(),
          note: z.string().trim().max(1500).optional(),
        })
        .safeParse(req.body);

      if (!body.success) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'Choose approve or reject and provide an optional review note.',
          },
        });
      }

      const owner = await companyLeadership(req);

      if (!owner) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message:
              'Only an active company owner or director can review branch daily closes.',
          },
        });
      }

      const q = await req.supabase
        .from('station_daily_closing_reviews')
        .select('id,company_id,station_id,status,business_date')
        .eq('id', id)
        .eq('company_id', owner.company_id)
        .maybeSingle();

      if (q.error) throw q.error;

      if (!q.data) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message:
              'Daily closing submission not found in your company.',
          },
        });
      }

      if (q.data.status !== 'submitted') {
        return res.status(409).json({
          error: {
            code: 'ALREADY_REVIEWED',
            message:
              'This submission has already been reviewed. A new manager submission is required to change it.',
          },
        });
      }

      const update = await req.supabase
        .from('station_daily_closing_reviews')
        .update({
          status: body.data.approve ? 'approved' : 'rejected',
          reviewed_by: req.user.id,
          reviewed_at: new Date().toISOString(),
          review_note: body.data.note || null,
        })
        .eq('id', id)
        .eq('company_id', owner.company_id)
        .eq('status', 'submitted')
        .select('*')
        .maybeSingle();

      if (update.error) throw update.error;

      if (!update.data) {
        return res.status(409).json({
          error: {
            code: 'ALREADY_REVIEWED',
            message:
              'This submission was reviewed by another action.',
          },
        });
      }

      const ae = await req.supabase
        .from('audit_events')
        .insert({
          company_id: owner.company_id,
          station_id: q.data.station_id,
          actor_user_id: req.user.id,
          action: body.data.approve
            ? 'BRANCH_DAILY_CLOSE_APPROVED'
            : 'BRANCH_DAILY_CLOSE_REJECTED',
          entity_type: 'station_daily_closing_review',
          entity_id: id,
          metadata: {
            businessDate: q.data.business_date,
            note: body.data.note || null,
          },
        });

      if (ae.error) throw ae.error;

      return res.json({ data: update.data });
    } catch (e) {
      next(e);
    }
  });

  r.get('/audit', async (req, res, next) => {
    try {
      const from = req.query.from
        ? String(req.query.from)
        : null;
      const to = req.query.to ? String(req.query.to) : null;

      if ((from || to) && !validDateRange(from, to)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_DATE_RANGE',
            message:
              'Provide valid from/to dates covering no more than 367 calendar days.',
          },
        });
      }

      const membership = await companyLeadership(req);

      if (!membership) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message:
              'Company owner access is required to view the company-wide audit trail.',
          },
        });
      }

      let eq = req.supabase
        .from('audit_events')
        .select(
          'id,station_id,actor_user_id,action,entity_type,entity_id,metadata,created_at'
        )
        .eq('company_id', membership.company_id)
        .order('created_at', { ascending: false })
        .limit(500);

      if (from && to) {
        eq = inRange(eq, 'created_at', from, to);
      }

      const [events, stations] = await Promise.all([
        eq,
        req.supabase
          .from('stations')
          .select('id,name')
          .eq('company_id', membership.company_id),
      ]);

      if (events.error) throw events.error;
      if (stations.error) throw stations.error;

      const names = new Map(
        (stations.data || []).map((station) => [
          station.id,
          station.name,
        ])
      );

      return res.json({
        data: {
          events: (events.data || []).map((event) => ({
            ...event,
            station_name:
              names.get(event.station_id) || 'Company-wide',
          })),
          count: (events.data || []).length,
          from,
          to,
          limit: 500,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  r.post('/', async (req, res, next) => {
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Company name must contain 2–160 characters.',
        },
      });
    }

    try {
      const {
        data: existing,
        error: lookupError,
      } = await req.supabase
        .from('company_members')
        .select('company_id')
        .eq('user_id', req.user.id)
        .eq('status', 'active')
        .limit(1);

      if (lookupError) throw lookupError;

      if (existing?.length) {
        return res.status(409).json({
          error: {
            code: 'COMPANY_ALREADY_EXISTS',
            message:
              'Your account already belongs to an active company.',
          },
        });
      }

      const q = await req.supabase.rpc(
        'bootstrap_company_owner',
        {
          p_user_id: req.user.id,
          p_company_name: parsed.data.name,
          p_company_currency: parsed.data.currency,
        }
      );

      if (q.error) throw q.error;

      return res.status(201).json({ data: q.data });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
