// tests/rtc.spec.ts — makeRtcConfig ICE server list + waitForIceGathering timeout.
//
// Pure logic under the node environment; RTCPeerConnection is faked with a
// minimal EventTarget-like stub (this repo has no jsdom/webrtc polyfill), see
// tests/signaling.spec.ts for the sibling net-adjacent spec style.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { hasNonHostCandidate, makeRtcConfig, waitForIceGathering } from '../src/net/rtc';

describe('makeRtcConfig (§4.2/§4.3)', () => {
  it('lanOnly ⇒ no ICE servers at all', () => {
    expect(makeRtcConfig(true).iceServers).toEqual([]);
  });

  it('non-LAN ⇒ ≥2 STUN servers + ≥1 TURN server with credentials', () => {
    const servers = makeRtcConfig(false).iceServers ?? [];

    const urlsOf = (s: RTCIceServer): string[] =>
      Array.isArray(s.urls) ? s.urls : [s.urls];

    const stunServers = servers.filter((s) => urlsOf(s).some((u) => u.startsWith('stun:')));
    const turnServers = servers.filter((s) => urlsOf(s).some((u) => u.startsWith('turn:')));

    expect(stunServers.length).toBeGreaterThanOrEqual(2);
    expect(turnServers.length).toBeGreaterThanOrEqual(1);
    for (const turn of turnServers) {
      expect(turn.username).toBeTruthy();
      expect(turn.credential).toBeTruthy();
    }
  });

  it('STUN entries carry no credentials (only TURN needs auth)', () => {
    const servers = makeRtcConfig(false).iceServers ?? [];
    const urlsOf = (s: RTCIceServer): string[] =>
      Array.isArray(s.urls) ? s.urls : [s.urls];
    const stunOnly = servers.filter((s) => urlsOf(s).every((u) => u.startsWith('stun:')));
    for (const s of stunOnly) {
      expect(s.username).toBeUndefined();
      expect(s.credential).toBeUndefined();
    }
  });
});

/** Minimal fake RTCPeerConnection: just enough of the EventTarget + state
 *  surface that `waitForIceGathering` touches. */
class FakePc {
  iceGatheringState: RTCIceGatheringState = 'gathering';
  private listeners = new Set<() => void>();
  addEventListener(type: string, cb: () => void): void {
    if (type === 'icegatheringstatechange') this.listeners.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    if (type === 'icegatheringstatechange') this.listeners.delete(cb);
  }
  complete(): void {
    this.iceGatheringState = 'complete';
    for (const cb of this.listeners) cb();
  }
}

describe('waitForIceGathering', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately if already complete', async () => {
    const pc = new FakePc();
    pc.iceGatheringState = 'complete';
    await expect(waitForIceGathering(pc as unknown as RTCPeerConnection)).resolves.toBeUndefined();
  });

  it('resolves as soon as gathering state flips to complete, before the timeout', async () => {
    const pc = new FakePc();
    const done = waitForIceGathering(pc as unknown as RTCPeerConnection, 7000);
    pc.complete();
    await expect(done).resolves.toBeUndefined();
  });

  it('default timeout is well above the old 4000ms (raised for TURN allocation round-trips)', async () => {
    vi.useFakeTimers();
    const pc = new FakePc();
    const done = waitForIceGathering(pc as unknown as RTCPeerConnection); // default timeout
    let resolved = false;
    void done.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(4000);
    expect(resolved).toBe(false); // old 4000ms default would have already fired

    await vi.advanceTimersByTimeAsync(3000); // now past 7000ms total
    expect(resolved).toBe(true);
  });
});

/** Fake `getStats()` report: enough of `RTCStats` + `candidateType` for
 *  `hasNonHostCandidate` to read. */
type FakeReport = { type: string; candidateType?: string };

/** Fake `RTCStatsReport`: just the `forEach` shape `hasNonHostCandidate` uses. */
function fakeStatsReport(reports: FakeReport[]): { forEach: (cb: (r: FakeReport) => void) => void } {
  return { forEach: (cb) => reports.forEach(cb) };
}

function fakePcWithReports(reports: FakeReport[]): RTCPeerConnection {
  return {
    getStats: () => Promise.resolve(fakeStatsReport(reports)),
  } as unknown as RTCPeerConnection;
}

describe('hasNonHostCandidate (§NET3 diagnostic-only helper)', () => {
  it('false when only host candidates were gathered', async () => {
    const pc = fakePcWithReports([
      { type: 'local-candidate', candidateType: 'host' },
      { type: 'local-candidate', candidateType: 'host' },
      { type: 'remote-candidate', candidateType: 'host' },
    ]);
    await expect(hasNonHostCandidate(pc)).resolves.toBe(false);
  });

  it('true when a srflx local candidate was gathered', async () => {
    const pc = fakePcWithReports([
      { type: 'local-candidate', candidateType: 'host' },
      { type: 'local-candidate', candidateType: 'srflx' },
    ]);
    await expect(hasNonHostCandidate(pc)).resolves.toBe(true);
  });

  it('true when a relay local candidate was gathered', async () => {
    const pc = fakePcWithReports([{ type: 'local-candidate', candidateType: 'relay' }]);
    await expect(hasNonHostCandidate(pc)).resolves.toBe(true);
  });

  it('ignores non-"local-candidate" report types (e.g. remote-candidate srflx)', async () => {
    const pc = fakePcWithReports([
      { type: 'remote-candidate', candidateType: 'srflx' },
      { type: 'candidate-pair' },
    ]);
    await expect(hasNonHostCandidate(pc)).resolves.toBe(false);
  });

  it('false when no candidates were reported at all', async () => {
    const pc = fakePcWithReports([]);
    await expect(hasNonHostCandidate(pc)).resolves.toBe(false);
  });
});
