import { Router } from 'express';
import { createHash } from 'node:crypto';

const hash = token => createHash('sha256').update(token).digest('hex');

// Public, read-only invitation preview. The raw token is never stored or returned.
export default function publicInvitationRoutes(supabase) {
  const router = Router();
  router.get('/invitations/preview', async (req, res, next) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (token.length < 30 || token.length > 200) {
      return res.status(400).json({ error: { code: 'INVALID_INVITATION', message: 'This invitation link is incomplete. Ask the inviter for a fresh link.' } });
    }
    if (!supabase) return res.status(503).json({ error: { code: 'SERVICE_NOT_CONFIGURED', message: 'Invitations are temporarily unavailable.' } });
    try {
      const { data: invitation, error } = await supabase
        .from('station_invitations')
        .select('id,station_id,email,role,status,expires_at')
        .eq('token_hash', hash(token))
        .maybeSingle();
      if (error) throw error;
      if (!invitation || invitation.status !== 'pending' || !invitation.email || new Date(invitation.expires_at).getTime() <= Date.now()) {
        return res.status(404).json({ error: { code: 'INVITATION_UNAVAILABLE', message: 'This invitation is invalid, expired, or already used. Ask the company owner, director, or manager for a new link.' } });
      }
      const { data: station, error: stationError } = await supabase
        .from('stations').select('id,name,company_id').eq('id', invitation.station_id).maybeSingle();
      if (stationError) throw stationError;
      if (!station) return res.status(404).json({ error: { code: 'INVITATION_UNAVAILABLE', message: 'The invited branch is no longer available. Ask the inviter for a new link.' } });
      const { data: company, error: companyError } = await supabase
        .from('companies').select('name').eq('id', station.company_id).maybeSingle();
      if (companyError) throw companyError;
      return res.json({ data: {
        email: invitation.email.toLowerCase(),
        role: invitation.role,
        stationName: station.name,
        companyName: company?.name || 'HySmart Station company',
        expiresAt: invitation.expires_at,
      } });
    } catch (error) { next(error); }
  });
  return router;
}
