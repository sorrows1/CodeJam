export interface EvidenceBinding {
  missionId: string;
  selectionId: string | null;
  designRevisionId: string | null;
  workspaceRevisionId: string | null;
}

export interface PreviewSessionBinding {
  missionId: string;
  target: { kind: 'design'; revisionId: string } | { kind: 'workspace'; revisionId: string; designRevisionId: string };
}

export function evidenceBindingKey(binding: EvidenceBinding): string {
  return [binding.missionId, binding.selectionId ?? '-', binding.designRevisionId ?? '-', binding.workspaceRevisionId ?? '-'].join(':');
}

export function previewMatchesBinding(session: PreviewSessionBinding, binding: EvidenceBinding, target: PreviewSessionBinding['target']): boolean {
  return session.missionId === binding.missionId && session.target.kind === target.kind && session.target.revisionId === target.revisionId && (target.kind === 'design' ? binding.designRevisionId === target.revisionId : session.target.kind === 'workspace' && binding.workspaceRevisionId === target.revisionId && binding.designRevisionId === target.designRevisionId && session.target.designRevisionId === target.designRevisionId);
}
