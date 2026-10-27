import { Router } from 'express';
import { z } from 'zod';

const uuid = z.string().uuid();

const stationSchema = z.object({
  stationId: uuid,
});

const dipSchema = z.object({
  stationId: uuid,
  tankId: uuid,
  measuredStockLitres: z.coerce
    .number()
    .min(0, 'Measured stock cannot be negative')
    .max(100000000, 'Measured stock is too large'),
  measurementMethod: z
    .enum(['dip_stick', 'electronic_gauge', 'manual_estimate'])
    .default('dip_stick'),
  notes: z.string().max(1000).optional(),
});

/*
 * IMPORTANT FIX:
 *
 * .min() and .max() must be applied to the Zod number schema
 * before .refine().
 *
 * Calling .refine() first changes the schema type and, with the
 * Zod version used by this project, .min()/.max() are no longer
 * available afterwards.
 */
const kgAdjustmentSchema = z.object({ stationId: uuid, tankId: uuid, quantityDeltaKg: z.coerce.number().min(-100000000).max(100000000).refine(value => value !== 0), reason: z.string().trim().min(5).max(500), reference: z.string().max(100).optional() });

const adjustmentSchema = z.object({
  stationId: uuid,
  tankId: uuid,
  quantityDeltaLitres: z.coerce
    .number()
    .min(-100000000, 'Adjustment is too small')
    .max(100000000, 'Adjustment is too large')
    .refine(
      (value) => value !== 0,
      'Adjustment cannot be zero'
    ),
  reason: z.string().trim().min(5).max(500),
  reference: z.string().max(100).optional(),
});

const reviewSchema = z.object({
  stationId: uuid,
  approve: z.boolean(),
  note: z.string().max(1000).optional(),
});

const openShiftSchema = z.object({
  stationId: uuid,
  cashierUserId: uuid,
  openingFloat: z.coerce
    .number()
    .min(0)
    .max(100000000),
});

const closeShiftSchema = z.object({
  stationId: uuid,
  countedCash: z.coerce
    .number()
    .min(0)
    .max(1000000000),
  notes: z.string().max(1000).optional(),
});

function fail(res, status, code, message) {
  return res.status(status).json({
    error: {
      code,
      message,
    },
  });
}

async function access(req, stationId) {
  const {
    data: station,
    error,
  } = await req.supabase
    .from('stations')
    .select('id,company_id,name')
    .eq('id', stationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!station) {
    return {
      missing: true,
    };
  }

  const [
    {
      data: cm,
      error: ce,
    },
    {
      data: sm,
      error: se,
    },
  ] = await Promise.all([
    req.supabase
      .from('company_members')
      .select('role,status')
      .eq('company_id', station.company_id)
      .eq('user_id', req.user.id)
      .maybeSingle(),

    req.supabase
      .from('station_members')
      .select('role,status')
      .eq('station_id', stationId)
      .eq('user_id', req.user.id)
      .maybeSingle(),
  ]);

  if (ce) {
    throw ce;
  }

  if (se) {
    throw se;
  }

  const owner =
    ['COMPANY_OWNER', 'COMPANY_ADMIN'].includes(cm?.role) &&
    cm?.status === 'active';

  const manager =
    sm?.role === 'STATION_MANAGER' &&
    sm?.status === 'active';

  const attendant =
    sm?.role === 'ATTENDANT' &&
    sm?.status === 'active';

  return {
    station,
    owner,
    manager,
    attendant,
    canManage: owner || manager,
  };
}

async function checked(req, res, stationId, write = false) {
  const a = await access(req, stationId);

  if (a.missing) {
    fail(
      res,
      404,
      'NOT_FOUND',
      'Station not found.'
    );

    return null;
  }

  if (!(a.owner || a.manager || a.attendant)) {
    fail(
      res,
      403,
      'FORBIDDEN',
      'You are not assigned to this station.'
    );

    return null;
  }

  if (write && !a.canManage) {
    fail(
      res,
      403,
      'FORBIDDEN',
      'Only a station manager or company owner can perform this action.'
    );

    return null;
  }

  return a;
}

async function audit(
  req,
  a,
  action,
  type,
  id,
  metadata = {}
) {
  const { error } = await req.supabase
    .from('audit_events')
    .insert({
      company_id: a.station.company_id,
      station_id: a.station.id,
      actor_user_id: req.user.id,
      action,
      entity_type: type,
      entity_id: String(id),
      metadata,
    });

  if (error) {
    throw error;
  }
}

function handle(next, error) {
  next(error);
}

export default function controlsRoutes() {
  const r = Router();

  /*
   * GET CONTROL DATA
   */
  r.get(
    '/',
    async (req, res, next) => {
      const parsed = stationSchema.safeParse({
        stationId: req.query.stationId,
      });

      if (!parsed.success) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Select a valid station.'
        );
      }

      try {
        const a = await checked(
          req,
          res,
          parsed.data.stationId
        );

        if (!a) {
          return;
        }

        const sid = parsed.data.stationId;

        const names = [
          'tank_dip_readings',
          'stock_adjustment_requests',
          'tank_stock_movements',
          'station_cash_shifts',
          'station_shift_reconciliations',
          'kg_stock_adjustment_requests',
          'kg_tank_stock_movements',
        ];

        const results = await Promise.all(
          names.map((table) => {
            let query = req.supabase
              .from(table)
              .select('*')
              .eq('station_id', sid);

            /*
             * Attendants can only see their own operational records.
             */
            if (
              a.attendant &&
              !a.owner &&
              !a.manager
            ) {
              if (table === 'station_cash_shifts') {
                query = query.eq(
                  'cashier_user_id',
                  req.user.id
                );
              }

              if (table === 'tank_dip_readings') {
                query = query.eq(
                  'measured_by',
                  req.user.id
                );
              }

              if (
                table ===
                'stock_adjustment_requests'
              ) {
                query = query.eq(
                  'requested_by',
                  req.user.id
                );
              }

              if (table === 'kg_stock_adjustment_requests') { query = query.eq('requested_by', req.user.id); }
              if (table === 'kg_tank_stock_movements') { query = query.eq('created_by', req.user.id); }
              if (
                table ===
                'tank_stock_movements'
              ) {
                query = query.eq(
                  'created_by',
                  req.user.id
                );
              }
            }

            const orderColumn =
              table === 'station_cash_shifts'
                ? 'opened_at'
                : table === 'tank_dip_readings'
                  ? 'measured_at'
                  : table ===
                      'tank_stock_movements'
                    ? 'created_at'
                    : table ===
                        'station_shift_reconciliations'
                      ? 'reconciled_at'
                      : table === 'kg_tank_stock_movements' ? 'created_at' : 'requested_at';

            return query
              .order(orderColumn, {
                ascending: false,
              })
              .limit(100);
          })
        );

        const bad = results.find(
          (result) => result.error
        );

        if (bad) {
          throw bad.error;
        }

        const data = Object.fromEntries(
          names.map((name, index) => [
            name,
            results[index].data || [],
          ])
        );

        /*
         * Attendants can only see reconciliations belonging
         * to their own cash shifts.
         */
        if (
          a.attendant &&
          !a.owner &&
          !a.manager
        ) {
          const ownShiftIds = new Set(
            (data.station_cash_shifts || []).map(
              (shift) => shift.id
            )
          );

          data.station_shift_reconciliations =
            (
              data.station_shift_reconciliations ||
              []
            ).filter((reconciliation) =>
              ownShiftIds.has(
                reconciliation.cash_shift_id
              )
            );
        }

        res.json({
          data: { ...data, permissions: { canManage: a.canManage, isOwner: a.owner } },
        });
      } catch (error) {
        handle(next, error);
      }
    }
  );

  /*
   * RECORD TANK DIP
   */
  r.post(
    '/tank-dips',
    async (req, res, next) => {
      const parsed = dipSchema.safeParse(req.body);

      if (!parsed.success) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Enter a valid tank, measured litres and measurement method.'
        );
      }

      try {
        const a = await checked(
          req,
          res,
          parsed.data.stationId,
          true
        );

        if (!a) {
          return;
        }

        const {
          data: tank,
          error: tankError,
        } = await req.supabase
          .from('station_tanks')
          .select(
            'id,capacity_litres,opening_stock_litres'
          )
          .eq('id', parsed.data.tankId)
          .eq(
            'station_id',
            parsed.data.stationId
          )
          .maybeSingle();

        if (tankError) {
          throw tankError;
        }

        if (!tank) {
          return fail(
            res,
            400,
            'INVALID_TANK',
            'Choose a tank at this station.'
          );
        }

        if (
          parsed.data.measuredStockLitres >
          Number(tank.capacity_litres)
        ) {
          return fail(
            res,
            400,
            'DIP_EXCEEDS_CAPACITY',
            'Measured stock cannot exceed the tank capacity.'
          );
        }

        const {
          data: book,
          error: bookError,
        } = await req.supabase.rpc(
          'calculate_tank_book_stock',
          {
            p_tank_id: tank.id,
          }
        );

        if (bookError) {
          throw bookError;
        }

        if (
          book === null ||
          book === undefined
        ) {
          throw new Error(
            'TANK_STOCK_POSITION_UNAVAILABLE'
          );
        }

        const row = {
          station_id:
            parsed.data.stationId,

          tank_id:
            parsed.data.tankId,

          measured_stock_litres:
            parsed.data.measuredStockLitres,

          book_stock_litres:
            Number(book.toFixed(2)),

          variance_litres:
            Number(
              (
                parsed.data.measuredStockLitres -
                book
              ).toFixed(2)
            ),

          measurement_method:
            parsed.data.measurementMethod,

          measured_by:
            req.user.id,

          notes:
            parsed.data.notes || null,
        };

        const result = await req.supabase
          .from('tank_dip_readings')
          .insert(row)
          .select('*')
          .single();

        if (result.error) {
          throw result.error;
        }

        await audit(
          req,
          a,
          'TANK_DIP_RECORDED',
          'tank_dip_reading',
          result.data.id,
          {
            varianceLitres:
              result.data.variance_litres,
          }
        );

        res.status(201).json({
          data: result.data,
        });
      } catch (error) {
        handle(next, error);
      }
    }
  );

  /*
   * REQUEST STOCK ADJUSTMENT
   */
  r.post(
    '/stock-adjustments',
    async (req, res, next) => {
      const parsed =
        adjustmentSchema.safeParse(req.body);

      if (!parsed.success) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Enter a non-zero adjustment and explain the reason (at least five characters).'
        );
      }

      try {
        const a = await checked(
          req,
          res,
          parsed.data.stationId,
          true
        );

        if (!a) {
          return;
        }

        const {
          data: tank,
          error: tankError,
        } = await req.supabase
          .from('station_tanks')
          .select('id')
          .eq(
            'id',
            parsed.data.tankId
          )
          .eq(
            'station_id',
            parsed.data.stationId
          )
          .maybeSingle();

        if (tankError) {
          throw tankError;
        }

        if (!tank) {
          return fail(
            res,
            400,
            'INVALID_TANK',
            'Choose a tank at this station.'
          );
        }

        const result = await req.supabase
          .from('stock_adjustment_requests')
          .insert({
            station_id:
              parsed.data.stationId,

            tank_id:
              parsed.data.tankId,

            quantity_delta_litres:
              parsed.data.quantityDeltaLitres,

            reason:
              parsed.data.reason,

            reference:
              parsed.data.reference || null,

            requested_by:
              req.user.id,
          })
          .select('*')
          .single();

        if (result.error) {
          throw result.error;
        }

        await audit(
          req,
          a,
          'STOCK_ADJUSTMENT_REQUESTED',
          'stock_adjustment_request',
          result.data.id,
          {
            quantityDeltaLitres:
              result.data
                .quantity_delta_litres,
          }
        );

        res.status(201).json({
          data: result.data,
        });
      } catch (error) {
        handle(next, error);
      }
    }
  );

  r.post('/kg-stock-adjustments', async (req, res, next) => {
    const parsed = kgAdjustmentSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter a non-zero kilogram adjustment and explain the reason.');
    try {
      const a = await checked(req, res, parsed.data.stationId, true); if (!a) return;
      const { data: tank, error: te } = await req.supabase.from('station_tanks').select('id,unit_of_measure').eq('id', parsed.data.tankId).eq('station_id', parsed.data.stationId).maybeSingle();
      if (te) throw te;
      if (!tank) return fail(res, 404, 'INVALID_TANK', 'Choose a tank at this station.');
      if (tank.unit_of_measure !== 'kg') return fail(res, 409, 'FUEL_UNIT_MISMATCH', 'This workflow is only for kilogram tanks.');
      const result = await req.supabase.from('kg_stock_adjustment_requests').insert({station_id: parsed.data.stationId, tank_id: parsed.data.tankId, quantity_delta_kg: parsed.data.quantityDeltaKg, reason: parsed.data.reason, reference: parsed.data.reference || null, requested_by: req.user.id}).select('*').single();
      if (result.error) throw result.error;
      await audit(req, a, 'KG_STOCK_ADJUSTMENT_REQUESTED', 'kg_stock_adjustment_request', result.data.id, {quantityDeltaKg: result.data.quantity_delta_kg});
      res.status(201).json({data: result.data});
    } catch (error) { handle(next, error); }
  });

  r.post('/kg-stock-adjustments/:id/review', async (req, res, next) => {
    const id = uuid.safeParse(req.params.id); const parsed = reviewSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Provide a valid request ID and review decision.');
    try {
      const a = await checked(req, res, parsed.data.stationId, true); if (!a) return;
      if (!a.owner) return fail(res, 403, 'OWNER_APPROVAL_REQUIRED', 'Only an active company owner or director can approve kilogram stock adjustments.');
      const result = await req.supabase.rpc('review_kg_stock_adjustment', {p_request_id: id.data, p_reviewer: req.user.id, p_approve: parsed.data.approve, p_note: parsed.data.note || null});
      if (result.error) {
        const m = String(result.error.message || '');
        if (m.includes('SELF_APPROVAL_NOT_ALLOWED')) return fail(res, 409, 'SELF_APPROVAL_NOT_ALLOWED', 'The requester cannot approve their own adjustment.');
        if (m.includes('KG_ADJUSTMENT_ALREADY_REVIEWED')) return fail(res, 409, 'ALREADY_REVIEWED', 'This adjustment has already been reviewed.');
        if (m.includes('ADJUSTMENT_NEGATIVE_STOCK')) return fail(res, 409, 'NEGATIVE_STOCK', 'This adjustment would make estimated kilogram stock negative.');
        if (m.includes('ADJUSTMENT_EXCEEDS_CAPACITY')) return fail(res, 409, 'CAPACITY_EXCEEDED', 'This adjustment would exceed tank capacity.');
        throw result.error;
      }
      await audit(req, a, parsed.data.approve ? 'KG_STOCK_ADJUSTMENT_APPROVED' : 'KG_STOCK_ADJUSTMENT_REJECTED', 'kg_stock_adjustment_request', id.data, {note: parsed.data.note || null});
      res.json({data: result.data});
    } catch (error) { handle(next, error); }
  });

  /*
   * REVIEW STOCK ADJUSTMENT
   */
  r.post(
    '/stock-adjustments/:id/review',
    async (req, res, next) => {
      const id = uuid.safeParse(
        req.params.id
      );

      const parsed =
        reviewSchema.safeParse(req.body);

      if (
        !id.success ||
        !parsed.success
      ) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Provide a valid request ID and review decision.'
        );
      }

      try {
        const a = await checked(
          req,
          res,
          parsed.data.stationId,
          true
        );

        if (!a) {
          return;
        }

        if (!a.owner) {
          return fail(
            res,
            403,
            'OWNER_APPROVAL_REQUIRED',
            'A company owner/admin must approve or reject stock adjustments.'
          );
        }

        const result =
          await req.supabase.rpc(
            'review_stock_adjustment',
            {
              p_request_id: id.data,
              p_reviewer: req.user.id,
              p_approve:
                parsed.data.approve,
              p_note:
                parsed.data.note || null,
            }
          );

        if (result.error) {
          const message = String(
            result.error.message || ''
          );

          if (
            message.includes(
              'SELF_APPROVAL_NOT_ALLOWED'
            )
          ) {
            return fail(
              res,
              409,
              'SELF_APPROVAL_NOT_ALLOWED',
              'The person who requested an adjustment cannot approve it.'
            );
          }

          if (
            message.includes(
              'ADJUSTMENT_ALREADY_REVIEWED'
            )
          ) {
            return fail(
              res,
              409,
              'ALREADY_REVIEWED',
              'This adjustment has already been reviewed.'
            );
          }

          if (
            message.includes(
              'ADJUSTMENT_NEGATIVE_STOCK'
            )
          ) {
            return fail(
              res,
              409,
              'NEGATIVE_STOCK',
              'This adjustment would make estimated stock negative.'
            );
          }

          if (
            message.includes(
              'ADJUSTMENT_EXCEEDS_CAPACITY'
            )
          ) {
            return fail(
              res,
              409,
              'CAPACITY_EXCEEDED',
              'This adjustment would exceed tank capacity.'
            );
          }

          throw result.error;
        }

        await audit(
          req,
          a,
          parsed.data.approve
            ? 'STOCK_ADJUSTMENT_APPROVED'
            : 'STOCK_ADJUSTMENT_REJECTED',
          'stock_adjustment_request',
          id.data,
          {
            note:
              parsed.data.note || null,
          }
        );

        res.json({
          data: result.data,
        });
      } catch (error) {
        handle(next, error);
      }
    }
  );

  /*
   * OPEN CASH SHIFT
   */
  r.post(
    '/cash-shifts/open',
    async (req, res, next) => {
      const parsed =
        openShiftSchema.safeParse(req.body);

      if (!parsed.success) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Select the cashier and enter a valid opening float.'
        );
      }

      try {
        const a = await checked(
          req,
          res,
          parsed.data.stationId
        );

        if (!a) {
          return;
        }

        /*
         * Existing authorization logic preserved:
         * managers/owners can open a shift for another
         * eligible cashier; attendants can only open
         * their own.
         */
        if (
          !a.canManage &&
          parsed.data.cashierUserId !==
            req.user.id
        ) {
          return fail(
            res,
            403,
            'CASHIER_ASSIGNMENT_FORBIDDEN',
            'Only an owner or station manager can open a shift for another cashier.'
          );
        }

        const [
          {
            data: member,
            error: memberError,
          },
          {
            data: companyMember,
            error: companyMemberError,
          },
        ] = await Promise.all([
          req.supabase
            .from('station_members')
            .select(
              'user_id,status'
            )
            .eq(
              'station_id',
              parsed.data.stationId
            )
            .eq(
              'user_id',
              parsed.data
                .cashierUserId
            )
            .eq(
              'status',
              'active'
            )
            .maybeSingle(),

          req.supabase
            .from('company_members')
            .select(
              'user_id,status'
            )
            .eq(
              'company_id',
              a.station.company_id
            )
            .eq(
              'user_id',
              parsed.data
                .cashierUserId
            )
            .eq(
              'status',
              'active'
            )
            .maybeSingle(),
        ]);

        if (memberError) {
          throw memberError;
        }

        if (companyMemberError) {
          throw companyMemberError;
        }

        if (
          !member &&
          !companyMember
        ) {
          return fail(
            res,
            400,
            'INVALID_CASHIER',
            'Cashier must be an active member of this station or company.'
          );
        }

        const result = await req.supabase
          .from('station_cash_shifts')
          .insert({
            station_id:
              parsed.data.stationId,

            cashier_user_id:
              parsed.data.cashierUserId,

            opened_by:
              req.user.id,

            opening_float:
              parsed.data.openingFloat,
          })
          .select('*')
          .single();

        if (result.error) {
          if (
            String(result.error.code) ===
            '23505'
          ) {
            return fail(
              res,
              409,
              'SHIFT_ALREADY_OPEN',
              'This cashier already has an open shift at this station.'
            );
          }

          throw result.error;
        }

        await audit(
          req,
          a,
          'CASH_SHIFT_OPENED',
          'station_cash_shift',
          result.data.id,
          {
            cashierUserId:
              parsed.data
                .cashierUserId,

            openingFloat:
              parsed.data
                .openingFloat,
          }
        );

        res.status(201).json({
          data: result.data,
        });
      } catch (error) {
        handle(next, error);
      }
    }
  );

  /*
   * CLOSE CASH SHIFT
   */
  r.post(
    '/cash-shifts/:id/close',
    async (req, res, next) => {
      const id = uuid.safeParse(
        req.params.id
      );

      const parsed =
        closeShiftSchema.safeParse(
          req.body
        );

      if (
        !id.success ||
        !parsed.success
      ) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Enter a valid shift ID and counted cash.'
        );
      }

      try {
        const a = await checked(
          req,
          res,
          parsed.data.stationId
        );

        if (!a) {
          return;
        }

        const {
          data: shift,
          error: shiftError,
        } = await req.supabase
          .from('station_cash_shifts')
          .select('*')
          .eq('id', id.data)
          .eq(
            'station_id',
            parsed.data.stationId
          )
          .maybeSingle();

        if (shiftError) {
          throw shiftError;
        }

        if (!shift) {
          return fail(
            res,
            404,
            'SHIFT_NOT_FOUND',
            'Cash shift not found.'
          );
        }

        if (
          !a.owner &&
          shift.cashier_user_id !==
            req.user.id
        ) {
          return fail(
            res,
            403,
            'CASHIER_ONLY_CLOSE',
            'Only the assigned cashier or company owner can close this shift.'
          );
        }

        // Do not finalize a shift while its opening or closing meter submissions
        // are still awaiting manager review. A rejected record must be corrected
        // before the shift can be closed and reconciled.
        const [pendingOpenings, pendingLitres, pendingKg, roster, approvedOpenings] = await Promise.all([
          req.supabase.from('shift_meter_openings').select('id').eq('station_id', parsed.data.stationId).eq('cash_shift_id', id.data).eq('status', 'pending').limit(1),
          req.supabase.from('nozzle_meter_readings').select('id').eq('station_id', parsed.data.stationId).eq('cash_shift_id', id.data).eq('status', 'pending').limit(1),
          req.supabase.from('kg_nozzle_meter_readings').select('id').eq('station_id', parsed.data.stationId).eq('cash_shift_id', id.data).eq('status', 'pending').limit(1),
          req.supabase.from('shift_nozzle_roster').select('nozzle_id').eq('station_id', parsed.data.stationId).eq('cash_shift_id', id.data),
          req.supabase.from('shift_meter_openings').select('nozzle_id').eq('station_id', parsed.data.stationId).eq('cash_shift_id', id.data).eq('status', 'approved'),
        ]);
        const pendingError = [pendingOpenings, pendingLitres, pendingKg, roster, approvedOpenings].find(q => q.error)?.error;
        if (pendingError) throw pendingError;
        const expectedNozzles = roster.data || [];
        const approvedNozzleIds = new Set((approvedOpenings.data || []).map(x => x.nozzle_id));
        if (expectedNozzles.length && expectedNozzles.some(x => !approvedNozzleIds.has(x.nozzle_id))) {
          return fail(res, 409, 'SHIFT_OPENING_READINESS_INCOMPLETE', 'Every nozzle assigned to this shift must have an approved opening meter before the shift can close.');
        }
        if ((pendingOpenings.data || []).length || (pendingLitres.data || []).length || (pendingKg.data || []).length) {
          return fail(res, 409, 'METER_APPROVAL_PENDING', 'This shift has opening or closing meter readings awaiting manager approval. Resolve every pending reading before closing the shift.');
        }

        const result =
          await req.supabase.rpc(
            'close_station_cash_shift',
            {
              p_shift_id: id.data,
              p_closed_by: req.user.id,
              p_counted_cash:
                parsed.data.countedCash,
              p_note:
                parsed.data.notes ||
                null,
            }
          );

        if (result.error) {
          const message = String(
            result.error.message || ''
          );

          if (
            message.includes(
              'SHIFT_ALREADY_CLOSED'
            )
          ) {
            return fail(
              res,
              409,
              'SHIFT_ALREADY_CLOSED',
              'This shift has already been closed.'
            );
          }

          throw result.error;
        }

        await audit(
          req,
          a,
          'CASH_SHIFT_CLOSED',
          'station_cash_shift',
          id.data,
          {
            variance:
              result.data.variance,
          }
        );

        res.json({
          data: result.data,
        });
      } catch (error) {
        handle(next, error);
      }
    }
  );


  // Manager daily close: branch-scoped readiness, submission, and immutable review history.
  r.get('/daily-closing', async (req, res, next) => {
    try {
      const parsed = stationSchema.safeParse({ stationId: req.query.stationId });
      const date = String(req.query.date || '');
      if (!parsed.success || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(new Date(`${date}T00:00:00Z`).getTime()) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) return fail(res,400,'INVALID_DAILY_CLOSE_QUERY','Select a valid branch and date.');
      const a = await checked(req,res,parsed.data.stationId);
      if (!a) return;
      if (!a.canManage) return fail(res,403,'FORBIDDEN','Only the assigned branch manager or company owner can view daily closing readiness.');
      const start = `${date}T00:00:00.000Z`, end = new Date(new Date(start).getTime()+86400000).toISOString();
      const [shiftsQ, recsQ, closeQ] = await Promise.all([
        req.supabase.from('station_cash_shifts').select('id,status,opened_at,closed_at,cashier_user_id,variance').eq('station_id',parsed.data.stationId).gte('opened_at',start).lt('opened_at',end).order('opened_at'),
        req.supabase.from('station_shift_reconciliations').select('cash_shift_id,expected_sales,collected_total,sales_variance,cash_variance,status,reconciled_at').eq('station_id',parsed.data.stationId),
        req.supabase.from('station_daily_closing_reviews').select('*').eq('station_id',parsed.data.stationId).eq('business_date',date).maybeSingle()
      ]);
      for (const q of [shiftsQ,recsQ,closeQ]) if(q.error) throw q.error;
      const recs = new Map((recsQ.data||[]).map(x=>[x.cash_shift_id,x]));
      const shifts = (shiftsQ.data||[]).map(x=>({...x,reconciliation:recs.get(x.id)||null}));
      const blockers = [];
      if(shifts.some(x=>x.status==='open')) blockers.push('Close every cashier shift opened on this date.');
      if(shifts.some(x=>x.status!=='open'&&!x.reconciliation)) blockers.push('Reconcile every closed cashier shift.');
      const summary = {shiftCount:shifts.length,openShifts:shifts.filter(x=>x.status==='open').length,unreconciledShifts:shifts.filter(x=>x.status!=='open'&&!x.reconciliation).length,reconciledShifts:shifts.filter(x=>!!x.reconciliation).length,expectedSales:shifts.reduce((n,x)=>n+Number(x.reconciliation?.expected_sales||0),0),collections:shifts.reduce((n,x)=>n+Number(x.reconciliation?.collected_total||0),0),salesVariance:shifts.reduce((n,x)=>n+Number(x.reconciliation?.sales_variance||0),0),cashVariance:shifts.reduce((n,x)=>n+Number(x.reconciliation?.cash_variance||0),0)};
      res.json({data:{stationId:parsed.data.stationId,date,shifts,summary,blockers,ready:blockers.length===0,submission:closeQ.data||null,canSubmit:a.canManage&&!a.owner}});
    } catch(e){next(e)}
  });
  r.post('/daily-closing/submit', async (req,res,next)=>{
    try {
      const parsed = z.object({stationId:uuid,businessDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),managerNote:z.string().trim().max(1500).optional()}).safeParse(req.body);
      if(!parsed.success) return fail(res,400,'VALIDATION_ERROR','Provide a valid branch, date and optional handover note.');
      const requestedDate = new Date(`${parsed.data.businessDate}T00:00:00Z`);
      if(!Number.isFinite(requestedDate.getTime()) || requestedDate.toISOString().slice(0,10)!==parsed.data.businessDate) return fail(res,400,'VALIDATION_ERROR','Provide a valid branch, date and optional handover note.');
      const a=await checked(req,res,parsed.data.stationId,true);if(!a)return;
      if(a.owner) return fail(res,403,'MANAGER_SUBMISSION_REQUIRED','A branch manager must submit the daily close for independent owner review.');
      const start=`${parsed.data.businessDate}T00:00:00.000Z`,end=new Date(new Date(start).getTime()+86400000).toISOString();
      const [sq,rq]=await Promise.all([
        req.supabase.from('station_cash_shifts').select('id,status').eq('station_id',parsed.data.stationId).gte('opened_at',start).lt('opened_at',end),
        req.supabase.from('station_shift_reconciliations').select('cash_shift_id,expected_sales,collected_total,sales_variance,cash_variance').eq('station_id',parsed.data.stationId)
      ]);if(sq.error)throw sq.error;if(rq.error)throw rq.error;
      const reconciled=new Set((rq.data||[]).map(x=>x.cash_shift_id));
      if((sq.data||[]).some(x=>x.status==='open'||!reconciled.has(x.id))) return fail(res,409,'DAILY_CLOSE_BLOCKED','Close all shifts and save reconciliation for every closed shift before submitting the daily close.');
      const recs=(rq.data||[]).filter(x=>(sq.data||[]).some(s=>s.id===x.cash_shift_id));
      const summary={shiftCount:(sq.data||[]).length,reconciledShifts:recs.length,expectedSales:recs.reduce((n,x)=>n+Number(x.expected_sales||0),0),collections:recs.reduce((n,x)=>n+Number(x.collected_total||0),0),salesVariance:recs.reduce((n,x)=>n+Number(x.sales_variance||0),0),cashVariance:recs.reduce((n,x)=>n+Number(x.cash_variance||0),0)};
      const result=await req.supabase.from('station_daily_closing_reviews').upsert({station_id:parsed.data.stationId,company_id:a.station.company_id,business_date:parsed.data.businessDate,submitted_by:req.user.id,manager_note:parsed.data.managerNote||null,summary,status:'submitted',submitted_at:new Date().toISOString(),reviewed_by:null,reviewed_at:null,review_note:null},{onConflict:'station_id,business_date'}).select('*').single();if(result.error)throw result.error;
      await audit(req,a,'BRANCH_DAILY_CLOSE_SUBMITTED','station_daily_closing_review',result.data.id,{businessDate:parsed.data.businessDate,summary});
      res.status(201).json({data:result.data});
    }catch(e){next(e)}
  });
  return r;
}