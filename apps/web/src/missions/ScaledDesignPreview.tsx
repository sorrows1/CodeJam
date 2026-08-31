import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogicalDesignViewport } from './design-preview-model';

function describeNavigation(raw: string): string {
  if (!raw) return 'This preview link has no destination.';
  return `This preview kept navigation to ${raw} inside the design review.`;
}

function fragmentTarget(document: Document, raw: string): HTMLElement | null {
  if (!raw.startsWith('#')) return null;
  const fragment = raw.slice(1);
  if (!fragment) return document.documentElement;
  let decoded = fragment;
  try { decoded = decodeURIComponent(fragment); } catch { decoded = fragment; }
  return document.getElementById(decoded) ?? (document.getElementsByName(decoded)[0] as HTMLElement | undefined) ?? null;
}

function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  // Do not use `target instanceof Element` here. The event target lives in the
  // iframe's Window realm, so parent-realm instanceof checks return false.
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  return (candidate?.closest?.('a[data-conductor-href], a[href]') as HTMLAnchorElement | null) ?? null;
}

export function ScaledDesignPreview({
  html,
  viewport,
  frameKey,
  title,
  fit = 'width',
  zoom = null,
  onContainedInteraction,
  onNavigationRequest,
}: {
  html: string;
  viewport: LogicalDesignViewport;
  frameKey: string;
  title: string;
  fit?: 'width' | 'contain';
  zoom?: number | null;
  onContainedInteraction: (message: string) => void;
  onNavigationRequest?: (destination: string) => boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const detachFrameHandlers = useRef<(() => void) | null>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setAvailable({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => detachFrameHandlers.current?.(), []);

  const scale = useMemo(() => {
    if (!available.width) return 0;
    const widthScale = available.width / viewport.width;
    const heightScale = fit === 'contain' && available.height ? available.height / viewport.height : 1;
    return zoom === null ? Math.min(1, widthScale, heightScale) : Math.min(2, Math.max(0.25, zoom / 100));
  }, [available.height, available.width, fit, viewport.height, viewport.width, zoom]);
  const renderedHeight = Math.round(viewport.height * scale);

  const attachInteractionPolicy = useCallback(() => {
    detachFrameHandlers.current?.();
    detachFrameHandlers.current = null;
    const frame = iframeRef.current;
    const document = frame?.contentDocument;
    const frameWindow = frame?.contentWindow;
    if (!document || !frameWindow) return;

    frameWindow.scrollTo(0, 0);

    for (const element of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      if (element.dataset.conductorHref === undefined) element.dataset.conductorHref = element.getAttribute('href')?.trim() ?? '';
      element.setAttribute('href', '#');
      element.removeAttribute('target');
    }

    const onClick = (event: MouseEvent) => {
      const anchor = closestAnchor(event.target);
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const raw = anchor.dataset.conductorHref ?? anchor.getAttribute('href')?.trim() ?? '';
      if (raw.startsWith('#')) {
        const destination = fragmentTarget(document, raw);
        if (destination) {
          destination.scrollIntoView({ block: 'start', inline: 'nearest' });
          return;
        }
      }
      if (onNavigationRequest?.(raw)) return;
      onContainedInteraction(describeNavigation(raw));
    };
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onContainedInteraction('Form submission is disabled inside the design preview.');
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    detachFrameHandlers.current = () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, [onContainedInteraction, onNavigationRequest]);

  return <div
    ref={containerRef}
    className={`scaled-design-preview is-${fit}`}
    data-logical-width={viewport.width}
    data-logical-height={viewport.height}
    data-preview-scale={scale.toFixed(4)}
    style={fit === 'width' ? { height: renderedHeight || 1 } : undefined}
  >
    <div className="scaled-design-preview__canvas" style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}>
      <iframe
        ref={iframeRef}
        key={frameKey}
        title={title}
        sandbox="allow-same-origin"
        srcDoc={html}
        width={viewport.width}
        height={viewport.height}
        scrolling="no"
        onLoad={attachInteractionPolicy}
      />
    </div>
  </div>;
}
