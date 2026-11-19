'use client';

/**
 * The audible alert for an incoming order (FR-SHP-01, UI-4).
 *
 * This is the one piece of the dashboard that has to work from across a
 * kitchen, and it is harder than it looks for one reason: **browsers refuse
 * to play audio until the user has interacted with the page.** A tablet left
 * on a counter overnight, reloaded by a browser restart, will silently fail
 * to alert — and nobody finds out until orders start going unanswered.
 *
 * So this module does three things rather than just calling play():
 *
 *  1. Synthesises the tone with the Web Audio API instead of loading a file.
 *     No asset to 404, no decode delay before the first alert, and the tone
 *     can be two notes rather than a beep.
 *  2. Reports whether it is actually permitted to make sound, so the UI can
 *     show a "tap to enable sound" prompt rather than pretending it is armed.
 *  3. Repeats while an order is still unanswered, because one chime at the
 *     moment nobody was looking is the same as no chime.
 */

export type AlertState = 'ready' | 'blocked' | 'unsupported';

export class OrderAlert {
  private context: AudioContext | null = null;
  private repeatTimer: ReturnType<typeof setInterval> | null = null;

  get state(): AlertState {
    if (typeof window === 'undefined') return 'unsupported';
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return 'unsupported';
    if (!this.context) return 'blocked';
    return this.context.state === 'running' ? 'ready' : 'blocked';
  }

  /**
   * Call from a click handler. Browsers only allow an AudioContext to start
   * inside a user gesture, so this cannot be done on mount — which is exactly
   * why the UI needs an explicit "enable sound" affordance.
   */
  async arm(): Promise<AlertState> {
    if (typeof window === 'undefined') return 'unsupported';

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!Ctor) return 'unsupported';

    try {
      this.context ??= new Ctor();
      if (this.context.state === 'suspended') await this.context.resume();
      // A near-silent blip confirms the context really is running, rather
      // than reporting 'running' and producing nothing.
      this.tone(880, 0.05, 0.0001);
      return this.state;
    } catch {
      return 'blocked';
    }
  }

  /** Two rising notes — distinct from a notification ping, hard to miss. */
  chime(): void {
    if (this.state !== 'ready') return;
    this.tone(784, 0.18, 0.22);
    window.setTimeout(() => this.tone(1047, 0.26, 0.22), 170);
  }

  /**
   * Keep chiming until the order is dealt with.
   *
   * FR-SHP-02 gives the shop a five-minute window, and an order lost because
   * the one chime happened while the owner was at the fryer is a cancelled
   * sale. Every eight seconds is insistent without being unbearable.
   */
  startRepeating(): void {
    if (this.repeatTimer) return;
    this.chime();
    this.repeatTimer = setInterval(() => this.chime(), 8000);
  }

  stopRepeating(): void {
    if (!this.repeatTimer) return;
    clearInterval(this.repeatTimer);
    this.repeatTimer = null;
  }

  dispose(): void {
    this.stopRepeating();
    void this.context?.close();
    this.context = null;
  }

  private tone(frequency: number, seconds: number, gainPeak: number): void {
    if (!this.context) return;

    const osc = this.context.createOscillator();
    const gain = this.context.createGain();

    osc.type = 'sine';
    osc.frequency.value = frequency;

    // A short attack and a smooth decay. A square wave at full gain would
    // clip on tablet speakers and sound like a fault rather than an alert.
    const now = this.context.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

    osc.connect(gain).connect(this.context.destination);
    osc.start(now);
    osc.stop(now + seconds + 0.02);
  }
}
