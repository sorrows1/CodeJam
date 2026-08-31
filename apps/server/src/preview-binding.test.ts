import { describe, expect, it } from 'vitest';
import { evidenceBindingKey, previewMatchesBinding } from '../../web/src/missions/preview-binding.js';

describe('evidence preview binding', () => {
  it('changes for Mission, selection, design, or workspace authority changes', () => {
    const base = { missionId: 'mission-a', selectionId: 'run-a', designRevisionId: 'design-a', workspaceRevisionId: 'workspace-a' };
    const key = evidenceBindingKey(base);
    expect(evidenceBindingKey({ ...base, missionId: 'mission-b' })).not.toBe(key);
    expect(evidenceBindingKey({ ...base, selectionId: 'run-b' })).not.toBe(key);
    expect(evidenceBindingKey({ ...base, designRevisionId: 'design-b' })).not.toBe(key);
    expect(evidenceBindingKey({ ...base, workspaceRevisionId: 'workspace-b' })).not.toBe(key);
  });

  it('never accepts a session for a different Mission or immutable target', () => {
    const binding = { missionId: 'mission-a', selectionId: 'run-a', designRevisionId: 'design-a', workspaceRevisionId: 'workspace-a' };
    const target = { kind: 'workspace' as const, revisionId: 'workspace-a', designRevisionId: 'design-a' };
    expect(previewMatchesBinding({ missionId: 'mission-a', target }, binding, target)).toBe(true);
    expect(previewMatchesBinding({ missionId: 'mission-b', target }, binding, target)).toBe(false);
    expect(previewMatchesBinding({ missionId: 'mission-a', target: { ...target, revisionId: 'workspace-b' } }, binding, target)).toBe(false);
    expect(previewMatchesBinding({ missionId: 'mission-a', target: { kind: 'design', revisionId: 'design-a' } }, binding, target)).toBe(false);
  });
});
