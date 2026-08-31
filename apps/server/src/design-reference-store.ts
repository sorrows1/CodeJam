import type { DesignRevision, MissionArtifact } from './types.js';

export type DesignReferenceKind = 'package' | 'preview' | 'contract';
export interface DesignReferenceDescriptor {
  missionId: string;
  revisionId: string;
  kind: DesignReferenceKind;
  key: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
}
export interface DesignReferenceMaterialization {
  package: DesignReferenceDescriptor;
  preview: DesignReferenceDescriptor;
  contract: DesignReferenceDescriptor;
}

export type DesignReferenceResolution =
  | { ok: true; materialization: DesignReferenceMaterialization }
  | { ok: false; reason: 'reference_artifacts_missing' | 'reference_binding_invalid' };

const sha256 = /^[0-9a-f]{64}$/i;
const descriptorDefinitions: Record<DesignReferenceKind, { artifactId: keyof Pick<DesignRevision, 'packageArtifactId' | 'previewArtifactId' | 'contractArtifactId'>; artifactKind: MissionArtifact['kind']; mediaType: string }> = {
  package: { artifactId: 'packageArtifactId', artifactKind: 'design_package', mediaType: 'application/json' },
  preview: { artifactId: 'previewArtifactId', artifactKind: 'design_preview', mediaType: 'text/html' },
  contract: { artifactId: 'contractArtifactId', artifactKind: 'design_contract', mediaType: 'application/json' },
};

export function resolveDesignReferenceMaterialization(input: { revision: DesignRevision; artifacts: readonly MissionArtifact[] }): DesignReferenceResolution {
  if (typeof input.revision.missionId !== 'string' || !input.revision.missionId || typeof input.revision.id !== 'string' || !input.revision.id) return { ok: false, reason: 'reference_binding_invalid' };
  const result = {} as DesignReferenceMaterialization;
  for (const kind of Object.keys(descriptorDefinitions) as DesignReferenceKind[]) {
    const definition = descriptorDefinitions[kind];
    const artifact = input.artifacts.find((candidate) => candidate.id === input.revision[definition.artifactId]);
    if (!artifact) return { ok: false, reason: 'reference_artifacts_missing' };
    const expectedHash = kind === 'package' ? input.revision.packageHash : kind === 'preview' ? input.revision.previewHash : input.revision.contractHash;
    if (typeof expectedHash !== 'string' || !sha256.test(expectedHash) || artifact.missionId !== input.revision.missionId || artifact.taskId !== input.revision.sourceTaskId || artifact.attemptId !== input.revision.sourceAttemptId || artifact.kind !== definition.artifactKind || artifact.storage.kind !== 'external' || artifact.content !== null || artifact.mediaType !== definition.mediaType || !Number.isSafeInteger(artifact.originalByteLength) || artifact.originalByteLength < 0 || !sha256.test(artifact.sha256) || artifact.sha256.toLowerCase() !== expectedHash.toLowerCase() || artifact.storage.key !== `design-reference-${input.revision.missionId}-${input.revision.id}-${kind}`) return { ok: false, reason: 'reference_binding_invalid' };
    result[kind] = { missionId: input.revision.missionId, revisionId: input.revision.id, kind, key: artifact.storage.key, sha256: artifact.sha256, byteLength: artifact.originalByteLength, mediaType: artifact.mediaType };
  }
  return { ok: true, materialization: result };
}

export interface DesignReferenceStore {
  initialize(): Promise<void>;
  materialize(input: { missionId: string; revisionId: string; packageJson: string; previewHtml: string; contractJson: string }): Promise<DesignReferenceMaterialization>;
  verify(materialization: DesignReferenceMaterialization): Promise<boolean>;
  verifySync(materialization: DesignReferenceMaterialization): boolean;
  read(descriptor: DesignReferenceDescriptor, maxBytes: number): Promise<string>;
}
