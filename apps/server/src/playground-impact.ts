import type { PlaygroundImpactDecision, PlaygroundImpactProposal } from './types.js';
import { classifyChangedPath, type RepositoryFrameworkFacts } from './workspace-projection.js';

const MAX_ARRAY = 64;
const MAX_STRING_BYTES = 512;
const MAX_SURFACES = 8;
const portablePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._@+\-/]+$/;
const surfaceId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const frontendExtension = /\.(?:css|scss|sass|less|html|jsx|tsx|vue|svelte)$/i;
const frontendSegment = /(?:^|\/)(?:app|pages|routes|views|components|layouts?|navigation|ui)(?:\/|$)/i;
const visualIntent = /\b(?:ui|ux|visual|layout|style|styling|color|font|spacing|responsive|page|screen|navigation|navbar|sidebar|modal|dialog|form|button|component|accessibility|interaction|animation|display|frontend|front-end)\b/i;
const nonActionableConversation = /^(?:(?:hi|hello|hey|hiya|howdy|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|ok|okay|great|nice|cool)(?:\s+there)?|how\s+are\s+you|what\s+can\s+you\s+do|what\s+did\s+we\s+just\s+do|tell\s+me\s+what\s+changed)[\s!,.?]*$/i;

export const PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE: PlaygroundImpactProposal = {
  routes: ['/settings', '/agents'],
  entrypoints: ['src/App.tsx'],
  sharedLayouts: ['src/Sidebar.tsx'],
  componentDependencies: ['src/Settings.tsx'],
  predictedWritePaths: ['src/Settings.tsx', 'src/Sidebar.tsx'],
  surfaces: [
    {
      id: 'settings',
      route: '/settings',
      entrypoint: 'src/App.tsx',
      sourcePaths: ['src/Settings.tsx'],
      sharedDependencies: ['src/Sidebar.tsx'],
      states: ['default', 'saving'],
      viewport: { width: 1440, height: 900 },
    },
    {
      id: 'agents',
      route: '/agents',
      entrypoint: 'src/App.tsx',
      sourcePaths: ['src/Agents.tsx'],
      sharedDependencies: ['src/Sidebar.tsx'],
      states: ['default'],
      viewport: { width: 1440, height: 900 },
    },
  ],
  effects: { visual: true, interaction: true, accessibility: true, display: true },
  evidence: ['The request changes a shared navigation component and adds a routed page.'],
  uncertainty: 'low',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > MAX_STRING_BYTES) throw new Error(`Invalid impact proposal ${label}`);
  return value.trim();
}

function strings(value: unknown, label: string, paths = false): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY) throw new Error(`Invalid impact proposal ${label}`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`Duplicate impact proposal ${label}`);
  if (paths && result.some((item) => !portablePath.test(item))) throw new Error(`Invalid impact proposal ${label} path`);
  return result;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`Invalid impact proposal ${label} properties`);
}

function parseJsonOutput(output: string): unknown {
  if (bytes(output) > 64 * 1024) throw new Error('Impact proposal exceeds its output bound');
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

export function parsePlaygroundImpactProposal(output: string): PlaygroundImpactProposal {
  const source = parseJsonOutput(output);
  if (!isRecord(source)) throw new Error('Impact proposal must be an object');
  exactKeys(source, ['routes', 'entrypoints', 'sharedLayouts', 'componentDependencies', 'predictedWritePaths', 'surfaces', 'effects', 'evidence', 'uncertainty'], 'root');
  if (!isRecord(source.effects)) throw new Error('Invalid impact proposal effects');
  exactKeys(source.effects, ['visual', 'interaction', 'accessibility', 'display'], 'effects');
  const effects = {
    visual: source.effects.visual,
    interaction: source.effects.interaction,
    accessibility: source.effects.accessibility,
    display: source.effects.display,
  };
  if (Object.values(effects).some((value) => typeof value !== 'boolean')) throw new Error('Invalid impact proposal effects');
  if (!Array.isArray(source.surfaces) || source.surfaces.length > MAX_SURFACES) throw new Error('Invalid impact proposal surfaces');
  const surfaces = source.surfaces.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.viewport)) throw new Error(`Invalid impact proposal surfaces[${index}]`);
    exactKeys(item, ['id', 'route', 'entrypoint', 'sourcePaths', 'sharedDependencies', 'states', 'viewport'], `surfaces[${index}]`);
    exactKeys(item.viewport, ['width', 'height'], `surfaces[${index}].viewport`);
    const id = text(item.id, `surfaces[${index}].id`);
    const route = text(item.route, `surfaces[${index}].route`);
    const entrypoint = text(item.entrypoint, `surfaces[${index}].entrypoint`);
    if (!surfaceId.test(id) || !route.startsWith('/') || route.includes('..') || !portablePath.test(entrypoint)) throw new Error(`Invalid impact proposal surfaces[${index}] binding`);
    const width = item.viewport.width;
    const height = item.viewport.height;
    if (!Number.isSafeInteger(width) || (width as number) < 800 || (width as number) > 1920 || !Number.isSafeInteger(height) || (height as number) < 600 || (height as number) > 1200) throw new Error(`Invalid impact proposal surfaces[${index}] desktop viewport`);
    return { id, route, entrypoint, sourcePaths: strings(item.sourcePaths, `surfaces[${index}].sourcePaths`, true), sharedDependencies: strings(item.sharedDependencies, `surfaces[${index}].sharedDependencies`, true), states: strings(item.states, `surfaces[${index}].states`), viewport: { width: width as number, height: height as number } };
  });
  if (new Set(surfaces.map((item) => item.id)).size !== surfaces.length || new Set(surfaces.map((item) => item.route)).size !== surfaces.length) throw new Error('Duplicate impact proposal surface');
  const uncertainty = source.uncertainty;
  if (!['low', 'medium', 'high'].includes(String(uncertainty))) throw new Error('Invalid impact proposal uncertainty');
  return {
    routes: strings(source.routes, 'routes'),
    entrypoints: strings(source.entrypoints, 'entrypoints', true),
    sharedLayouts: strings(source.sharedLayouts, 'sharedLayouts', true),
    componentDependencies: strings(source.componentDependencies, 'componentDependencies', true),
    predictedWritePaths: strings(source.predictedWritePaths, 'predictedWritePaths', true),
    surfaces,
    effects: effects as PlaygroundImpactProposal['effects'],
    evidence: strings(source.evidence, 'evidence'),
    uncertainty: uncertainty as PlaygroundImpactProposal['uncertainty'],
  };
}

export interface ImpactAdmissionDecision {
  decision: PlaygroundImpactDecision;
  allowNonvisualConfirmation: boolean;
  reason: string;
}

export function fallbackPlaygroundImpactProposal(reason = 'Read-only impact planning was unavailable.'): PlaygroundImpactProposal {
  return {
    routes: [], entrypoints: [], sharedLayouts: [], componentDependencies: [], predictedWritePaths: [], surfaces: [],
    effects: { visual: false, interaction: false, accessibility: false, display: false },
    evidence: [reason], uncertainty: 'high',
  };
}

export function normalizePlaygroundImpactProposal(prompt: string, proposal: PlaygroundImpactProposal): PlaygroundImpactProposal {
  if (!nonActionableConversation.test(prompt.trim())) return proposal;
  return {
    routes: [], entrypoints: [], sharedLayouts: [], componentDependencies: [], predictedWritePaths: [], surfaces: [],
    effects: { visual: false, interaction: false, accessibility: false, display: false },
    evidence: ['The message is conversational and requests no workspace change.'], uncertainty: 'low',
  };
}

export function isFrontendPath(value: string, facts?: RepositoryFrameworkFacts): boolean {
  return frontendExtension.test(value) || frontendSegment.test(value.replaceAll('\\', '/')) || Boolean(facts && classifyChangedPath(value, facts) === 'frontend');
}

export function decidePlaygroundImpact(input: { prompt: string; proposal: PlaygroundImpactProposal; repositoryPaths: readonly string[]; repositoryFacts?: RepositoryFrameworkFacts }): ImpactAdmissionDecision {
  const repository = new Set(input.repositoryPaths.map((item) => item.replaceAll('\\', '/')));
  const proposalPaths = [...input.proposal.entrypoints, ...input.proposal.sharedLayouts, ...input.proposal.componentDependencies, ...input.proposal.predictedWritePaths, ...input.proposal.surfaces.flatMap((surface) => [surface.entrypoint, ...surface.sourcePaths, ...surface.sharedDependencies])];
  const missingInspectedPath = [...input.proposal.entrypoints, ...input.proposal.sharedLayouts, ...input.proposal.componentDependencies, ...input.proposal.surfaces.flatMap((surface) => [surface.entrypoint, ...surface.sharedDependencies])].find((item) => !repository.has(item));
  const frontendFact = proposalPaths.some((value) => isFrontendPath(value, input.repositoryFacts)) || input.proposal.routes.length > 0 || input.proposal.surfaces.length > 0;
  const effect = Object.values(input.proposal.effects).some(Boolean);
  const deterministicVisual = visualIntent.test(input.prompt);
  if (missingInspectedPath) return { decision: 'confirmation_required', allowNonvisualConfirmation: false, reason: `Conductor could not verify this proposed workspace path: ${missingInspectedPath}` };
  if (frontendFact !== effect) return { decision: 'confirmation_required', allowNonvisualConfirmation: false, reason: 'The repository evidence and the proposed user-facing impact disagree, so Conductor stopped for confirmation.' };
  if (deterministicVisual || frontendFact || effect) return { decision: 'governed', allowNonvisualConfirmation: false, reason: deterministicVisual ? 'The request explicitly describes a user-facing product change.' : 'Repository evidence shows this work changes the user-facing product.' };
  if (input.proposal.uncertainty !== 'low') return { decision: 'confirmation_required', allowNonvisualConfirmation: true, reason: 'Conductor cannot yet prove this is non-UI work. Any continuation stays isolated until the actual changes are known.' };
  return { decision: 'nonvisual', allowNonvisualConfirmation: true, reason: 'No user-facing impact is proven yet. Conductor will run the work in isolation and inspect the complete changes before publishing.' };
}

export function impactProposalPrompt(userPrompt: string, repositoryPaths: readonly string[]): string {
  const paths = repositoryPaths.slice(0, 2_048).join('\n');
  return `You are performing a read-only implementation-impact proposal. Do not write files or run commands that mutate the workspace. Inspect the repository when inspection tools are available, but do not fail merely because a shell is unavailable: the bounded inventory below is trusted server-provided context. Return ONLY one JSON object, with no prose or Markdown fences.\n\nExact schema rules:\n- Root keys are exactly routes, entrypoints, sharedLayouts, componentDependencies, predictedWritePaths, surfaces, effects, evidence, uncertainty.\n- routes, entrypoints, sharedLayouts, componentDependencies, predictedWritePaths, and evidence are arrays of strings, never arrays of objects.\n- Every surface has exactly id, route, entrypoint, sourcePaths, sharedDependencies, states, viewport. id, route, and entrypoint are non-null strings; route is one string, never an array. sourcePaths, sharedDependencies, and states are arrays of strings. viewport has exactly numeric width and height; do not use desktopViewport.\n- All paths are portable repository-relative paths without a leading slash or /workspace prefix. Use only inventory-verified paths for entrypoints, sharedLayouts, componentDependencies, and surface sharedDependencies. New predicted/source paths may be repository-relative paths that do not exist yet.\n- Every route, path, surface, state, and effect must describe a change the user request would cause. Existing repository pages and files are context only; never list them merely because they exist.\n- If the user message is conversational, an acknowledgement, or otherwise requests no workspace change, return empty routes, entrypoints, sharedLayouts, componentDependencies, predictedWritePaths, and surfaces; set every effect to false and uncertainty to low.\n- If repository evidence is insufficient, keep unproven arrays empty and raise uncertainty instead of inventing affected paths.\n- effects has exactly boolean visual, interaction, accessibility, display. uncertainty is exactly low, medium, or high.\n- Represent one shared component affecting multiple routes with separate surface objects using unique ids and routes.\n\nComplete shape example only; replace its paths and facts with inspected repository evidence:\n${JSON.stringify(PLAYGROUND_IMPACT_PROPOSAL_EXAMPLE, null, 2)}\n\nUser request:\n${userPrompt}\n\nBounded repository path inventory:\n${paths}`;
}
