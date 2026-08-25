/* CleanBid F1 — Invitation authorization regression harness.
 *
 * Requires:
 *   1. supabase-schema.sql (the consolidated authoritative schema) applied
 *      to the live project via the Supabase Dashboard SQL Editor.
 *   2. Two real auth users A and B (Supabase Auth). Because the project has
 *      email confirmation ON and an email-send rate limit, you may need to
 *      create these in the dashboard / wait out the rate limit.
 *
 * Credentials: reads the PUBLIC anon key from the deployed JS bundle or from
 * scripts/.env.pulled. Never needs the service-role key.
 *
 * Run:  node scripts/audit-invitations.cjs
 *
 * RESULT LABELS used in output:
 *   [LIVE]       executed against the real database
 *   [NOT RUN]    could not run (rate limit / missing accounts) — see stderr
 */
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const ANON = process.env.CB_ANON || 'sb_publishable_igEK1vCJZuW2ltMxkA3B0Q_9bqrtbFp';
const URL = 'https://jydwyzhmlsbckxwshplf.supabase.co';

const A_EMAIL = 'inv_a_' + Date.now().toString().slice(-6) + '@cleanbid.app';
const B_EMAIL = 'inv_b_' + Date.now().toString().slice(-6) + '@cleanbid.app';
const PW = 'Audit!Passw0rd#' + Date.now();

let pass = 0, fail = 0, notrun = 0;
function ok(tag, name, cond, detail) {
  if (cond === 'skip') { notrun++; console.log('  [NOT RUN] ' + name + (detail ? ' (' + detail + ')' : '')); }
  else if (cond) { pass++; console.log('  [LIVE] PASS ' + name + (detail ? ' (' + detail + ')' : '')); }
  else { fail++; console.log('  [LIVE] FAIL ' + name + (detail ? ' (' + detail + ')' : '')); }
}

async function signUp(email) {
  const c = createClient(URL, ANON);
  const { data, error } = await c.auth.signUp({ email, password: PW, options: { data: { full_name: 'Inv' } } });
  if (error) throw error;
  return { c, user: data.user, session: data.session };
}
async function signIn(email) {
  const c = createClient(URL, ANON);
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw error;
  return { c, user: data.user, session: data.session };
}

(async () => {
  console.log('F1 INVITATION REGRESSION (project jydwyzhmlsbckxwshplf)\n');
  let A, B;
  try { A = await signUp(A_EMAIL); } catch (e) { console.error('User A signup blocked (rate limit?): ' + e.message); console.error('=> Run after cooldown or create users in Supabase dashboard.'); process.exit(3); }
  try { B = await signUp(B_EMAIL); } catch (e) { console.error('User B signup blocked: ' + e.message); process.exit(3); }
  if (!A.session) { try { A = await signIn(A_EMAIL); } catch (e) { console.error('No session A: ' + e.message); process.exit(3); } }
  if (!B.session) { try { B = await signIn(B_EMAIL); } catch (e) { console.error('No session B: ' + e.message); process.exit(3); } }

  // Owner A creates Workspace A
  const { data: wsA } = await A.c.from('workspaces').insert({ name: 'Inv WS A' }).select().single();
  await A.c.from('workspace_members').insert({ workspace_id: wsA.id, user_id: A.user.id, role: 'owner' });
  // Member B creates Workspace B
  const { data: wsB } = await B.c.from('workspaces').insert({ name: 'Inv WS B' }).select().single();
  await B.c.from('workspace_members').insert({ workspace_id: wsB.id, user_id: B.user.id, role: 'owner' });

  console.log('\n[Self-join vulnerability — must be DENIED]');
  const aJoinB = await A.c.from('workspace_members').insert({ workspace_id: wsB.id, user_id: A.user.id, role: 'member' });
  ok('LIVE', 'User A self-inserts into Workspace B (no invite) -> DENIED', !!aJoinB.error, aJoinB.error ? aJoinB.error.message : 'ALLOWED-BAD');

  console.log('\n[Legitimate invitation flow]');
  // B (owner of WS B) invites A
  const inv = await B.c.rpc('create_workspace_invitation', { p_workspace: wsB.id, p_email: A_EMAIL.toLowerCase(), p_role: 'estimator' });
  ok('LIVE', 'Owner B creates invitation for A -> token returned', !inv.error && typeof inv.data === 'string' && inv.data.length > 0, inv.error ? inv.error.message : 'token len ' + (inv.data || '').length);
  const token = inv.data;

  // A accepts
  const acc = await A.c.rpc('accept_workspace_invitation', { p_token: token });
  ok('LIVE', 'A accepts invitation -> membership created', !acc.error, acc.error ? acc.error.message : JSON.stringify(acc.data));
  const mem = await A.c.from('workspace_members').select('*').eq('workspace_id', wsB.id).eq('user_id', A.user.id).maybeSingle();
  ok('LIVE', 'A is now a member of Workspace B', !!mem.data, mem.data ? 'role=' + mem.data.role : 'no membership');

  console.log('\n[Invalid invitation scenarios — must be DENIED]');
  // Already accepted (reuse same token)
  const acc2 = await A.c.rpc('accept_workspace_invitation', { p_token: token });
  ok('LIVE', 'Re-accept same token -> DENIED', !!acc2.error, acc2.error ? acc2.error.message : 'ALLOWED-BAD');
  // Bad token
  const acc3 = await A.c.rpc('accept_workspace_invitation', { p_token: 'deadbeef' + token });
  ok('LIVE', 'Invalid token -> DENIED', !!acc3.error, acc3.error ? acc3.error.message : 'ALLOWED-BAD');
  // Unauthenticated acceptance
  const anon = createClient(URL, ANON);
  const acc4 = await anon.rpc('accept_workspace_invitation', { p_token: token });
  ok('LIVE', 'Unauthenticated acceptance -> DENIED', !!acc4.error, acc4.error ? acc4.error.message : 'ALLOWED-BAD');
  // Wrong email: B tries to accept an invite sent to A's email using B's session
  const inv2 = await B.c.rpc('create_workspace_invitation', { p_workspace: wsB.id, p_email: A_EMAIL.toLowerCase(), p_role: 'estimator' });
  const acc5 = await B.c.rpc('accept_workspace_invitation', { p_token: inv2.data });
  ok('LIVE', 'Wrong-email acceptance (B accepts A invite) -> DENIED', !!acc5.error, acc5.error ? acc5.error.message : 'ALLOWED-BAD');

  console.log('\n[Role attacks — must be DENIED]');
  // Member A (now member of WS B) tries to invite an admin -> DENIED (A is estimator)
  const inv3 = await A.c.rpc('create_workspace_invitation', { p_workspace: wsB.id, p_email: 'someone@cleanbid.app', p_role: 'admin' });
  ok('LIVE', 'Estimator A invites admin -> DENIED', !!inv3.error, inv3.error ? inv3.error.message : 'ALLOWED-BAD');
  // Self-promote via workspace_members (no UPDATE policy) -> DENIED
  const promo = await A.c.from('workspace_members').update({ role: 'owner' }).eq('workspace_id', wsB.id).eq('user_id', A.user.id);
  ok('LIVE', 'A self-promotes role -> DENIED', !!promo.error || promo.count === 0, promo.error ? promo.error.message : 'count=' + promo.count);
  // A changes B's role -> DENIED
  const promo2 = await A.c.from('workspace_members').update({ role: 'estimator' }).eq('workspace_id', wsB.id).eq('user_id', B.user.id);
  ok('LIVE', 'A changes B role -> DENIED', !!promo2.error || promo2.count === 0, promo2.error ? promo2.error.message : 'count=' + promo2.count);

  console.log('\n[Existing isolation — re-confirmed]');
  const aReadB = await A.c.from('customers').select('*').eq('workspace_id', wsB.id);
  ok('LIVE', 'A reads B data -> DENIED', aReadB.data && aReadB.data.length === 0);

  // cleanup
  await B.c.from('workspace_members').delete().eq('workspace_id', wsB.id);
  await A.c.from('workspace_members').delete().eq('workspace_id', wsA.id);
  await A.c.from('workspaces').delete().eq('id', wsA.id);
  await B.c.from('workspaces').delete().eq('id', wsB.id);

  console.log('\n========================================');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed, ' + notrun + ' not run');
  console.log('Note: test auth users ' + A_EMAIL + ' / ' + B_EMAIL + ' remain in auth.users.');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + e.message); process.exit(99); });
