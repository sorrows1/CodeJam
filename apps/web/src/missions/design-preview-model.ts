export interface LogicalDesignViewport { width: number; height: number }
export interface DesignPreviewState { instance: number; notice: string | null }

const FALLBACK_VIEWPORT: LogicalDesignViewport = { width: 1440, height: 900 };

export function parseLogicalDesignViewport(contractJson: string): LogicalDesignViewport {
  try {
    const value = JSON.parse(contractJson) as { primarySurfaceId?: string; surfaces?: Array<{ id?: string; viewport?: { width?: unknown; height?: unknown } }>; viewport?: { width?: unknown; height?: unknown } };
    const primary = value.surfaces?.find((item) => item.id === value.primarySurfaceId) ?? value.surfaces?.[0];
    const width = primary?.viewport?.width ?? value.viewport?.width;
    const height = primary?.viewport?.height ?? value.viewport?.height;
    if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && Number(width) > 0 && Number(height) > 0) {
      return { width: Number(width), height: Number(height) };
    }
  } catch {
    // The server validates authoritative contracts; the fallback keeps a corrupt presentation fail-safe.
  }
  return FALLBACK_VIEWPORT;
}

export function resetDesignPreview(state: DesignPreviewState): DesignPreviewState {
  return { instance: state.instance + 1, notice: null };
}

export function designPreviewFrameKey(revisionId: string, instance: number): string {
  return `${revisionId}:${instance}`;
}
