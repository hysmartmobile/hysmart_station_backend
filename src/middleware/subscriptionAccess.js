// Protect operational APIs when a company's trial has expired and no paid plan is active.
// Billing, /me and company bootstrap routes are mounted before this middleware so owners can upgrade.
export function subscriptionAccess(supabase) {
  return async (req, res, next) => {
    try {
      let companyId = null;
      const companyMembership = await supabase.from('company_members')
        .select('company_id').eq('user_id', req.user.id).eq('status', 'active').limit(1).maybeSingle();
      if (companyMembership.error) throw companyMembership.error;
      companyId = companyMembership.data?.company_id || null;

      if (!companyId) {
        const stationMembership = await supabase.from('station_members')
          .select('station_id').eq('user_id', req.user.id).eq('status', 'active').limit(1).maybeSingle();
        if (stationMembership.error) throw stationMembership.error;
        if (stationMembership.data?.station_id) {
          const station = await supabase.from('stations').select('company_id')
            .eq('id', stationMembership.data.station_id).maybeSingle();
          if (station.error) throw station.error;
          companyId = station.data?.company_id || null;
        }
      }
      // New users need to reach company setup; company creation is deliberately not gated here.
      if (!companyId) return next();

      const [company, subscription] = await Promise.all([
        supabase.from('companies').select('trial_ends_at').eq('id', companyId).maybeSingle(),
        supabase.from('company_subscriptions').select('status,current_period_end').eq('company_id', companyId).maybeSingle(),
      ]);
      if (company.error) throw company.error;
      if (subscription.error) throw subscription.error;
      const trialActive = !!company.data?.trial_ends_at && new Date(company.data.trial_ends_at).getTime() > Date.now();
      const paidActive = subscription.data?.status === 'active' && !!subscription.data.current_period_end && new Date(subscription.data.current_period_end).getTime() > Date.now();
      if (trialActive || paidActive) return next();
      return res.status(402).json({ error: { code: 'TRIAL_EXPIRED', message: 'Your 7-day trial has ended. Upgrade to a paid plan to continue using station operations.', requestId: req.requestId } });
    } catch (error) { next(error); }
  };
}
