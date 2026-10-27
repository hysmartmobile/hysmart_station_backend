import { Router } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const PLANS = {
  starter: { id: 'starter', name: 'Starter', amount: 3000000, amountNaira: 30000, branchLimit: 1 },
  multi: { id: 'multi', name: 'Multi-Branch', amount: 12000000, amountNaira: 120000, branchLimit: 5 },
};
const naira = amount => `₦${Number(amount).toLocaleString('en-NG')}`;
async function ownerCompany(req) {
  const q = await req.supabase.from('company_members')
    .select('company_id,role,companies(id,name,trial_started_at,trial_ends_at)')
    .eq('user_id', req.user.id).eq('status', 'active')
    .in('role', ['COMPANY_OWNER', 'COMPANY_ADMIN']).limit(1).maybeSingle();
  if (q.error) throw q.error;
  return q.data;
}

export function billingWebhookRoutes(config, supabase) {
  const r = Router();
  r.post('/webhook', async (req, res, next) => {
    try {
      if (!config.paystackSecretKey || !req.rawBody) return res.status(503).json({ error: 'Billing webhook is not configured.' });
      const supplied = String(req.headers['x-paystack-signature'] || '');
      const expectedSignature = createHmac('sha512', config.paystackSecretKey).update(req.rawBody).digest('hex');
      const a = Buffer.from(supplied); const b = Buffer.from(expectedSignature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid webhook signature.' });
      if (req.body?.event !== 'charge.success') return res.status(200).json({ received: true });
      const transaction = req.body?.data;
      const reference = transaction?.reference;
      if (!reference || transaction?.reference !== reference || transaction?.status !== 'success' || transaction?.currency !== 'NGN' || transaction?.id == null) return res.status(200).json({ received: true });
      const attemptQuery = await supabase.from('company_payment_attempts').select('company_id,plan,amount_naira,branch_limit,status').eq('paystack_reference', reference).maybeSingle();
      if (attemptQuery.error) throw attemptQuery.error;
      const attempt = attemptQuery.data;
      // Unknown references are acknowledged: they are not eligible to grant access.
      if (!attempt) return res.status(200).json({ received: true });
      const plan = PLANS[attempt.plan];
      if (!plan || transaction.amount !== plan.amount || attempt.amount_naira !== plan.amountNaira || attempt.branch_limit !== plan.branchLimit || transaction.metadata?.company_id !== attempt.company_id || transaction.metadata?.plan !== attempt.plan || Number(transaction.metadata?.branch_limit) !== plan.branchLimit) return res.status(400).json({ error: 'Payment metadata does not match the pending checkout.' });
      const applied = await supabase.rpc('activate_company_subscription_from_payment', { p_reference: reference, p_transaction_id: String(transaction.id), p_paid_at: transaction.paid_at || transaction.paidAt || new Date().toISOString(), p_actor_user_id: null, p_source: 'paystack_webhook' });
      if (applied.error) throw applied.error;
      return res.status(200).json({ received: true, processed: applied.data?.processed === true, alreadyProcessed: applied.data?.alreadyProcessed === true });
    } catch (error) { next(error); }
  });
  return r;
}

export default function billingRoutes(config) {
  const r = Router();
  r.get('/status', async (req, res, next) => {
    try {
      const membership = await ownerCompany(req);
      if (!membership) return res.status(404).json({ error: { code: 'COMPANY_NOT_FOUND', message: 'Create or join a company workspace first.' } });
      const company = Array.isArray(membership.companies) ? membership.companies[0] : membership.companies;
      const [{ data: subscription, error: subError }, { count, error: countError }] = await Promise.all([
        req.supabase.from('company_subscriptions').select('plan,status,amount_naira,branch_limit,current_period_start,current_period_end,paystack_reference,updated_at').eq('company_id', membership.company_id).maybeSingle(),
        req.supabase.from('stations').select('id', { count: 'exact', head: true }).eq('company_id', membership.company_id),
      ]);
      if (subError) throw subError; if (countError) throw countError;
      const trialEnd = company?.trial_ends_at || null;
      const trialActive = !!trialEnd && new Date(trialEnd).getTime() > Date.now();
      const paidActive = subscription?.status === 'active' && !!subscription.current_period_end && new Date(subscription.current_period_end).getTime() > Date.now();
      res.json({ data: { companyId: membership.company_id, companyName: company?.name || '', trialStartedAt: company?.trial_started_at || null, trialEndsAt: trialEnd, trialActive, trialExpired: !!trialEnd && !trialActive, subscription: subscription || null, paidActive, branchCount: count || 0, branchLimit: paidActive ? subscription.branch_limit : 0, plans: Object.values(PLANS).map(p => ({ id: p.id, name: p.name, amountNaira: p.amountNaira, branchLimit: p.branchLimit, label: naira(p.amountNaira) })) } });
    } catch (e) { next(e); }
  });

  r.post('/checkout', async (req, res, next) => {
    const parsed = z.object({ plan: z.enum(['starter', 'multi']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_PLAN', message: 'Choose Starter or Multi-Branch.' } });
    if (!config.paystackSecretKey) return res.status(503).json({ error: { code: 'BILLING_NOT_CONFIGURED', message: 'Online payments are not configured yet. Contact HySmart support.' } });
    try {
      const membership = await ownerCompany(req);
      if (!membership) return res.status(403).json({ error: { code: 'OWNER_REQUIRED', message: 'Only the active company owner can subscribe.' } });
      const plan = PLANS[parsed.data.plan];
      const branchCount = await req.supabase.from('stations').select('id', { count: 'exact', head: true }).eq('company_id', membership.company_id).eq('status', 'active');
      if (branchCount.error) throw branchCount.error;
      if ((branchCount.count || 0) > plan.branchLimit) return res.status(409).json({ error: { code: 'PLAN_BRANCH_LIMIT', message: `This plan supports ${plan.branchLimit} active branch${plan.branchLimit === 1 ? '' : 'es'}. Contact support to resolve your current branch count before switching.` } });
      const reference = `hysmart_${membership.company_id}_${randomUUID().replaceAll('-', '')}`;
      const insert = await req.supabase.from('company_payment_attempts').insert({ company_id: membership.company_id, plan: plan.id, status: 'pending', amount_naira: plan.amountNaira, branch_limit: plan.branchLimit, paystack_reference: reference });
      if (insert.error) throw insert.error;
      const init = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST', headers: { Authorization: `Bearer ${config.paystackSecretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: req.user.email, amount: plan.amount, currency: 'NGN', reference, callback_url: `${config.frontendOrigin}/billing?reference=${encodeURIComponent(reference)}`, metadata: { company_id: membership.company_id, user_id: req.user.id, plan: plan.id, branch_limit: plan.branchLimit } }),
      });
      const provider = await init.json().catch(() => ({}));
      if (!init.ok || !provider.status || !provider.data?.authorization_url) {
        console.error('[billing] Paystack initialization failed', { status: init.status, message: provider.message });
        const failed = await req.supabase.from('company_payment_attempts').update({ status: 'failed' }).eq('paystack_reference', reference).eq('status', 'pending');
        if (failed.error) throw failed.error;
        return res.status(502).json({ error: { code: 'CHECKOUT_FAILED', message: 'Could not start checkout. Please try again.' } });
      }
      res.status(201).json({ data: { authorizationUrl: provider.data.authorization_url, reference, plan: plan.id, amountNaira: plan.amountNaira } });
    } catch (e) { next(e); }
  });

  r.post('/verify', async (req, res, next) => {
    const parsed = z.object({ reference: z.string().min(8).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_REFERENCE', message: 'A valid payment reference is required.' } });
    if (!config.paystackSecretKey) return res.status(503).json({ error: { code: 'BILLING_NOT_CONFIGURED', message: 'Online payments are not configured yet.' } });
    try {
      const membership = await ownerCompany(req);
      if (!membership) return res.status(403).json({ error: { code: 'OWNER_REQUIRED', message: 'Company owner access is required.' } });
      const pending = await req.supabase.from('company_payment_attempts').select('plan,amount_naira,branch_limit,paystack_reference,status').eq('company_id', membership.company_id).eq('paystack_reference', parsed.data.reference).maybeSingle();
      if (pending.error) throw pending.error;
      if (!pending.data) return res.status(404).json({ error: { code: 'PAYMENT_NOT_FOUND', message: 'This payment reference was not found for your company.' } });
      if (pending.data.status === 'paid') return res.json({ data: { message: 'This payment has already been processed.', alreadyProcessed: true } });
      const verify = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(parsed.data.reference)}`, { headers: { Authorization: `Bearer ${config.paystackSecretKey}` } });
      const provider = await verify.json().catch(() => ({}));
      const expected = PLANS[pending.data.plan];
      const transaction = provider.data;
      if (!verify.ok || !provider.status || transaction?.status !== 'success' || transaction?.reference !== parsed.data.reference || transaction?.amount !== expected.amount || transaction?.currency !== 'NGN' || transaction?.id == null || pending.data.amount_naira !== expected.amountNaira || pending.data.branch_limit !== expected.branchLimit || transaction?.metadata?.company_id !== membership.company_id || transaction?.metadata?.user_id !== req.user.id || transaction?.metadata?.plan !== expected.id || Number(transaction?.metadata?.branch_limit) !== expected.branchLimit) {
        return res.status(402).json({ error: { code: 'PAYMENT_NOT_CONFIRMED', message: 'Payment has not been confirmed. If you were charged, contact support before retrying.' } });
      }
      const applied = await req.supabase.rpc('activate_company_subscription_from_payment', { p_reference: parsed.data.reference, p_transaction_id: String(transaction.id), p_paid_at: transaction.paid_at || transaction.paidAt || new Date().toISOString(), p_actor_user_id: req.user.id, p_source: 'browser_verify' });
      if (applied.error) throw applied.error;
      const current = await req.supabase.from('company_subscriptions').select('plan,status,amount_naira,branch_limit,current_period_start,current_period_end').eq('company_id', membership.company_id).single();
      if (current.error) throw current.error;
      res.json({ data: { subscription: current.data, alreadyProcessed: applied.data?.alreadyProcessed === true, message: applied.data?.alreadyProcessed ? 'This payment has already been processed.' : `${expected.name} is now active.` } });
    } catch (e) { next(e); }
  });
  return r;
}
