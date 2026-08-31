import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { PREVIEW_SECURITY_HEADERS } from "./revision-preview.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);

    const craftedRead = await app.inject({ method: "GET", url: "/api/agents?x=/previews/00000000-0000-4000-8000-000000000001/content/" });
    const craftedMutation = await app.inject({ method: "POST", url: "/api/agents?x=/previews/00000000-0000-4000-8000-000000000001/content/", payload: { name: "bypass" } });
    expect(craftedRead.statusCode).toBe(401);
    expect(craftedMutation.statusCode).toBe(401);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("uses the strict role-based Mission boundary", async () => {
    const calls: unknown[] = [];
    const missions = {
      listMissions: () => [],
      getMission: () => ({}) ,
      createMission: (input: unknown) => { calls.push(input); return Promise.resolve({ id: "mission" }); },
      startMission: () => Promise.reject(new (class extends Error { statusCode = 409; code = "MISSION_STAGE_UNAVAILABLE"; details = { stage: "design" }; })()),
      recover: () => Promise.resolve({}),
    } as any;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, missions);
    const id = "00000000-0000-4000-8000-000000000001";
    const obsoleteField = "participant" + "AgentIds";
    const obsolete = await app.inject({ method: "POST", url: "/api/missions", payload: { goal: "x", [obsoleteField]: [id] } });
    expect(obsolete.statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/api/missions", payload: { goal: "x", sourceAgentId: id, designerAgentId: id, builderAgentId: id } });
    expect(created.statusCode).toBe(201); expect(calls).toHaveLength(1);
    await app.close();
  });

  it("exposes narrow server-side design feedback and approval actions", async () => {
    const calls: string[] = [];
    const missions = {
      submitDesignFeedback: (missionId: string, revisionId: string, feedback: string) => { calls.push(`feedback:${missionId}:${revisionId}:${feedback}`); return Promise.resolve({ ok: true }); },
      approveDesignRevision: (missionId: string, revisionId: string, reviewedSurfaceIds: string[]) => { calls.push(`approve:${missionId}:${revisionId}:${reviewedSurfaceIds.join(',')}`); return Promise.resolve({ ok: true }); },
      getDesignReference: () => Promise.resolve({ revision: {}, previewHtml: "", contractJson: "{}" }),
    } as any;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, missions);
    const missionId = "00000000-0000-4000-8000-000000000001";
    const revisionId = "00000000-0000-4000-8000-000000000002";
    const feedback = await app.inject({ method: "POST", url: `/api/missions/${missionId}/design-revisions/${revisionId}/feedback`, payload: { feedback: "Make the heading clearer" } });
    const approval = await app.inject({ method: "POST", url: `/api/missions/${missionId}/design-revisions/${revisionId}/approve`, payload: { reviewedSurfaceIds: ['home'] } });
    const malformed = await app.inject({ method: "POST", url: `/api/missions/${missionId}/design-revisions/${revisionId}/approve`, payload: { approved: true } });
    expect(feedback.statusCode).toBe(200); expect(approval.statusCode).toBe(200); expect(malformed.statusCode).toBe(400); expect(calls).toEqual([`feedback:${missionId}:${revisionId}:Make the heading clearer`, `approve:${missionId}:${revisionId}:home`]);
    await app.close();
  });

  it("rejects implementation authority fields at the shared start boundary", async () => {
    const missions = { startMission: () => Promise.resolve({ mission: { status: 'paused' } }) } as any;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, missions);
    const missionId = "00000000-0000-4000-8000-000000000001";
    const injected = await app.inject({ method: "POST", url: `/api/missions/${missionId}/start`, payload: { stage: "implement", revisionId: "00000000-0000-4000-8000-000000000002" } });
    const empty = await app.inject({ method: "POST", url: `/api/missions/${missionId}/start`, payload: {} });
    expect(injected.statusCode).toBe(400); expect(empty.statusCode).toBe(202);
    await app.close();
  });

  it("issues a partitioned HttpOnly preview cookie and credentials opaque sandbox content without the API bearer", async () => {
    const missionId = "00000000-0000-4000-8000-000000000001"; const revisionId = "00000000-0000-4000-8000-000000000002"; const designRevisionId = "00000000-0000-4000-8000-000000000004"; const sessionId = "00000000-0000-4000-8000-000000000003"; const token = "opaque-token";
    const previewHtml = '<link rel="stylesheet" href="./styles.css"><script type="module" crossorigin src="./app.js"></script><img src="./logo.svg"><main/>';
    const missions = { createPreview: () => Promise.resolve({ session: { id: sessionId, missionId, target: { kind: 'workspace', revisionId }, profile: 'static-html', contentPath: `/api/missions/${missionId}/previews/${sessionId}/content/`, expiresAt: new Date(Date.now() + 300_000).toISOString() }, token }), getPreviewAsset: (_mission: string, _session: string, supplied: string) => supplied === token ? Promise.resolve({ bytes: Buffer.from(previewHtml), mediaType: 'text/html; charset=utf-8', headers: PREVIEW_SECURITY_HEADERS }) : Promise.reject(new Error('denied')) } as any;
    const app = await createApp(loadConfig({ NODE_ENV: 'test', APP_AUTH_TOKEN: 'a-strong-test-token' }), service, missions);
    const created = await app.inject({ method: 'POST', url: `/api/missions/${missionId}/previews`, headers: { authorization: 'Bearer a-strong-test-token' }, payload: { kind: 'workspace', revisionId, designRevisionId } });
    expect(created.statusCode).toBe(201);
    const cookie = created.headers['set-cookie'];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Partitioned');
    expect(cookie).toContain(`/previews/${sessionId}/content/`);
    expect(cookie).not.toContain('SameSite=Strict');

    const denied = await app.inject({ method: 'GET', url: `/api/missions/${missionId}/previews/${sessionId}/content/` });
    expect(denied.statusCode).not.toBe(200);

    const content = await app.inject({ method: 'GET', url: `/api/missions/${missionId}/previews/${sessionId}/content/`, headers: { cookie: `conductor_preview_${sessionId}=${token}`, host: 'localhost:5173' } });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-security-policy']).toContain("connect-src 'none'");
    const scopedContentUrl = `http://localhost:5173/api/missions/${missionId}/previews/${sessionId}/content/`;
    expect(content.headers['content-security-policy']?.split(scopedContentUrl)).toHaveLength(6);
    expect(content.headers['access-control-allow-origin']).toBe('null');
    expect(content.headers['access-control-allow-credentials']).toBe('true');
    expect(content.body).toContain('<link rel="stylesheet" href="./styles.css" crossorigin="use-credentials">');
    expect(content.body).toContain('<script type="module" crossorigin="use-credentials" src="./app.js"></script>');
    expect(content.body).toContain('<img src="./logo.svg" crossorigin="use-credentials">');
    await app.close();
  });
});
