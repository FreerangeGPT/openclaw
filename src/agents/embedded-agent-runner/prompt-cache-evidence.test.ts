import { describe, expect, it, vi } from "vitest";
import {
  appendMainSessionPromptCacheEvidence,
  assertMainSessionCacheKeeperEvidenceFresh,
  assertMainSessionCacheKeeperIdentity,
  assertMainSessionCacheKeeperProviderIdentity,
  assertMainSessionCacheKeeperTranscriptAnchor,
  matchesLivePromptCacheEvidence,
  PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
  readPromptCacheEvidenceData,
  refreshLivePromptCacheEvidence,
} from "./prompt-cache-evidence.js";

const evidence = {
  timestamp: 1_700_000_000_000,
  provider: "anthropic",
  modelId: "claude-opus-4-8",
  cacheRetention: "long" as const,
  cacheRead: 80_000,
  cacheWrite: 10_000,
  cacheWrite1h: 90_000,
  promptTokens: 96_083,
  promptIdentity: "prompt-identity-1",
  providerCachePrefixIdentity: "provider-cache-prefix-identity-1",
  requestOptionsIdentity: "request-options-identity-1",
  providerMessageIdentity: "provider-message-identity-1",
  authFingerprint: "auth-fingerprint-1",
  authProfileId: "anthropic:main",
};

describe("main-session prompt cache evidence", () => {
  it("persists actual cache retention for the canonical main dialogue", () => {
    const appendCustomEntry = vi.fn();

    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
      }),
    ).toBe(true);
    expect(appendCustomEntry).toHaveBeenCalledWith(
      PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      expect.objectContaining({
        ...evidence,
        confirmedCachedTokens: 90_000,
        evidenceId: expect.any(String),
      }),
    );
    const written = appendCustomEntry.mock.calls[0]?.[1] as { evidenceId: string };
    expect(matchesLivePromptCacheEvidence(appendCustomEntry.mock.calls[0]?.[1])).toBe(true);
    expect(() =>
      assertMainSessionCacheKeeperIdentity({
        evidenceId: written.evidenceId,
        promptIdentity: evidence.promptIdentity,
        authFingerprint: evidence.authFingerprint,
      }),
    ).not.toThrow();
    expect(() =>
      assertMainSessionCacheKeeperProviderIdentity({
        evidenceId: written.evidenceId,
        providerCachePrefixIdentity: evidence.providerCachePrefixIdentity,
        requestOptionsIdentity: evidence.requestOptionsIdentity,
        providerMessageLongCachePrefixIndex: 2,
        providerMessagePrefixIdentities: ["empty", evidence.providerMessageIdentity, "candidate"],
        providerMessageTokenUpperBounds: [100, 3_917],
      }),
    ).not.toThrow();
    expect(() =>
      assertMainSessionCacheKeeperEvidenceFresh(
        written.evidenceId,
        evidence.timestamp + 59 * 60_000,
      ),
    ).not.toThrow();
    expect(() =>
      assertMainSessionCacheKeeperEvidenceFresh(
        written.evidenceId,
        evidence.timestamp + 60 * 60_000,
      ),
    ).toThrow(/cache-evidence-expired/);
    let continuationFailure: unknown;
    try {
      assertMainSessionCacheKeeperEvidenceFresh(
        written.evidenceId,
        evidence.timestamp + 60 * 60_000,
        false,
      );
    } catch (error) {
      continuationFailure = error;
    }
    expect(continuationFailure).toMatchObject({ replaySafe: false });
  });

  it("refreshes only a process-confirmed one-hour entry with a covering cache read", () => {
    const establish = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: establish },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        promptIdentity: "prompt-identity-refresh",
        authFingerprint: "auth-fingerprint-refresh",
      }),
    ).toBe(true);

    const establishedEntry = {
      type: "custom",
      customType: PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      data: establish.mock.calls[0]?.[1],
    };
    const refresh = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: refresh, getBranch: () => [establishedEntry] },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        timestamp: evidence.timestamp + 15 * 60_000,
        promptIdentity: "prompt-identity-refresh",
        authFingerprint: "auth-fingerprint-refresh",
        cacheRead: 90_000,
        cacheWrite: 0,
        cacheWrite1h: 0,
      }),
    ).toBe(true);
    expect(refresh).toHaveBeenCalledWith(
      PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      expect.objectContaining({ confirmedCachedTokens: 90_000, cacheWrite1h: 0 }),
    );
  });

  it("advances live freshness after a successful covering keeper response", () => {
    const establish = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: establish },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        promptIdentity: "prompt-identity-live-refresh",
        authFingerprint: "auth-fingerprint-live-refresh",
      }),
    ).toBe(true);
    const written = establish.mock.calls[0]?.[1] as { evidenceId: string };
    const refreshedAt = evidence.timestamp + 59 * 60_000;

    expect(
      refreshLivePromptCacheEvidence({
        evidenceId: written.evidenceId,
        timestamp: refreshedAt,
        usage: {
          input: 1_000,
          output: 100,
          cacheRead: 90_000,
          cacheWrite: 0,
          cacheWrite1h: 0,
          contextUsage: { state: "available", promptTokens: 91_000, totalTokens: 91_100 },
          totalTokens: 91_100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    ).toBe(true);
    expect(() =>
      assertMainSessionCacheKeeperEvidenceFresh(
        written.evidenceId,
        refreshedAt + 59 * 60_000,
        false,
      ),
    ).not.toThrow();
    expect(() =>
      assertMainSessionCacheKeeperEvidenceFresh(
        written.evidenceId,
        refreshedAt + 60 * 60_000,
        false,
      ),
    ).toThrow(/cache-evidence-expired/);

    const continued = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: {
          appendCustomEntry: continued,
          getBranch: () => [
            {
              type: "custom",
              customType: PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
              data: establish.mock.calls[0]?.[1],
            },
          ],
        },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        timestamp: evidence.timestamp + 70 * 60_000,
        promptIdentity: "prompt-identity-live-refresh",
        authFingerprint: "auth-fingerprint-live-refresh",
        cacheRead: 90_000,
        cacheWrite: 0,
        cacheWrite1h: 0,
      }),
    ).toBe(true);
    expect(continued).toHaveBeenCalledOnce();
  });

  it("combines a confirmed long-cache read with an incremental one-hour write", () => {
    const establish = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: establish },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        promptIdentity: "prompt-identity-extension",
        authFingerprint: "auth-fingerprint-extension",
        cacheRead: 0,
        cacheWrite: 80_000,
        cacheWrite1h: 80_000,
        promptTokens: 80_000,
      }),
    ).toBe(true);

    const establishedEntry = {
      type: "custom",
      customType: PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      data: establish.mock.calls[0]?.[1],
    };
    const appendCustomEntry = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry, getBranch: () => [establishedEntry] },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        timestamp: evidence.timestamp + 15 * 60_000,
        promptIdentity: "prompt-identity-extension",
        authFingerprint: "auth-fingerprint-extension",
        cacheRead: 80_000,
        cacheWrite: 20_000,
        cacheWrite1h: 20_000,
        promptTokens: 100_000,
      }),
    ).toBe(true);
    expect(appendCustomEntry).toHaveBeenCalledWith(
      PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      expect.objectContaining({ confirmedCachedTokens: 100_000 }),
    );
  });

  it("tombstones an intervening short-cache turn before long retention is restored", () => {
    const establish = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: establish },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        promptIdentity: "prompt-identity-retention-switch",
        authFingerprint: "auth-fingerprint-retention-switch",
        cacheRead: 0,
        cacheWrite: 80_000,
        cacheWrite1h: 80_000,
        promptTokens: 80_000,
      }),
    ).toBe(true);
    const establishedEntry = {
      type: "custom",
      customType: PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      data: establish.mock.calls[0]?.[1],
    };
    const invalidate = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: invalidate },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        cacheRetention: "short",
        timestamp: evidence.timestamp + 10 * 60_000,
      }),
    ).toBe(false);
    const invalidationEntry = {
      type: "custom",
      customType: PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      data: invalidate.mock.calls[0]?.[1],
    };
    expect(invalidationEntry.data).toEqual(
      expect.objectContaining({ kind: "invalidated", reason: "cache-not-long" }),
    );

    const restore = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: {
          appendCustomEntry: restore,
          getBranch: () => [establishedEntry, invalidationEntry],
        },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        timestamp: evidence.timestamp + 15 * 60_000,
        promptIdentity: "prompt-identity-retention-switch",
        authFingerprint: "auth-fingerprint-retention-switch",
        cacheRead: 80_000,
        cacheWrite: 20_000,
        cacheWrite1h: 20_000,
        promptTokens: 100_000,
      }),
    ).toBe(false);
    expect(restore).toHaveBeenCalledWith(
      PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      expect.objectContaining({ kind: "invalidated", reason: "cache-unconfirmed" }),
    );
  });

  it("does not carry long-cache confirmation across a transcript prefix break", () => {
    const establish = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: establish },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        promptIdentity: "prompt-identity-prefix",
        authFingerprint: "auth-fingerprint-prefix",
      }),
    ).toBe(true);
    const establishedEntry = {
      type: "custom",
      customType: PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      data: establish.mock.calls[0]?.[1],
    };
    const appendCustomEntry = vi.fn();
    const refresh = {
      sessionManager: { appendCustomEntry },
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      ...evidence,
      timestamp: evidence.timestamp + 15 * 60_000,
      promptIdentity: "prompt-identity-prefix",
      authFingerprint: "auth-fingerprint-prefix",
      cacheRead: 90_000,
      cacheWrite: 0,
      cacheWrite1h: 0,
    };

    expect(
      appendMainSessionPromptCacheEvidence({
        ...refresh,
        sessionManager: {
          appendCustomEntry,
          getBranch: () => [establishedEntry, { type: "compaction" }],
        },
      }),
    ).toBe(false);
    expect(
      appendMainSessionPromptCacheEvidence({
        ...refresh,
        sessionManager: { appendCustomEntry, getBranch: () => [] },
      }),
    ).toBe(false);
    expect(appendCustomEntry).toHaveBeenCalledTimes(2);
    expect(appendCustomEntry).toHaveBeenLastCalledWith(
      PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      expect.objectContaining({ kind: "invalidated", reason: "cache-unconfirmed" }),
    );
  });

  it("rejects an unproven read and any keeper identity drift", () => {
    const appendCustomEntry = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        promptIdentity: "prompt-identity-unproven",
        authFingerprint: "auth-fingerprint-unproven",
        cacheRead: 90_000,
        cacheWrite: 0,
        cacheWrite1h: 0,
      }),
    ).toBe(false);
    expect(appendCustomEntry).toHaveBeenCalledWith(
      PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      expect.objectContaining({ kind: "invalidated", reason: "cache-unconfirmed" }),
    );

    const established = vi.fn();
    appendMainSessionPromptCacheEvidence({
      sessionManager: { appendCustomEntry: established },
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      ...evidence,
      promptIdentity: "prompt-identity-drift",
      authFingerprint: "auth-fingerprint-drift",
    });
    const written = established.mock.calls[0]?.[1] as { evidenceId: string };
    expect(() =>
      assertMainSessionCacheKeeperIdentity({
        evidenceId: written.evidenceId,
        promptIdentity: "changed-prompt",
        authFingerprint: "auth-fingerprint-drift",
      }),
    ).toThrow(/prompt-or-credential-identity-changed/);
    expect(() =>
      assertMainSessionCacheKeeperIdentity({
        evidenceId: written.evidenceId,
        promptIdentity: "prompt-identity-drift",
        authFingerprint: "changed-auth",
      }),
    ).toThrow(/prompt-or-credential-identity-changed/);
    expect(() =>
      assertMainSessionCacheKeeperProviderIdentity({
        evidenceId: written.evidenceId,
        providerCachePrefixIdentity: evidence.providerCachePrefixIdentity,
        requestOptionsIdentity: "changed-request-options",
        providerMessageLongCachePrefixIndex: 1,
        providerMessagePrefixIdentities: ["empty", evidence.providerMessageIdentity],
        providerMessageTokenUpperBounds: [100],
      }),
    ).toThrow(/provider-payload-identity-changed/);
    let continuationFailure: unknown;
    try {
      assertMainSessionCacheKeeperProviderIdentity({
        evidenceId: written.evidenceId,
        providerCachePrefixIdentity: "changed-provider-prefix",
        requestOptionsIdentity: evidence.requestOptionsIdentity,
        providerMessageLongCachePrefixIndex: 1,
        providerMessagePrefixIdentities: ["empty", evidence.providerMessageIdentity],
        providerMessageTokenUpperBounds: [100],
        replaySafe: false,
      });
    } catch (error) {
      continuationFailure = error;
    }
    expect(continuationFailure).toMatchObject({
      reason: "provider-payload-identity-changed",
      replaySafe: false,
    });

    let coverageFailure: unknown;
    try {
      assertMainSessionCacheKeeperProviderIdentity({
        evidenceId: written.evidenceId,
        providerCachePrefixIdentity: evidence.providerCachePrefixIdentity,
        requestOptionsIdentity: evidence.requestOptionsIdentity,
        providerMessageLongCachePrefixIndex: 2,
        providerMessagePrefixIdentities: ["empty", evidence.providerMessageIdentity, "candidate"],
        providerMessageTokenUpperBounds: [100, 3_918],
        replaySafe: false,
      });
    } catch (error) {
      coverageFailure = error;
    }
    expect(coverageFailure).toMatchObject({ reason: "message-prefix-diverged", replaySafe: false });

    expect(() =>
      assertMainSessionCacheKeeperProviderIdentity({
        evidenceId: written.evidenceId,
        providerCachePrefixIdentity: evidence.providerCachePrefixIdentity,
        requestOptionsIdentity: evidence.requestOptionsIdentity,
        providerMessageLongCachePrefixIndex: 1,
        providerMessagePrefixIdentities: ["empty", "different-message-prefix"],
        providerMessageTokenUpperBounds: [1],
      }),
    ).toThrow(/message-prefix-diverged/);
    expect(() =>
      assertMainSessionCacheKeeperProviderIdentity({
        evidenceId: written.evidenceId,
        providerCachePrefixIdentity: evidence.providerCachePrefixIdentity,
        requestOptionsIdentity: evidence.requestOptionsIdentity,
        providerMessageLongCachePrefixIndex: 1,
        providerMessagePrefixIdentities: ["empty", evidence.providerMessageIdentity],
        providerMessageTokenUpperBounds: [],
      }),
    ).toThrow(/message-prefix-diverged/);
    expect(() =>
      assertMainSessionCacheKeeperProviderIdentity({
        evidenceId: written.evidenceId,
        providerCachePrefixIdentity: evidence.providerCachePrefixIdentity,
        requestOptionsIdentity: evidence.requestOptionsIdentity,
        providerMessagePrefixIdentities: ["empty", evidence.providerMessageIdentity],
        providerMessageTokenUpperBounds: [1],
      }),
    ).toThrow(/message-prefix-diverged/);
  });

  it("requires the admitted keeper turn to remain the only child of its preflight leaf", () => {
    expect(() =>
      assertMainSessionCacheKeeperTranscriptAnchor({
        currentLeaf: {
          id: "heartbeat-user",
          parentId: "preflight-leaf",
          type: "message",
          message: { role: "user" },
        },
        expectedParentId: "preflight-leaf",
        persistedUserMessageId: "heartbeat-user",
      }),
    ).not.toThrow();
    expect(() =>
      assertMainSessionCacheKeeperTranscriptAnchor({
        currentLeaf: {
          id: "intervening-turn",
          parentId: "heartbeat-user",
          type: "message",
          message: { role: "user" },
        },
        expectedParentId: "preflight-leaf",
        persistedUserMessageId: "heartbeat-user",
      }),
    ).toThrow(/transcript-anchor-changed/);
  });

  it("does not confirm a one-hour entry when transcript persistence fails", () => {
    expect(() =>
      appendMainSessionPromptCacheEvidence({
        sessionManager: {
          appendCustomEntry: () => {
            throw new Error("transcript unavailable");
          },
        },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        promptIdentity: "prompt-identity-failed-write",
        authFingerprint: "auth-fingerprint-failed-write",
      }),
    ).toThrow("transcript unavailable");

    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry: vi.fn() },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        timestamp: evidence.timestamp + 15 * 60_000,
        promptIdentity: "prompt-identity-failed-write",
        authFingerprint: "auth-fingerprint-failed-write",
        cacheRead: 90_000,
        cacheWrite: 0,
        cacheWrite1h: 0,
      }),
    ).toBe(false);
  });

  it("does not persist evidence for isolated or channel sessions", () => {
    const appendCustomEntry = vi.fn();

    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main:heartbeat",
        ...evidence,
      }),
    ).toBe(false);
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("does not let an actionable heartbeat establish main-dialogue evidence", () => {
    const appendCustomEntry = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        ...evidence,
        runKind: "heartbeat",
      }),
    ).toBe(false);
    expect(appendCustomEntry).toHaveBeenCalledWith(
      PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
      expect.objectContaining({ kind: "invalidated", reason: "keeper-unverified" }),
    );
  });

  it("rejects non-cache and malformed evidence", () => {
    const valid = {
      evidenceId: "evidence-1",
      ...evidence,
      confirmedCachedTokens: 90_000,
    };
    expect(readPromptCacheEvidenceData({ ...valid, confirmedCachedTokens: 0 })).toBeUndefined();
    expect(readPromptCacheEvidenceData({ ...valid, cacheRetention: "none" })).toBeUndefined();
    expect(
      readPromptCacheEvidenceData({ ...valid, providerCachePrefixIdentity: "" }),
    ).toBeUndefined();
    expect(readPromptCacheEvidenceData({ ...valid, requestOptionsIdentity: "" })).toBeUndefined();
    expect(readPromptCacheEvidenceData({ ...valid, providerMessageIdentity: "" })).toBeUndefined();
  });
});
