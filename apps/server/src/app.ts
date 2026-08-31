import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { MissionService } from "./mission-service.js";
import { credentializePreviewHtml, scopePreviewAssetSecurityHeaders } from "./revision-preview.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).optional(), instructions: z.string().max(10_000).optional() });
const updateAgentBody = createAgentBody.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
const messageBody = z.object({ content: z.string().trim().min(1).max(50_000), requestId: z.string().uuid().optional() }).strict();
const impactParams = z.object({ id: z.string().uuid(), admissionId: z.string().uuid() });
const impactConfirmationBody = z.object({ choice: z.enum(['governed', 'nonvisual']) }).strict();
const missionBody = z.object({ goal: z.string().trim().min(1).max(8_192), sourceAgentId: z.string().uuid(), designerAgentId: z.string().uuid(), builderAgentId: z.string().uuid(), tokenBudget: z.number().int().positive().safe().max(1_000_000_000).nullable().optional() }).strict();
const recoveryRequest = z.discriminatedUnion("action", [
  z.object({ requestId: z.string().uuid(), action: z.literal("resume"), taskId: z.string().uuid() }),
  z.object({ requestId: z.string().uuid(), action: z.literal("retry_current"), taskId: z.string().uuid() }),
  z.object({ requestId: z.string().uuid(), action: z.literal("rollback_and_retry"), taskId: z.string().uuid(), revisionId: z.string().uuid() }),
  z.object({ requestId: z.string().uuid(), action: z.literal("intervene_and_retry"), taskId: z.string().uuid(), note: z.string().trim().min(1).max(4_096) }),
  z.object({ requestId: z.string().uuid(), action: z.literal("stop_preserve") }),
  z.object({ requestId: z.string().uuid(), action: z.literal("stop_restore"), revisionId: z.string().uuid() }),
]);
const feedbackBody = z.object({ feedback: z.string().trim().min(1).max(16_384) }).strict();
const approvalBody = z.object({ reviewedSurfaceIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1).max(8) }).strict();
const startMissionBody = z.object({}).strict();
const verifyMissionBody = z.object({}).strict();
const implementationReviewBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept") }).strict(),
  z.object({ decision: z.literal("request_changes"), feedback: z.string().trim().min(1).max(4_096) }).strict(),
]);
const previewBody = z.discriminatedUnion("kind", [z.object({ kind: z.literal("design"), revisionId: z.string().uuid() }).strict(), z.object({ kind: z.literal("workspace"), revisionId: z.string().uuid(), designRevisionId: z.string().uuid() }).strict()]);
const previewParams = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() });
const previewContentPath = /^\/api\/(?:missions|agents)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/previews\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/content\/(?:.*)?$/i;

export async function createApp(config: AppConfig, service: AgentService, missions?: MissionService): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] }, bodyLimit: 1_048_576 });

  await app.register(cors, { origin: config.nodeEnv === "development" ? ["http://localhost:5173", "http://127.0.0.1:5173"] : false });

  app.addHook("onRequest", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const cookieAuthenticatedPreviewContent = request.method === "GET" && previewContentPath.test(pathname);
    if (!config.authToken || !pathname.startsWith("/api/") || pathname === "/api/health" || pathname === "/api/auth" || cookieAuthenticatedPreviewContent) return;
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid = candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) return reply.code(401).send({ error: "Authentication required" });
  });

  app.get("/api/health", async () => ({ ok: true, service: "volc-agent-launchpad" }));
  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));
  app.get("/api/system", async () => service.systemInfo());
  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents/:id/previews", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const { id } = agentIdParams.parse(request.params);
    const secure = config.nodeEnv === "production" && !new Set(["127.0.0.1", "::1", "localhost"]).has(config.host);
    if (secure && !request.protocol.startsWith("https")) throw new HttpError(503, "Preview requires TLS");
    const created = await missions.createAgentPreview(id);
    return reply.header("set-cookie", `conductor_preview_${created.session.id}=${created.token}; HttpOnly; SameSite=None; Secure; Partitioned; Path=${created.session.contentPath}; Max-Age=300`).code(201).send({ session: { id: created.session.id, agentId: id, workspaceHash: created.session.target.kind === 'agent' ? created.session.target.workspaceHash : '', profile: created.session.profile, contentPath: created.session.contentPath, expiresAt: created.session.expiresAt, previewDataHash: created.session.previewDataHash } });
  });
  app.delete("/api/agents/:id/previews/:sessionId", async (request, reply) => { if (!missions) throw new HttpError(503, "Mission service unavailable"); const params = previewParams.parse(request.params); await missions.stopAgentPreview(params.id, params.sessionId); return reply.code(204).send(); });
  app.get("/api/agents/:id/previews/:sessionId/content/*", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const params = previewParams.extend({ '*': z.string() }).parse(request.params);
    const cookies = Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
    const token = cookies[`conductor_preview_${params.sessionId}`] ?? '';
    const asset = await missions.getAgentPreviewAsset(params.id, params.sessionId, token, params['*']);
    const body = asset.mediaType.startsWith('text/html') ? Buffer.from(credentializePreviewHtml(asset.bytes.toString('utf8')), 'utf8') : asset.bytes;
    const host = request.headers.host;
    if (!host) throw new HttpError(400, 'Preview request host is required');
    const contentUrl = new URL(`/api/agents/${params.id}/previews/${params.sessionId}/content/`, `${request.protocol}://${host}`).toString();
    const securityHeaders = asset.mediaType.startsWith('text/html') ? scopePreviewAssetSecurityHeaders(asset.headers, contentUrl) : asset.headers;
    return reply.code(asset.status ?? 200).headers({ ...securityHeaders, 'content-type': asset.mediaType, 'access-control-allow-origin': 'null', 'access-control-allow-credentials': 'true' }).send(body);
  });

  app.get("/api/missions", async () => ({ missions: missions?.listMissions() ?? [], summaries: missions?.listMissionSummaries() ?? [], agentAvailability: missions?.listAgentAvailability() ?? [] }));
  app.get("/api/missions/:id", async (request) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    return missions.getMissionWithHistory(id);
  });
  app.get("/api/missions/:id/evidence/:artifactId", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const params = z.object({ id: z.string().uuid(), artifactId: z.string().uuid() }).parse(request.params);
    const evidence = await missions.getEvidence(params.id, params.artifactId);
    return reply.headers({ "content-type": evidence.mediaType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" }).send(evidence.bytes);
  });
  app.post("/api/missions/:id/previews", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const id = z.string().uuid().parse((request.params as { id: string }).id); const target = previewBody.parse(request.body); const secure = config.nodeEnv === "production" && !new Set(["127.0.0.1", "::1", "localhost"]).has(config.host); if (secure && !request.protocol.startsWith("https")) throw new HttpError(503, "Preview requires TLS"); const created = await missions.createPreview(id, target);
    return reply.header("set-cookie", `conductor_preview_${created.session.id}=${created.token}; HttpOnly; SameSite=None; Secure; Partitioned; Path=${created.session.contentPath}; Max-Age=300`).code(201).send({ session: created.session });
  });
  app.get("/api/missions/:id/previews/:sessionId", async (request) => { if (!missions) throw new HttpError(503, "Mission service unavailable"); const params = previewParams.parse(request.params); return { session: await missions.getPreview(params.id, params.sessionId) }; });
  app.delete("/api/missions/:id/previews/:sessionId", async (request, reply) => { if (!missions) throw new HttpError(503, "Mission service unavailable"); const params = previewParams.parse(request.params); await missions.stopPreview(params.id, params.sessionId); return reply.code(204).send(); });
  app.get("/api/missions/:id/previews/:sessionId/content/*", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const params = previewParams.extend({ '*': z.string() }).parse(request.params);
    const cookies = Object.fromEntries(String(request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
    const token = cookies[`conductor_preview_${params.sessionId}`] ?? '';
    const asset = await missions.getPreviewAsset(params.id, params.sessionId, token, params['*']);
    const body = asset.mediaType.startsWith('text/html') ? Buffer.from(credentializePreviewHtml(asset.bytes.toString('utf8')), 'utf8') : asset.bytes;
    const host = request.headers.host;
    if (!host) throw new HttpError(400, 'Preview request host is required');
    const contentUrl = new URL(`/api/missions/${params.id}/previews/${params.sessionId}/content/`, `${request.protocol}://${host}`).toString();
    const securityHeaders = asset.mediaType.startsWith('text/html') ? scopePreviewAssetSecurityHeaders(asset.headers, contentUrl) : asset.headers;
    return reply.code(asset.status ?? 200).headers({ ...securityHeaders, 'content-type': asset.mediaType, 'access-control-allow-origin': 'null', 'access-control-allow-credentials': 'true' }).send(body);
  });
  app.addHook('onClose', async () => { await missions?.shutdown?.(); });
  app.post("/api/missions", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const body = missionBody.parse(request.body);
    return reply.code(201).send({ mission: await missions.createMission(body) });
  });
  app.post("/api/missions/:id/start", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    startMissionBody.parse(request.body ?? {});
    return reply.code(202).send(await missions.startMission(id));
  });
  app.post("/api/missions/:id/verify", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    verifyMissionBody.parse(request.body ?? {});
    return reply.code(202).send(await missions.verifyMission(id));
  });
  app.post("/api/missions/:id/workspace-publication/retry", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    verifyMissionBody.parse(request.body ?? {});
    return reply.code(202).send(await missions.retryWorkspacePublication(id));
  });
  app.post("/api/missions/:id/implementation-review", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const body = implementationReviewBody.parse(request.body);
    return reply.code(202).send(await missions.reviewImplementation(id, body));
  });
  app.post("/api/missions/:id/recovery", async (request, reply) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const body = recoveryRequest.parse(request.body);
    return reply.code(202).send(await missions.recover(id, body));
  });
  app.post("/api/missions/:id/design-revisions/:revisionId/feedback", async (request) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const params = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    const body = feedbackBody.parse(request.body);
    return missions.submitDesignFeedback(params.id, params.revisionId, body.feedback);
  });
  app.post("/api/missions/:id/design-revisions/:revisionId/approve", async (request) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const params = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    const body = approvalBody.parse(request.body);
    return missions.approveDesignRevision(params.id, params.revisionId, body.reviewedSurfaceIds);
  });
  app.get("/api/missions/:id/design-revisions/:revisionId/reference", async (request) => {
    if (!missions) throw new HttpError(503, "Mission service unavailable");
    const params = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    return missions.getDesignReference(params.id, params.revisionId);
  });

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });
  app.get("/api/agents/:id", async (request) => { const { id } = agentIdParams.parse(request.params); return { agent: service.getAgent(id) }; });
  app.patch("/api/agents/:id", async (request) => { const { id } = agentIdParams.parse(request.params); const body = updateAgentBody.parse(request.body); return { agent: await service.updateAgent(id, body) }; });
  app.delete("/api/agents/:id", async (request) => { const { id } = agentIdParams.parse(request.params); return service.deleteAgent(id); });
  app.post("/api/agents/:id/start", async (request) => { const { id } = agentIdParams.parse(request.params); return { agent: await service.startAgent(id) }; });
  app.post("/api/agents/:id/stop", async (request) => { const { id } = agentIdParams.parse(request.params); return { agent: await service.stopAgent(id) }; });
  app.get("/api/agents/:id/messages", async (request) => { const { id } = agentIdParams.parse(request.params); return { messages: service.getMessages(id) }; });
  app.get("/api/agents/:id/runs", async (request) => { const { id } = agentIdParams.parse(request.params); return { runs: service.getRuns(id) }; });
  app.get("/api/agents/:id/impact-admissions", async (request) => { const { id } = agentIdParams.parse(request.params); return { admissions: service.listImpactAdmissions(id) }; });
  app.post("/api/agents/:id/impact-admissions/:admissionId/confirm", async (request, reply) => { const { id, admissionId } = impactParams.parse(request.params); const { choice } = impactConfirmationBody.parse(request.body); return reply.code(202).send({ admission: await service.confirmImpactAdmission(id, admissionId, choice) }); });
  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendGovernedMessage(id, body.content, body.requestId);
    return reply.code(202).send(result);
  });
  app.get("/api/runs/:id", async (request) => { const { id } = runIdParams.parse(request.params); return { run: service.getRun(id) }; });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "API route not found" });
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
    const statusCode = error instanceof HttpError ? error.statusCode : validationError ? 400 : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599 ? frameworkStatus : 500;
    if (statusCode >= 500) request.log.error(appError);
    return reply.code(statusCode).send({ error: appError.message, ...((error instanceof HttpError && error.code) ? { code: error.code, ...(error.details ?? {}) } : {}), ...(validationError ? { details: error.issues } : {}) });
  });

  return app;
}
