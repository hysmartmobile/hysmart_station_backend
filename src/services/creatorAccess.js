/**
 * Creator access is controlled by the private public.creator_admins table.
 * The API uses its server-side Supabase client; RLS denies direct client access.
 * Fail closed if the database query fails or the migration has not been applied.
 */
export async function isActiveCreatorAdmin(supabase, userId) {
  if (!supabase || !userId) return false;
  const result = await supabase
    .from('creator_admins')
    .select('user_id')
    .eq('user_id', userId)
    .eq('active', true)
    .maybeSingle();
  if (result.error) throw result.error;
  return Boolean(result.data?.user_id);
}
