import { describe, expect, it } from 'vitest';
import { parseDesignContract } from './design-contract.js';
import {
  DESIGN_CONTRACT_AUTHORING_EXAMPLE,
  designContractAuthoringGuide,
} from './design-contract-authoring.js';
import { DESIGN_BUNDLE_AUTHORING_EXAMPLE, designBundleAuthoringGuide } from './design-bundle-authoring.js';
import { parseDesignBundleDraft } from './design-package.js';
import { buildImplementationPrompt, buildMissionPrompt, designTaskDefinition, MAX_TASK_BYTES } from './mission-prompt.js';
import type { Mission, MissionTask } from './types.js';

describe('DesignContract authoring guidance', () => {
  it('keeps the canonical example synchronized with the strict parser', () => {
    expect(parseDesignContract(DESIGN_CONTRACT_AUTHORING_EXAMPLE)).toEqual(DESIGN_CONTRACT_AUTHORING_EXAMPLE);
    expect(parseDesignBundleDraft(DESIGN_BUNDLE_AUTHORING_EXAMPLE).surfaces.map((surface) => surface.states)).toEqual([['default', 'saving'], ['default']]);
  });

  it('keeps stable task history separate from the current exact schema protocol', () => {
    const guide = designContractAuthoringGuide();
    const bundleGuide = designBundleAuthoringGuide();
    const instruction = designTaskDefinition().instruction;
    expect(instruction).toContain('Do not modify application source files');
    expect(instruction).toContain('do not claim human approval or Mission completion');
    expect(instruction).not.toContain(guide);
    expect(Buffer.byteLength(instruction, 'utf8')).toBeLessThanOrEqual(MAX_TASK_BYTES);
    const mission = { id: 'mission', goal: 'Build a landing page', participants: [] } as unknown as Mission;
    const task = { ...designTaskDefinition(), id: 'task', missionId: 'mission', stage: 'design', assignedAgentId: 'agent', inputArtifactIds: [] } as unknown as MissionTask;
    const prompt = buildMissionPrompt({ mission, tasks: [task], artifacts: [] }, task);
    expect(prompt).toContain(guide);
    expect(prompt).toContain(bundleGuide);
    expect(prompt.match(/surface contract property as exact DesignContractV1 JSON embedded in design-bundle\.json/g)).toHaveLength(1);
    expect(prompt).toContain('Do not write a separate design-contract.json file');
    expect(prompt.match(/states entries must never be objects/g)).toHaveLength(1);
    expect(prompt).toContain('Treat the Mission goal as the required product change');
    expect(prompt).toContain('Do not merely reproduce the current application');
    expect(prompt).toContain('Do not write /workspace/design-contract.json');
    expect(prompt).toContain('only permitted write is /workspace/.conductor/design-draft/design-bundle.json');
  });

  it('adds the current protocol once for a stale historical Design instruction without rewriting it', () => {
    const guide = designContractAuthoringGuide();
    const staleInstruction = 'Prepare a visual draft using the old loose format.';
    const mission = { id: 'mission', goal: 'Build a landing page', participants: [] } as unknown as Mission;
    const task = { ...designTaskDefinition(), instruction: staleInstruction, id: 'task', missionId: 'mission', stage: 'design', assignedAgentId: 'agent', inputArtifactIds: [] } as unknown as MissionTask;
    const prompt = buildMissionPrompt({ mission, tasks: [task], artifacts: [] }, task);
    expect(prompt).toContain(staleInstruction);
    expect(prompt).toContain(guide);
    expect(task.instruction).toBe(staleInstruction);
  });

  it('keeps browser verification independent from Builder-authored tooling', () => {
    const prompt = buildImplementationPrompt({
      mission: { id: 'mission', goal: 'Add an activity filter', participants: [] } as unknown as Mission,
      task: { id: 'task', title: 'Build', instruction: 'Implement the approved design.' } as unknown as MissionTask,
      participant: null,
      designRevisionId: 'revision',
      designVersion: 1,
      packageHash: 'package',
      previewHash: 'preview',
      contractHash: 'contract',
      contractJson: '{}',
      packageExcerpt: '{}',
      previewExcerpt: '<main>Activity</main>',
      workspaceRevisionId: 'workspace',
    });
    expect(prompt).toContain('use only the application\'s existing bounded checks');
    expect(prompt).toContain('Do not add or download browser-automation/verification dependencies');
    expect(prompt).toContain('duplicate Conductor\'s independent verification');
  });

  it('does not loosen strict parsing for the incompatible live shape', () => {
    expect(() => parseDesignContract({
      schemaVersion: 1,
      viewport: { width: 1440, height: 900, breakpoints: [320] },
      requiredText: [],
      requiredElements: [{ selector: '#order', type: 'link', expectedText: 'Order Now' }],
      interactions: [],
    })).toThrow();
  });
});
