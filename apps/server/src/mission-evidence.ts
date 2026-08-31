import { randomUUID } from 'node:crypto';
import type { Database, Mission, MissionEvent } from './types.js';

export interface BoundedMissionText {
  content: string;
  originalByteLength: number;
  truncated: boolean;
}

const secretKey = String.raw`(?:(?:(?:AWS|VOLCENGINE|ALIYUN)[_-]?)?(?:ARK[_-]?API[_-]?KEY|APP[_-]?AUTH[_-]?TOKEN|AUTHORIZATION|SET[_-]?COOKIE|COOKIE|API[_-]?KEY|ACCESS[_-]?(?:KEY(?:[_-]?ID)?|TOKEN)|SECRET[_-]?(?:ACCESS[_-]?)?KEY(?:[_-]?ID)?|CLIENT[_-]?SECRET|PASSWORD|PASSWD|SECRET|TOKEN|AK|SK))`;
const secretPatterns = [
  new RegExp(`(["'])(${secretKey})\\1(\\s*:\\s*)(["'])(.*?)\\4`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9_])(${secretKey})(?![A-Za-z0-9_])(\\s*[=:]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;}\\]]+)`, 'gi'),
  /((?:Bearer|Basic))\s+[A-Za-z0-9._~+/=-]+/gi,
];
const secretKeyPattern = new RegExp(`^${secretKey}$`, 'i');

export const MAX_ARTIFACT_INLINE_BYTES = 64 * 1024;

export function boundedText(
  content: string,
  maxBytes = 50 * 1024,
): BoundedMissionText {
  const originalByteLength = Buffer.byteLength(content, 'utf8');
  if (originalByteLength <= maxBytes) {
    return { content, originalByteLength, truncated: false };
  }
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const result = content.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
  return { content: result, originalByteLength, truncated: true };
}

export function safeMissionText(
  content: string,
  maxBytes = 50 * 1024,
  configuredSecrets: readonly string[] = [],
): BoundedMissionText {
  let redacted = content;
  for (const secret of [...new Set(configuredSecrets)].filter((value) => value.length > 0).sort((left, right) => right.length - left.length)) redacted = redacted.split(secret).join('[REDACTED]');
  redacted = redacted.replace(secretPatterns[0]!, (_match, quote, key, separator, valueQuote) =>
    `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`,
  );
  redacted = redacted.replace(secretPatterns[1]!, (_match, key, separator) => `${key}${separator}[REDACTED]`);
  redacted = redacted.replace(secretPatterns[2]!, (_match, scheme) => `${scheme} [REDACTED]`);
  return boundedText(redacted, maxBytes);
}

export function sanitizeMissionEventDetails(
  details: MissionEvent['details'],
): MissionEvent['details'] {
  const result: MissionEvent['details'] = {};
  for (const [rawKey, value] of Object.entries(details).slice(0, 16)) {
    const key = safeMissionText(rawKey, 64).content;
    const safeValue = secretKeyPattern.test(key) ? '[REDACTED]' :
      typeof value === 'string' ? safeMissionText(value, 1024).content :
        typeof value === 'number' && !Number.isFinite(value) ? null :
          value !== null && typeof value !== 'number' && typeof value !== 'boolean' && value !== undefined
            ? safeMissionText(JSON.stringify(value), 1024).content
            : value;
    const candidate = { ...result, [key]: safeValue };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 8192) break;
    result[key] = safeValue;
  }
  return result;
}

export function addEvent(
  database: Database,
  mission: Mission,
  type: MissionEvent['type'],
  values: Partial<
    Pick<MissionEvent, 'taskId' | 'attemptId' | 'agentId' | 'actor'>
  >,
  details: MissionEvent['details'] = {},
): MissionEvent {
  const event: MissionEvent = {
    id: randomUUID(),
    missionId: mission.id,
    sequence: mission.nextEventSequence++,
    type,
    taskId: values.taskId ?? null,
    attemptId: values.attemptId ?? null,
    agentId: values.agentId ?? null,
    actor: values.actor ?? 'system',
    details: sanitizeMissionEventDetails(details),
    createdAt: new Date().toISOString(),
  };
  database.missionEvents.push(event);
  return event;
}
