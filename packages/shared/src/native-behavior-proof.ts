import type {NativeScrollResult,NativeScrollRead,NativeMediaRead,ScrollDirection,MediaDesired} from './native-behavior.js';
import {validScrollActResult,validScrollReadResult,validMediaReadResult,validMediaActResult} from './native-behavior.js';
export type ProofVerdict = { verdict: 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN'; reason?: string };

/** SCROLLED(direction): satisfied iff the bounded scroll verifiably moved the
 * scope one page in direction, or the scope was already at that boundary;
 * NOT_SATISFIED for a confirmed no-progress; UNKNOWN when effects or the
 * fresh read could not be honestly determined. The independent fresh read
 * must still confirm the direction (an external scroll-back reverts it). */
export function evaluateScrollProof(direction: ScrollDirection, actResult: unknown, freshRead: unknown): ProofVerdict {
  const a = actResult as NativeScrollResult | null, r = freshRead as NativeScrollRead | null;
  if (!validScrollActResult(a) || !validScrollReadResult(r)) return { verdict: 'UNKNOWN', reason: 'scroll_result_unobserved' };
  if (!r.ok) return { verdict: 'UNKNOWN', reason: r.reason ?? 'scroll_read_failed' };
  if (!r.binding_matches) return { verdict: 'UNKNOWN', reason: 'scroll_binding_drifted' };
  if(a.status!=='executed'||a.direction!==direction)return {verdict:'UNKNOWN',reason:'scroll_action_not_proven'};
  if (a.outcome === 'no_progress') return { verdict: 'NOT_SATISFIED', reason: a.reason ?? 'scroll_no_progress' };
  if (a.outcome === 'already_at_end') return { verdict: (direction==='down'?r.at_end:r.at_start)===true?'SATISFIED':'NOT_SATISFIED', reason: 'scroll_boundary_fresh_read:' + (a.at ?? '') };
  if (a.before === undefined) return { verdict: 'UNKNOWN', reason: 'scroll_before_unobserved' };
  const moved = direction === 'down' ? r.offset!.scroll_top > a.before.scroll_top || r.at_end === true
    : r.offset!.scroll_top < a.before.scroll_top || r.at_start === true;
  return moved ? { verdict: 'SATISFIED' } : { verdict: 'NOT_SATISFIED', reason: 'scroll_position_reverted' };
}

/** PLAYING/PAUSED: satisfied iff the fresh guarded read shows the desired
 * state on the SAME observed media identity (binding + source). The play()
 * promise is never consulted for satisfaction. */
export function evaluateMediaProof(desired: MediaDesired, freshRead: unknown, earlierRead?:unknown): ProofVerdict {
  const r = freshRead as NativeMediaRead | null;
  if (!validMediaReadResult(r)) return { verdict: 'UNKNOWN', reason: 'media_result_unobserved' };
  if (!r.ok) return { verdict: 'UNKNOWN', reason: r.reason ?? 'media_read_failed' };
  if (!r.binding_matches) return { verdict: 'UNKNOWN', reason: 'media_binding_drifted' };
  if (r.source_matches !== true) return { verdict: 'UNKNOWN', reason: 'media_source_drifted' };
  if(r.state!.connected!==true)return {verdict:'UNKNOWN',reason:'media_disconnected'};
  const playing = r.state!.paused === false && r.state!.ended === false && r.state!.ready_state>=2 && r.state!.current_src!=='';
  if(desired==='playing'&&playing){
    const before=earlierRead as NativeMediaRead|undefined;
    if(!validMediaReadResult(before)||!before.ok||before.document_ref!==r.document_ref||before.url!==r.url||JSON.stringify(before.identity)!==JSON.stringify(r.identity)||before.state?.current_src!==r.state!.current_src||before.state?.connected!==true||before.state?.ready_state!<2||before.state?.paused!==false||before.state?.ended!==false||!Number.isFinite(before.state?.current_time)||!Number.isFinite(r.state!.current_time)||!Number.isFinite(r.state!.playback_rate)||r.state!.playback_rate!<=0)return {verdict:'UNKNOWN',reason:'media_progress_unobserved'};
    if(r.state!.current_time!<=before.state!.current_time!+0.001)return {verdict:'NOT_SATISFIED',reason:'media_playback_not_advancing'};
  }
  const reached = desired === 'playing' ? playing : r.state!.paused === true;
  return reached ? { verdict: 'SATISFIED' } : { verdict: 'NOT_SATISFIED', reason: 'media_state_not_reached' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Native result → ActionResult status mapping for the daemon act switch
// (mirrors the COMMIT ack-honesty rules; unknown shapes are never trusted).
// ─────────────────────────────────────────────────────────────────────────────

export type BehaviorActionMapping =
  | { status: 'executed'; outcome: string }
  | { status: 'not_executed'; reason: string }
  | { status: 'effect_unknown'; reason: string };

export function mapScrollActionResult(native: unknown): BehaviorActionMapping {
  if (!validScrollActResult(native)) return { status: 'effect_unknown', reason: 'scroll_ack_unproven' };
  if (native.status === 'executed') return { status: 'executed', outcome: native.outcome };
  if (native.status === 'not_executed') return { status: 'not_executed', reason: native.reason ?? 'scroll_not_executed' };
  return { status: 'effect_unknown', reason: native.reason ?? 'scroll_effect_unknown' };
}
export function mapMediaActionResult(native: unknown): BehaviorActionMapping {
  if (!validMediaActResult(native)) return { status: 'effect_unknown', reason: 'media_ack_unproven' };
  if (native.status === 'executed') return { status: 'executed', outcome: native.outcome };
  if (native.status === 'not_executed') return { status: 'not_executed', reason: native.reason ?? 'media_not_executed' };
  return { status: 'effect_unknown', reason: native.reason ?? 'media_effect_unknown' };
}

