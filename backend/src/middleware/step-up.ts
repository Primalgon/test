import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { forbidden, unauthorized } from '../lib/errors';
import { one, run, nowSec } from '../db/client';

/**
 * Step-up authentication.
 *
 * A session is a long-lived thing — twelve hours idle, fourteen days absolute.
 * That is the right trade for browsing and for placing an order. It is the wrong
 * trade for changing the account's email address, disabling MFA, issuing a
 * refund, or exporting every customer record.
 *
 * The gap this closes: an attacker who gets a session — borrowed laptop, XSS
 * that survived the CSP, stolen cookie — otherwise inherits every capability the
 * account has, permanently. Requiring a fresh proof of identity for the small
 * set of operations that are irreversible or that grant persistence means the
 * stolen session is worth far less, and the re-auth prompt itself is a signal to
 * the real owner that something is happening.
 *
 * This is why bank and cloud consoles re-prompt at the point of a dangerous
 * action rather than only at login.
 *
 * The freshness window is deliberately short. Ten minutes covers doing several
 * admin tasks in a row without re-typing; an hour would mean a session captured
 * shortly after login inherits the elevated state too.
 */

const DEFAULT_FRESHNESS_SEC = 600;

export interface StepUpOptions {
  /** How recently the user must have re-proven identity. */
  freshnessSec?: number;
  /** When the account has MFA enrolled, require the second factor specifically. */
  requireMfa?: boolean;
  /** Human-readable name of the action, shown in the 403 and written to the audit log. */
  action: string;
}

/**
 * Guard a route. Responds 403 with `step_up_required` and the reason, so the
 * frontend can show a re-auth prompt and retry the original request rather than
 * dumping the user back to the login screen and losing their work.
 */
export function requireStepUp(opts: StepUpOptions): MiddlewareHandler<AppContext> {
  const freshness = opts.freshnessSec ?? DEFAULT_FRESHNESS_SEC;

  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw unauthorized();

    const db = c.get('db');
    const row = await one<{
      reauth_at: number | null;
      reauth_method: string | null;
      mfa_enabled: number;
    }>(db,
      `SELECT s.reauth_at, s.reauth_method, u.mfa_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
      [user.sessionId],
    );

    const now = nowSec();
    const age = row?.reauth_at ? now - row.reauth_at : Infinity;
    const mfaEnrolled = !!row?.mfa_enabled;

    if (age > freshness) {
      c.get('log').info('step_up_required', { action: opts.action, age: Number.isFinite(age) ? age : null });
      return c.json({
        error: {
          code: 'step_up_required',
          message: `Confirm your identity to ${opts.action}.`,
          // Tells the client which prompt to render.
          methods: mfaEnrolled ? ['totp', 'password'] : ['password'],
          preferred: mfaEnrolled ? 'totp' : 'password',
          request_id: c.get('requestId'),
        },
      }, 403);
    }

    // A password re-entry is not equivalent to a second factor. If the account
    // has MFA and the operation is flagged requireMfa, accept only the factor
    // the attacker is least likely to hold.
    if (opts.requireMfa && mfaEnrolled && row?.reauth_method !== 'totp' && row?.reauth_method !== 'recovery') {
      return c.json({
        error: {
          code: 'step_up_required',
          message: `Confirm with your authenticator app to ${opts.action}.`,
          methods: ['totp'],
          preferred: 'totp',
          request_id: c.get('requestId'),
        },
      }, 403);
    }

    await next();
  };
}

/**
 * Record a successful re-authentication. Called by the step-up verify route
 * after a password or TOTP check passes.
 *
 * Marked on the **session**, not the user. Elevating the user record would
 * elevate every device that account is logged in on, including the attacker's.
 */
export async function markReauthenticated(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  method: 'password' | 'totp' | 'recovery',
): Promise<void> {
  const user = c.get('user');
  if (!user) return;
  await run(c.get('db'),
    'UPDATE sessions SET reauth_at = ?, reauth_method = ? WHERE id = ?',
    [nowSec(), method, user.sessionId],
  );
}

/**
 * Drop elevation immediately. Called on logout, on password change, and any
 * time an anomaly signal fires on the session — elevation should not survive
 * the moment its basis becomes questionable.
 */
export async function clearReauth(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  sessionId?: string,
): Promise<void> {
  const id = sessionId ?? c.get('user')?.sessionId;
  if (!id) return;
  await run(c.get('db'),
    'UPDATE sessions SET reauth_at = NULL, reauth_method = NULL WHERE id = ?', [id]);
}

/**
 * The operations that require step-up, in one place.
 *
 * Centralised so the list can be reviewed as a list. Scattered across route
 * files, the question "what can a stolen session do?" has no answer short of
 * reading every route.
 *
 * The test for inclusion: is it irreversible, does it move money, does it expose
 * bulk personal data, or does it grant the attacker persistence?
 */
export const SENSITIVE = {
  changeEmail:      { action: 'change the account email', requireMfa: true },
  changePassword:   { action: 'change your password', requireMfa: false },
  disableMfa:       { action: 'turn off two-factor authentication', requireMfa: true },
  viewRecoveryCodes:{ action: 'view your recovery codes', requireMfa: true },
  deleteAccount:    { action: 'delete this account', requireMfa: true },
  exportData:       { action: 'export personal data', requireMfa: true },
  issueRefund:      { action: 'issue a refund', requireMfa: true },
  changeUserRole:   { action: 'change a user\'s role', requireMfa: true },
  rotateSecrets:    { action: 'rotate integration secrets', requireMfa: true },
} as const satisfies Record<string, StepUpOptions>;
